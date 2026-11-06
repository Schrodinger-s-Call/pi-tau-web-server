import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
const { checkedPath, toPiPath, fromPiPath, listWorkspaces, requireWorkspace, readFrames, FRAME_LIMIT } = await import('../bin/workspaces.js') as any;
const { RunIdentity } = await import('../bin/run-identity.js') as any;
const { PiRpcSession, LiveSessionManager, _setSpawnPiForTest, server } = await import('../bin/tau.js') as any;
const bundle = { name: 'one', sha256: 'a'.repeat(64), commit: null };

async function fixture(t: any) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-ws-'));
  const workspaces = ['debug', 'exp1'].map(workspace_id => {
    const paths = { files: path.join(root, workspace_id, 'files'), sessions: path.join(root, workspace_id, 'sessions') };
    for (const dir of Object.values(paths)) fs.mkdirSync(dir, { recursive: true });
    fs.mkdirSync(path.join(paths.sessions, 'project'));
    fs.writeFileSync(path.join(paths.sessions, 'project', 'same.jsonl'), JSON.stringify({ type: 'session', id: 'same', cwd: '/workspace' }) + '\n');
    fs.writeFileSync(path.join(paths.files, 'report.txt'), workspace_id);
    return { workspace_id, display_name: workspace_id, paths, current_bundle: { ...bundle } };
  });
  const requests: any[] = [];
  let respond = (request: any) => request.type === 'workspaces'
    ? { type: 'workspaces', protocol_version: 1, revision: 1, workspaces }
    : { type: 'session-updated', protocol_version: 1, run_id: request.run_id, workspace_id: request.workspace_id, seq: request.seq, session_id: request.session_id, session_file: request.session_file };
  const socket = path.join(root, 'bridge.sock');
  const bridge = net.createServer(connection => {
    readFrames(connection, (request: any) => { requests.push(request); connection.end(JSON.stringify(respond(request)) + '\n'); }, () => connection.destroy());
  });
  await new Promise<void>(resolve => bridge.listen(socket, resolve));
  const oldSocket = process.env.GPAS_TAU_SOCKET;
  const oldMode = process.env.TAU_WORKSPACE_MODE;
  process.env.GPAS_TAU_SOCKET = socket;
  process.env.TAU_WORKSPACE_MODE = 'bridge';
  t.after(async () => {
    _setSpawnPiForTest(null);
    if (oldSocket === undefined) delete process.env.GPAS_TAU_SOCKET; else process.env.GPAS_TAU_SOCKET = oldSocket;
    if (oldMode === undefined) delete process.env.TAU_WORKSPACE_MODE; else process.env.TAU_WORKSPACE_MODE = oldMode;
    await new Promise<void>(resolve => bridge.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, workspaces, requests, setRespond: (fn: typeof respond) => { respond = fn; } };
}

test('directory queries reject missing identity, overlapping roots, and symbolic links', async t => {
  const f = await fixture(t);
  assert.equal((await listWorkspaces()).workspaces.length, 2);
  await assert.rejects(requireWorkspace(undefined), /required/);
  await assert.rejects(requireWorkspace('other'), /Unknown/);
  const w = f.workspaces[0];
  assert.equal(toPiPath(w, path.join(w.paths.sessions, 'project/same.jsonl'), 'sessions'), '/root/.pi/agent/sessions/project/same.jsonl');
  assert.equal(fromPiPath(w, '/workspace/report.txt', 'files'), path.join(w.paths.files, 'report.txt'));
  assert.throws(() => fromPiPath(w, '/workspace/../secret', 'files'), /Invalid/);
  assert.throws(() => checkedPath(w.paths.files, f.workspaces[1].paths.files), /outside/);
  fs.symlinkSync(f.workspaces[1].paths.files, path.join(w.paths.files, 'link'));
  assert.throws(() => checkedPath(w.paths.files, 'link/report.txt'), /Symbolic/);
  assert.throws(() => checkedPath(w.paths.files, 'link/missing.txt', true), /Symbolic/);
  f.workspaces[1].paths.files = w.paths.files;
  await assert.rejects(listWorkspaces(), /overlap/);
});

test('bounded framing handles split Unicode and rejects oversized incomplete frames', () => {
  const input = new PassThrough();
  const frames: any[] = [];
  const errors: Error[] = [];
  readFrames(input, (frame: any) => frames.push(frame), (error: Error) => errors.push(error));
  const bytes = Buffer.from('{"name":"实验"}\n');
  for (const byte of bytes) input.write(Buffer.from([byte]));
  assert.equal(frames[0].name, '实验');
  input.write(Buffer.alloc(FRAME_LIMIT, 65));
  assert.equal(errors.length, 1);
  input.end();
});

test('identity updates retry the same sequence and preserve later transitions', async t => {
  const f = await fixture(t);
  let failures = 1;
  f.setRespond((request: any) => failures-- > 0
    ? { type: 'error', protocol_version: 1, code: 'QUERY_TIMEOUT', message: 'Try again' } as any
    : { type: 'session-updated', protocol_version: 1, run_id: request.run_id, workspace_id: request.workspace_id, seq: request.seq, session_id: request.session_id, session_file: request.session_file });
  const identity = new RunIdentity('1'.repeat(32), 'debug', () => {});
  t.after(() => identity.stop());
  identity.update({ session_id: 'one', session_file: '/root/.pi/agent/sessions/one.jsonl' });
  identity.update({ session_id: 'two', session_file: '/root/.pi/agent/sessions/two.jsonl' });
  await new Promise(resolve => setTimeout(resolve, 1200));
  assert.deepEqual(f.requests.map(r => r.seq), [1, 1, 2]);
  assert.equal(identity.pending, false);
});

function fakeChild(w: any, runId: string, options: { fail?: boolean } = {}) {
  const child: any = new EventEmitter();
  child.pid = 1; child.exitCode = null; child.signalCode = null;
  child.stdout = new PassThrough(); child.stderr = new PassThrough();
  const metadata = new PassThrough();
  let current = 'same';
  child.setIdentity = (value: string) => { current = value; };
  child.stdin = { writable: true, write(line: string, callback: any) {
    const request = JSON.parse(line);
    if (request.type === 'fork') { current = 'forked'; fs.writeFileSync(path.join(w.paths.sessions, 'project/forked.jsonl'), JSON.stringify({ type: 'session', id: current }) + '\n'); }
    let data: any = {};
    if (request.type === 'get_state') data = { sessionId: current, sessionFile: `/root/.pi/agent/sessions/project/${current}.jsonl` };
    if (request.type === 'get_entries') data = { entries: [] };
    if (request.type === 'get_tree') data = { tree: [], leafId: null };
    queueMicrotask(() => child.stdout.write(JSON.stringify({ type: 'response', command: request.type, id: request.id, success: true, data }) + '\n'));
    callback?.();
    return true;
  } };
  child.stdio = [child.stdin, child.stdout, child.stderr, metadata];
  child.kill = () => { child.exitCode = 0; child.emit('exit', 0, null); };
  setTimeout(() => {
    if (options.fail) { child.kill(); return; }
    metadata.write(JSON.stringify({ type: 'ready', protocol_version: 1, run_id: runId, workspace_id: w.workspace_id, session_id: current, session_file: `/root/.pi/agent/sessions/project/${current}.jsonl`, seq: 0, kind: 'rpc', actual_bundle: { ...bundle }, started_at: new Date().toISOString() }) + '\n');
  }, 5);
  return child;
}

test('children keep independent contexts and actual bundles while fork updates the same run', async t => {
  const f = await fixture(t);
  const manager = new LiveSessionManager();
  const calls: any[] = [];
  _setSpawnPiForTest((_command: string, args: string[], options: any) => {
    calls.push({ args, options });
    const w = f.workspaces.find(w => w.workspace_id === options.env.GPAS_TAU_WORKSPACE_ID);
    return fakeChild(w, String(calls.length).repeat(32));
  });
  const [a, b] = await Promise.all(f.workspaces.map(w => manager.create({ workspace_id: w.workspace_id })));
  t.after(async () => { a.identity.stop(); b.identity.stop(); await manager.shutdown(); });
  assert.equal(calls[0].options.env.GPAS_TAU_CWD, '/workspace');
  assert.equal(calls[1].options.env.GPAS_TAU_WORKSPACE_ID, 'exp1');
  assert.equal(process.env.GPAS_TAU_WORKSPACE_ID, undefined);
  assert.equal(calls[0].options.stdio.length, 4);
  assert.notEqual(a.sessionFile, b.sessionFile);
  assert.equal(f.requests.filter(r => r.type === 'session-update').length, 0);
  f.workspaces[0].current_bundle.name = 'two';
  await a.send({ type: 'fork', entryId: 'entry' });
  assert.equal(a.piSessionId, 'forked');
  assert.equal(a.run.run_id, '1'.repeat(32));
  assert.equal(a.run.actual_bundle.name, 'one');
  assert.equal(b.piSessionId, 'same');
  fs.writeFileSync(path.join(a.workspace.paths.sessions, 'project/extension.jsonl'), JSON.stringify({ type: 'session', id: 'extension-fork' }) + '\n');
  a.child.setIdentity('extension-fork');
  fs.writeFileSync(path.join(a.workspace.paths.sessions, 'project/extension-fork.jsonl'), JSON.stringify({ type: 'session', id: 'extension-fork' }) + '\n');
  a.handleEvent({ type: 'extension_ui_request', method: 'setStatus', statusKey: 'tau_session_identity', statusText: JSON.stringify({ sessionId: 'extension-fork', sessionFile: '/root/.pi/agent/sessions/project/extension-fork.jsonl' }) });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(a.piSessionId, 'extension-fork');
  await a.identity.flush();
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.ok(f.requests.some(r => r.type === 'session-update' && r.session_id === 'extension-fork' && r.run_id === '1'.repeat(32)));
  const existing = await manager.resume({ workspace: b.workspace, cwd: b.cwd, sessionFile: b.sessionFile });
  assert.equal(existing, b);
  assert.equal(calls.length, 2);
});

test('startup fails without ready and does not register a live session', async t => {
  const f = await fixture(t);
  const manager = new LiveSessionManager();
  _setSpawnPiForTest(() => fakeChild(f.workspaces[0], 'f'.repeat(32), { fail: true }));
  await assert.rejects(manager.create({ workspace_id: 'debug' }), /exited/);
  assert.equal(manager.sessions.size, 0);
});

test('HTTP histories with copied IDs stay separate and file requests reject another workspace', async t => {
  const f = await fixture(t);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = async (url: string) => fetch(base + url);
  const histories = await (await get('/api/sessions')).json() as any;
  assert.equal(histories.projects.length, 2);
  assert.equal(histories.projects[0].sessions[0].id, histories.projects[1].sessions[0].id);
  const a = f.workspaces[0], b = f.workspaces[1];
  const response = await get(`/api/file/download?workspace_id=debug&path=${encodeURIComponent(path.join(a.paths.files, 'report.txt'))}`);
  assert.equal(await response.text(), 'debug');
  assert.equal((await get(`/api/file/download?workspace_id=debug&path=${encodeURIComponent(path.join(b.paths.files, 'report.txt'))}`)).status, 400);
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aO1sAAAAASUVORK5CYII=', 'base64');
  fs.writeFileSync(path.join(a.paths.files, 'chart.png'), png);
  fs.symlinkSync(path.join(a.paths.files, 'chart.png'), path.join(a.paths.files, 'linked.png'));
  const image = (workspace: string, file: string) => get(`/api/file/image?${new URLSearchParams({ workspace_id: workspace, path: file })}`);
  const displayed = await image('debug', '/workspace/chart.png');
  assert.equal(displayed.status, 200);
  assert.equal(displayed.headers.get('content-type'), 'image/png');
  assert.equal(displayed.headers.get('content-disposition'), 'inline');
  assert.deepEqual(Buffer.from(await displayed.arrayBuffer()), png);
  assert.equal((await image('exp1', path.join(a.paths.files, 'chart.png'))).status, 400);
  assert.equal((await image('debug', '../chart.png')).status, 400);
  assert.equal((await image('debug', 'linked.png')).status, 400);
  assert.equal((await image('debug', 'report.txt')).status, 400);
  assert.equal((await image('', 'chart.png')).status, 400);
  const upload = (body: unknown) => fetch(base + '/api/file/upload', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await upload({ workspace_id: 'debug', name: 'uploaded.txt', data: Buffer.from('material').toString('base64') })).status, 200);
  assert.equal(fs.readFileSync(path.join(a.paths.files, 'uploaded.txt'), 'utf8'), 'material');
  assert.equal(fs.existsSync(path.join(b.paths.files, 'uploaded.txt')), false);
  assert.equal((await upload({ workspace_id: 'debug', name: '../escape.txt', data: '' })).status, 400);
  assert.equal((await upload({ workspace_id: 'debug', name: 'report.txt', data: '' })).status, 400);
  assert.equal((await upload({ workspace_id: 'debug', path: b.paths.files, name: 'escape.txt', data: '' })).status, 400);
  const deletion = await fetch(base + '/api/sessions/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workspace_id: 'debug', filePath: path.join(a.paths.sessions, 'project/same.jsonl') }) });
  assert.equal(deletion.status, 200);
  assert.ok(fs.existsSync(path.join(b.paths.sessions, 'project/same.jsonl')));
  const missing = await fetch(base + '/api/live-sessions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(missing.status, 400);
});

function record(runId: string, seq: number, identity: any, state = 'running') {
  return { type: 'run-info', protocol_version: 1, run: { run_id: runId, workspace_id: 'debug', kind: 'rpc', state,
    initial_session_id: 'same', initial_session_file: '/root/.pi/agent/sessions/project/same.jsonl',
    ...identity, seq, actual_bundle: bundle, started_at: '2026-11-06T01:00:00+00:00', finished_at: null, exit_code: null } };
}

test('lost acknowledgements are reconciled with the persisted run after bounded retries', async t => {
  const f = await fixture(t);
  const runId = 'b'.repeat(32);
  const next = { session_id: 'next', session_file: '/root/.pi/agent/sessions/next.jsonl' };
  f.setRespond((request: any) => request.type === 'session-update'
    ? { type: 'error', protocol_version: 1, code: 'QUERY_TIMEOUT', message: 'Timed out' } as any
    : record(runId, 1, next) as any);
  let failed = false;
  const sync = new RunIdentity(runId, 'debug', () => {}, () => { failed = true; });
  sync.initialize({ session_id: 'same', session_file: '/root/.pi/agent/sessions/project/same.jsonl' });
  sync.update(next);
  await sync.flush();
  assert.deepEqual(f.requests.map(r => r.type), ['session-update', 'session-update', 'session-update', 'run-info']);
  assert.equal(sync.seq, 1);
  assert.equal(sync.pending, false);
  assert.equal(failed, false);
});

test('a conflicting update fails its owner without advancing the sequence', async t => {
  const f = await fixture(t);
  const runId = 'c'.repeat(32);
  f.setRespond((request: any) => request.type === 'session-update'
    ? { type: 'error', protocol_version: 1, code: 'SESSION_IN_USE', message: 'History is in use' } as any
    : record(runId, 0, { session_id: 'same', session_file: '/root/.pi/agent/sessions/project/same.jsonl' }) as any);
  let failed = false;
  const sync = new RunIdentity(runId, 'debug', () => {}, () => { failed = true; });
  sync.update({ session_id: 'other', session_file: '/root/.pi/agent/sessions/other.jsonl' });
  await sync.flush();
  assert.equal(failed, true);
  assert.equal(sync.pending, true);
  assert.equal(sync.seq, 0);
  assert.equal(f.requests.filter(r => r.type === 'session-update').length, 1);
});

test('new initial history stays at sequence zero until a different identity is verified on disk', async t => {
  const f = await fixture(t);
  const { validateHistoryIdentity } = await import('../bin/workspaces.js') as any;
  const w = f.workspaces[0];
  const initial = { session_id: 'new', session_file: '/root/.pi/agent/sessions/project/new.jsonl' };
  const sync = new RunIdentity('d'.repeat(32), 'debug', () => {}, () => assert.fail('Unexpected failure'),
    (identity: any) => validateHistoryIdentity(w, identity.session_id, identity.session_file));
  t.after(() => sync.stop());
  sync.initialize(initial);
  sync.update(initial);
  await sync.flush();
  assert.equal(f.requests.length, 0);
  const next = { session_id: 'next', session_file: '/root/.pi/agent/sessions/project/next.jsonl' };
  sync.update(next);
  assert.equal(sync.pending, true);
  assert.equal(f.requests.length, 0);
  fs.writeFileSync(path.join(w.paths.sessions, 'project/next.jsonl'), JSON.stringify({ type: 'session', id: 'next' }) + '\n');
  await sync.flush();
  assert.equal(sync.seq, 1);
  assert.equal(sync.pending, false);
});

test('invalid encodings, carriage returns, arrays, and unknown control fields are rejected', async () => {
  const { validateControl } = await import('../bin/workspace-protocol.js') as any;
  for (const bytes of [Buffer.from([0xff, 10]), Buffer.from('{}\r\n'), Buffer.from('[]\n'), Buffer.from([0xef, 0xbb, 0xbf, 123, 125, 10])]) {
    const stream = new PassThrough();
    let failed = false;
    readFrames(stream, () => assert.fail('Invalid frame accepted'), () => { failed = true; });
    stream.end(bytes);
    assert.equal(failed, true);
  }
  assert.throws(() => validateControl({ type: 'workspaces', protocol_version: 1, revision: 0, workspaces: [], extra: true }));
  assert.throws(() => validateControl({ type: 'result', protocol_version: 1, revision: 0, workspaces: [] }));
  assert.throws(() => validateControl({ type: 'workspaces', protocol_version: 1, revision: true, workspaces: [] }));
});
