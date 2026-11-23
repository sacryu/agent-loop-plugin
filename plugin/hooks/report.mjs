// Agent Loop 插件的上报脚本：这是唯一会把数据发出本机的代码。
//
// Claude Code 每触发一个 hook 事件，就以 `node report.mjs` 起一次这个脚本，把事件数据从标准输入传进来。
// 脚本用白名单的方式挑出允许的字段，重新拼成一条事件，发到服务器，然后退出。不记任何状态。
//
// 隐私规则（详见仓库里的 docs/privacy.md）：
//   - 每条事件都有匿名字段：类别、耗时、加盐哈希后的编号。盐在本机随机生成，永不上传。
//   - 分享多少由你在插件设置里选（share）：anonymous 只有匿名字段；summary 另附小附件（星系名、项目名、对话标题、
//     每一步的工具名和对象、报错第一行、回答最后一句）；full 再附大附件（整句话、工具完整的输入输出、完整的回答和报错）。
//     没选时本机用 full，非本机用 summary。
//   - 发往本机（主机名严格是 127.0.0.1、localhost、::1）时附件是明文，数据不出电脑。
//   - 发往别处时附件一律用 AES-256-GCM 加密，密钥从邀请链接（#k=…）里派生，只在你的插件和看的人的浏览器里。
//     没有邀请链接（没有密钥）就什么都不发。
//   - 用 /agent-loop:leave 退出过的星系群也什么都不发（记在插件数据目录的 left.json 里，/agent-loop:rejoin 去掉）。
//   - 用接入命令换了群以后，还拿着旧设置的会话也不发（moved.json，/reload-plugins 以后就是新设置了）。
//   - 附件里出现的邀请密钥（k=…）一律抹掉，不会跟着别的内容发出去。
//
// 这个文件不能依赖任何包，也不能从仓库其他目录导入（插件装到你机器上时只有 plugin/ 这一个目录）。
// 任何失败都吞掉：不往标准输出写任何东西，退出码永远是 0。需要 Node 18 以上（自带 fetch）。

import { createCipheriv, createHash, hkdfSync, randomBytes } from "node:crypto";
import { closeSync, fstatSync, linkSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, statSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";

/** 默认发往本机（plugin.json 里 userConfig.server_url 的默认值要一起改，测试会检查两处一致）。
 *  本机没有服务在听时静默失败，没有任何可见影响 */
export const DEFAULT_SERVER_URL = "http://127.0.0.1:4317";
export const PROTOCOL_VERSION = 2;
/** 插件自己的版本，每次上报放在请求头 x-agent-loop-plugin 里，页面据此提示更新。
 *  和 plugin.json 的 version、shared/src/version.ts 的 PLUGIN_VERSION 一致（测试检查） */
export const PLUGIN_VERSION = "0.2.9";
export const SEND_TIMEOUT_MS = 2000;
/** SessionEnd 是同步 hook（会话退出时异步进程会被杀掉，见 docs/step0-findings.md）。Claude Code 给 SessionEnd 的
 *  总时间约 1.5 秒，超过就取消并在终端打一行提示；Node 启动的时间也算在里面，所以发送超时要短 */
export const SESSION_END_TIMEOUT_MS = 600;
/** 本机、档位 2 附带的原样数据过大时，把长字符串截短 */
const RAW_MAX_BYTES = 200_000;
/** 小附件、大附件明文的上限（字节，JSON）。和 shared/ 的 SMALL_MAX_BYTES、FULL_MAX_BYTES 一致 */
export const SMALL_MAX_BYTES = 600;
export const FULL_MAX_BYTES = 32 * 1024;
/** 星系编号、星系群编号的长度（十六进制字符数，128 位）。和 shared/src/attach.ts 的 ID_HEX 一致。
 *  这两个编号是公开的，服务器靠它们认人，所以比别的哈希（16 个字符）长 */
export const ID_HEX = 32;

// ---- 和 shared/ 保持一致的表（test/plugin-sync.test.ts 检查）

/** @typedef {"read"|"edit"|"search"|"shell"|"web"|"agent"|"ask"|"plan"|"progress"|"mcp"|"other"} ToolKind */
/** @typedef {"rate_limit"|"server"|"auth"|"billing"|"max_output"|"other"} ErrKind */
/** @typedef {0|1|2} Level */

/** @type {Record<string, ToolKind>} */
export const TOOL_TABLE = {
  Read: "read", NotebookRead: "read", LS: "read",
  Edit: "edit", MultiEdit: "edit", Write: "edit", NotebookEdit: "edit",
  Grep: "search", Glob: "search",
  Bash: "shell", PowerShell: "shell", BashOutput: "shell", KillBash: "shell", KillShell: "shell",
  WebFetch: "web", WebSearch: "web",
  Task: "agent", Agent: "agent",
  AskUserQuestion: "ask",
  ExitPlanMode: "plan",
  TodoWrite: "progress", TaskCreate: "progress", TaskUpdate: "progress", TaskList: "progress", TaskGet: "progress",
  SubagentHandback: "progress",
};

export const EVENT_NAMES = [
  "SessionStart", "SessionEnd", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PostToolUseFailure",
  "PostToolBatch", "PermissionRequest", "PermissionDenied", "Notification", "Stop", "StopFailure",
  "SubagentStart", "SubagentStop", "PreCompact", "PostCompact",
];
export const SESSION_SOURCES = ["startup", "resume", "clear", "compact", "fork"];
export const NOTIFICATION_TYPES = [
  "permission_prompt", "idle_prompt", "auth_success", "elicitation_dialog", "elicitation_complete",
  "elicitation_response", "agent_needs_input", "agent_completed",
];
export const BUILTIN_AGENT_TYPES = ["general-purpose", "Explore", "Plan", "statusline-setup", "claude-code-guide"];
/** 模型名只认 Claude 的模型名（claude-… 或几个别名），别的（比如自建网关上起的名字）一律不传 */
export const MODEL_RE = /^(claude-[a-z0-9.-]{1,60}(\[1m\])?|opus|sonnet|haiku|fable)$/;
export const SHARE_OPTIONS = ["auto", "anonymous", "summary", "full"];
const TOOL_EVENTS = new Set(["PreToolUse", "PostToolUse", "PostToolUseFailure", "PermissionRequest", "PermissionDenied"]);
const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/**
 * 上传的事件。和 shared/src/protocol.ts 的 schema 一一对应。
 * @typedef {{
 *   v: 2, level: Level, ev: string, ts: number, sid: string, proj: string,
 *   agent?: string, prompt?: string, tool?: string, kind?: ToolKind, duration_ms?: number,
 *   interrupt?: boolean, source?: string, ntype?: string, bg?: number, err_kind?: ErrKind,
 *   agent_type?: string, agent_type_h?: string, task_note?: boolean, model?: string, ctx_tok?: number, out_tok?: number, laps?: number, steps?: number,
 *   detail?: Detail, detail_full?: unknown, enc?: string, enc_full?: string, card?: Detail, enc_card?: string,
 *   title?: Detail, enc_title?: string, raw?: unknown
 * }} OutEvent
 */

/** 小附件的明文（和 shared/ 的 Detail 一致） @typedef {{ me?: string, proj?: string, label?: string, name?: string,
 *  obj?: string, err?: string, type?: string, say?: string }} Detail */

/** @param {unknown} name @returns {ToolKind} */
export function toolKind(name) {
  const n = typeof name === "string" ? name : "";
  if (Object.prototype.hasOwnProperty.call(TOOL_TABLE, n)) return TOOL_TABLE[n];
  if (n.startsWith("mcp__")) return "mcp";
  return "other";
}

/**
 * StopFailure 的 error（rate_limit、server_error、authentication_failed……）归类。照搬 Python 版的 error_kind。
 * @param {unknown} err @returns {ErrKind}
 */
export function errorKind(err) {
  let raw;
  if (err && typeof err === "object") raw = Object.values(err).map(String).join(" ");
  else raw = String(err ?? "");
  const s = raw.toLowerCase();
  if ((s.includes("rate") && s.includes("limit")) || s.includes("429")) return "rate_limit";
  if (s.includes("overload") || s.includes("529") || s.includes("busy") || s.includes("server") || /\b5\d\d\b/.test(s)) return "server";
  if (s.includes("auth") || s.includes("login") || s.includes("401") || s.includes("403") || s.includes("token expired")) return "auth";
  if (s.includes("billing") || s.includes("credit") || s.includes("payment") || s.includes("quota")) return "billing";
  if (s.includes("max_output") || s.includes("max_tokens") || s.includes("output token") || s.includes("too long")) return "max_output";
  return "other";
}

/**
 * 是不是本机地址：主机名严格是 127.0.0.1、localhost、::1。只有本机地址才发明文附件
 * @param {string} url @returns {boolean}
 */
export function isLocal(url) {
  try {
    return LOOPBACK.has(new URL(url).hostname);
  } catch {
    return false;
  }
}

/**
 * 分享档位：设置里的 share 加上是不是本机。没设、或者设成 auto：本机 2（完整），非本机 1（概要）；认不出的值按 1
 * @param {string | undefined} share @param {boolean} local @returns {Level}
 */
export function shareLevel(share, local) {
  const v = (share || "").trim().toLowerCase();
  if (!v || v === "auto" || v.startsWith("${")) return local ? 2 : 1;
  if (v === "anonymous") return 0;
  if (v === "full") return 2;
  return 1;
}

/** @param {string} salt @param {string} value */
export function hash16(salt, value) {
  return createHash("sha256").update(salt + value).digest("hex").slice(0, 16);
}

/** 公开的星系编号 = sha256(secret) 的前 32 个十六进制字符 @param {string} secret */
export function galaxyId(secret) {
  return createHash("sha256").update(secret).digest("hex").slice(0, ID_HEX);
}

/** 项目目录哈希前统一大小写和分隔符 @param {string} dir */
export function normDir(dir) {
  return dir.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

/** @param {unknown} v @returns {v is string} */
const str = v => typeof v === "string" && v.length > 0;

/** 太大时把长字符串截短（数组最多留 200 项） @param {unknown} v @param {number} n @returns {unknown} */
export function clipDeep(v, n) {
  if (typeof v === "string") return v.length > n ? v.slice(0, n) + `…(+${v.length - n})` : v;
  if (Array.isArray(v)) return v.slice(0, 200).map(x => clipDeep(x, n));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clipDeep(x, n)]));
  return v;
}

