# Runtime file reads for Tau

Status (2026-11-06): Both sides have approved the interface contract. run_tau
support is implemented. The rebuilt Tau image passed isolated real Pi integration
and browser acceptance for runtime file listing, preview, and download. Production
deployment and live provider/tool acceptance are separate from these checks.
This extends the user bridge protocol v1. The shared protocol.md in the run_tau
checkout remains the authority and includes this approved contract. The Pi-agent
owner maintains the runtime implementation, specification, and protocol tests. Tau does not read host placeholder files for these resources.

## Request and response

One request per connection, with the existing 2 second query timeout and 262144
byte frame limit including LF:

```json
{"type":"run-file","protocol_version":1,"run_id":"<32 lowercase hex characters>","workspace_id":"exp1","name":"AGENTS.md"}
```

Only the exact names AGENTS.md and RUNTIME.json are accepted. There is no client
path, account, bundle selector, or command. The user is determined by the socket.

```json
{
  "type": "run-file",
  "protocol_version": 1,
  "run_id": "<same run ID>",
  "workspace_id": "exp1",
  "name": "AGENTS.md",
  "actual_bundle": {"name":"v1","sha256":"<64 lowercase hex characters>","commit":null},
  "size": 123,
  "content_base64": "<canonical base64 of the exact file bytes>"
}
```

The entire file must be at most 131072 bytes (128 KiB). Read at most that limit
plus one byte, reject larger files, and never return truncated content. Base64
keeps the complete response within the existing frame limit even for escaped
JSON text. Files must contain valid UTF-8; their byte representation is preserved
for downloads. Empty real files are allowed; empty placeholders are never a source.

## Runtime ownership and file sources

Resolve the record within the socket user's records. Verify workspace_id matches,
the run is running, and its active RPC session still exists. Resolve both file
sources from that exact session, never the workspace's current bundle reference:

- AGENTS.md: the source actually mounted at /workspace/AGENTS.md for that run,
  derived from its frozen bundle.
- RUNTIME.json: that session's generated metadata file mounted at
  /workspace/RUNTIME.json, not the persistent run record JSON. Its session_id is
  the identifier generated when the run started and corresponds to run_id. It is
  not the current Pi history session_id after fork or history switching. Return
  the original bytes without rewriting this field. Query run-info for the current
  history session_id and session_file.

Use the runtime's guarded paths and fixed source mapping. Reject symlinks,
nonregular files, and missing sources. Do not expose host paths, arbitrary bundle
files, configuration, credentials, or tool sockets. Return actual_bundle from the
frozen run record and verify consistency with the active session.

Immediately before reading and again after reading, run_tau checks that the
record is running and the same active RPC session instance is still registered
for that run. If either check fails, reject with RUN_NOT_ACTIVE. Tau checks its
own active Pi child and run again after receiving the response. These checks do
not guarantee that Pi remains alive after the response is sent. Reads must not
extend the run lifetime, delay termination, or persist additional records.

## Error mapping

Use the existing error envelope: type, protocol_version, code, message, and the
existing optional run_id. The safe reason is the message field; do not add reason,
detail, path, or other fields. Use exactly the following messages, without dynamic
exception text, host paths, or tracebacks.

| Condition | code | message |
| --- | --- | --- |
| Invalid protocol version | UNSUPPORTED_VERSION | 协议版本不支持 |
| Missing workspace_id | WORKSPACE_REQUIRED | 必须指定工作区 |
| Malformed identifiers, missing fields other than workspace_id, extra fields, or invalid request structure | PROTOCOL_ERROR | 控制请求非法 |
| No record for run_id within the socket user's records, including a run belonging to another user | RUN_NOT_FOUND | 运行记录不存在 |
| Record workspace_id differs from the request | WORKSPACE_NOT_FOUND | 工作区未登记 |
| Run is not running, is not RPC, has no active instance, or the active instance ended or changed during the read | RUN_NOT_ACTIVE | 运行已结束 |
| name is not exactly AGENTS.md or RUNTIME.json, including paths or traversal; source path escapes its allowed root or contains a symlink | PATH_INVALID | 路径不属于工作区或不安全 |
| Source file is missing | RUNTIME_FILE_UNAVAILABLE | 运行时文件不存在 |
| Source is not a regular file | RUNTIME_FILE_UNAVAILABLE | 运行时文件不是普通文件 |
| Source bytes are not valid UTF-8 | RUNTIME_FILE_UNAVAILABLE | 运行时文件不是有效 UTF-8 文本 |
| Source exceeds 131072 bytes | RUNTIME_FILE_UNAVAILABLE | 运行时文件超过 128 KiB 限制 |
| Source cannot be read for another I/O reason | RUNTIME_FILE_UNAVAILABLE | 运行时文件无法读取 |
| Frozen bundle and active session disagree | BUNDLE_INVALID | 快照缺失或摘要不一致 |
| Encoded control frame exceeds 262144 bytes including LF | FRAME_TOO_LARGE | 控制帧超限 |

