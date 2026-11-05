# Pi Tau Web Server

**Browser workspace for [Pi](https://github.com/earendil-works/pi) — a standalone web server that manages multiple live Pi RPC sessions in parallel.**

Pi Tau Web Server is a fork of [deflating/tau](https://github.com/deflating/tau), forked at
[`5e2bce39`](https://github.com/deflating/tau/tree/5e2bce39) and rewritten from
a Pi extension that ran inside the Pi TUI into a standalone Node.js web server.
The original Tau project was retired on 2026-09-30 and is no longer maintained.
This fork is under active maintenance and development. Instead of living inside
a TUI session, Tau runs one backend process and spawns headless `pi --mode rpc`
child processes — one per in-page Tau tab — so you can work with multiple Pi
sessions side by side in your browser.

## Key differences from `5e2bce39`

| Area                  | Upstream (`5e2bce39`)                                                                         | This fork                                                                                                      |
| --------------------- | --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| **Architecture**      | Pi extension loaded inside the Pi TUI process; browser displayed a single running TUI session | Standalone Node.js server that spawns independent `pi --mode rpc` child processes                              |
| **Multiple sessions** | Not supported                                                                                 | In-page tabs each backed by their own Pi RPC subprocess; run N sessions in parallel                            |
| **Session lifecycle** | Tied to the Pi TUI session — close the TUI and the browser view died                          | Sessions are server-owned; closing/reloading the browser does not kill Pi children                             |
| **Pi communication**  | In-process Pi extension API                                                                   | Out-of-process JSON line-delimited RPC over stdin/stdout                                                       |
| **UI dialogs**        | `ctx.ui.confirm/input/select` shown in TUI only; not forwarded to the browser                 | All forwarded to the browser — extensions that use these built-in UI interfaces work seamlessly in the browser |
| **Test coverage**     | Javascript and No tests                                                                       | Typescript + Full test suite                                                                                   |
| **Auto-start**           | Extension auto-started inside Pi unless `TAU_DISABLED=1`                                      | Always explicit — the user runs `pi-tau-web-server` when they want it                                          |
| **Various enhancements** | N/A                                                                                           | Session tree and branching, mirroring Pi TUI's `/tree` command                                                  |

![Tau light mode](docs/images/main-page.jpg)

![Tau dark mode](docs/images/main-page-dark.jpg)

![New tab modal](docs/images/new-tab.jpg)

![Commands](docs/images/commands.png)

![Model completion](docs/images/model-completion.jpg)

![Settings](docs/images/settings.png)

![Mobile main page](docs/images/mobile-main-page.jpeg)

![Mobile sidebar](docs/images/mobile-side-bar.jpeg)

## What it does

- **Standalone server** — run `pi-tau-web-server`; it serves the web UI and manages Pi RPC child processes as subprocesses via `pi --mode rpc`
- **Multiple live sessions** — in-page Tau tabs (not browser tabs) each represent a live Pi RPC session. Create, switch, and close them from one browser page. Tau runs all of them in parallel.
- **Session persistence while the server runs** — closing or reloading the browser does not kill Pi child sessions; only closing an in-page Tau tab or shutting down the Tau server does
- **Works on any device** — open the same Tau server from your phone, tablet, or another monitor
- **Session history browser** — view saved Pi JSONL session files, search across all sessions by message content
- **WebSocket-based client-server architecture** — the browser connects to Tau over HTTP and WebSocket; Tau communicates with Pi processes over JSON line-delimited RPC over stdin/stdout

## Install

Requires Node.js 22.19 or newer and [Pi](https://github.com/earendil-works/pi)
installed as the `pi` command on your `PATH`.

```bash
npm install --global pi-tau-web-server
```

## Usage

```bash
pi-tau-web-server
```

Open the printed URL (default `http://localhost:3001`). Click `+` in the tab bar or sidebar to create an in-page Tau tab, choose or type a project directory, optionally enter a Pi `/model`-style model string, then chat.

```bash
pi-tau-web-server --host 127.0.0.1 --port 3001 --open
TAU_PORT=3001 TAU_HOST=0.0.0.0 TAU_PROJECTS_DIR="$HOME/projects" pi-tau-web-server
```

## Containers

The container launcher runs one isolated Tau service per instance name. Docker
and Podman are supported; set `TAU_CONTAINER_RUNTIME` to select one explicitly.
The image is built automatically on the first run, or it can be built ahead of
time:

```bash
container/tau-container build
```

Start an instance with credentials in the environment:

```bash
TAU_USER=alice TAU_PASS='choose-a-password' \
  container/tau-container run personal-workspace --port 3001
```

Missing credentials are prompted for, with the password input hidden. Start
additional isolated instances by giving each one a different name and host
port:

```bash
container/tau-container run work-workspace --port 3002
container/tau-container status
container/tau-container logs work-workspace
container/tau-container stop work-workspace
```

Each instance has an isolated `~/projects` directory inside the container,
available at `/state/home/projects`. It is mounted read-write from the
instance's `projects/` state directory.

On an instance's first launch, the launcher copies
`${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}` into that instance's writable state.
Symlinks are dereferenced on the host. The host `sessions/`, `npm/`, and `git/`
directories are excluded. Package declarations remain in `settings.json`, so Pi
installs missing npm/git packages when its first RPC session starts.

The copied configuration is never refreshed automatically. Changes made by Pi
or Tau therefore survive container recreation and remain isolated from other
instances. Projects and session files are also stored separately per instance.
By default, state is kept under:

```text
${XDG_DATA_HOME:-$HOME/.local/share}/pi-tau-web-server/instances/<instance>/
```

The host-side projects directory is `<instance>/projects/` beneath that path.
Override the state root with `TAU_CONTAINER_STATE_DIR`.

Ports bind to all host interfaces by default. HTTP Basic Auth does not encrypt
credentials or traffic, so use a TLS reverse proxy for access from another
machine. Pass `--bind 127.0.0.1` to restrict an instance to local access.

## Features

### Chat

- Full markdown rendering with syntax-highlighted code blocks
- Streaming responses with typing indicator
- Image attachments (paste, drag & drop, or button)
- Copy any message with one click
- Inline diff viewer for edit tool calls
- Message queuing while the agent is working

### Nexus UI components

Assistant replies can include JSON fenced with `json [nexus-ui]`. Tau renders
`select`, `confirm`, `form`, `progress`, `radar`, and `sankey` components in the
order they appear alongside the reply. Progress also accepts `[nexus-ui] progress`
and `json [nexus-ui] progress` headers. Ordinary code, tool output, user messages,
and file previews do not activate components.

Selections require at least one answer per question. Options marked `is_other`
require text when selected. Forms send all answers in one ordinary user message
through the existing session. Confirm actions with `submit: false` close the
card without sending a message. Only the latest completed reply in the selected
live session accepts answers, and the session must be idle and connected.
The message draft and attachments are kept when a card sends an answer.

Submitted cards cannot be clicked again. Explicitly rejected sends can be
retried; uncertain delivery asks the user to check the conversation first.
Newer turns disable older cards. History loaded from the server, including after
reload or reconnect, renders interactive cards as read-only; users can still
answer through the message input. Card answers are not stored separately from
ordinary session messages.

Charts use local SVG and work without an external chart service. Radar axes use
the supplied 0–1 values and show their original values in tooltips and a table.
Sankey charts preserve link weights without inventing units. Cycles, self-links,
zero-only graphs, and graphs above 60 nodes or 11 columns show the complete link
table. Progress cards show the state recorded in the message, without polling
or a fabricated percentage. Charts and state cards remain visible in history.

Each component is limited to 64 KiB of JSON text. A message renders up to 30
components; selections allow 50 options, confirmations 20 actions, forms 20
questions, radar charts 3–12 axes, and Sankey data 200 links. Invalid or unknown
components remain readable as code and do not prevent later blocks from rendering.

### Live Session Management

- Backend-owned live Pi RPC sessions, each backed by a `pi --mode rpc` subprocess
- JupyterLab-style in-page Tau tab strip — each tab is an independent Pi session
- Browser reload or reconnect restores live Tau tabs from the backend
- Multiple browser clients see the same live session list
- Historical sessions remain read-only
- **Session tree and branching** — inspect the active session's full tree and jump to any earlier entry, mirroring Pi TUI's `/tree` behavior; choose a user message to restore it to the composer and create a new branch

### Model & Thinking

- Optional model string at session creation using Pi `/model` syntax (e.g. `openai/gpt-5.5:high`)
- Per-session model picker with fuzzy search
- Per-session thinking level controls
- Token usage percentage with context window visualiser
- Cost tracking per session

### File Browser

- Right sidebar rooted at the active live session's working directory
- Click text files to read them in tabs beside the conversation. File tabs belong to the selected session and stay available when you return to it.
- Markdown opens with formatting and a source toggle. Other UTF-8 text files preserve their contents and spacing. Previews are read-only and include Copy, Refresh, and Add to message actions.
- Click a text file card above the input to open its preview. Drag files onto the input to insert their path.
- Text previews accept regular UTF-8 files up to 256 KiB. Larger files and binary files show an explanation without loading their contents into the page.
- Markdown formatting runs in a background worker with a one-second time limit. Documents above 32 KiB, 1,500 lines, or 2,000 characters per line show source. Images and relative links appear as text; external links remain clickable.
- File tabs reload their contents when selected. Up to 12 file tabs are retained in the browser; reloading the page closes them.
- Images can be added to the input with a click or opened with a double-click in an application on the server.

### Session Browser

- Sidebar with all saved Pi JSONL session files, grouped by project
- Full-text search across all historical sessions with highlighted snippets
- Rename sessions, export to HTML

### Mobile Support

- Slide-over sidebar with swipe-from-edge gesture
- Slimmed header, model picker stays accessible
- Larger touch targets and font sizes optimized for mobile
- Auto-reconnect WebSocket on return from background
- PWA: installable as a standalone app on iOS, Android, and macOS

### Themes

Six built-in themes: Dusk (clean neutral dark, default), Dawn (warm blue dark), Midnight (OLED black), Clean (Apple-style light with cyan-blue accents), Terracotta (warm light), Sage (warm olive-green). All with frosted glass header and input area.

## Configuration

### CLI flags

| Flag                                  |                                                  Description |
| ------------------------------------- | -----------------------------------------------------------: |
| `--open`                              |                 Open the URL in the default browser on start |
| `--port` / `TAU_PORT`                 |                                Server port (default: `3001`) |
| `--host` / `TAU_HOST`                 |                            Bind address (default: `0.0.0.0`) |
| `--projects-dir` / `TAU_PROJECTS_DIR` | Directory scanned for project chips in the new-session modal; also the base for relative paths typed in the project field |
| `--pi-command` / `TAU_PI_COMMAND`     |                     Pi executable that Tau runs (default: `pi`) |

### Environment variables

| Variable           |     Default |                                              Description |
| ------------------ | ----------: | -------------------------------------------------------: |
| `TAU_PORT`         |      `3001` |                                              Server port |
| `TAU_HOST`         |   `0.0.0.0` |                                             Bind address |
| `TAU_DEFAULT_CWD` | _(none)_ | Default directory filled into the new-tab form |
| `TAU_PROJECTS_DIR` |    _(none)_ | Directory scanned for project chips in the new-tab modal |
| `TAU_PI_COMMAND`   |        `pi` |                              Pi executable that Tau runs |
| `TAU_STATIC_DIR`   | _(bundled)_ |                               Override static files path |
| `TAU_USER`         |    _(none)_ |                                 HTTP Basic Auth username |
| `TAU_PASS`         |    _(none)_ |                                 HTTP Basic Auth password |
| `TAU_COOKIE_SECRET`| _(generated)_ |            Secret that signs session cookies (optional) |
| `TAU_INTERACTION_DIAGNOSTICS` | _(off)_ | Set to `1` to log dialog/Abort lifecycle IDs, reasons, and timestamps to stderr |

Set `TAU_DEFAULT_CWD=/workspace` in the container environment to prefill the
new-tab directory. The path must exist inside the container. The container
launcher forwards this variable when set. You can also set
`tau.defaultCwd` in the instance's Pi `settings.json`; the environment variable
takes priority. Restart Tau after changing this configuration.
An explicitly selected or already entered directory is kept. Otherwise, the
configured default is used, followed by the active session's directory.

Tau also reads matching values from `~/.pi/agent/settings.json` under the `tau` key (`host`, `port`, `projectsDir`, `user`, `pass`, `authEnabled`, `cookieSecret`).

### Using a different Pi command

To run a Pi fork or wrapper instead of `pi`, pass `--pi-command` or set
`TAU_PI_COMMAND` (the flag wins). The value is a single executable with no
arguments. If it keeps its config outside `~/.pi/agent`, also set
`PI_CODING_AGENT_DIR`.

```bash
pi-tau-web-server --pi-command pi-bolt
```

### Authentication

Tau Web Server supports optional HTTP Basic Auth. Set credentials in `~/.pi/agent/settings.json` or via environment variables, then toggle "Require login" in Tau Settings.

```json
{
  "tau": {
    "user": "pi",
    "pass": "your-password"
  }
}
```

Both HTTP and WebSocket connections are gated when enabled. `/api/health` remains open for monitoring.

After the first successful Basic login, the server sets a signed `HttpOnly` session cookie and accepts it in place of the Authorization header. This keeps mobile browsers (notably iOS Safari and the installed PWA, which evict cached Basic credentials whenever you switch apps) from re-prompting for the password every time you return to the app. The cookie is scoped to the browser session — killing the browser ends it and the Basic prompt appears again — and the token inside it expires after 12 hours of inactivity, renewing itself while the app is in use. Changing the password invalidates every outstanding cookie on all devices, and deleting the auto-generated `cookieSecret` from `~/.pi/agent/settings.json` force-logs-out all devices at once.

## How it works

```
┌─────────────┐     ┌──────────────────────────┐     ┌───────────────────────────┐
│  Browser    │◄───►│  Tau Web Server          │◄───►│  pi --mode rpc            │
│  (Tau UI)   │     │  HTTP + WebSocket +      │     │  child session 1          │
│             │     │  LiveSessionManager      │     ├───────────────────────────┤
│             │     │  (Node.js)               │     │  pi --mode rpc            │
│             │     │                          │     │  child session 2          │
│             │     │                          │     ├───────────────────────────┤
│             │     │                          │     │  pi --mode rpc            │
│             │     │                          │     │  child session (N)        │
└─────────────┘     └──────────────────────────┘     └───────────────────────────┘
```

The browser connects to Tau Web Server over WebSocket (and HTTP for history and API calls). Tau manages a pool of `PiRpcSession` instances, each of which spawns a `pi --mode rpc` subprocess. Communication with Pi is over JSON line-delimited RPC via stdin/stdout. Closing an in-page Tau tab sends a DELETE request that terminates the corresponding Pi child. Shutting down Tau terminates all managed children.

For diagnosis, `TAU_INTERACTION_DIAGNOSTICS=1` logs dialog creation/resolution and Abort sent/acknowledged/timed-out events. These opt-in records exclude command arguments, dialog text, credentials, and conversation content. Live request IDs are never stored in the conversation history or restored after a Pi process restart.

## Development

### Prerequisites

- [Pi](https://github.com/earendil-works/pi) must be installed (`pi` on `PATH`)
- Node.js and npm

## License

MIT
