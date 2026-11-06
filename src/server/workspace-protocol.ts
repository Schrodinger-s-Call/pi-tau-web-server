export const FRAME_LIMIT = 262144;
export function protocolError(message = 'Invalid workspace protocol', code = 'PROTOCOL_ERROR') { return Object.assign(new Error(message), { code }); }
export function objectFields(value: any, required: string[], optional: string[] = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || required.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) throw protocolError();
}
export function validId(value: unknown): value is string { return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value); }
export function validRunId(value: unknown): value is string { return typeof value === 'string' && /^[a-f0-9]{32}$/.test(value); }
const number = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const time = (value: unknown) => typeof value === 'string' && /(?:Z|\+00:00)$/.test(value) && Number.isFinite(Date.parse(value));
export function validBundle(value: any): boolean {
  try { objectFields(value, ['name', 'sha256', 'commit']); } catch { return false; }
  return typeof value.name === 'string' && !!value.name && typeof value.sha256 === 'string' && /^[a-f0-9]{64}$/.test(value.sha256) && (value.commit === null || typeof value.commit === 'string');
}
export function validSessionFile(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith('/root/.pi/agent/sessions/') && value.endsWith('.jsonl') && !value.includes('\0') && value.split('/').slice(1).every(part => !!part && part !== '.' && part !== '..');
}
export function validateControl(frame: any) {
  if (!frame || typeof frame !== 'object' || Array.isArray(frame)) throw protocolError();
  if (frame.protocol_version !== 1) throw protocolError('Unsupported workspace protocol', 'UNSUPPORTED_VERSION');
  const common = ['type', 'protocol_version'];
  const identity = ['run_id', 'workspace_id', 'seq', 'session_id', 'session_file'];
  const started = [...identity, 'kind', 'actual_bundle', 'started_at'];
  switch (frame.type) {
    case 'error':
      objectFields(frame, [...common, 'code', 'message'], ['run_id']);
      if (typeof frame.code !== 'string' || !frame.code || typeof frame.message !== 'string' || ('run_id' in frame && !validRunId(frame.run_id))) throw protocolError();
      return frame;
    case 'workspaces':
      objectFields(frame, [...common, 'revision', 'workspaces']);
      if (!number(frame.revision) || !Array.isArray(frame.workspaces)) throw protocolError();
      for (const w of frame.workspaces) {
        objectFields(w, ['workspace_id', 'display_name', 'paths', 'current_bundle']);
        objectFields(w.paths, ['files', 'sessions']);
        if (!validId(w.workspace_id) || typeof w.display_name !== 'string' || typeof w.paths.files !== 'string' || typeof w.paths.sessions !== 'string' || !validBundle(w.current_bundle)) throw protocolError();
      }
      return frame;
    case 'run-file': {
      objectFields(frame, [...common, 'run_id', 'workspace_id', 'name', 'actual_bundle', 'size', 'content_base64']);
      if (!validRunId(frame.run_id) || !validId(frame.workspace_id) || !['AGENTS.md', 'RUNTIME.json'].includes(frame.name) || !validBundle(frame.actual_bundle) || !number(frame.size) || frame.size > 128 * 1024 || typeof frame.content_base64 !== 'string') throw protocolError();
      const bytes = Buffer.from(frame.content_base64, 'base64');
      if (bytes.length !== frame.size || bytes.toString('base64') !== frame.content_base64) throw protocolError();
      return frame;
    }
    case 'run-info': {
      objectFields(frame, [...common, 'run']);
      const run = frame.run;
      objectFields(run, [...started, 'state', 'initial_session_id', 'initial_session_file', 'finished_at', 'exit_code']);
      if (!validRunId(run.run_id) || !validId(run.workspace_id) || !number(run.seq) || !['rpc', 'models', 'export'].includes(run.kind) || !['starting', 'running', 'exited', 'failed', 'interrupted'].includes(run.state) || !validBundle(run.actual_bundle) || !time(run.started_at) || (run.finished_at !== null && !time(run.finished_at)) || (run.exit_code !== null && !Number.isInteger(run.exit_code))) throw protocolError();
      for (const key of ['session_id', 'initial_session_id']) if (run[key] !== null && !validId(run[key])) throw protocolError();
      for (const key of ['session_file', 'initial_session_file']) if (run[key] !== null && !validSessionFile(run[key])) throw protocolError();
      if (run.kind === 'rpc' && run.state === 'running' && (!run.session_id || !run.session_file)) throw protocolError();
      return frame;
    }
    case 'session-updated':
      objectFields(frame, [...common, ...identity]);
      if (!validRunId(frame.run_id) || !validId(frame.workspace_id) || !number(frame.seq) || !validId(frame.session_id) || !validSessionFile(frame.session_file)) throw protocolError();
      return frame;
    case 'ready':
    case 'started':
      objectFields(frame, [...common, ...started]);
      if (!validRunId(frame.run_id) || !validId(frame.workspace_id) || frame.seq !== 0 || !validBundle(frame.actual_bundle) || !time(frame.started_at)) throw protocolError();
      if (frame.type === 'ready' ? frame.kind !== 'rpc' || !validId(frame.session_id) || !validSessionFile(frame.session_file) : !['models', 'export'].includes(frame.kind) || frame.session_id !== null || frame.session_file !== null) throw protocolError();
      return frame;
    case 'completed':
      objectFields(frame, [...common, 'run_id', 'workspace_id', 'kind', 'actual_bundle', 'finished_at', 'exit_code']);
      if (!validRunId(frame.run_id) || !validId(frame.workspace_id) || !['rpc', 'models', 'export'].includes(frame.kind) || !validBundle(frame.actual_bundle) || !time(frame.finished_at) || !Number.isInteger(frame.exit_code)) throw protocolError();
      return frame;
    default: throw protocolError();
  }
}