const bytes = (/** @type {unknown} */ v) => Buffer.byteLength(JSON.stringify(v) ?? "", "utf8");

// ---- 附件里的短字段：只负责挑字段和截断，不负责造句（句子由浏览器按看的人的语言拼）

/** 东亚宽字符算 1，其余算 0.55（照搬 Python 版 humanize.py 的 char_width） @param {string} ch */
const charW = ch => /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]|[\ud800-\udbff]/.test(ch) ? 1 : 0.55;
/** @param {string} s */
const textW = s => { let w = 0; for (const c of s) w += charW(c); return w; };
/** 压掉空白，超出 n 个字符时截断加省略号 @param {unknown} v @param {number} n */
export function clip(v, n) {
  const s = typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "";
  return s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s;
}
/** 第一行非空的文字 @param {unknown} v */
export function firstLine(v) {
  if (typeof v !== "string") return "";
  for (const line of v.trim().split(/\r?\n/)) if (line.trim()) return line.trim();
  return "";
}

// 只在分句的标点处截断。括号、引号、书名号不算
const PUNCT = new Set("，。！？；：、,!?;:");
/** @param {string} t @param {number} i */
function isBreak(t, i) {
  const c = t[i];
  if (c === ":") return i + 1 === t.length || t[i + 1] === " ";   // http://、C:\、12:30 里的冒号不算
  if (PUNCT.has(c)) return true;
  return c === "." && (i + 1 === t.length || t[i + 1] === " ");   // 英文句点只在句末算
}

/**
 * 对话的标签：输入的第一句的开头，最多约 12 个汉字宽，在标点处截断。照搬 Python 版 humanize.py 的 label_from_prompt
 * @param {unknown} text @param {number} [width] @returns {string}
 */
