# Cuby app packages — developer guide

An app package is a self-contained vertical integration: an MCP server plus an
optional MCP Apps UI. Cuby discovers it, starts its server, registers its tools
with the agent, and renders tool results that point at a `ui://` resource in a
sandboxed iframe.

This guide covers the v1 host contract and the workflow for building, running,
and packaging an app. The full design is in
`docs/superpowers/specs/2026-11-21-cuby-app-packages-design.md`; the working
reference is `apps/fixture`.

> **v1 scope:** build-time/bundled and `CUBY_DEV_APPS` apps only. Runtime
> installation, signatures, a full UI kit, skills/entry points, and OS-level
> server sandboxing are not part of v1.

## Quickstart

Start from the fixture:

```sh
cp -R apps/fixture apps/my-app
```

1. Edit `apps/my-app/app.json`: change `id` to `my-app`, `name`, and the UI
   resource URI (for example `ui://my-app/hello`).
2. Edit `apps/my-app/server.mjs`: rename the tool if you like and keep the
   `_meta.ui.resourceUri` in sync with `ui.resources[]`.
3. Edit `apps/my-app/ui/index.html`: render the `ui/notifications/tool-result`
   payload.
4. Run Cuby in dev mode with the app source root:

```sh
CUBY_DEV_APPS=apps/my-app npm run dev:desktop
```

5. In a chat, ask the model to call `mcp_my_app_hello` with
   `{"name":"Cuby"}`. The Cuby-framed app view should appear and stay visible
   after the activity cluster collapses.

`CUBY_DEV_APPS` accepts a comma-separated list of app directories. Dev entries
override bundled/user apps with the same `id`; this is the fastest edit loop.

## How it works

```text
model
  │  tools/call mcp_<app>_<tool>
  ▼
Cuby agent ── MCP stdio ──▶ app server
  │                           │
  │  tool result with         │
  │  _meta.ui.resourceUri     │
  ▼                           │
AppManager / AppViewStore     │
  │  tool-event.app           │
  ▼                           │
renderer AppViewHost ── resources/read ──▶ app server
  │
  ├─ inject CSP into the HTML
  ├─ sandboxed iframe (allow-scripts)
  └─ AppViewBridge ◀── postMessage JSON-RPC ──▶ app UI
         │
         ├─ tools/call / resources/read ──▶ agent ──▶ app server
         ├─ ui/message ──▶ chat (provenance + rate limit)
         └─ ui/open-link / ui/download-file (capability-gated)
```

The agent owns the MCP session. The renderer only owns the iframe and the
host-side MCP Apps protocol; it forwards real MCP operations through the
`app_bridge` WebSocket control.

## Directory layout

```text
apps/<id>/
  app.json          # manifest (required)
  server/           # MCP server sources (or server.mjs at the root)
  ui/               # UI source or build output
  runtime/          # bundled Python/Node runtime (optional)
  assets/           # icons and static assets (optional)
  tests/            # app-owned tests (optional)
```

Cuby discovers apps from:

- `CUBY_BUNDLED_APPS_DIR` (packaged `resources/apps`, read via `registry.json`)
- `CUBY_USER_APPS_DIR` (default `~/.cuby/apps`)
- `CUBY_DEV_APPS` (comma-separated local app directories, highest precedence)

The directory name must match `app.json.id`; the build rejects a mismatch.

## Manifest

### Minimal `app.json`

```json
{
  "schemaVersion": 1,
  "id": "my-app",
  "name": "My App",
  "version": "0.1.0",
  "engines": { "cuby": ">=2.0.0" },
  "server": {
    "scope": "session",
    "transport": "stdio",
    "command": "node",
    "args": ["server.mjs"],
    "cwd": "${APP_ROOT}"
  },
  "ui": {
    "resources": [
      { "uri": "ui://my-app/hello", "entry": "ui/index.html" }
    ],
    "defaultResourceUri": "ui://my-app/hello",
    "prefersBorder": true,
    "csp": {}
  },
  "capabilities": {
    "appToolCalls": ["echo"],
    "appMessages": "allow",
    "workspace": "none"
  }
}
```

