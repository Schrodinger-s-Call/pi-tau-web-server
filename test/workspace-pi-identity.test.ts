import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { test } from 'node:test';
import assert from 'node:assert/strict';

test('real Pi reports fork and switch identities through the Tau lifecycle extension', async () => {
  const repo = path.resolve(import.meta.dirname, '..');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-pi-identity-'));
  const file = path.join(root, 'history.jsonl');
  const timestamp = new Date().toISOString();
  fs.writeFileSync(file, [
    { type: 'session', version: 3, id: 'test-original', timestamp, cwd: root },
    { type: 'message', id: 'user1', parentId: null, timestamp, message: { role: 'user', content: 'First question', timestamp: Date.now() } },
    { type: 'message', id: 'user2', parentId: 'user1', timestamp, message: { role: 'user', content: 'Second question', timestamp: Date.now() } },
  ].map(entry => JSON.stringify(entry)).join('\n') + '\n');
  const cancelExtension = path.join(root, 'cancel.ts');
  fs.writeFileSync(cancelExtension, `export default function (pi) { pi.on('session_before_fork', event => ({ cancel: event.entryId === 'user1' })); }`);
  const child = spawn(process.execPath, [
    path.join(repo, 'node_modules/@earendil-works/pi-coding-agent/dist/cli.js'),
    '--mode', 'rpc', '--session', file,
    '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-themes',
    '--extension', path.join(repo, 'src/pi-extension/tau-tree.ts'),
    '--extension', cancelExtension,
  ], {
    cwd: root,
    env: { PATH: process.env.PATH, HOME: root, PI_CODING_AGENT_DIR: path.join(root, 'agent') },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const pending = new Map<string, (frame: any) => void>();
  const notices: Array<{ sessionId: string; sessionFile: string }> = [];
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  readline.createInterface({ input: child.stdout }).on('line', line => {
    const frame = JSON.parse(line);
    if (frame.method === 'setStatus' && frame.statusKey === 'tau_session_identity') notices.push(JSON.parse(frame.statusText));
    const resolve = pending.get(frame.id);
    if (resolve) { pending.delete(frame.id); resolve(frame); }
  });
  let count = 0;
  const rpc = (type: string, body: Record<string, unknown> = {}): Promise<any> => new Promise((resolve, reject) => {
    const id = String(++count);
    const timer = setTimeout(() => reject(new Error(`Timeout waiting for ${type}: ${stderr}`)), 15000);
    pending.set(id, frame => { clearTimeout(timer); resolve(frame); });
    child.stdin.write(JSON.stringify({ type, id, ...body }) + '\n');
  });
  try {
    const first = await rpc('get_state');
    const noticeCount = notices.length;
    const cancelled = await rpc('fork', { entryId: 'user1' });
    assert.equal(cancelled.data.cancelled, true);
    assert.equal(notices.length, noticeCount);
    assert.equal((await rpc('get_state')).data.sessionId, first.data.sessionId);
    const fork = await rpc('fork', { entryId: 'user2' });
    const second = await rpc('get_state');
    const switched = await rpc('switch_session', { sessionPath: file });
    const third = await rpc('get_state');
    assert.equal(first.success, true);
    assert.equal(fork.success, true);
    assert.equal(fork.data.cancelled, false);
    assert.notEqual(second.data.sessionId, first.data.sessionId);
    assert.equal(switched.success, true);
    assert.equal(third.data.sessionId, first.data.sessionId);
    assert.ok(notices.some(n => n.sessionId === second.data.sessionId && n.sessionFile === second.data.sessionFile));
    assert.equal(notices.at(-1)?.sessionId, third.data.sessionId);
    assert.equal(notices.at(-1)?.sessionFile, third.data.sessionFile);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise(resolve => child.once('exit', resolve));
      child.kill('SIGTERM');
      await exited;
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});
