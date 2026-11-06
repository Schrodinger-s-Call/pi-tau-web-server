import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-export-'));
const command = path.join(root, 'pi-test.mjs');
process.env.TAU_PI_COMMAND = command;
process.env.TAU_WORKSPACE_MODE = 'bridge';
process.env.GPAS_TAU_SOCKET = path.join(root, 'bridge.sock');
process.env.TAU_TEST_EXPORT_ROOT = root;
const { handleRpcCommand, liveManager, _setExecFileForTest } = await import('../bin/tau.js') as any;
const { readFrames } = await import('../bin/workspaces.js') as any;

fs.writeFileSync(command, `#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2);
const kind = args[0] === '--list-models' ? 'models' : 'export';
const common = { protocol_version: 1, run_id: 'a'.repeat(32), workspace_id: process.env.GPAS_TAU_WORKSPACE_ID, kind, actual_bundle: { name: 'current', sha256: 'a'.repeat(64), commit: null } };
const metadata = frame => fs.writeSync(3, JSON.stringify(frame) + '\\n');
metadata({ ...common, type: 'started', session_id: null, session_file: null, seq: 0, started_at: new Date().toISOString() });
if (process.env.GPAS_TAU_CWD !== '/workspace' || process.env.GPAS_TAU_PROTOCOL_VERSION !== '1') process.exit(3);
if (kind === 'models') console.log('test  model  1000  100  yes  no');
else {
  if (args[1] !== '/root/.pi/agent/sessions/project/same.jsonl') process.exit(2);
  const output = args[2];
  const local = path.join(process.env.TAU_TEST_EXPORT_ROOT, process.env.GPAS_TAU_WORKSPACE_ID, 'sessions', path.relative('/root/.pi/agent/sessions', output));
  fs.writeFileSync(local, process.env.GPAS_TAU_WORKSPACE_ID);
  console.log('Exported to: ' + output);
}
metadata({ ...common, type: 'completed', finished_at: new Date().toISOString(), exit_code: 0 });
`, { mode: 0o700 });

test('exports map both directions and model enumeration uses the live Pi when available', async t => {
  const workspaces = ['debug', 'exp1'].map(workspace_id => {
    const paths = { files: path.join(root, workspace_id, 'files'), sessions: path.join(root, workspace_id, 'sessions') };
    fs.mkdirSync(paths.files, { recursive: true });
    fs.mkdirSync(path.join(paths.sessions, 'project'), { recursive: true });
    fs.writeFileSync(path.join(paths.sessions, 'project/same.jsonl'), '{"type":"session","id":"same"}\n');
    return { workspace_id, display_name: workspace_id, paths, current_bundle: { name: 'current', sha256: 'a'.repeat(64), commit: null } };
  });
  const bridge = net.createServer(socket => readFrames(socket, () => socket.end(JSON.stringify({ type: 'workspaces', protocol_version: 1, revision: 1, workspaces }) + '\n'), () => socket.destroy()));
  await new Promise<void>(resolve => bridge.listen(process.env.GPAS_TAU_SOCKET, resolve));
  t.after(async () => {
    _setExecFileForTest(null);
    liveManager.sessions.clear();
    await new Promise<void>(resolve => bridge.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  });
  for (const w of workspaces) {
    const result = await handleRpcCommand({ type: 'export_html', workspace_id: w.workspace_id, filePath: path.join(w.paths.sessions, 'project/same.jsonl') });
    assert.equal(result.success, true, result.error);
    assert.equal(fs.readFileSync(result.data.path, 'utf8'), w.workspace_id);
    assert.match(result.data.downloadUrl, new RegExp(`workspace_id=${w.workspace_id}`));
  }
  const cross = await handleRpcCommand({ type: 'export_html', workspace_id: 'debug', filePath: path.join(workspaces[1].paths.sessions, 'project/same.jsonl') });
  assert.equal(cross.success, false);
  const models = await handleRpcCommand({ type: 'get_available_models', workspace_id: 'debug' });
  assert.equal(models.success, true, models.error);
  assert.equal(models.data.models[0].provider, 'test');
  liveManager.sessions.set('live', {
    workspace: workspaces[0], cwd: workspaces[0].paths.files,
    send: async (request: any) => ({ success: true, data: { models: [{ provider: 'old', id: request.type }] } }),
  });
  const live = await handleRpcCommand({ type: 'get_available_models', sessionId: 'live' });
  assert.equal(live.data.models[0].provider, 'old');
  const fork = await handleRpcCommand({ type: 'fork', sessionId: 'live', entryId: 'entry' });
  assert.equal(fork.success, true, fork.error);
  assert.equal(fork.data.models[0].id, 'fork');
  const wrong = await handleRpcCommand({ type: 'get_available_models', sessionId: 'live', workspace_id: 'exp1' });
  assert.equal(wrong.success, false);
});
