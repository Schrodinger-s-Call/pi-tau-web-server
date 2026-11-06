# Validation

Validated on 2026-11-06 against the shared run_tau contract at
`openspec/changes/refactor-tau-user-workspaces/protocol.md` in its
`codex/run-local-gpas` checkout. The contract file SHA-256 was
`8206beb0fd5781cd4dd4ed8345c8806e28575c57373b1b6f72368f942bb346a7`.

## Source and browser checks

- `npm run typecheck` passed.
- `npm test` passed 338 tests. Six existing permission integration tests skipped
  because TAU_PERMISSION_EXTENSION_DIR was not configured. No tests failed.
- The browser suite passed all 120 tests without skips in about 30 seconds.
- `git diff --check` passed.

The browser runner used existing temporary libraries and font configuration:

```sh
LD_LIBRARY_PATH=/tmp/tau-browser-libs/root/usr/lib/x86_64-linux-gnu \
FONTCONFIG_FILE=/tmp/tau-browser-libs/fonts.conf npm run test:e2e
```

The real local Pi test uses Pi 1.5.0 with isolated settings and synthetic history.
It verifies fork, switch, cancellation, and lifecycle identity notifications
without a model request. Protocol tests cover invalid encodings and fields,
bounded frames, complete ACK checks, retries, run-info reconciliation, conflicts,
initial seq 0, delayed file creation, file isolation, export, and short commands.

## Real container integration

`test/integration/workspaces.py` uses the run_tau source checkout, an independent
temporary state root, two synthetic users, two workspaces per user, and the offline
fixture provider. It creates and removes only containers labeled for that test
root. It runs `workspace-browser.ts` for real Chromium and WebSocket checks.

Run it from the run_tau project with that project's dependencies:

```sh
PYTHONPATH="$GPAS_CHECKOUT" uv run --project "$GPAS_CHECKOUT" python \
  "$TAU_CHECKOUT/test/integration/workspaces.py"
```

Supply the browser library and font settings above when the host needs them.
The harness uses `localhost/pi-tau-web-server:workspace-candidate` and
`172.20.2.109:5000/gpas/agent-bundle:1.1.0`. The tested candidate is the same image
now tagged `1.2.1-dev`.

The joint run passed:

- Real workspace queries through Tau HTTP and the user socket.
- New Pi ready with an uncreated history file and persisted seq 0.
- Models and exports through fd 3 started/completed metadata.
- Offline model replies, HTML export and download, uploads, and file isolation.
- Cross-user run queries rejected by the runtime.
- RPC fork and extension-driven new history persisted by run_tau with new seq.
- Browser workspace selection, page reload, and WebSocket reconnect preserving
  the active Pi run and actual bundle.
- Current bundle updates affecting new runs while existing runs keep v1.
- Active history resume reusing Pi; stopped history resume starting a new run
  with the same Pi history ID.
- Stopping one user leaving the other user's Tau and Pi alive.
- Cleanup of every container belonging to the test root.

An initial joint attempt found that Tau's HTTP command allowlist rejected fork
before it reached Pi. The allowlist and regression test were fixed. The final
joint run passed against the actual Pi image; that earlier failure was not a Pi
image limitation.

## Image

Built using `container/tau-container build` with Podman, then tagged the tested
candidate as `localhost/pi-tau-web-server:1.2.1-dev`.

Image ID:
`fa90eedad4fb69c1761c2670314ff63c14f9dc7e6570fc543a5928bfd8f5e36e`.

A disposable container using the image's normal entrypoint passed the health and
authenticated workspace API checks. Its protocol frame limit is 262144 bytes.
The checkout includes uncommitted changes; this is a local development image.

## Remaining deployment checks

No production environment was migrated, restarted, or replaced. No image was
pushed to a registry and no source changes were committed or pushed. GPAS source
files were not edited.

Real account authentication, public skills such as nexus-ui, live model providers,
and the migration window remain deployment checks. Histories with old absolute
parentSession paths still require the migration mapping identified by run_tau;
synthetic-history success does not establish migration readiness. Tau's pending
identity queue is not persistent across abrupt process loss. Runtime cleanup and
terminal records remain run_tau's responsibility.

## Image references and live model requests (2026-11-06)

Local Markdown images are served through the authenticated workspace image API.
HTTP tests cover image bytes and content type, missing workspace identity, cross
workspace access, path traversal, symbolic links, and unsupported file types.
The browser test decodes a local image and verifies that switching workspaces
preserves its original workspace.

Live model requests preserve their client ID. The real integration test sends
get_available_models over WebSocket to an active Pi twice across reconnects and
checks that each response has the original request ID and a successful model list.

Type checking passed. Unit tests: 338 passed, 6 existing skips. Browser tests:
120 passed, no skips, about 30 seconds. The isolated run_tau integration passed,
including real Pi fork, extension identity updates, exports, reconnects, and
cleanup. Logs are /tmp/tau-image-model-{tests,e2e,joint,build}.log.

The local 1.2.1-dev image is now
4c1dabf5ac3aacaaee6852bdf095a41fdba1bc6ce43c0730de626489f1f09154.
No existing deployment was restarted or replaced.
