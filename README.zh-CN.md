# opencode-workbuddy-ai

[English](README.md) | 简体中文

把 **WorkBuddy AI**（腾讯 WorkBuddy 的**国际版**桌面端，`www.workbuddy.ai`）接进
[OpenCode 2](https://opencode.ai) 的 provider 插件。

浏览器登录一次，之后就能在 OpenCode 里用 WorkBuddy AI 套餐的模型（DeepSeek、
GPT、Gemini、GLM、Kimi、MiniMax 等），工具调用、图片输入和推理档位都支持。

> 非官方插件。它调用的是 WorkBuddy 桌面端自己用的内部接口，腾讯一改就可能失效。
> 请自用，风险自负。
>
> **只支持国际版。** WorkBuddy 国内版（CodeBuddy / `copilot.tencent.com`）是另一个
> 产品，有别的插件负责，见 [同类方案](#同类方案)。

## 环境要求

- OpenCode **2.x**（`opencode --version` 输出 `2.0.x`）。本插件用 V2 插件 API
  （`Plugin.define`），在 OpenCode 1.x 上**加载不了**。
- 一个 WorkBuddy AI 账号（付费套餐，或 Free 套餐给什么用什么）。
- 能访问 `www.workbuddy.ai`。走代理的话，启动 OpenCode 前先导出 `HTTPS_PROXY`。

## 安装

把插件放进 OpenCode 的全局插件目录：

```sh
mkdir -p ~/.config/opencode/plugins
curl -fsSL -o ~/.config/opencode/plugins/workbuddy-ai.js \
  https://raw.githubusercontent.com/Qsd6917/opencode-workbuddy-ai/main/plugins/workbuddy-ai.js
```

或者克隆仓库后复制 / 软链：

```sh
git clone https://github.com/Qsd6917/opencode-workbuddy-ai.git
ln -sf "$PWD/opencode-workbuddy-ai/plugins/workbuddy-ai.js" ~/.config/opencode/plugins/workbuddy-ai.js
```

不需要改 `opencode.json`：`~/.config/opencode/plugins/` 下每个 `.js` / `.ts` 文件
都会被自动加载。放好后重启 OpenCode（或 `opencode service restart`）。

## 登录

```sh
opencode auth login workbuddy-ai
```

终端会打印一个 `https://www.workbuddy.ai/login?...` 链接。用浏览器打开，登录你的
WorkBuddy AI 账号，终端会在 5 分钟内自动完成（出现 `◆ Connected to workbuddy-ai`）。
TUI 里也可以 `/connect`，选 **workbuddy-ai**。

插件只提供一种登录方式：**WorkBuddy AI account (browser)**。WorkBuddy 5.6 之后把
桌面端的登录态加密了，所以**故意不支持**直接读桌面 App 的 token 文件。

## 使用

```sh
opencode models | grep workbuddy-ai     # 看你的套餐有哪些模型
opencode                                 # 进去后 /models 选 workbuddy-ai/*
opencode -m workbuddy-ai/default-model "解释一下这个仓库"
opencode -m "workbuddy-ai/glm-5.3#high"  # 带推理档位（该模型支持时）
```

想设为默认，改 `~/.config/opencode/opencode.json`：

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "model": "workbuddy-ai/default-model"
}
```

模型名是 `workbuddy-ai/<id>`。模型列表、上下文长度、是否支持图片、推理档位都来自
你账号的 WorkBuddy 产品配置（`/v3/config`），每五分钟刷新一次。**没登录时**（或这次
拉取失败时）用内置兜底列表，并且 provider 会在选择器里隐藏 —— 因为 OpenCode 认为
没有连接的 provider 不可用。

配置里同名的两个模型（WorkBuddy 就有 `deepseek-v4.1-flash` 和
`deepseek-v4.1-flash-sg` 同叫一个名字）会自动标成 `Name (SG)` 以便区分。

### 账号与退出

```sh
opencode auth list                     # 已保存的账号（label 是账号 uid）
opencode auth logout workbuddy-ai u-1  # 参数是凭据的 label
```

access token 会在过期前由 OpenCode 自动续期，并把新 token 写回凭据库。

## 插件做了什么

WorkBuddy 的接口是 `www.workbuddy.ai/v2` 上的 OpenAI 兼容 chat completions，但它
**只接受长得像它自己客户端**的请求：

- **请求头**：`User-Agent: WorkBuddy/5.5.6`（缺了直接拒，错误码 10085）、`X-User-Id`、
  `X-Domain`、`X-IDE-Name`/`X-IDE-Type`/`X-IDE-Version`、`X-Product: SaaS`、
  `X-Agent-Purpose: conversation`、`X-Agent-Type: main`，企业账号再加
  `X-Enterprise-Id`/`X-Tenant-Id`。
- **会话 ID**：`X-Conversation-ID`、`X-Conversation-Request-ID`、
  `X-Conversation-Message-ID`，由 OpenCode 的 session 和用户消息派生。这样一次发送
  的多步（工具结果回传、重试）在 WorkBuddy 用量页里算作 1 次请求，下一条用户消息算
  另一次。
- **报文写法**：`max_completion_tokens` → `max_tokens`，`developer` → `system`，补上
  首条 system，`tool_choice` 转成 WorkBuddy 要的字符串形式。
- **工具 schema**：WorkBuddy 模型不接受的形状会被改成等价的合法形状 —— 元组式
  `items`、正则 `pattern` 里的 `\0`、没有 `type` 的 `enum`、出现在 schema 位置的
  `true`/`false`、根节点不是 object。工具名里 WorkBuddy 不接受的字符（`.`、`:`、
  `/`、空格、中文）发出去时换成 `_`，模型返回的调用名再还原成客户端的原名。
- **被拒词**：请求里带 Codex / Claude Code 自己身份行时，WorkBuddy 会回
  “Illegal API invocation from an unapproved channel”；已知的几句会被改成同样的意思
  继续放行。
- **Gemini 特例**：工具结果后面跟用户消息的请求，`gemini` 会回 `400` 错误码 `11153`
  （“对话必须以用户消息结尾”）。插件会在两者之间插一条空 assistant 消息重试；之后同一
  模型直接按这种方式发送。

全部在一个文件里：`plugins/workbuddy-ai.js`（约 1000 行，除 `@opencode/plugin`
外无依赖）。

## 排错

| 现象 | 处理 |
|---|---|
| `opencode models` 里没有 `workbuddy-ai` | 没登录，或凭据失效 → 重跑 `opencode auth login workbuddy-ai`。 |
| 日志里 `Unable to load plugin` | 用的是 OpenCode 1.x，或文件没放到 `~/.config/opencode/plugins/`。 |
| `10085` | User-Agent 被改过。保持 `WorkBuddy/5.5.6`，或改成当前客户端实际发送的值。 |
| `unapproved channel` | 请求里含插件还不认识的 Codex/Claude Code 身份行 —— 换个模型试，或把那一行加进 `FLAGGED`。 |
| `11140` / “account has been restricted” | 账号被 WorkBuddy 风控，去 App 里申诉或换号；重新登录解不开。 |
| `11133 Invalid request parameters` | 有工具 schema 没被整形到位；提 issue 时附上引发问题的 MCP / 插件工具。 |
| 卡在 `Waiting for authorization…` | 浏览器那边没登录完，或网络/代理连不上 `www.workbuddy.ai`。 |
| 大对话 `ECONNRESET` | WorkBuddy 对超过 2 MiB 且登录被拒的请求直接断连；重新登录并确认 token 没过期。 |
| 浏览器一直没弹出来 | 插件本身不会去开浏览器 —— 自己点终端里打印的链接即可（任何能访问该站的机器都行）。 |

看插件加载错误：用 `--print-logs` 启动 OpenCode。

## 同类方案

| 想要 | 用什么 |
|---|---|
| WorkBuddy AI + OpenCode **2** | 本插件 |
| WorkBuddy 国内版（CodeBuddy 套餐） | [`opencode-codebuddy-oauth`](https://www.npmjs.com/package/opencode-codebuddy-oauth)（V2） |
| 国内 + 国际，OpenCode **1** | [`@magpie-community/opencode-workbuddy-auth`](https://www.npmjs.com/package/@magpie-community/opencode-workbuddy-auth)、[`opencode-tencent-auth`](https://www.npmjs.com/package/opencode-tencent-auth) |
| 别的 agent（Claude Code、Codex、DSH…） | 本地桥，如 [flow-one](https://github.com/9Ashwin/flow-one)、[magpie](https://usemagpie.ai) |

## 致谢

从 [`@magpie-community/opencode-workbuddy-auth`](https://github.com/magpie-community/plugins/tree/main/packages/workbuddy)
（MIT）移植到 OpenCode 2 的插件 API：报文整形、登录流程、模型列表都来自他们。

## 许可证

MIT —— 见 [LICENSE](LICENSE)。
