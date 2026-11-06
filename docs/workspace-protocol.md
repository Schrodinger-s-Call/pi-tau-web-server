# gpas-tau-workspace/v1

Tau follows the shared contract in the run_tau change
`openspec/changes/refactor-tau-user-workspaces/protocol.md`. This document describes
the Tau adapter. Both projects must change their contract tests when fields change.

## Configuration and transport

Set `TAU_WORKSPACE_MODE=bridge`, `GPAS_TAU_PROTOCOL_VERSION=1`, and
`GPAS_TAU_SOCKET=/run/gpas-tau/bridge.sock`. Each child gets its own environment with
`GPAS_TAU_WORKSPACE_ID` and `GPAS_TAU_CWD=/workspace`. Never change the server's
global environment to select a workspace. Ordinary mode keeps three pipes.

Control traffic is UTF-8 NDJSON without BOM or CRLF. Each frame, including LF, is
at most 262144 bytes. Object fields, types, IDs, versions, and responses are
validated. Workspace and session IDs match `[A-Za-z0-9][A-Za-z0-9_-]{0,63}`; run IDs
are 32 lowercase hex characters. Queries use one socket connection per request,
with a two-second total deadline. Errors carry type, protocol_version, code,
message, and optionally run_id. Local connection and timeout errors use
SOCKET_UNAVAILABLE and QUERY_TIMEOUT.

## Directory and run queries

The workspaces request has type workspaces and protocol_version 1. Its response
has the same type and version, revision, and workspaces. Each entry contains
workspace_id, display_name, paths with files and sessions, and current_bundle
with name, sha256, and commit. The digest is 64 lowercase hex characters; commit
may be null. The launcher reports Tau container paths, not host paths or secrets.
It mounts `/gpas/workspaces/<id>/files` and `/gpas/workspaces/<id>/sessions`.

Tau refreshes on page load, selection, before dependent operations, and every five
seconds while visible. Query errors do not become empty successful lists. The
runtime independently resolves the current bundle when starting each Pi.

run-info carries run_id and returns type run-info with run. The record contains
run_id, workspace_id, kind, state, initial_session_id, initial_session_file,
session_id, session_file, seq, actual_bundle, started_at, finished_at, and exit_code.
States are starting, running, exited, failed, and interrupted. Records belong to
run_tau, remain queryable after exit, and are scoped to the socket's user.

## Child metadata and completion

Bridge children use four pipes. fd 3 carries ready, started, completed, and error;
stdout and stderr retain the original Pi bytes. RPC ready carries run_id,
workspace_id, kind rpc, session_id, session_file, seq 0, actual_bundle, started_at,
and protocol_version 1. Tau waits at most 130 seconds from spawn. The runtime has
120 seconds total for preparation and startup, including an internal state probe
of at most 30 seconds, whose private response is consumed by the runtime.

Short commands use started with kind models or export, null session_id and
session_file, and seq 0. completed carries run_id, workspace_id, kind,
actual_bundle, finished_at, and exit_code. Tau waits for metadata, stdout drain,
and child close. It allows 260 seconds total including startup. Timeout terminates
the bridge to trigger runtime cleanup. Neither short command creates a chat.

## Paths and session changes

Tau maps materials to Pi `/workspace` and histories to
`/root/.pi/agent/sessions`. Pi RPC keeps sessionFile; bridge fields use session_file.
Paths must stay within their roots without traversal or symbolic links. Existing
history headers must match the actual Pi session ID. IDs are never inferred from
filenames. Known switch targets are checked against live ownership before Pi is
asked to switch; the runtime's ACK validation is the final ownership check.

ready is the persisted initial identity at seq 0. A new session may have a valid
allocated path before its first message creates the file. Tau does not submit
that unchanged identity as seq 1. Later identities wait for the file and matching
header before submission. Waiting ends when the run ends; it does not use the ACK
retry budget. Normal messages remain available to make Pi persist the new history.
A missing or invalid later identity is never reported as synchronized.

Tau's lifecycle extension sends the identity through Pi's extension_ui_request
setStatus channel with statusKey tau_session_identity. Tau queries get_state to
verify changes from extensions and explicit fork, clone, new, and switch commands.
Current history is refreshed from get_tree; the old history is not kept visible
as the new one. The running bundle and run ID do not change when history changes.

## Ordered updates

session-update carries protocol_version 1, run_id, workspace_id, seq, session_id,
and session_file. session-updated echoes every one of those identity fields. Tau
checks the whole ACK. One unacknowledged update is in flight; later observations
queue. Only acknowledged updates advance the sequence. The initial sequence is 0.
There are at most three attempts for the same message, with 200 and 500 ms delays.
After exhaustion Tau queries run-info. If the exact identity and sequence cannot
be confirmed, it marks synchronization failed and terminates the initiating run.
File operations and further session changes are blocked while identity is pending.

A repeated final ACK can be confirmed after a run ends. A new sequence against a
terminal record is rejected. Runtime conflicts, stale or skipped sequences,
invalid histories, and persistence errors must not be treated as successful
updates. Unknown extension targets may only be detected after switching; this is
not a transaction that prevents every extension write before ownership validation.

The runtime alone persists records. Tau's pending queue is memory-only; an abrupt
Tau loss can interrupt a final notification. Runtime cleanup and terminal records
remain the runtime's responsibility.

## Browser API

GET /api/workspaces returns enabled, revision, and workspaces. Ordinary mode
returns enabled false. GET /api/run-info forwards the scoped run query.
Creating and resuming in bridge mode require workspace_id. History responses and
operations carry their workspace identity; a live sessionId resolves its stored
workspace and rejects a conflicting explicit workspace_id.

Report links retain the originating workspace. File browser paths use /workspace
so paths inserted into messages make sense to Pi. Downloads accept path with a
workspace_id or live sessionId. Exports specify their output path and return a
history-root download URL. Uploads accept a single-component name and base64 data,
are limited to 10 MiB, and never overwrite an existing file.

Markdown images with local paths use GET /api/file/image with workspace_id and
path. Relative paths start at the workspace files root; /workspace paths map to
the same root. Images retain the message's workspace when the sidebar selection
changes. The endpoint requires the usual authentication, rejects symbolic links
and paths outside the workspace, and serves supported image types inline with
caching disabled. SVG responses have a sandbox policy that blocks scripts and
external resources. Files in Pi's private temporary directories are not shared.
External image URLs and embedded image data keep their existing handling.

Model queries for a live session use that session's Pi process and preserve the
client request ID in the response, including over WebSocket.

Runtime-mounted root files AGENTS.md and RUNTIME.json are resolved through the
owning live run using the restricted run-file query. The adapter contract and
pending runtime acceptance checks are in runtime-files-handoff.md. Tau never
uses workspace placeholder bytes or the current bundle reference for these files.