export function labelFromPrompt(text, width = 12) {
  let t = (typeof text === "string" ? text : "").replace(/\[(Image #\d+|图片)\]/g, " ").replace(/\s+/g, " ").trim();
  if (!t) return "";
  // 先取第一个分句；太短的开头（「1.」「好的，」）认不出对话，跳过这个标点接着找
  for (let i = 1; i < t.length; i++) if (isBreak(t, i) && textW(t.slice(0, i).trim()) >= 3) { t = t.slice(0, i); break; }
  t = t.trim();
  if (textW(t) <= width) return t;
  // 还是太长：在宽度内最后一个空格处断开（英文），否则硬截
  let w = 0, cut = "";
  for (const c of t) { w += charW(c); if (w > width - 1) break; cut += c; }
  const sp = cut.lastIndexOf(" ");
  if (sp >= 4) cut = cut.slice(0, sp);
  return cut.trimEnd() + "…";
}

/** 对话标签的宽度（汉字算 1，其余算 0.55） */
export const LABEL_WIDTH = 20;

/** 回答的最后一句（去掉 Markdown 记号） @param {unknown} text */
export function lastSentence(text) {
  if (typeof text !== "string") return "";
  /** @type {string[]} */
  const out = [];
  for (let line of text.replace(/[`*#>\[\]]+/g, "").split(/\r?\n/)) {
    line = line.replace(/^[\s\-•]+|[\s\-•]+$/g, "");
    if (!line) continue;
    for (const part of line.split(/(?<=[。！？!?])|(?<=\.)\s+/)) if (part.trim()) out.push(part.trim());
  }
  return out.length ? out[out.length - 1] : "";
}

/** 路径的最后两段：web/draw.ts @param {unknown} p */
export function lastTwo(p) {
  const parts = (typeof p === "string" ? p : "").split(/[\\/]+/).filter(Boolean);
  const s = parts.slice(-2).join("/");
  return s.length > 120 ? "…" + s.slice(-119) : s;   // 太长时留结尾：文件名比目录要紧
}

/**
 * 一步的对象（照搬 Python 版 tool_phrase 取的东西，不带动词）。其余工具（含 MCP）没有对象：真实工具名已经够了
 * @param {string} name @param {any} inp @returns {string}
 */
export function toolObj(name, inp) {
  const i = inp && typeof inp === "object" ? inp : {};
  switch (name) {
    case "Bash": case "PowerShell": return clip(i.command, 60);
    case "Read": case "Edit": case "MultiEdit": case "Write": return lastTwo(i.file_path);
    case "NotebookEdit": return lastTwo(i.notebook_path || i.file_path);
    case "Grep": case "Glob": return clip(i.pattern, 60);
    case "WebFetch": try { return clip(new URL(String(i.url)).hostname, 120); } catch { return clip(i.url, 60); }
    case "WebSearch": return clip(i.query, 60);
    case "Agent": case "Task": return clip(firstLine(i.description) || i.subagent_type, 60);
    case "AskUserQuestion": {
      const q = Array.isArray(i.questions) && i.questions[0] && typeof i.questions[0] === "object" ? i.questions[0].question : "";
      return clip(firstLine(q), 60);
    }
    case "Skill": return clip(i.skill || i.command, 60);
    default: return "";
  }
}

/** 去掉空字段；还超过上限就把最长的那个字段一截一截地剪短 @param {Detail} d @returns {Detail | null} */
export function fitSmall(d) {
  /** @type {Record<string, string>} */
  const o = {};
  for (const [k, v] of Object.entries(d)) if (typeof v === "string" && v) o[k] = v;
  if (!Object.keys(o).length) return null;
  for (let guard = 0; bytes(o) > SMALL_MAX_BYTES && guard < 200; guard++) {
    const k = Object.keys(o).sort((a, b) => o[b].length - o[a].length)[0];
    const s = o[k];
    if (s.length <= 4) { delete o[k]; continue; }
    o[k] = s.slice(0, Math.floor(s.length * 0.8)).trimEnd() + "…";
  }
  return Object.keys(o).length ? o : null;
}

/** 大附件：超过上限时把长字符串越截越短；还是太大就不发 @param {unknown} v @returns {unknown} */
export function fitFull(v) {
  if (v === undefined || v === null || v === "") return undefined;
  if (bytes(v) <= FULL_MAX_BYTES) return v;
  for (const n of [8000, 2000, 500, 120]) { const c = clipDeep(v, n); if (bytes(c) <= FULL_MAX_BYTES) return c; }
  return undefined;
}

/** 通知、报错的文字：字符串原样，对象取 message @param {unknown} v @returns {string} */
const textOf = v => typeof v === "string" ? v
  : v && typeof v === "object" && typeof (/** @type {any} */ (v)).message === "string" ? /** @type {any} */ (v).message : "";

/**
 * 小附件（档位 1 起）
 * @param {any} hook @param {string} name @param {{ me?: string, projectDir?: string, taskNote?: boolean }} ctx @returns {Detail | null}
 */
export function smallDetail(hook, name, ctx) {
  switch (name) {
    case "SessionStart": {
      const dir = str(ctx.projectDir) ? ctx.projectDir : str(hook.cwd) ? hook.cwd : "";
      return fitSmall({ me: clip(ctx.me, 40), proj: clip(lastTwo(dir).split("/").pop(), 80) });
    }
    // 宽度比 Python 版的 12 宽一些：它在这里还要当对话的标题；画面上放不下时浏览器会再截
    case "UserPromptSubmit": return ctx.taskNote ? null : fitSmall({ label: labelFromPrompt(hook.prompt, LABEL_WIDTH) });
    case "PreToolUse": case "PermissionRequest": {
      const tn = str(hook.tool_name) ? hook.tool_name.slice(0, 160) : "";
      return tn ? fitSmall({ name: tn, obj: toolObj(tn, hook.tool_input) }) : null;
    }
    case "PostToolUseFailure": return fitSmall({ err: clip(firstLine(textOf(hook.error)), 160) });
    case "SubagentStart": return fitSmall({ type: clip(hook.agent_type, 80) });
    case "Stop": return fitSmall({ say: clip(lastSentence(hook.last_assistant_message), 200) });
    default: return null;
  }
}

/**
 * 大附件（档位 2）
 * @param {any} hook @param {string} name @param {{ taskNote?: boolean }} ctx @returns {unknown}
 */
export function fullDetail(hook, name, ctx) {
  switch (name) {
    case "UserPromptSubmit": return ctx.taskNote ? undefined : fitFull(hook.prompt);
    case "PreToolUse": case "PermissionRequest": return fitFull(hook.tool_input);
    case "PostToolUse": {
      let r = hook.tool_response;
      // Edit、Write 的回应里有整份原文件：又大又和 tool_input 重复，不要
      if (r && typeof r === "object" && !Array.isArray(r) && "originalFile" in r) { r = { ...r }; delete r.originalFile; }
      return fitFull(r);
    }
    case "PostToolUseFailure": return fitFull(textOf(hook.error));
    case "Notification": return fitFull(textOf(hook.message));
    case "Stop": return fitFull(hook.last_assistant_message);
    default: return undefined;
  }
}

// ---- 加密

/** base64url 编码 @param {Buffer} b */
const b64u = b => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/**
 * 从邀请链接里的 K 派生出口令（发给服务器）和内容密钥（永不离开本机）。K 是 32 字节随机数的 base64url（43 个字符）。
 * 星系群编号 = sha256(口令) 的前 32 个十六进制字符，服务器自己也这样算
 * @param {string} k @returns {{ access: string, group: string, content: Buffer } | null}
 */
export function deriveKeys(k) {
  if (typeof k !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(k)) return null;
  const K = Buffer.from(k.replace(/-/g, "+").replace(/_/g, "/") + "=", "base64");
  if (K.length !== 32) return null;
  const hk = (/** @type {string} */ info) => Buffer.from(hkdfSync("sha256", K, Buffer.alloc(0), info, 32));
  const access = b64u(hk("agent-loop/access/v1"));
  return { access, group: createHash("sha256").update(access).digest("hex").slice(0, ID_HEX), content: hk("agent-loop/content/v1") };
}

/**
 * AES-256-GCM 加密：base64url(12 字节随机数 ‖ 密文 ‖ 16 字节校验)。aad 是 协议版本|槽|sid|键
 * @param {Buffer} key @param {unknown} value @param {string} aad
 */
export function seal(key, value, aad) {
  const iv = randomBytes(12), c = createCipheriv("aes-256-gcm", key, iv);
  c.setAAD(Buffer.from(aad, "utf8"));
  return b64u(Buffer.concat([iv, c.update(JSON.stringify(value), "utf8"), c.final(), c.getAuthTag()]));
}

/**
 * 一条事件的附件放进哪个槽、用什么键。和 shared/src/attach.ts 的 slotsOf 一致（test/plugin-sync.test.ts 检查）
 * 名片（card）的附加校验数据里放星系编号 gid：服务器没法把你的名片挪到别人的星系上
 * @param {{ ev: string, sid: string, proj: string, tool?: string, agent?: string, prompt?: string }} ev @param {string} [gid]
 * @returns {{ small: { slot: string, sid: string, k: string } | null, full: { slot: string, sid: string, k: string } | null }}
 */
export function slotsOf(ev, gid = "") {
  const sid = ev.sid, tool = ev.tool, pr = ev.prompt ?? "";
  switch (ev.ev) {
    case "SessionStart": return { small: { slot: "card", sid: gid, k: ev.proj }, full: null };
    case "UserPromptSubmit": return { small: { slot: "ask", sid, k: pr }, full: { slot: "full-ask", sid, k: pr } };
    case "PreToolUse": case "PermissionRequest":
      return tool ? { small: { slot: "step", sid, k: tool }, full: { slot: "full-in", sid, k: tool } } : { small: null, full: null };
    case "PostToolUse": return { small: null, full: tool ? { slot: "full-out", sid, k: tool } : null };
    case "PostToolUseFailure":
      return tool ? { small: { slot: "fail", sid, k: tool }, full: { slot: "full-out", sid, k: tool } } : { small: null, full: null };
    case "SubagentStart": return { small: ev.agent ? { slot: "sub", sid, k: ev.agent } : null, full: null };
    case "Notification": return { small: null, full: { slot: "full-note", sid, k: pr } };
    case "Stop": return { small: { slot: "ans", sid, k: pr }, full: { slot: "full-ans", sid, k: pr } };
    default: return { small: null, full: null };
  }
}
/** 附加校验数据 @param {string} slot @param {string} sid @param {string} k */
export const aadOf = (slot, sid, k) => `agent-loop/${PROTOCOL_VERSION}|${slot}|${sid}|${k}`;

// ---- 模型名：hook 数据里没有（docs/step0-findings.md），从会话记录末尾最后一条回答里取

/** @param {unknown} path @returns {string | undefined} */
export function modelFromTranscript(path) {
  if (!str(path)) return undefined;
  /** @type {number | undefined} */
  let fd;
  try {
    fd = openSync(/** @type {string} */ (path), "r");
    const size = fstatSync(fd).size, n = Math.min(size, 64 * 1024), buf = Buffer.alloc(n);
    readSync(fd, buf, 0, n, size - n);
    const lines = buf.toString("utf8").split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].includes('"assistant"')) continue;
      try {
        const o = JSON.parse(lines[i]);
        const mdl = o && o.type === "assistant" && o.message && o.message.model;
        if (typeof mdl === "string" && mdl.length <= 80 && MODEL_RE.test(mdl)) return mdl;
      } catch { /* 第一行可能被截断了 */ }
    }
  } catch { /* 没有这个文件 */ } finally {
    if (fd !== undefined) try { closeSync(fd); } catch { /* ignore */ }
  }
  return undefined;
}

// ---- token 数和对话的标题：hook 数据里也没有，从会话记录里读
//
// ctx：最后一次回答时的上下文大小（输入 + 缓存读 + 缓存写）；out：主对话所有回答的输出 token 加起来。
// 同一条回答在记录里拆成好几条、每条带同一份 usage：按 message.id 只算一次。子 agent 的记录（isSidechain）不算。
// 标题：Claude Code 自己给对话起的（type "ai-title" 的行，第一句话发出后几秒才写进去，之后隔一阵重写一遍）；
// 用 /rename 改过的（type "custom-title"）优先。
// laps：主对话回答了几次（按 message.id 数，Claude Code 自己补的 <synthetic> 回答不算），一次回答就是一圈；
// steps：主对话调用了几次工具（tool_use）。服务器重启过、会话中途才接上时，页面上的累计圈数、步数靠这两个数补回来。
// 记录可能有几十 MB：记下读到了哪里（cacheFile），下次从那里接着读。

const USAGE_CHUNK = 1 << 20;
const MAX_TOK = 1e11;
const tokN = (/** @type {unknown} */ v) => (typeof v === "number" && isFinite(v) && v > 0 ? Math.floor(v) : 0);

const TITLE_MAX = 80;
const USAGE_CACHE_V = 3;   // 缓存里加了东西（2：标题，3：圈数、步数）：旧的缓存从头再读一遍，不然已经读过去的就数不到了

/**
 * @param {unknown} path @param {string} [cacheFile]
 * @returns {{ ctx: number, out: number, laps: number, steps: number, title?: string, titleNew?: true } | undefined}
 *   titleNew：这次读到的标题和上次读到的不一样（包括第一次读到）
 */
export function usageFromTranscript(path, cacheFile) {
  if (!str(path)) return undefined;
  /** @type {{ v: number, path: string, off: number, out: number, ctx: number, ids: string[], laps: number, steps: number, tools: string[], ai: string, custom: string }} */
  let st = { v: USAGE_CACHE_V, path: /** @type {string} */ (path), off: 0, out: 0, ctx: 0, ids: [], laps: 0, steps: 0, tools: [], ai: "", custom: "" };
  if (cacheFile) {
    try {
      const c = JSON.parse(readFileSync(cacheFile, "utf8"));
      if (c && c.v === USAGE_CACHE_V && c.path === path && Number.isInteger(c.off) && c.off >= 0 && Array.isArray(c.ids) && Array.isArray(c.tools)) {
        st = { ...st, ...c, out: tokN(c.out), ctx: tokN(c.ctx), laps: tokN(c.laps), steps: tokN(c.steps),
               ai: str(c.ai) ? c.ai : "", custom: str(c.custom) ? c.custom : "" };
      }
    } catch { /* 第一次 */ }
  }
  const titleBefore = st.custom || st.ai;
  /** @type {number | undefined} */
  let fd;
  const start = st.off;
  try {
    fd = openSync(/** @type {string} */ (path), "r");
    const size = fstatSync(fd).size;
    if (size < st.off) st = { ...st, off: 0, out: 0, ctx: 0, ids: [], laps: 0, steps: 0, tools: [], ai: "", custom: "" };   // 文件被换掉了：从头读
    const seen = new Set(st.ids), seenTools = new Set(st.tools);
    let pos = st.off, rest = Buffer.alloc(0);
    while (pos < size) {
      const buf = Buffer.alloc(Math.min(USAGE_CHUNK, size - pos));
      const n = readSync(fd, buf, 0, buf.length, pos);
      if (n <= 0) break;
      pos += n;
      const data = rest.length ? Buffer.concat([rest, buf.subarray(0, n)]) : buf.subarray(0, n);
      const nl = data.lastIndexOf(10);
      if (nl < 0) { rest = data; continue; }
      rest = Buffer.from(data.subarray(nl + 1));
      st.off = pos - rest.length;   // 只算到最后一个换行：最后一行可能还没写完
      for (const line of data.subarray(0, nl).toString("utf8").split("\n")) {
        if (line.startsWith('{"type":"ai-title"') || line.startsWith('{"type":"custom-title"')) {
          let o;
          try { o = JSON.parse(line); } catch { continue; }
          const ai = o && o.type === "ai-title", t = ai ? o.aiTitle : o && o.type === "custom-title" ? o.customTitle : undefined;
          if (str(t)) st[ai ? "ai" : "custom"] = clip(t, TITLE_MAX);
          continue;
        }
        if (!line.includes('"usage"') || !line.includes('"assistant"')) continue;
        let o;
        try { o = JSON.parse(line); } catch { continue; }
        const m = o && o.type === "assistant" && !o.isSidechain && o.message;
        const u = m && m.usage;
        if (!u || typeof u !== "object") continue;
        const ctx = tokN(u.input_tokens) + tokN(u.cache_read_input_tokens) + tokN(u.cache_creation_input_tokens);
        if (ctx) st.ctx = Math.min(MAX_TOK, ctx);
        const real = m.model !== "<synthetic>";
        // 同一条回答拆成好几行，每行一块内容：工具调用按它自己的编号数
        if (real && Array.isArray(m.content)) {
          for (const b of m.content) {
            if (!b || b.type !== "tool_use") continue;
            const tid = str(b.id) ? b.id : "";
            if (tid && seenTools.has(tid)) continue;
            if (tid) { seenTools.add(tid); st.tools.push(tid); if (st.tools.length > 64) st.tools.shift(); }
            st.steps += 1;
          }
        }
        const id = str(m.id) ? m.id : "";
        if (id && seen.has(id)) continue;
        if (id) { seen.add(id); st.ids.push(id); if (st.ids.length > 32) st.ids.shift(); }
        if (real) st.laps += 1;
        st.out = Math.min(MAX_TOK, st.out + tokN(u.output_tokens));
      }
    }
  } catch { return undefined; /* 没有这个文件 */ } finally {
    if (fd !== undefined) try { closeSync(fd); } catch { /* ignore */ }
  }
  if (cacheFile && st.off !== start) {
    try {
      const tmp = `${cacheFile}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(st), { mode: 0o600 });
      renameSync(tmp, cacheFile);
    } catch { /* 写不了：下次从头读 */ }
  }
  const title = st.custom || st.ai;
  if (!st.ctx && !st.out && !st.laps && !title) return undefined;
  return { ctx: st.ctx, out: st.out, laps: st.laps, steps: st.steps, ...(title ? { title } : {}), ...(title && title !== titleBefore ? { titleNew: /** @type {true} */ (true) } : {}) };
}

/** 读到哪里的记录：数据目录下 usage/<哈希后的会话编号>.json，只在本机 @param {string} dir @param {string} sid */
function usageCacheFile(dir, sid) {
  const d = join(dir, "usage");
  try { mkdirSync(d, { recursive: true }); } catch { /* ignore */ }
  return join(d, `${sid}.json`);
}

/** 删掉 30 天没动过的：会话结束不删（--resume 沿用原来的会话编号） @param {string} dir */
function pruneUsageCache(dir) {
  const d = join(dir, "usage"), old = Date.now() - 30 * 86400_000;
  try {
    for (const f of readdirSync(d)) {
      try { if (statSync(join(d, f)).mtimeMs < old) unlinkSync(join(d, f)); } catch { /* ignore */ }
    }
  } catch { /* 还没有 */ }
}

/** 邀请链接里的密钥（k= 后面 43 个字符） */
const KEY_IN_TEXT = /(\bk=)[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/g;

/**
 * 把 hook 数据里出现的邀请密钥抹掉（换成 k=…）。接入、换群时那几行命令、粘进来的邀请链接、回答里复述的链接都带着
 * 新群的密钥：不抹掉的话，档位 2 会把它（用旧群的密钥加密）发给旧群，旧群的人就能拿它进新群。没有就原样返回
 * @param {any} hook @returns {any}
 */
export function scrubKeys(hook) {
  let text;
  try { text = JSON.stringify(hook); } catch { return hook; }
  if (!text || text.search(KEY_IN_TEXT) < 0) return hook;
  return JSON.parse(text.replace(KEY_IN_TEXT, "$1…"));
}

/**
 * 从原始 hook 数据挑出允许的字段，重新拼一条事件。返回 null 表示这条不发。
 * 这是白名单：下面没写到的字段一律不出去，Claude Code 以后新增的字段默认也不会被传出去。
 * 附件按档位附上：本机是明文（detail、detail_full），非本机用 ctx.key 加密（enc、enc_full），没有 key 就不附。
 * @param {any} hook 原始 hook 数据
 * @param {{ salt: string, level: Level, local?: boolean, key?: Buffer, gid?: string, me?: string, projectDir?: string, now?: number,
 *           readModel?: (path: unknown) => string | undefined,
 *           readUsage?: (path: unknown, sid: string) => { ctx: number, out: number, laps?: number, steps?: number, title?: string, titleNew?: true } | undefined }} ctx
 * @returns {OutEvent | null}
 */
export function buildEvent(hook, ctx) {
  if (!hook || typeof hook !== "object") return null;
  hook = scrubKeys(hook);
  const name = hook.hook_event_name;
  if (!EVENT_NAMES.includes(name) || !str(hook.session_id)) return null;
  const H = (/** @type {string} */ v) => hash16(ctx.salt, v);
  const dir = str(ctx.projectDir) ? ctx.projectDir : str(hook.cwd) ? hook.cwd : "";

  /** @type {OutEvent} */
  const out = {
    v: PROTOCOL_VERSION, level: ctx.level, ev: name, ts: Math.floor(ctx.now ?? Date.now()),
    sid: H(hook.session_id), proj: H(normDir(dir)),
  };
  if (str(hook.agent_id)) out.agent = H(hook.agent_id);
  if (str(hook.prompt_id)) out.prompt = H(hook.prompt_id);
  if (str(hook.tool_use_id)) out.tool = H(hook.tool_use_id);
  if (TOOL_EVENTS.has(name)) out.kind = toolKind(hook.tool_name);
  if ((name === "PostToolUse" || name === "PostToolUseFailure") && typeof hook.duration_ms === "number"
      && isFinite(hook.duration_ms) && hook.duration_ms >= 0) out.duration_ms = Math.min(1e9, Math.round(hook.duration_ms));
  if (name === "PostToolUseFailure" && hook.is_interrupt === true) out.interrupt = true;
  if (name === "SessionStart" && SESSION_SOURCES.includes(hook.source)) out.source = hook.source;
  if (name === "SessionStart" || name === "Stop") {
    if (typeof hook.model === "string" && hook.model.length <= 80 && MODEL_RE.test(hook.model)) out.model = hook.model;
    else if (ctx.readModel) { const mdl = ctx.readModel(hook.transcript_path); if (mdl) out.model = mdl; }
  }
  /** 对话的标题（会话记录里 Claude Code 起的）：附件，下面按档位附上 @type {string} */
  let title = "";
  if ((name === "SessionStart" || name === "Stop" || name === "PostToolBatch" || name === "UserPromptSubmit") && !out.agent && ctx.readUsage) {
    const u = ctx.readUsage(hook.transcript_path, out.sid);
    // token 数：只是两个数，和模型名一样原样发
    if (u && name !== "UserPromptSubmit") { if (u.ctx) out.ctx_tok = u.ctx; if (u.out) out.out_tok = u.out; }
    // 记录里已有的圈数、步数：也只是两个数。每圈结束时不带（那时记录里有正在跑的这一圈，服务器只在没有圈在跑时用它）
    if (u && name !== "PostToolBatch") { if (u.laps) out.laps = u.laps; if (u.steps) out.steps = u.steps; }
    // 标题：会话开始、每次提问、每次回答完都带上（服务器重启过也能补回来）；每一圈结束时只在它变了的时候带
    if (u && u.title && (name !== "PostToolBatch" || u.titleNew)) title = u.title;
  }
  if (name === "Notification" && NOTIFICATION_TYPES.includes(hook.notification_type)) out.ntype = hook.notification_type;
  if (name === "Stop") out.bg = Array.isArray(hook.background_tasks) ? Math.min(1000, hook.background_tasks.length) : 0;
  if (name === "StopFailure") out.err_kind = errorKind(hook.error);
  if (name === "SubagentStart" || name === "SubagentStop") {
    const t = str(hook.agent_type) ? hook.agent_type : "";
    if (t) {
      out.agent_type = BUILTIN_AGENT_TYPES.includes(t) ? t : "custom";
      out.agent_type_h = H("agent-type:" + t);
    }
  }
  if (name === "PreToolUse" && out.kind === "agent" && !out.agent) {
    // 派子 agent：对要派的类型算同样的哈希，服务器用它把起来的子 agent 配对到这一次派遣上。没写类型就是 general-purpose
    const inp = hook.tool_input && typeof hook.tool_input === "object" ? hook.tool_input : {};
    const t = str(inp.subagent_type) ? inp.subagent_type : "general-purpose";
    out.agent_type = BUILTIN_AGENT_TYPES.includes(t) ? t : "custom";
    out.agent_type_h = H("agent-type:" + t);
  }
  if (name === "UserPromptSubmit") {
    // 输入的话只留一个布尔值：是不是后台任务（或后台子 agent）跑完的通知
    const p = typeof hook.prompt === "string" ? hook.prompt.trimStart() : "";
    out.task_note = p.startsWith("<task-notification") || p.startsWith("<agent-message");
  }
  // ---- 附件
  if (ctx.level >= 1 && (ctx.local || ctx.key)) {
    const dctx = { me: ctx.me, projectDir: ctx.projectDir, taskNote: out.task_note === true };
    const slots = slotsOf(out, ctx.gid);
    const small = slots.small ? smallDetail(hook, name, dctx) : null;
    const full = ctx.level >= 2 && slots.full ? fullDetail(hook, name, dctx) : undefined;
    if (ctx.local) {
      if (small) out.detail = small;
      if (full !== undefined) out.detail_full = full;
    } else if (ctx.key) {
      if (small && slots.small) out.enc = seal(ctx.key, small, aadOf(slots.small.slot, slots.small.sid, slots.small.k));
      if (full !== undefined && slots.full) out.enc_full = seal(ctx.key, full, aadOf(slots.full.slot, slots.full.sid, slots.full.k));
    }
    // 每次提问补发名片（和 SessionStart 的小附件同一个槽、同样的内容）：会话开始那条事件没送到时
    // （服务器重启过、会话中途才设好插件），项目名和星系名靠它补上。子 agent 的事件不带
    if (name === "UserPromptSubmit" && !out.agent) {
      const card = smallDetail(hook, "SessionStart", dctx);
      if (card && ctx.local) out.card = card;
      else if (card && ctx.key) out.enc_card = seal(ctx.key, card, aadOf("card", ctx.gid ?? "", out.proj));
    }
    // 对话的标题：槽 title，键为空（一个会话只有一个标题）
    const t = title ? fitSmall({ label: title }) : null;
    if (t && ctx.local) out.title = t;
    else if (t && ctx.key) out.enc_title = seal(ctx.key, t, aadOf("title", out.sid, ""));
  }
  if (ctx.local && ctx.level === 2) {
    const text = JSON.stringify(hook);
    out.raw = text.length > RAW_MAX_BYTES ? clipDeep(hook, 2000) : hook;
  }
  return out;
}

// ---- 身份

/**
 * 第一次运行时生成安装密钥和本机的盐。同时触发的几个 hook 进程可能一起来建：
 * 先写临时文件再用硬链接放到位（已存在就失败），保证谁也读不到写了一半的文件。
 * @param {string} dir
 * @returns {{ secret: string, salt: string }}
 */
export function loadIdentity(dir) {
  const file = join(dir, "identity.json");
  const read = () => {
    const d = JSON.parse(readFileSync(file, "utf8"));
    if (!/^[0-9a-f]{64}$/.test(d.secret) || !/^[0-9a-f]{32}$/.test(d.salt)) throw new Error("bad identity");
    return { secret: d.secret, salt: d.salt };
  };
  try { return read(); } catch { /* 还没有，或者正被别人写 */ }
  mkdirSync(dir, { recursive: true });
  const fresh = { secret: randomBytes(32).toString("hex"), salt: randomBytes(16).toString("hex") };
  const body = JSON.stringify(fresh) + "\n";
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    writeFileSync(tmp, body, { mode: 0o600 });
    try {
      linkSync(tmp, file);
      return fresh;
    } catch (e) {
      if (/** @type {any} */ (e).code !== "EEXIST") {
        // 文件系统不支持硬链接：退回独占创建
        try {
          const fd = openSync(file, "wx", 0o600);
          writeSync(fd, body); closeSync(fd);
          return fresh;
        } catch { /* 别人先建好了 */ }
      }
    }
  } finally {
    try { unlinkSync(tmp); } catch { /* ignore */ }
  }
  // 别人先建好了：读它的。独占创建的那条路可能还没写完，稍等再读
  for (let i = 0; i < 20; i++) {
    try { return read(); } catch { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25); }
  }
  return read();
}

/** 插件数据目录：hook 里是 CLAUDE_PLUGIN_DATA；拿不到时（命令正文里的 ${CLAUDE_PLUGIN_DATA} 没被替换）用同一个目录 */
export function dataDir() {
  const env = process.env.CLAUDE_PLUGIN_DATA;
  return env && !env.startsWith("${") ? env : installedDataDir();
}

/**
 * 插件设置。Claude Code 以 CLAUDE_PLUGIN_OPTION_<KEY> 传进来；没设过时什么都不传（docs/step0-findings.md 第 7 项）。
 *   server_url：本机地址，或者一条邀请链接（https://<服务器>/#k=<K>）
 *   share：auto（默认）、anonymous、summary、full
 *   name：星系的名字，空着就用自动生成的星表编号
 * @param {Record<string, string | undefined>} [env]
 */
export function settings(env = process.env) {
  const opt = (/** @type {string} */ k) => { const v = (env[`CLAUDE_PLUGIN_OPTION_${k}`] || "").trim(); return v && !v.startsWith("${") ? v : ""; };
  return { target: parseTarget(opt("SERVER_URL")), share: opt("SHARE"), me: opt("NAME").slice(0, 40) };
}

/**
 * 把 server_url 拆成服务器地址和邀请链接里的 K。#k= 之后的部分只在本机用，不会发给服务器
 * @param {string} v @returns {{ url: string, k: string | null }}
 */
export function parseTarget(v) {
  const raw = (v || "").trim() || DEFAULT_SERVER_URL;
  const hash = raw.indexOf("#");
  const base = (hash >= 0 ? raw.slice(0, hash) : raw).replace(/\/+$/, "");
  const m = hash >= 0 ? /(?:^|[#&])k=([A-Za-z0-9_-]+)/.exec(raw.slice(hash)) : null;
  return { url: base || DEFAULT_SERVER_URL, k: m ? m[1] : null };
}

/** userConfig 的 server_url 里的服务器地址（不含 #k=）；没设过就用默认的本机地址 */
export function serverUrl(env = process.env) {
  return settings(env).target.url;
}

/**
 * 记下最近一次用的 server_url，给 /galaxy 用：server_url 是敏感设置（邀请链接里有密钥），存在系统的凭据存储里，
 * 命令正文里拿不到（docs/step0-findings.md）。文件在插件数据目录里，权限 0600，和安装密钥放在一起。变了才写
 * @param {string} dir @param {string} value
 */
export function rememberTarget(dir, value) {
  const file = join(dir, "server.json");
  try { if (JSON.parse(readFileSync(file, "utf8")).server_url === value) return; } catch { /* 还没有 */ }
  try {
    mkdirSync(dir, { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ server_url: value }) + "\n", { mode: 0o600 });
    renameSync(tmp, file);
  } catch { /* 写不了：/galaxy 退回默认地址 */ }
}

/** @param {string} dir @returns {string} */
function rememberedTarget(dir) {
  try { const v = JSON.parse(readFileSync(join(dir, "server.json"), "utf8")).server_url; return typeof v === "string" ? v : ""; } catch { return ""; }
}

// ---- 退出星系群（/agent-loop:leave）
//
// server_url 是敏感设置，命令里改不了它。所以退出是在插件数据目录里记一笔（left.json，存星系群编号），
// 每个 hook 发送前都看：目标是退出过的群就不发。这样所有窗口里的会话立刻都停，不用重载；
// 改设置以前开的旧会话拿着旧的邀请链接，也不会把星系又带回群里。想回去用 /agent-loop:rejoin。

const LEFT_MAX = 20;

/** 退出过的星系群编号 @param {string} dir @returns {string[]} */
export function leftGroups(dir) {
  try {
    const g = JSON.parse(readFileSync(join(dir, "left.json"), "utf8")).groups;
    return Array.isArray(g) ? g.filter(x => typeof x === "string" && /^[0-9a-f]{32}$/.test(x)) : [];
  } catch { return []; }
}

/** 记下（on）或者去掉（!on）一个退出过的星系群 @param {string} dir @param {string} group @param {boolean} on */
export function markLeft(dir, group, on) {
  const now = leftGroups(dir).filter(g => g !== group);
  if (on) now.push(group);
  const file = join(dir, "left.json");
  mkdirSync(dir, { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ groups: now.slice(-LEFT_MAX) }) + "\n", { mode: 0o600 });
  renameSync(tmp, file);
}

/** 星系群的指纹：编号开头 16 个字符，四个一组（和页面上的一样，用来核对是哪个群） @param {string} group */
export const fingerprint = group => (group.slice(0, 16).match(/.{1,4}/g) ?? []).join(" ");

/** 告诉服务器这个星系退出了（只能移走自己）。返回 HTTP 状态码，连不上返回 "unreachable"
 *  @param {string} url @param {string} secret @param {string} access */
export async function sendLeave(url, secret, access) {
  try {
    const res = await fetch(url + "/v1/leave", {
      method: "POST", headers: { authorization: `Bearer ${secret}`, "x-group": access, "x-agent-loop-plugin": PLUGIN_VERSION },
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    await res.arrayBuffer().catch(() => {});
    return res.status;
  } catch { return "unreachable"; }
}

/**
 * /agent-loop:leave 和 /agent-loop:rejoin。输出会进对话、发给模型：只有服务器地址和指纹，不带密钥
 * @param {"leave" | "rejoin"} what @param {string} dir @param {string} value server_url 的值
 * @returns {Promise<string>}
 */
export async function leaveOrRejoin(what, dir, value) {
  const target = parseTarget(value);
  const keys = target.k ? deriveKeys(target.k) : null;
  const how = "To report to this computer instead, set server_url back to http://127.0.0.1:4317 with /plugin configure agent-loop@agent-loop.";
  if (isLocal(target.url) || !keys) return `Not in a galaxy group: server_url is ${target.url}${target.k ? " (with an incomplete invite link)" : ""}. Nothing to ${what === "leave" ? "leave" : "rejoin"}.`;
  const fp = fingerprint(keys.group), left = leftGroups(dir).includes(keys.group);
  if (what === "rejoin") {
    if (!left) return `Already in galaxy group ${fp} on ${target.url}: this computer is reporting to it.`;
    markLeft(dir, keys.group, false);
    return `Rejoined galaxy group ${fp} on ${target.url}. Your galaxy shows up again with the next step in any session.`;
  }
  markLeft(dir, keys.group, true);
  const status = await sendLeave(target.url, loadIdentity(dir).secret, keys.access);
  const server = status === 204 ? "Your galaxy was removed from the group on the server, together with the full step details stored there."
    : `The server could not be told (${status === "unreachable" ? "unreachable" : `HTTP ${status}`}); your galaxy stays visible in the group until its sessions time out on the server (shown as possibly closed after 30 minutes, gone within about 2 hours). Run /agent-loop:leave again once the server is reachable to remove it right away.`;
  return `Left galaxy group ${fp} on ${target.url}. No session on this computer reports to it any more (no reload needed). ${server}\n` +
    `server_url still holds the invite link. ${how} To rejoin this group later, run /agent-loop:rejoin. Browsers that opened the invite link can still watch the group until they leave it on the page.`;
}

// ---- 换过群：旧设置的会话不再发（moved.json）
//
// 接入命令（--welcome）把 server_url 换成新的邀请链接，可已经开着的会话（包括跑这条命令的这个）在 /reload-plugins 以前
// 拿的还是旧值：它们的 hook 照样拿同一个安装密钥报给旧群，服务器每收到一条就把星系在两个群之间搬一次，还会把 server.json
// 改回旧链接。所以 --welcome 把旧的目标记下来，拿着它的 hook 不发、不记地址。
// 新开的会话（SessionStart 的 startup）拿的一定是当前的设置：它还是旧值，说明用户又改回去了，去掉记号照常发。

const MOVED_MAX = 20;

/** 一个目标的记号：星系群用群编号，别的用地址 @param {{ url: string, k: string | null }} target */
export function targetKey(target) {
  const keys = target.k ? deriveKeys(target.k) : null;
  return keys ? `g:${keys.group}` : `u:${target.url}`;
}

/** 换走了的目标（targetKey） @param {string} dir @returns {string[]} */
export function movedFrom(dir) {
  try {
    const g = JSON.parse(readFileSync(join(dir, "moved.json"), "utf8")).from;
    return Array.isArray(g) ? g.filter(x => typeof x === "string" && x.length <= 400) : [];
  } catch { return []; }
}

/** 记下（on）或者去掉（!on）一个换走了的目标。没变就不写 @param {string} dir @param {string} key @param {boolean} on */
export function markMoved(dir, key, on) {
  const was = movedFrom(dir);
  if (was.includes(key) === on) return;
  const now = was.filter(g => g !== key);
  if (on) now.push(key);
  const file = join(dir, "moved.json");
  mkdirSync(dir, { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ from: now.slice(-MOVED_MAX) }) + "\n", { mode: 0o600 });
  renameSync(tmp, file);
}

/**
 * 这个 hook 拿的是换走了的旧设置：返回 true 表示不发。新开的会话拿着它时去掉记号（见上）
 * @param {string} dir @param {{ url: string, k: string | null }} target @param {any} hook
 */
export function staleTarget(dir, target, hook) {
  const key = targetKey(target);
  if (!movedFrom(dir).includes(key)) return false;
  if (hook && hook.hook_event_name === "SessionStart" && hook.source === "startup") {
    try { markMoved(dir, key, false); } catch { /* 写不了：这次照常发 */ }
    return false;
  }
  return true;
}

/** 旧设置的会话里说话、/clear 时提示一行。不带密钥 @param {string} url */
export const staleMessage = url =>
  `Agent Loop: this session still has the old server_url (${url}) from before you joined another galaxy group, so it is not reporting. Run /reload-plugins to switch it over. (If you switched back to ${url} on purpose, open a new session.)`;

// ---- 上报不出去时告诉用户
//
// 异步 hook 失败时 Claude Code 什么都不显示（docs/step0-findings.md），设错了 server_url 的人只会觉得「装了没用」。
// 所以每次发送后把结果记进 status.json（变了才写），会话开始时检查设置和上次的结果，有问题就在 Claude Code 里提示一行。

/**
 * 记下这次发送的结果。status：HTTP 状态码，或者 "unreachable"（连不上、超时）
 * @param {string} dir @param {string} url 服务器地址（不含 #k=） @param {number | "unreachable"} status
 */
export function recordStatus(dir, url, status) {
  const file = join(dir, "status.json");
  try { const d = JSON.parse(readFileSync(file, "utf8")); if (d.url === url && d.status === status) return; } catch { /* 还没有 */ }
  try {
    mkdirSync(dir, { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ url, status }) + "\n", { mode: 0o600 });
    renameSync(tmp, file);
  } catch { /* 写不了就算了 */ }
}

/** @param {string} dir @returns {{ url: string, status: number | "unreachable" } | null} */
export function lastStatus(dir) {
  try {
    const d = JSON.parse(readFileSync(join(dir, "status.json"), "utf8"));
    return typeof d.url === "string" && (typeof d.status === "number" || d.status === "unreachable") ? d : null;
  } catch { return null; }
}

/** 插件要的最低 Node 版本（自带的 fetch、AbortSignal.timeout） */
export const MIN_NODE = 18;
/**
 * Node 太旧：fetch 不存在，每次发送都会失败，却会被记成「连不上服务器」。会话开始时直接说清楚
 * @param {string} version process.versions.node @returns {string | null}
 */
export function nodeProblem(version) {
  const major = Number(String(version).split(".")[0]);
  return major >= MIN_NODE ? null : `Agent Loop is not reporting: it needs Node.js ${MIN_NODE} or newer, but \`node\` here is ${version}. Install a newer Node.js, then start a new session.`;
}

/** server_url 是不是以 http:// 或 https:// 开头 @param {string} url */
export const hasScheme = url => /^https?:\/\//i.test(url);

/**
 * 设置或者上次的发送有没有问题。没问题返回 null；有问题返回给用户看的一行字（英文，和插件别的输出一样）。
 * 这行字会显示在 Claude Code 里，也可能进对话：不能带密钥
 * @param {{ url: string, k: string | null }} target @param {{ url: string, status: number | "unreachable" } | null} last
 * @param {string[]} [left] 退出过的星系群编号（leftGroups）
 */
export function reportProblem(target, last, left = []) {
  const { url, k } = target;
  const fix = "Paste the whole invite link (…/#k=…) into the Agent Loop plugin's server_url setting, then run /reload-plugins.";
  // 漏了 http://：不替人补（补错成 http:// 会把口令明文发出去），照实说
  if (!hasScheme(url)) return `Agent Loop is not reporting: server_url must start with http:// or https:// (it is "${url}"). ${fix}`;
  if (!isLocal(url)) {
    if (!k) return `Agent Loop is not reporting: server_url points to ${url} but has no group key. ${fix}`;
    const keys = deriveKeys(k);
    if (!keys) return `Agent Loop is not reporting: the invite link in server_url is incomplete (the key after #k= must be 43 characters). ${fix}`;
    if (left.includes(keys.group)) {
      return `Agent Loop is not reporting: you left galaxy group ${fingerprint(keys.group)} with /agent-loop:leave. To report to this computer, set server_url back to http://127.0.0.1:4317 with /plugin configure agent-loop@agent-loop; to rejoin, run /agent-loop:rejoin.`;
    }
  }
  // 上次的结果只对同一个地址算数：换过地址就等下一次发送
  if (!last || last.url !== url) return null;
  const s = last.status;
  if (s === "unreachable") {
    return isLocal(url)
      ? `Agent Loop could not reach ${url} last time. To watch on this computer, run \`npx agent-loop\`. To join a galaxy group instead, paste its invite link (…/#k=…) into the plugin's server_url setting.`
      : `Agent Loop could not reach ${url} last time. Check that the server is running and reachable from this computer.`;
  }
  if (s === 401 || s === 403) return `Agent Loop: ${url} refused the reports (HTTP ${s}). The invite link may be wrong, or this server only accepts certain galaxy groups. ${fix}`;
  if (s === 400) return `Agent Loop: ${url} rejected the reports (HTTP 400). The plugin and the server may be different versions: update the plugin.`;
  return null;
}

// ---- 第一次接上一个星系群时，让 Claude 跟用户讲清楚
//
// 页面上发给 Claude Code 的那段话只有一两句（装插件、提醒重载），说明都在这里：插件生效以后，用户在新接上的
// 星系群里第一次说话时（同步的 UserPromptSubmit hook，会话开始时 Claude 还不会开口），把这段作为上下文交给 Claude，
// 让它顺带讲一遍会分享什么、怎么加密，问要不要改名字和分享多少。每个星系群只讲一次，记在插件数据目录的 hello.json 里。
// 这段会进对话、发给模型：只有服务器地址和指纹，不带密钥

const HELLO_MAX = 20;
export const PLUGIN_REPO = "https://github.com/sacryu/agent-loop-plugin";

/** 讲过的星系群编号 @param {string} dir @returns {string[]} */
export function helloGroups(dir) {
  try {
    const g = JSON.parse(readFileSync(join(dir, "hello.json"), "utf8")).groups;
    return Array.isArray(g) ? g.filter(x => typeof x === "string" && /^[0-9a-f]{32}$/.test(x)) : [];
  } catch { return []; }
}

/** 每一档分享的内容（给 Claude 讲用），按 shareLevel 的 0、1、2 */
const SHARE_WHAT = [
  ["anonymous", "only anonymous categories and timings (which kind of tool, how long each step took)"],
  ["summary", "the project folder name, session titles, each step's tool and target (file name, start of the command, search terms), the first line of errors and the last sentence of each answer; no full inputs or outputs"],
  ["full", "everything in summary, plus the full prompts, complete tool inputs and outputs, and complete answers"],
];

/**
 * 记下这个星系群讲过了。已经讲过、记不下来（记不下来就不讲：不然每句话都讲一遍）返回 false
 * @param {string} dir @param {string} group
 */
function claimHello(dir, group) {
  const done = helloGroups(dir);
  if (done.includes(group)) return false;
  try {
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "hello.json"), tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ groups: [...done, group].slice(-HELLO_MAX) }) + "\n", { mode: 0o600 });
    renameSync(tmp, file);
    return true;
  } catch { return false; }
}