### Field reference

| Field | Required | Meaning |
|---|---|---|
| `schemaVersion` | yes | `1` for this host contract |
| `id` | yes | stable, unique, `[a-z0-9-]+`; must equal the directory name |
| `name` | yes | human-readable name |
| `version` | yes | semver of the app package |
| `description` | no | short description |
| `engines.cuby` | yes | semver range; unsatisfied apps are disabled with an error |
| `server.scope` | no | `"global"` (default) or `"session"` (one process per chat) |
| `server.transport` | yes | `"stdio"` in v1 (`"streamableHttp"` is reserved) |
| `server.command` | yes | string or `{ "<platform>-<arch>": "..." }` |
| `server.args` / `cwd` / `env` | no | strings supporting placeholders |
| `server.toolTimeout` | no | seconds; used for tool calls and the app bridge |
| `server.enabledTools` | no | model-side allowlist; default `["*"]` |
| `credentials[]` | no | `{ key, label, type: "secret"|"json", required?, schema? }`; v1 injects values from the host environment |
| `ui.resources[]` | no | `{ uri: "ui://...", entry: "..." }`; required when a tool renders UI |
| `ui.defaultResourceUri` | no | default resource; must be declared in `resources[]` |
| `ui.displayModes` | no | `inline` / `fullscreen` / `pip`; v1 negotiates inline/fullscreen |
| `ui.prefersBorder` | no | request host border/background; default `true` |
| `ui.csp` | no | `connectDomains`, `resourceDomains`, `frameDomains`, `baseUriDomains` |
| `capabilities.appToolCalls` | yes | app reverse-call allowlist; `[]` disables reverse calls |
| `capabilities.appMessages` | yes | `false` / `"ask"` / `"allow"`; v1 treats `"ask"` as denied |
| `capabilities.downloads` | no | allow `ui/download-file` |
| `capabilities.openLinks` | no | allow `ui/open-link` |
| `capabilities.workspace` | no | `none` / `read` / `write`; requires `scope: "session"` |
| `capabilities.modelConfig` | no | declares model protocols; not injected in v1 |
| `runtime` | no | runtime kind/version/platform paths; used by future packaging |
| `build` | no | `ui.command` / `ui.output` and `include` / `exclude` |
| `licenses` | no | third-party notices; used by future packaging |
| `integrity` | no | hash algorithm; build writes `registry.json` hashes |

### Placeholders

Allowed in `server.command` / `args` / `cwd` / `env`:

| Placeholder | Value |
|---|---|
| `${APP_ROOT}` | app package root |
| `${APP_DATA}` | persistent app data directory |
| `${SESSION_WORKSPACE}` | current chat workspace (session scope only) |
| `${CUBY_USER_DATA}` | Cuby user-data root |

Unknown placeholders are rejected. `${SESSION_WORKSPACE}` requires
`server.scope: "session"` and `capabilities.workspace != "none"`. Plaintext
secrets in `server.env` are rejected; declare them in `credentials` and Cuby
injects the values from the host environment/settings.

## Server contract

Implement a stdio MCP server that answers:

- `initialize`
- `tools/list`
- `tools/call`
- `resources/list`
- `resources/read`

Every tool that renders UI declares:

```js
_meta: { ui: { resourceUri: "ui://my-app/hello" } }
```

The URI must appear in `ui.resources[]`. `resources/read` for that URI must
return `text/html;profile=mcp-app` HTML.

A minimal server skeleton:

```js
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const server = new Server(
  { name: "my-app", version: "0.1.0" },
  { capabilities: { tools: {}, resources: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{
    name: "hello",
    description: "Say hello",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string" } },
    },
    _meta: { ui: { resourceUri: "ui://my-app/hello" } },
  }],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => ({
  content: [{ type: "text", text: `Hello, ${request.params.arguments?.name ?? "world"}` }],
}));

server.setRequestHandler(ListResourcesRequestSchema, async () => ({
  resources: [{
    uri: "ui://my-app/hello",
    mimeType: "text/html;profile=mcp-app",
  }],
}));

server.setRequestHandler(ReadResourceRequestSchema, async (request) => ({
  contents: [{
    uri: request.params.uri,
    mimeType: "text/html;profile=mcp-app",
    text: "<html>...</html>",
  }],
}));

await server.connect(new StdioServerTransport());
```