Apply request structure and version validation first, then the filename allowlist,
user-scoped run lookup, workspace ownership, active RPC checks, and source checks.
Check the size before decoding UTF-8. After attempting the read, repeat the active
instance check before returning contents or a source-read error: RUN_NOT_ACTIVE
wins if the run ended during the attempt. FRAME_TOO_LARGE is reserved for the
wire frame limit; it does not describe a file exceeding the 128 KiB source limit.
The existing transport errors and their fixed messages remain unchanged.

Older runtimes rejecting run-file remain usable; Tau shows a clear unavailable
message and never falls back to placeholders.

## Tau behavior and acceptance

File listing, text preview, and download use the owning live Tau session's run_id.
The browser's sidebar selection does not participate. Tau checks all response
identity fields and actual_bundle against that run, and checks the run again
after the read. The root listing labels both files as runtime read-only and shows
actual byte counts or an unavailable reason. Preview and download use the same
reader. Successful previews pin their downloads and refreshes to the returned
run_id. Responses are not cached.

Check with real Pi/run_tau after implementation:

1. Start run A on bundle v1. Both files match the files mounted in Pi, for listing,
   preview, and download.
2. Move the workspace to v2 and start run B. A still returns v1 AGENTS.md and A's
   metadata; B returns v2 and B's metadata.
3. Switch the sidebar, open multiple live tabs, and reconnect. Files stay bound
   to their originating live session and run.
4. Reject other users' runs, mismatched workspace/run IDs, arbitrary filenames,
   traversal, symlinks, oversized files, and stopped runs.
5. Fork or switch history within run A's existing Pi process. After identity
   synchronization completes, both runtime files still match the original mounted
   bytes and actual bundle. RUNTIME.json.session_id still equals A's run_id;
   run-info instead reports the new current history identity. Preview and download
   must not rewrite the runtime JSON from run-info.
6. Stop a run before a read and during a read. Verify the lifecycle checks reject
   both cases, without requiring a successful response to keep the run alive.
7. With an older runtime or missing file, show an unavailable reason and never
   return the host placeholder's zero bytes as real content.

## Tau validation

Type checking passed. The unit suite passed 339 tests with 6 existing skips.
The browser suite passed 121 tests with no skips in about 28 seconds. After
adding malformed-content and run-termination checks, all 11 workspace tests
passed again. Coverage includes response identity and bundle mismatches,
invalid UTF-8, size mismatches, oversized responses, stopping during a read,
missing live sessions, nested ordinary files, and unsupported runtimes.
Browser coverage checks both the visible read-only label and unavailable state,
and verifies preview refresh and download request ownership after sidebar changes.
These tests use a fixture bridge; they do not replace real runtime acceptance.

## Real Pi acceptance (2026-11-06)

The local image localhost/pi-tau-web-server:1.2.1-dev has ID
562cbf094acd38cd53bfe108d97e7d9b42393f5f520c398d3d8aca08c45b18e2.
It includes the theme fix and runtime file adapter. The joint harness used the
updated run_tau source, real Pi image agent-bundle:1.1.0, an offline fixture
provider, synthetic users, and a disposable deployment root.

Both runtime files matched the bytes mounted in Pi, including trailing newlines,
through HTTP preview and download; file listings showed the real byte sizes.
Fork, extension-created history, and explicit history switching changed run-info
without changing either runtime file. Existing v1 and new v2 runs in the same
workspace returned their own frozen instructions. Chromium verified read-only
labels, previews, and downloaded bytes after sidebar switching and reconnects.
Cross-user and mismatched-workspace HTTP requests and stopped-session downloads
were rejected. Test containers were cleaned up.

The full joint log is /tmp/tau-runtime-image-joint.log; the image build log is
/tmp/tau-runtime-image-build.log. Type checking and git diff --check passed.
No existing supervisor or user container was restarted; no image was published.