/**
 * 讲的内容：几条要点（英文，交给 Claude 用用户的语言讲）。不带密钥
 * @param {string} url @param {string} share @param {string} me
 */
function helloPoints(url, share, me) {
  const [level, what] = SHARE_WHAT[shareLevel(share, isLocal(url))];
  return [
    "- What it is: Agent Loop draws running Claude Code sessions as a galaxy (each session a planet, each tool call a ray), and people in the group can see each other's.",
    `- What is shared now (share = ${share || "auto"}, which means ${level} for this server): ${what}.`,
    "- Encryption: apart from anonymous categories and timings, everything is encrypted (AES-256-GCM) with the key in the invite link. The key never goes to the server, so the server can't read it; only people with the link can.",
    `- Permissions: the plugin is only hooks plus 3 slash commands. Its hook script picks allowed fields out of each event and sends them; it doesn't change any code and has no dependencies. Source: ${PLUGIN_REPO}`,
    `- Ask whether they want to change their name in the group (now: ${me ? JSON.stringify(me) : "an auto-generated catalog number like ALC 1342+27"}) or how much to share (auto, anonymous, summary, full). Change nothing unless they ask. To change, pipe a JSON with only the keys to change into \`claude plugin configure agent-loop@agent-loop --values-stdin\`, for example {"name":"Alice"} or {"share":"anonymous"}, then remind them to run /reload-plugins.`,
    "- /agent-loop:galaxy opens their galaxy in the browser; /agent-loop:leave takes them out of the group.",
  ];
}