The server must write only JSON-RPC to stdout; send logs and diagnostics to
stderr. A server that pollutes stdout will fail discovery with a protocol
pollution hint.

Tool errors should return `{ isError: true, content: [...] }`; the host does not
render an app view for `isError` results.

## UI contract

The UI is self-contained HTML loaded into an iframe with
`sandbox="allow-scripts"` and no `allow-same-origin`. It must not import Cuby
React components or Cuby contracts. It speaks the standard MCP Apps protocol
(`2026-01-26`) over `postMessage`.

### Handshake

```text
App  -> Host: ui/initialize { protocolVersion, appCapabilities, appInfo }
Host -> App:  result { protocolVersion, hostInfo, hostCapabilities, hostContext }
App  -> Host: ui/notifications/initialized
Host -> App:  ui/notifications/tool-input { arguments }
Host -> App:  ui/notifications/tool-result { content, structuredContent? }
```

The host also sends `ui/notifications/host-context-changed` when theme,
display mode, or size changes. The app can send
`ui/notifications/size-changed` and `ui/notifications/request-teardown`.

### Host methods

| Method | Behavior |
|---|---|
| `ui/initialize` | returns host capabilities and context |
| `tools/call` | forwarded to this app's MCP server; restricted to `appToolCalls` |
| `resources/read` | forwarded to this app's MCP server |
| `ui/message` | enters the chat when `appMessages: "allow"`; rate limited (10/min/view) |
| `ui/open-link` | requires `capabilities.openLinks`; asks for confirmation |
| `ui/download-file` | requires `capabilities.downloads`; native save dialog |
| `ui/request-display-mode` | `inline` / `fullscreen` |
| `ui/update-model-context` | accepted and acknowledged; not stored in v1 |

### Host context

The host context includes `theme`, `styles.variables` (mapped from Cuby design
tokens), `displayMode`, `availableDisplayModes`, `containerDimensions`,
`locale`, `timeZone`, `platform: "desktop"`, `deviceCapabilities`, and
`safeAreaInsets`. Apply `styles.variables` to your document root; do not hardcode
Cuby colors.

### CSP and network

The host injects a default-deny CSP into the HTML:

```text
default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline';
img-src data:; base-uri 'none'; object-src 'none'; form-action 'none'
```

Only `ui.csp.connectDomains`, `resourceDomains`, `frameDomains`, and
`baseUriDomains` add allowed origins. A UI that needs a network call must
declare the origin in the manifest.

### Display modes and size

`ui/request-display-mode` supports `inline` and `fullscreen` in v1. The host
sends `host-context-changed` with the new `displayMode`. The app can report its
height with `ui/notifications/size-changed`; the host applies it to the iframe.

`containerDimensions` is `{ width, maxHeight }` in pixels. Inline it is the fixed
chat budget, `800 × 640`. In fullscreen it is the frame's measured width and the
height left below it in the window, and the host sends `host-context-changed`
again when the window is resized.

### Large results

Tool results larger than 256 KiB, or containing images, are externalized under
`${APP_DATA}/views/<viewId>/`. The transcript stores `resultRef`; when the view
mounts, the host calls `view/result` to restore the full payload before sending
`tool-result`. Apps should handle both inline and restored results.

## Development and testing

```sh
CUBY_DEV_APPS=apps/fixture npm run dev:desktop
```

Manual checklist for a new app:

- the tool is registered as `mcp_<app>_<tool>` and visible to the model;
- the app view renders and stays visible after the activity cluster collapses;
- the iframe can call an allowlisted tool through the bridge;
- `ui/message` appears as a user message with the app id;
- `ui/open-link` asks for confirmation and `ui/download-file` opens the save
  dialog when the capabilities are declared;
- toggling Cuby light/dark sends a new host context and the UI updates;
- an oversized result still restores after a refresh.

Useful commands:

