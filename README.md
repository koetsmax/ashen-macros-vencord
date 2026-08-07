# Ashen Macros ↔ Vencord Bridge

Private **Vencord userplugin** that listens on a localhost WebSocket and drives Discord through webpack modules only (`MessageActions`, `ChannelRouter` / `NavigationRouter`, `ApplicationCommandIndexStore`, `RestAPI`). No DOM scraping, no composer typing.

Ashen Macros (PySide6) remains the brain; this plugin is the hands inside Discord.

## Requirements

- [Vencord built from source](https://docs.vencord.dev/installing/) (custom plugins need a source build)
- Discord Desktop or Vesktop (the WebSocket server runs in `native.ts` via Electron — not available in the browser extension)

## Install

1. Clone this repo (or copy its contents) into your Vencord tree:

```bash
git clone https://github.com/koetsmax/ashen-macros-vencord.git /path/to/Vencord/src/userplugins/ashenMacrosBridge
```

Folder name can be `ashenMacrosBridge` or similar; Vencord loads any `userplugins/*/index.ts`.

2. Rebuild Vencord (`pnpm build` / your usual inject flow) and restart Discord.

3. Enable **AshenMacrosBridge** under Vencord → Plugins.

4. Open plugin settings and set:
   - **Port** — default `47832`
   - **Auth token** — shared secret (change from `change-me`)

5. In Ashen Macros → Settings → **Experimental → Vencord Discord bridge**, enable the bridge and enter the **same port + token**.

## Auth

- Bind address is always `127.0.0.1` (never `0.0.0.0`).
- Shared secret only — **not** your Discord user token and **not** an Ashen API token.
- Authenticate either way:
  1. Query string: `ws://127.0.0.1:47832/?token=YOUR_SECRET`
  2. First JSON message: `{ "id": "1", "type": "auth", "token": "YOUR_SECRET" }`
  3. Or include `"token"` on each request until the socket is marked authenticated

On connect the plugin sends:

```json
{ "type": "hello", "needsAuth": true, "plugin": "AshenMacrosBridge", "version": "0.1.0" }
```

(`needsAuth` is `false` if the query token already matched.)

## Protocol (JSON over WebSocket)

**Request:** `{ "id": string, "type": string, "token"?: string, ...payload }`  
**Response:** `{ "id": string, "ok": boolean, "error"?: string, ...data }`

| `type` | Payload | Notes |
|---|---|---|
| `auth` | `token` | Pair the socket |
| `ping` | — | Round-trip; returns `pong: true` |
| `cancel` | `targetId` / `cancelId` optional | Abort in-flight op(s); omit target to cancel all |
| `react` | `channelId`, `messageId`, `emoji: { name, id? }` or string | `MessageActions.addReaction` |
| `edit` | `channelId`, `messageId`, `content` | `MessageActions.editMessage` |
| `send` | `channelId`, `content` | `MessageActions.sendMessage` |
| `switchChannel` | `channelId`, optional `guildId` | `ChannelRouter.transitionToChannel` (fallback `NavigationRouter`) |
| `messageCommand` | `channelId`, `messageId`, optional `name` (default `"update bonus"`), optional `guildId` | MESSAGE context command via index + `POST /interactions` |
| `slashCommand` | `channelId`, `name`, optional `options: [{ name, type?, value }]`, optional `guildId` | CHAT_INPUT slash via same `/interactions` path (Phase 2) |

### Examples

```json
{ "id": "1", "type": "auth", "token": "YOUR_SECRET" }
{ "id": "2", "type": "ping" }
{ "id": "3", "type": "react", "channelId": "…", "messageId": "…", "emoji": { "name": "pending", "id": "1024068629123309578" } }
{ "id": "4", "type": "edit", "channelId": "…", "messageId": "…", "content": "~~old~~\nnew" }
{ "id": "5", "type": "send", "channelId": "…", "content": "hello" }
{ "id": "6", "type": "switchChannel", "channelId": "…" }
{ "id": "7", "type": "messageCommand", "name": "update bonus", "channelId": "…", "messageId": "…" }
{ "id": "8", "type": "slashCommand", "name": "process", "channelId": "…", "options": [{ "name": "user", "type": 6, "value": "123" }, { "name": "ship", "type": 3, "value": "…" }] }
{ "id": "9", "type": "cancel", "targetId": "8" }
```

## Architecture

| File | Role |
|---|---|
| `index.ts` | `definePlugin`, settings, start/stop, cancel map, renderer request dispatch |
| `native.ts` | Electron main: `127.0.0.1` WebSocket server → `webContents.executeJavaScript` into Discord |
| `actions.ts` | MessageActions / ChannelRouter / RestAPI interaction submitter |
| `types.ts` | Request/response TypeScript shapes |

Renderer cannot open a listening socket (browser WebSocket is client-only), so the server lives in `native.ts` and forwards each request into the Discord renderer where webpack modules exist.

## Caveats

- **`messageCommand` / `slashCommand`** use Discord’s undocumented client `POST /interactions` path. Command `id`/`version` come from `ApplicationCommandIndexStore`; if lookup fails, open slash/Apps once in that channel to warm the index, then retry.
- Interaction body shape can drift with Discord updates — capture a real Network-tab `interactions` payload if submits start failing.
- `session_id` is resolved via webpack `getSessionId`; if that finder breaks after a Discord update, command actions will error until updated.
- Cancel cannot unwind an HTTP call Discord already accepted; it stops applying/chaining the in-flight handler result.
- Desktop / Vesktop only (needs `native.ts`).

## License

GPL-3.0-or-later (compatible with Vencord). Private staff tooling — not intended for upstream Vencord submission.