/**
 * 要不要讲、讲什么。不在星系群里、设置有问题、退出过、讲过：返回 null。要讲时先记下来（同时开着的几个会话只讲一次）
 * @param {string} dir @param {{ url: string, k: string | null }} target @param {string} share @param {string} me
 * @returns {string | null}
 */
export function helloContext(dir, target, share, me) {
  if (!hasScheme(target.url) || isLocal(target.url) || !target.k) return null;
  const keys = deriveKeys(target.k);
  if (!keys || leftGroups(dir).includes(keys.group) || !claimHello(dir, keys.group)) return null;
  return [
    `The Agent Loop plugin just connected this computer to galaxy group ${fingerprint(keys.group)} on ${target.url}. This note appears only once.`,
    "Deal with the user's message as usual. In the same reply, add a short note in the user's language (a few lines, no headings) that covers:",
    ...helloPoints(target.url, share, me),
  ].join("\n");
}

// ---- 接入：页面上发给 Claude Code 的那段话的最后一行（--welcome）
//
// 装插件、设好邀请链接以后，hook 要等用户执行 /reload-plugins（或开新会话）才生效，而 Claude 执行不了斜杠命令。
// 所以那段话最后让 Claude 直接跑一次这个脚本（从插件市场的目录，路径是固定的）：
//   - 把正在跑的这个会话（Claude Code 给 Bash 的 CLAUDE_CODE_SESSION_ID）作为一次 SessionStart 报上去：星系马上出现，
//     用的是和 hook 一样的安装密钥、盐、项目目录（从会话记录里读），重载以后 hook 发来的事件接着画在同一颗行星上
//   - 带着密钥在浏览器里打开自己的星系（&welcome：页面飞进去，弹一张欢迎卡片）
//   - 把说明（和第一次说话时 hook 交给 Claude 的同一份要点）打印出来交给 Claude，并记下讲过了，hook 不再讲
// 这个命令不是 hook，拿不到 CLAUDE_PLUGIN_OPTION_*：地址从参数来，share、name 从用户级 settings.json 的 pluginConfigs 读。
// 输出会进对话：不带密钥

