# opencode-workbuddy-ai

English | [简体中文](README.zh-CN.md)

[OpenCode 2](https://opencode.ai) provider plugin for **WorkBuddy AI** — the
international build of Tencent's WorkBuddy desktop agent (`www.workbuddy.ai`).

Sign in once in the browser, then use WorkBuddy AI's plan models (DeepSeek,
GPT, Gemini, GLM, Kimi, MiniMax…) from OpenCode, with tool calls, images and
reasoning levels.

> Not official. It talks to the same internal API WorkBuddy's own desktop app
> uses; it can break whenever Tencent changes that API. Use it for yourself,
> at your own risk.
>
> This is the **international** build only. WorkBuddy China (CodeBuddy /
> `copilot.tencent.com`) is a different product served by different plugins —
> see [Related](#related).

## Requirements

- OpenCode **2.x** (`opencode --version` → `2.0.x`). This plugin uses the V2
  plugin API (`Plugin.define`), so it does **not** load on OpenCode 1.x.
- A WorkBuddy AI account (paid plan, or whatever your Free plan serves).
- Network access to `www.workbuddy.ai`. Behind a proxy, export
  `HTTPS_PROXY` before starting OpenCode.

## Install

Copy the plugin into OpenCode's global plugin directory:

```sh
mkdir -p ~/.config/opencode/plugins
curl -fsSL -o ~/.config/opencode/plugins/workbuddy-ai.js \
  https://raw.githubusercontent.com/Qsd6917/opencode-workbuddy-ai/main/plugins/workbuddy-ai.js
```

Or clone the repo and copy / symlink the file:

```sh
git clone https://github.com/Qsd6917/opencode-workbuddy-ai.git
ln -sf "$PWD/opencode-workbuddy-ai/plugins/workbuddy-ai.js" ~/.config/opencode/plugins/workbuddy-ai.js
```

No `opencode.json` entry is needed: every `.js` / `.ts` file under
`~/.config/opencode/plugins/` is loaded automatically. Restart OpenCode (or
`opencode service restart`) after adding it.

## Sign in

```sh
opencode auth login workbuddy-ai
```

That prints a `https://www.workbuddy.ai/login?...` link. Open it in a browser
and sign in with your WorkBuddy AI account; the terminal finishes on its own
(`◆ Connected to workbuddy-ai`) within 5 minutes. In the TUI you can also run
`/connect` and pick **workbuddy-ai**.

The plugin offers a single sign-in method, **WorkBuddy AI account (browser)**.
WorkBuddy 5.6+ keeps its desktop sign-in encrypted, so reading the desktop
app's token file is not supported on purpose.

## Use

```sh
opencode models | grep workbuddy-ai     # what your plan serves
opencode                                 # then /models and pick workbuddy-ai/*
opencode -m workbuddy-ai/default-model "explain this repo"
opencode -m "workbuddy-ai/glm-5.3#high"  # a reasoning level, where the model has them
```

Make it the default in `~/.config/opencode/opencode.json`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "model": "workbuddy-ai/default-model"
}
```

Models are `workbuddy-ai/<id>`. The list, their context windows, image input
and reasoning levels come from WorkBuddy's own product config (`/v3/config`)
for your account, refreshed every five minutes. Until you sign in — or if that
call fails — a built-in fallback list is used and the provider stays hidden in
pickers, because it needs a connection to be available.

A model that exists twice in the config (WorkBuddy ships e.g.
`deepseek-v4.1-flash` and `deepseek-v4.1-flash-sg` under the same name) is
labelled `Name (SG)` so the two can be told apart.

### Accounts and sign-out

```sh
opencode auth list                     # your saved accounts (label = account uid)
opencode auth logout workbuddy-ai u-1  # give the credential's label
```

The access token is refreshed automatically inside OpenCode, a little before
it expires, and the new token is written back.

## What the plugin does

WorkBuddy's API is OpenAI-compatible chat completions at `www.workbuddy.ai/v2`,
but it only takes requests that look like its own client's:

- **Headers.** `User-Agent: WorkBuddy/5.5.6` (a request without it is refused
  with error 10085), `X-User-Id`, `X-Domain`, `X-IDE-Name`/`X-IDE-Type`/
  `X-IDE-Version`, `X-Product: SaaS`, `X-Agent-Purpose: conversation`,
  `X-Agent-Type: main`, and `X-Enterprise-Id`/`X-Tenant-Id` for team accounts.
- **Conversation ids.** `X-Conversation-ID`, `X-Conversation-Request-ID` and
  `X-Conversation-Message-ID`, derived from the OpenCode session and the user's
  message, so every step of one send (a tool result sent back, a retry) counts
  as one request in WorkBuddy's usage list, and the next message as another.
- **Body spellings.** `max_completion_tokens` → `max_tokens`, `developer` →
  `system`, a system message first, `tool_choice` as WorkBuddy's string form.
- **Tool schemas.** Shapes WorkBuddy's models refuse are mended the way that
  means the same thing: a tuple `items`, a `\0` in a regex `pattern`, an
  `enum` without a `type`, `true`/`false` where a schema goes, a non-object
  root. Tool names with characters WorkBuddy doesn't take (`.`, `:`, `/`,
  spaces, CJK) are sent with `_`, and the model's calls are named back to the
  client's own.
- **Refused words.** WorkBuddy answers "Illegal API invocation from an
  unapproved channel" to chats carrying Codex's or Claude Code's own identity
  lines; the ones known are reworded to say the same thing.
- **Gemini quirk.** `400` code `11153` ("the conversation must end with a user
  message") to a chat whose tool results are followed by the user's message is
  served again with an empty assistant message between them; the model that
  refused is sent that way up front from then on.

All of it is in one file, `plugins/workbuddy-ai.js` (~1000 lines, no
dependencies beyond `@opencode/plugin`).

## Troubleshooting

| Symptom | What to do |
|---|---|
| `workbuddy-ai` missing from `opencode models` | Not signed in, or the credential went bad → `opencode auth login workbuddy-ai` again. |
| `Unable to load plugin` in the log | OpenCode 1.x, or the file wasn't copied to `~/.config/opencode/plugins/`. |
| `10085` | The User-Agent was changed. Keep `WorkBuddy/5.5.6` or whatever the app currently sends. |
| `unapproved channel` | WorkBuddy refused the chat for identity lines the plugin doesn't know yet — try another model, or add the line to `FLAGGED`. |
| `11140` / "account has been restricted" | The account is restricted by WorkBuddy; appeal in the app or use another account. Re-signing in doesn't lift it. |
| `11133 Invalid request parameters` | A tool schema WorkBuddy doesn't take slipped through; open an issue with the MCP/plugin tool that caused it. |
| `Waiting for authorization…` hangs | The browser sign-in wasn't finished, or the network/proxy can't reach `www.workbuddy.ai`. |
| `ECONNRESET` on big chats | WorkBuddy closes the connection on a refused sign-in for bodies over 2 MiB; sign in again and check the token isn't expired. |
| The browser never opens | Nothing tries to open it — click the printed link yourself (works from any machine that can reach the site). |

Run OpenCode with `--print-logs` to see plugin load errors.

## Related

| Want | Use |
|---|---|
| WorkBuddy AI on OpenCode **2** | this plugin |
| WorkBuddy China (CodeBuddy plan) | [`opencode-codebuddy-oauth`](https://www.npmjs.com/package/opencode-codebuddy-oauth) (V2) |
| Both builds, OpenCode **1** | [`@magpie-community/opencode-workbuddy-auth`](https://www.npmjs.com/package/@magpie-community/opencode-workbuddy-auth), [`opencode-tencent-auth`](https://www.npmjs.com/package/opencode-tencent-auth) |
| Other agents (Claude Code, Codex, DSH…) | a local bridge, e.g. [flow-one](https://github.com/9Ashwin/flow-one), [magpie](https://usemagpie.ai) |

## Credit

Ported to OpenCode 2's plugin API from
[`@magpie-community/opencode-workbuddy-auth`](https://github.com/magpie-community/plugins/tree/main/packages/workbuddy)
(MIT): the request shaping, the sign-in flow and the model list are theirs.

## License

MIT — see [LICENSE](LICENSE).
