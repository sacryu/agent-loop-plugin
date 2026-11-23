# Agent Loop plugin for Claude Code

Draws your Claude Code sessions as planetary systems: every session is a planet, every tool call is a ray whose length is how long it took. This repository holds only the Claude Code plugin; the viewer runs on an Agent Loop server (one on your computer, or a galaxy group server someone invited you to).

[中文说明](#中文)

## Install

**The easy way**: whoever invited you can press **Invite → Copy for Claude Code** on the galaxy group's page and send you a short prompt. Give it to your Claude Code: it adds this marketplace, installs the plugin with your invite link, then runs `report.mjs --welcome` from the plugin. That puts the session you're in on the map right away, opens your own galaxy in the browser, and has Claude explain what the plugin does and sends (see below) and ask whether you want to change `name` and `share`. Run `/reload-plugins` then (Claude can't run it) so that session's steps are drawn; new sessions report on their own. If you opened the invite link first, the page shows you the same prompt.

**By hand**: in a terminal (also when the plugin is already installed: this switches it to the new group):

```sh
claude plugin marketplace add sacryu/agent-loop-plugin
claude plugin install agent-loop@agent-loop --config "server_url=<invite link>"
```

then `/reload-plugins` in Claude Code. The invite link looks like `http(s)://<server>/#k=<key>`.

Typed into your own terminal, that leaves the key in your shell history. To avoid that, install without `--config`, then in Claude Code run `/plugin configure agent-loop@agent-loop`, paste the link into **Server URL or invite link** (the input is masked), choose **Save**, and `/reload-plugins`. (`claude plugin configure` in a terminal only lists the options.)

`/galaxy` opens your own galaxy in the browser. `/agent-loop:status` shows where the plugin reports (server and group fingerprint), whether it is getting through, your galaxy's name and sharing level, and the plugin version.

`/agent-loop:create https://<server>` makes a new galaxy group of your own: the key is generated on your computer, your galaxy is reported to the new group, and only once the server accepts it is the new invite link saved into `server_url` (if the server refuses, your current setting is left alone). The group opens in your browser with the invite link to share; the key never appears in the conversation. Then run `/reload-plugins`. Needs a server on 0.2.11 or newer.

`/agent-loop:leave` takes your galaxy out of its galaxy group: every session on this computer stops reporting to it right away (no reload), and the server removes your galaxy and the step details it holds for you. Your settings still hold the invite link; set **Server URL or invite link** back to `http://127.0.0.1:4317` to report to this computer, or run `/agent-loop:rejoin` to go back. With a server on 0.2.12 or newer, the group's page then opens in your browser: it clears the group's key from that browser and shows that you left. ("Clear cache" under **Invite** on the web page only makes that browser forget the key; it doesn't stop the plugin.)

Needs Node.js 18+ (`node` on your PATH). If the plugin can't report (no key in the link, the link is missing `http://`/`https://`, the server is unreachable or refuses, Node is too old), Claude Code shows a one-line warning when a session starts.

## Settings

| Setting | Default | |
|---|---|---|
| `server_url` | `http://127.0.0.1:4317` | A server on this computer, or an invite link. Stored as a sensitive setting (the system credential store, not `settings.json`) |
| `share` | `auto` | `anonymous`, `summary`, `full`; `auto` is `full` on this computer and `summary` elsewhere |
| `name` | empty | Your name in the galaxy group; empty means an auto-generated catalog number |

Change them with `/plugin configure agent-loop@agent-loop` in Claude Code, or from a terminal by piping just the keys you want to change: `echo '{"name":"Alex","share":"summary"}' | claude plugin configure agent-loop@agent-loop --values-stdin`. Then `/reload-plugins`.

## What leaves your computer

The only script that sends anything is [`plugin/hooks/report.mjs`](plugin/hooks/report.mjs): no dependencies, no build step, readable in one sitting. It builds each event from an allow-list of fields.

| `share` | Sent |
|---|---|
| `anonymous` | Only event categories and timings: when you work, how many sessions, which **kind** of tool each step used, how long it took, the model name, and running totals of laps, steps and tokens (counted from the local transcript). IDs are salted hashes; the salt never leaves your computer |
| `summary` | Plus: galaxy name, project folder name, session title (the one Claude Code generates, read from the local transcript), each step's tool and target (file name, start of the command, search term), first line of errors, last sentence of each answer |
| `full` | Plus: your full prompts, complete tool input and output, complete answers and errors |

Anything beyond anonymous categories and timings is encrypted with AES-256-GCM before it leaves, using a key derived from the invite link (`#k=…`). The part after `#` is never sent to the server, so the server only sees anonymous categories, timings, and ciphertext it cannot read. Without an invite link, nothing is sent to a non-local server. Anyone with the invite link can watch the group and join it: only share it with people you trust.

## License

[MIT](LICENSE)

---

## 中文

Agent Loop 把正在跑的 Claude Code 对话画成行星系：每个对话是一颗行星，每次工具调用是一根射线，长度就是耗时。这个仓库只有 Claude Code 插件；画面在 Agent Loop 服务器上看（你自己电脑上的，或者邀请你加入的星系群服务器）。

**最省事的安装**：邀请你的人在星系群页面上点「邀请」→「复制给 Claude Code 的话」，发给你一段话。把它发给你的 Claude Code：它会加上这个插件市场、带着你的邀请链接装好插件，再跑插件里的 `report.mjs --welcome`。这一步把你正在用的这个会话直接报上去，在浏览器里打开你自己的星系，并让 Claude 讲清楚插件做什么、会发出什么（见下），问你要不要改 `name` 和 `share`。然后执行 `/reload-plugins`（Claude 执行不了），这个会话的每一步就会画出来；新开的会话会自己上报。你先打开了邀请链接的话，页面上也会给出同一段话。

**自己动手安装**：在终端里运行下面两行（插件已经装过也照样运行，会换成新的星系群），再在 Claude Code 里执行 `/reload-plugins`。邀请链接的样子是 `http(s)://<服务器>/#k=<密钥>`。

```sh
claude plugin marketplace add sacryu/agent-loop-plugin
claude plugin install agent-loop@agent-loop --config "server_url=<邀请链接>"
```

在你自己的终端里敲这一行，密钥会留在 shell 历史里。不想这样的话，装的时候不带 `--config`，然后在 Claude Code 里运行 `/plugin configure agent-loop@agent-loop`，把链接粘进 **Server URL or invite link**（输入会被遮住），选 **Save**，再 `/reload-plugins`（终端里的 `claude plugin configure` 只列出选项，填不了）。

**设置**：`server_url` 是本机的服务器或邀请链接；`share` 选分享多少（见下）；`name` 是你在星系群里的名字，空着是自动生成的星表编号。在 Claude Code 里用 `/plugin configure agent-loop@agent-loop` 改，或者在终端里只传要改的项：`echo '{"name":"小王","share":"summary"}' | claude plugin configure agent-loop@agent-loop --values-stdin`，改完 `/reload-plugins`。

`/galaxy` 在浏览器里打开你自己的星系。`/agent-loop:status` 列出报给哪里（服务器和星系群指纹）、发不发得出去、星系名字和分享档位、插件版本。`/agent-loop:create https://<服务器>` 建一个自己的星系群：密钥在你的电脑上生成，先把你的星系报到新群，服务器收下了才把新的邀请链接存进 `server_url`（被拒时原来的设置不动）；浏览器里会打开这个群，邀请链接在那里，不会出现在对话里。之后运行 `/reload-plugins`。服务器要 0.2.11 或更新。`/agent-loop:leave` 退出星系群：这台电脑上的所有会话马上停止往这个群上报（不用重载），服务器也会移走你的星系和存着的你的步骤详情；想回去运行 `/agent-loop:rejoin`，想改回本机就把 **Server URL or invite link** 改回 `http://127.0.0.1:4317`。服务器是 0.2.12 或更新时，退出以后浏览器里会打开这个群的页面：清掉这个浏览器里的群密钥，并显示你已经退出（网页上「邀请」里的「清除缓存」只让那个浏览器忘掉密钥，插件照样上报）。需要 Node.js 18 或更新（`node` 要在 PATH 里）。上报不出去时（链接里没有密钥、地址漏了 `http://`/`https://`、连不上服务器、服务器拒收、Node 太旧），会话开始时 Claude Code 里会提示一行。

**会发出什么**：唯一往外发东西的脚本是 [`plugin/hooks/report.mjs`](plugin/hooks/report.mjs)。`share` 设成 `anonymous` 只发事件的类别和耗时；`summary` 再加星系名、项目目录名、对话标题、每一步的工具和对象、报错第一行、回答最后一句；`full` 再加整句话、工具完整的输入输出和完整的回答。匿名的类别和耗时以外的一切，都用邀请链接里的密钥（`#k=…`）加密（AES-256-GCM）以后再发；`#` 后面的部分不会发给服务器，所以服务器只拿得到匿名的类别、耗时和一段它解不开的密文。拿到邀请链接的人就能看这个星系群、也能加入，只发给你信任的人。