export const PLUGIN_ID = "agent-loop@agent-loop";

/** Claude Code 的配置目录 @param {Record<string, string | undefined>} [env] */
export function configDir(env = process.env) {
  return env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
}

/** 插件装好以后 Claude Code 给它的数据目录（hook 里的 CLAUDE_PLUGIN_DATA）：<配置目录>/plugins/data/<插件>-<市场> */
export function installedDataDir(cfg = configDir()) {
  return join(cfg, "plugins", "data", PLUGIN_ID.replace("@", "-"));
}

/** 用户级设置里插件的 share、name（不敏感的设置存在这里，见 docs/step0-findings.md） @param {string} cfg */
export function savedOptions(cfg) {
  try {
    const o = JSON.parse(readFileSync(join(cfg, "settings.json"), "utf8")).pluginConfigs?.[PLUGIN_ID]?.options ?? {};
    return { share: typeof o.share === "string" ? o.share.trim() : "", me: typeof o.name === "string" ? o.name.trim().slice(0, 40) : "" };
  } catch { return { share: "", me: "" }; }
}

/** 装着的插件版本（installed_plugins.json）；没装返回 "" @param {string} cfg */
export function installedVersion(cfg) {
  try {
    const e = JSON.parse(readFileSync(join(cfg, "plugins", "installed_plugins.json"), "utf8")).plugins?.[PLUGIN_ID];
    const v = Array.isArray(e) ? e.find(x => x && typeof x.version === "string")?.version : undefined;
    return typeof v === "string" ? v : "";
  } catch { return ""; }
}

