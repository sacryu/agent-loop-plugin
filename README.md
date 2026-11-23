# Agent Loop plugin for Claude Code

Draws your Claude Code sessions as planetary systems: every session is a planet, every tool call is a ray whose length is how long it took. This repository holds only the Claude Code plugin; the viewer runs on an Agent Loop server (one on your computer, or a galaxy group server someone invited you to).

[中文说明](#中文)

## Install

In a terminal:

```sh
claude plugin marketplace add sacryu/agent-loop-plugin
claude plugin install agent-loop@agent-loop
```

Then, inside Claude Code, open the plugin settings, paste your **invite link** (`http(s)://<server>/#k=<key>`) into **Server URL or invite link** (the input is masked), choose **Save**, and reload:

```
/plugin configure agent-loop@agent-loop
/reload-plugins
```

`/galaxy` opens your own galaxy in the browser.

`/agent-loop:leave` takes your galaxy out of its galaxy group: every session on this computer stops reporting to it right away (no reload), and the server removes your galaxy and the step details it holds for you. Your settings still hold the invite link; set **Server URL or invite link** back to `http://127.0.0.1:4317` to report to this computer, or run `/agent-loop:rejoin` to go back. (Leaving the group on the web page only makes that browser forget the key; it doesn't stop the plugin.)

Needs Node.js 18+ (`node` on your PATH). If the plugin can't report (no key in the link, the link is missing `http://`/`https://`, the server is unreachable or refuses, Node is too old), Claude Code shows a one-line warning when a session starts.

## Settings

| Setting | Default | |
|---|---|---|
| `server_url` | `http://127.0.0.1:4317` | A server on this computer, or an invite link. Stored as a sensitive setting (the system credential store, not `settings.json`) |
| `share` | `auto` | `anonymous`, `summary`, `full`; `auto` is `full` on this computer and `summary` elsewhere |
| `name` | empty | Your name in the galaxy group; empty means an auto-generated catalog number |

## What leaves your computer

The only script that sends anything is [`plugin/hooks/report.mjs`](plugin/hooks/report.mjs): no dependencies, no build step, readable in one sitting. It builds each event from an allow-list of fields.

| `share` | Sent |
|---|---|
| `anonymous` | Only event categories and timings: when you work, how many sessions, which **kind** of tool each step used, how long it took. IDs are salted hashes; the salt never leaves your computer |
| `summary` | Plus: galaxy name, project folder name, session title, each step's tool and target (file name, start of the command, search term), first line of errors, last sentence of each answer |
| `full` | Plus: your full prompts, complete tool input and output, complete answers and errors |

Anything beyond anonymous categories and timings is encrypted with AES-256-GCM before it leaves, using a key derived from the invite link (`#k=…`). The part after `#` is never sent to the server, so the server only sees anonymous categories, timings, and ciphertext it cannot read. Without an invite link, nothing is sent to a non-local server. Anyone with the invite link can watch the group and join it: only share it with people you trust.

## License

[MIT](LICENSE)

---

## 中文

Agent Loop 把正在跑的 Claude Code 对话画成行星系：每个对话是一颗行星，每次工具调用是一根射线，长度就是耗时。这个仓库只有 Claude Code 插件；画面在 Agent Loop 服务器上看（你自己电脑上的，或者邀请你加入的星系群服务器）。

**安装**：在终端里

```sh
claude plugin marketplace add sacryu/agent-loop-plugin
claude plugin install agent-loop@agent-loop
```

然后在 Claude Code 里打开插件设置，把**邀请链接**（`http(s)://<服务器>/#k=<密钥>`）粘进 **Server URL or invite link**（输入会被遮住），选 **Save**，再重载：

```
/plugin configure agent-loop@agent-loop
/reload-plugins
```

`/galaxy` 在浏览器里打开你自己的星系。`/agent-loop:leave` 退出星系群：这台电脑上的所有会话马上停止往这个群上报（不用重载），服务器也会移走你的星系和存着的你的步骤详情；想回去运行 `/agent-loop:rejoin`，想改回本机就把 **Server URL or invite link** 改回 `http://127.0.0.1:4317`（在网页上离开只让那个浏览器忘掉密钥，插件照样上报）。需要 Node.js 18 或更新（`node` 要在 PATH 里）。上报不出去时（链接里没有密钥、地址漏了 `http://`/`https://`、连不上服务器、服务器拒收、Node 太旧），会话开始时 Claude Code 里会提示一行。

**会发出什么**：唯一往外发东西的脚本是 [`plugin/hooks/report.mjs`](plugin/hooks/report.mjs)。`share` 设成 `anonymous` 只发事件的类别和耗时；`summary` 再加星系名、项目目录名、对话标题、每一步的工具和对象、报错第一行、回答最后一句；`full` 再加整句话、工具完整的输入输出和完整的回答。匿名的类别和耗时以外的一切，都用邀请链接里的密钥（`#k=…`）加密（AES-256-GCM）以后再发；`#` 后面的部分不会发给服务器，所以服务器只拿得到匿名的类别、耗时和一段它解不开的密文。拿到邀请链接的人就能看这个星系群、也能加入，只发给你信任的人。
