# Design

Enable workspace mode with TAU_WORKSPACE_MODE=bridge. Use GPAS_TAU_SOCKET, or
/run/gpas-tau/bridge.sock, for bounded NDJSON control requests. Each request uses
its own connection. See docs/workspace-protocol.md for the wire contract.

Use Tau paths for local files and Pi paths for child arguments. Every child gets
its own environment. Never change process.env to select a workspace. History
identity consists of the workspace ID and Pi session ID; live Tau IDs and run IDs
remain separate. Bind each live session to a workspace for its whole lifetime.

Wait for fd 3 ready metadata before reporting a live session as created. Keep the
actual bundle immutable for that run. Report confirmed Pi identity changes to
run_tau, which alone persists records. Serialize identity notifications and retry
unacknowledged updates. Read current bundle information separately.

Keep existing HTTP formats in ordinary mode. In bridge mode, historical requests
carry workspace_id. Live requests resolve the immutable workspace on the live
session; an explicit conflicting workspace is rejected. File links retain the
originating live ID or workspace ID, never the sidebar selection.