/** a 比 b 旧（只比数字段） @param {string} a @param {string} b */
export function olderThan(a, b) {
  const pa = a.split(".").map(Number), pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) { const x = pa[i] || 0, y = pb[i] || 0; if (x !== y) return x < y; }
  return false;
}

/** 这个会话的记录：<配置目录>/projects/<任意>/<会话编号>.jsonl。找不到返回 "" @param {string} cfg @param {string} sid */
export function findTranscript(cfg, sid) {
  if (!/^[A-Za-z0-9-]{1,80}$/.test(sid)) return "";
  const root = join(cfg, "projects");
  try {
    for (const d of readdirSync(root)) {
      const p = join(root, d, `${sid}.jsonl`);
      try { if (statSync(p).isFile()) return p; } catch { /* 不在这里 */ }
    }
  } catch { /* 没有 projects */ }
  return "";
}

/** 会话启动时的目录（记录里第一个带 cwd 的行）：hook 用的 CLAUDE_PROJECT_DIR 就是它 @param {string} path */
export function transcriptCwd(path) {
  if (!path) return "";
  /** @type {number | undefined} */
  let fd;
  try {
    fd = openSync(path, "r");
    const buf = Buffer.alloc(Math.min(fstatSync(fd).size, 256 * 1024));
    readSync(fd, buf, 0, buf.length, 0);
    for (const line of buf.toString("utf8").split("\n")) {
      if (!line.includes('"cwd"')) continue;
      try { const o = JSON.parse(line); if (str(o.cwd)) return o.cwd; } catch { /* 最后一行可能被截断了 */ }
    }
  } catch { /* 读不了 */ } finally {
    if (fd !== undefined) try { closeSync(fd); } catch { /* ignore */ }
  }
  return "";
}

/**
 * @param {string} value 邀请链接（或者本机地址）
 * @param {{ cfg: string, dir: string, sid: string, cwd: string, open: boolean }} o
 * @returns {Promise<string>} 交给 Claude 的输出
 */
export async function welcome(value, o) {
  try {
    return await setUp(value, o);
  } catch (e) {
    // 读写不了自己的文件（权限、磁盘满、identity.json 坏了）。只说错误码：错误信息里可能带着文件内容（安装密钥）
    const code = e && typeof e === "object" && typeof (/** @type {any} */ (e).code) === "string" ? /** @type {any} */ (e).code : "";
    return `Problem: setting up Agent Loop failed${code ? ` (${code})` : ""} while reading or writing its files in ${o.dir}. ` +
      "Tell the user this in their language: they may need to check that this folder is writable and not damaged. Do not delete anything there and do not run any other command.";
  }
}

const AGAIN = "ask them to copy the whole message for Claude Code from the Invite panel on the galaxy group's page again";

/** @param {string} value @param {{ cfg: string, dir: string, sid: string, cwd: string, open: boolean }} o @returns {Promise<string>} */
async function setUp(value, o) {
  if (!value.trim()) {
    return "Problem: no invite link was given to --welcome (it goes right after --welcome, in quotes).\n" +
      `Tell the user this in their language, and ${AGAIN}. Do not run any other command.`;
  }
  const target = parseTarget(value), keys = target.k ? deriveKeys(target.k) : null, local = isLocal(target.url);
  const problem = nodeProblem(process.versions.node) ?? reportProblem(target, null, []);
  if (problem) {
    return `Problem: ${problem.replace(/^Agent Loop is not reporting: /, "the invite link given to --welcome is not usable: ")}\n` +
      `Tell the user this in their language, and ${AGAIN}. Do not run any other command.`;
  }
  // 插件没装上（安装那一行失败了）：重载以后没有 hook，报上去的这一次也接不上。先别动任何东西
  const have = installedVersion(o.cfg);
  if (!have) {
    return `Problem: the Agent Loop plugin is not installed, so the install line (claude plugin install ${PLUGIN_ID} …) did not work.\n` +
      "Tell the user this in their language, with the error that line printed if there was one. Once the cause is fixed, run the install line and then this line again.";
  }
  if (keys && leftGroups(o.dir).includes(keys.group)) markLeft(o.dir, keys.group, false);   // 退出过这个群又拿邀请回来：就是要回去
  // 换群：已经开着的会话在 /reload-plugins 以前还拿着旧的设置，记下来让它们别再发（见 moved.json）
  const prev = rememberedTarget(o.dir), old = prev ? parseTarget(prev) : null, now = targetKey(target);
  if (old && targetKey(old) !== now) markMoved(o.dir, targetKey(old), true);
  markMoved(o.dir, now, false);
  rememberTarget(o.dir, value);
  const { share, me } = savedOptions(o.cfg);
  const { secret, salt } = loadIdentity(o.dir);
  // 旧群在别的服务器上：告诉它这个星系走了，不用等超时（同一个服务器上，新群收到事件时已经搬过去了）
  const oldKeys = old && old.k ? deriveKeys(old.k) : null;
  if (old && oldKeys && targetKey(old) !== now && old.url !== target.url && hasScheme(old.url) && !isLocal(old.url)) {
    await sendLeave(old.url, secret, oldKeys.access);
  }

  /** @type {number | "unreachable" | null} */
  let status = null;
  if (o.sid) {
    const transcript = findTranscript(o.cfg, o.sid), cwd = transcriptCwd(transcript) || o.cwd;
    const hook = { hook_event_name: "SessionStart", session_id: o.sid, source: "resume", cwd, ...(transcript ? { transcript_path: transcript } : {}) };
    const ev = buildEvent(hook, {
      salt, level: shareLevel(share, local), local, key: keys?.content, gid: galaxyId(secret), me, projectDir: cwd,
      readModel: modelFromTranscript, readUsage: (p, sid) => usageFromTranscript(p, usageCacheFile(o.dir, sid)),
    });
    if (ev) {
      try { status = await send(target.url, secret, ev, SEND_TIMEOUT_MS * 2, keys?.access); } catch { status = "unreachable"; }
      recordStatus(o.dir, target.url, status);
    }
  }
  const reported = typeof status === "number" && status < 300, ok = status === null || reported;
  const where = keys ? `galaxy group ${fingerprint(keys.group)} on ${target.url}` : target.url;
  // &welcome（页面上「这是你的星系，刚才那个对话已经在这里了」）只在真报上去了时带；没报（拿不到会话编号）就只打开；被拒、连不上不开
  const opened = o.open && ok && openBrowser(`${galaxyUrl(o.dir, value, true)}${reported ? "&welcome" : ""}`);
  const lines = [
    `Agent Loop is set up: this computer reports to ${where}.`,
    `Their galaxy: ${galaxyUrl(o.dir, value, false)}`,
  ];
  if (opened) lines.push(`(opened in the browser${keys ? " with the group key" : ""}; the key is not shown here)`);
  if (!ok) {
    const p = status === "unreachable" ? `could not reach ${target.url}. Check that the server is running and reachable from this computer.`
      : `${target.url} refused the report (HTTP ${status}). The invite link may be wrong or expired.`;
    lines.push(`Problem: ${p}`);
  } else if (o.sid) {
    lines.push("This session is on the map already, but it only starts drawing its steps after the user runs /reload-plugins (Claude can't run it). Sessions that were already open need /reload-plugins too; new sessions report on their own.");
  } else {
    lines.push("Their galaxy shows up once the user runs /reload-plugins (Claude can't run it) and says something; new sessions report on their own.");
  }
  if (olderThan(have, PLUGIN_VERSION)) lines.push(`The installed plugin is ${have}, older than ${PLUGIN_VERSION}: run \`claude plugin update ${PLUGIN_ID}\` now, before /reload-plugins.`);
  if (keys) claimHello(o.dir, keys.group);   // 这里讲过了：第一次说话时 hook 不再讲
  lines.push("",
    "Tell the user, in their language, in a short note (a few lines, no headings): " +
    (opened ? "their galaxy is open in the browser (give the address above as a link)" : "the address of their galaxy above, as a link") +
    (ok ? ", that they should run /reload-plugins now" : ", the problem above and how to fix it") + (keys ? ", and:" : "."),
    ...(keys ? helloPoints(target.url, share, me) : []));
  return lines.join("\n");
}