```sh
npm run apps:list
npm run apps:build
npm run test:apps
```

## Build selection and staging

Select apps in `cuby.apps.json`:

```json
{ "schemaVersion": 1, "apps": ["fixture"] }
```

Or select on the command line / environment:

```sh
CUBY_APPS=fixture npm run apps:build
node scripts/apps/build-apps.mjs --apps fixture --out dist/apps
npm run apps:list
```

Selection precedence is CLI `--apps` > `CUBY_APPS` > `cuby.apps.json`. `*`
selects all discovered apps; an explicitly empty `CUBY_APPS` selects none.

The build:

- validates each manifest;
- checks the directory name matches `manifest.id`;
- checks every `ui.resources[].entry` exists;
- checks `server.command` has an entry for the current
  `process.platform-process.arch`;
- runs `build.ui.command` when declared and checks `build.ui.output`;
- stages `dist/apps/<id>/` with `app.json`, server/UI/assets, and a
  `registry.json` containing versions and SHA-256 hashes;
- skips apps that cannot run on the current platform; set
  `CUBY_APPS_STRICT=1` to fail instead.

## Security rules

- The app server is trusted build-time code in v1. Do not install third-party
  app packages without an OS sandbox.
- The UI iframe is sandboxed with scripts only; no same-origin access.
- Network access is denied by default through the injected CSP; only `ui.csp`
  domains are allowed.
- Reverse tool calls are allowlisted per app; cross-app calls are not possible.
- `ui/message` requires `"allow"`, is rate limited, and is marked as
  app-originated in the transcript.
- `ui/download-file` and `ui/open-link` require the matching capability;
  downloads are size limited and saved through the native dialog.
- Do not put keys in `app.json`, `server.args`, or UI code. Declare
  `credentials`; the host injects the values.

## Troubleshooting

| Symptom | Check |
|---|---|
| `Invalid app manifest` | strict fields, unknown placeholders, duplicate `ui.resources` URIs, plaintext secrets, `SESSION_WORKSPACE` without session scope |
| App tools missing | `server.command` platform entry, `cwd`, executable path, server stdout pollution, credentials; check agent logs for `[apps]` |
| `app 宿主不可用` / App host unavailable | the chat has no live WebSocket connection or the agent does not expose `app_bridge` |
| Blank iframe | `resources/read` returns `text/html;profile=mcp-app`; `ui/initialize` handshake; CSP blocks a network request |
| `ui/message` rejected | `appMessages` is not `"allow"`, empty content, or the 10/min limit was hit |
| `ui/open-link` / download rejected | declare `capabilities.openLinks` / `capabilities.downloads` |
| Oversized result not visible | check `${APP_DATA}/views/<viewId>/result.json`; the host restores it via `view/result` |
| Session state split across chats | use `scope: "session"`; do not share state in a `global` server |

App startup failures are currently reported in agent logs, not in a status
panel; a visible status surface is planned with entry points.

## Versioning and compatibility

- `schemaVersion` is the manifest structure version (`1`).
- `engines.cuby` gates the app against the Cuby version; unsatisfied apps are
  disabled with a reason.
- The MCP Apps protocol version is `2026-01-26`.
- `registry.json` carries `schemaVersion` and `hostApiVersion`; these fields are
  reserved for compatibility checks, but v1 does not yet reject incompatible
  registries or re-verify stored hashes.
- The UI should use `styles.variables` and host context rather than Cuby private
  CSS or React internals.

## Not in v1

- Runtime installation, signing, and updates
- OS-level sandboxing of app servers
- Skills, home/settings entry points, and a shared UI kit
- Manifest `dev` overrides (use `CUBY_DEV_APPS`)
- A visible app-status panel
- Python/Node runtime bundling inside app packages
- electron-builder packaging of `dist/apps`
- The FinanceBuddy migration

## Reference

- Full design: `docs/superpowers/specs/2026-11-21-cuby-app-packages-design.md`
- Working app: `apps/fixture`
- Build script: `scripts/apps/build-apps.mjs`
- MCP Apps spec: `2026-01-26` (SEP-1865)