// ---- 发送

/**
 * @param {string} url @param {string} secret @param {OutEvent} ev @param {number} timeoutMs @param {string} [access] 星系群的口令
 */
export async function send(url, secret, ev, timeoutMs, access) {
  /** @type {Record<string, string>} */
  const headers = { "content-type": "application/json", authorization: `Bearer ${secret}`, "x-agent-loop-plugin": PLUGIN_VERSION };
  if (access) headers["x-group"] = access;
  const res = await fetch(url + "/v1/events", {
    method: "POST", headers, body: JSON.stringify(ev), signal: AbortSignal.timeout(timeoutMs),
  });
  await res.arrayBuffer().catch(() => {});
  return res.status;
}

async function readStdin() {
  /** @type {Buffer[]} */
  const chunks = [];
  for await (const c of process.stdin) chunks.push(/** @type {Buffer} */ (c));
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * 「我的星系」的网址。带着邀请链接的密钥（#k=）时，这条网址发给别人就等于邀请对方
 * @param {string} dir 插件数据目录 @param {string} serverUrlValue server_url 的值（可能是邀请链接）
 * @param {boolean} [withKey] 带不带密钥
 */
export function galaxyUrl(dir, serverUrlValue, withKey = true) {
  const { url, k } = parseTarget(serverUrlValue);
  const id = galaxyId(loadIdentity(dir).secret);
  // &mine：告诉页面这是你自己的星系（别人发来的 #g= 链接没有它，不会被当成你的）
  return `${url}/#${k && withKey ? `k=${k}&` : ""}g=${id}&mine`;
}

/** 用系统的浏览器打开网址（参数直接传给程序，不经过 shell）。失败就算了
 *  Windows 不用 explorer.exe：网址里有 & 时它除了开浏览器，还会多开一个「文档」文件夹窗口；
 *  url.dll 的 FileProtocolHandler 直接交给默认浏览器，不经过 cmd，& 也不用转义
 *  @param {string} url */
function openBrowser(url) {
  try {
    const [cmd, args] = process.platform === "win32" ? ["rundll32.exe", ["url.dll,FileProtocolHandler", url]] : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
    spawn(cmd, args, { detached: true, stdio: "ignore" }).on("error", () => {}).unref();
    return true;
  } catch { return false; }
}

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === "--galaxy") {
    // /galaxy 命令：命令里的 shell 拿不到插件的环境变量，所以数据目录从参数传进来；地址从 hook 记下的 server.json 读
    const dir = args[1] && !args[1].startsWith("${") ? args[1] : dataDir();
    const given = args[2] && !args[2].startsWith("${") ? args[2] : "";
    const target = given || rememberedTarget(dir) || serverUrl();
    // 命令的输出会进对话、发给模型：密钥不能出现在这里。带密钥的网址直接交给浏览器打开
    let out = galaxyUrl(dir, target, false);
    if (parseTarget(target).k && !args.includes("--no-open") && openBrowser(galaxyUrl(dir, target, true))) {
      out += "\n(opened in your browser with the group key; the key is not shown here)";
    }
    const problem = nodeProblem(process.versions.node) ?? reportProblem(parseTarget(target), lastStatus(dir), leftGroups(dir));
    if (problem) out += `\nProblem: ${problem}`;
    await new Promise(r => process.stdout.write(out + "\n", () => r(undefined)));
    return;
  }
  if (args[0] === "--welcome") {
    // 接入（页面上那段话的最后一行）：Claude 在 Bash 里跑，从插件市场的目录。数据目录是插件装好以后 hook 用的那个
    const cfg = configDir(), env = process.env.CLAUDE_PLUGIN_DATA;
    // 链接是第一个不以 -- 开头的参数（--no-open 放在前面也认得）；没有就照实说，不退回本机地址
    const out = await welcome(args.slice(1).find(a => !a.startsWith("--")) ?? "", {
      cfg, dir: env && !env.startsWith("${") ? env : installedDataDir(cfg),
      sid: (process.env.CLAUDE_CODE_SESSION_ID || "").trim(), cwd: process.cwd(), open: !args.includes("--no-open"),
    });
    await new Promise(r => process.stdout.write(out + "\n", () => r(undefined)));
    return;
  }
  if (args[0] === "--leave" || args[0] === "--rejoin") {
    // /agent-loop:leave、/agent-loop:rejoin：和 /galaxy 一样，数据目录从参数传进来，地址从 server.json 读
    const dir = args[1] && !args[1].startsWith("${") ? args[1] : dataDir();
    const given = args[2] && !args[2].startsWith("${") ? args[2] : "";
    const out = await leaveOrRejoin(args[0] === "--leave" ? "leave" : "rejoin", dir, given || rememberedTarget(dir) || serverUrl());
    await new Promise(r => process.stdout.write(out + "\n", () => r(undefined)));
    return;
  }
  const text = await readStdin();
  const hook = JSON.parse(text);
  const { target, share, me } = settings();
  if (args[0] === "--check") {
    // 同步的检查（hooks.json 里 SessionStart、UserPromptSubmit 的第二个 hook）：只读本机的几个小文件，不连网络。
    // 异步 hook 的输出不会显示给用户、也不进上下文，所以这一步必须是同步的。
    // 会话开始时：设置或上次的发送有问题就提示一行（压缩上下文时不重复）。
    // 用户说话时：第一次接上这个星系群，把说明交给 Claude（helloContext）
    // 换过群以后还没 /reload-plugins 的旧会话：说话、/clear 时提示一行（新开的会话不算，见 staleTarget）
    let out = null;
    const dir = dataDir();
    const stale = !(hook.hook_event_name === "SessionStart" && hook.source === "startup") && movedFrom(dir).includes(targetKey(target));
    if (stale) {
      if (hook.source !== "compact") out = { systemMessage: staleMessage(target.url) };
    } else if (hook.hook_event_name === "UserPromptSubmit") {
      // 设置或上次的发送有问题时不讲（会话开始时已经提示过怎么改）
      const bad = nodeProblem(process.versions.node) ?? reportProblem(target, lastStatus(dir), leftGroups(dir));
      const ctx = bad ? null : helloContext(dir, target, share, me);
      if (ctx) out = { hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: ctx } };
    } else if (hook.source !== "compact") {
      const problem = nodeProblem(process.versions.node) ?? reportProblem(target, lastStatus(dir), leftGroups(dir));
      if (problem) out = { systemMessage: problem };
    }
    if (out) await new Promise(r => process.stdout.write(JSON.stringify(out) + "\n", () => r(undefined)));
    return;
  }
  const local = isLocal(target.url);
  const keys = target.k ? deriveKeys(target.k) : null;
  const dir = dataDir();
  const value = (process.env.CLAUDE_PLUGIN_OPTION_SERVER_URL || "").trim();
  // 地址漏了 http://，或者发往别处却没有邀请链接（或者链接坏了）：什么都不发。会话开始时的检查会告诉用户。
  // 这时只在还没记过地址时记一下（新用户设错了，/galaxy 也能照实说出问题）；记过就不动：
  // 改设置以前开的会话还拿着旧值，不能让它把新会话记下的好地址冲掉
  if (!hasScheme(target.url) || (!local && !keys)) { if (!rememberedTarget(dir)) rememberTarget(dir, value); return; }
  // 换过群以后还没 /reload-plugins 的旧会话：不发，也不把旧链接写回 server.json
  if (staleTarget(dir, target, hook)) return;
  rememberTarget(dir, value);
  // 用 /agent-loop:leave 退出过这个星系群：不发（会话开始时的检查会说明）
  if (keys && leftGroups(dir).includes(keys.group)) return;
  const { secret, salt } = loadIdentity(dir);
  const ev = buildEvent(hook, {
    salt, level: shareLevel(share, local), local, key: keys?.content, gid: galaxyId(secret), me,
    projectDir: process.env.CLAUDE_PROJECT_DIR, readModel: modelFromTranscript,
    readUsage: (p, sid) => usageFromTranscript(p, usageCacheFile(dir, sid)),
  });
  if (!ev) return;
  if (ev.ev === "SessionStart" && ev.source === "startup") pruneUsageCache(dir);
  // SessionEnd 的发送超时很短，超时不代表服务器有问题：它的结果不记
  if (ev.ev === "SessionEnd") return void await send(target.url, secret, ev, SESSION_END_TIMEOUT_MS, keys?.access);
  /** @type {number | "unreachable"} */
  let status;
  try { status = await send(target.url, secret, ev, SEND_TIMEOUT_MS, keys?.access); } catch { status = "unreachable"; }
  recordStatus(dir, target.url, status);
}

const isMain = (() => {
  try { return !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href; } catch { return false; }
})();
if (isMain) {
  process.on("uncaughtException", () => { process.exit(0); });
  process.on("unhandledRejection", () => { process.exit(0); });
  // 发完（或失败）就立刻退出：发送超时以后，没连上的 TCP 连接还会让进程多挂一两秒（Windows 上连被拒绝的端口会重试），
  // 同步的 SessionEnd 会因此被 Claude Code 取消
  main().catch(() => {}).finally(() => process.exit(0));
}
