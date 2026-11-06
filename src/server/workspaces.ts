import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import type { Readable } from 'node:stream';

import { FRAME_LIMIT, validateControl, validId, validBundle, protocolError } from './workspace-protocol.js';
export { FRAME_LIMIT, validBundle };
export const PI_FILES = '/workspace';
export const PI_SESSIONS = '/root/.pi/agent/sessions';
export type Bundle = { name: string; sha256: string; commit: string | null };
export type Workspace = { workspace_id: string; display_name: string; paths: { files: string; sessions: string }; current_bundle: Bundle };
export type Ready = { type: 'ready'; protocol_version: 1; run_id: string; workspace_id: string; kind: 'rpc'; session_id: string; session_file: string; seq: 0; actual_bundle: Bundle; started_at: string };
export function workspaceMode() { return process.env.TAU_WORKSPACE_MODE === 'bridge'; }
export function workspaceEnv(workspace: Workspace) {
  return { ...process.env, TAU_DISABLED: '1', GPAS_TAU_PROTOCOL_VERSION: '1', GPAS_TAU_WORKSPACE_ID: workspace.workspace_id, GPAS_TAU_CWD: PI_FILES, TAU_WORKSPACE_MODE: 'bridge' };
}

/** Read bounded lines, including when a producer splits a UTF-8 character across chunks. */
export function readFrames(stream: Readable, onFrame: (frame: any) => void, onError: (error: Error) => void) {
  let buffer = Buffer.alloc(0);
  let failed = false;
  const fail = (error: Error) => { if (!failed) { failed = true; onError(error); } };
  stream.on('data', (chunk: Buffer | string) => {
    if (failed) return;
    buffer = Buffer.concat([buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
    let end: number;
    while ((end = buffer.indexOf(10)) >= 0) {
      if (end + 1 > FRAME_LIMIT) return fail(protocolError('Bridge frame is too large', 'FRAME_TOO_LARGE'));
      const bytes = buffer.subarray(0, end);
      buffer = buffer.subarray(end + 1);
      try {
        if (bytes.includes(13) || (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf)) throw protocolError();
        const frame = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
        if (!frame || typeof frame !== 'object' || Array.isArray(frame)) throw protocolError();
        onFrame(frame);
      } catch (error) { return fail(error instanceof Error ? error : protocolError()); }
    }
    if (buffer.length >= FRAME_LIMIT) fail(protocolError('Bridge frame is too large', 'FRAME_TOO_LARGE'));
  });
  stream.on('error', () => fail(new Error('Bridge stream failed')));
  stream.on('end', () => { if (buffer.length) fail(new Error('Incomplete bridge frame')); });
}

export function bridgeQuery(request: Record<string, unknown>): Promise<any> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(process.env.GPAS_TAU_SOCKET || '/run/gpas-tau/bridge.sock');
    let settled = false;
    const finish = (error: Error | null, value?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error); else resolve(value);
    };
    const timer = setTimeout(() => finish(protocolError('Workspace service timed out', 'QUERY_TIMEOUT')), 2000);
    socket.on('connect', () => {
      const line = JSON.stringify({ ...request, protocol_version: 1 }) + '\n';
      if (Buffer.byteLength(line) > FRAME_LIMIT) return finish(new Error('Bridge request is too large'));
      socket.write(line);
    });
    socket.on('error', () => finish(protocolError('Workspace service unavailable', 'SOCKET_UNAVAILABLE')));
    socket.on('close', () => finish(new Error('Workspace service closed before replying')));
    readFrames(socket, frame => {
      try { validateControl(frame); } catch (error) { return finish(error as Error); }
      if (frame.type === 'error') return finish(Object.assign(new Error(typeof frame.message === 'string' ? frame.message : 'Workspace request failed'), { code: frame.code }));
      const expected = request.type === 'session-update' ? 'session-updated' : request.type;
      if (frame.type !== expected) return finish(protocolError());
      if (frame.type === 'run-info' && frame.run.run_id !== request.run_id) return finish(protocolError());
      finish(null, frame);
    }, error => finish(error));
  });
}

export const validWorkspaceId = validId;
export async function listWorkspaces(): Promise<{ revision: number; workspaces: Workspace[] }> {
  const result = await bridgeQuery({ type: 'workspaces' });
  if (result.type !== 'workspaces' || !Number.isSafeInteger(result.revision) || result.revision < 0 || !Array.isArray(result.workspaces)) throw new Error('Invalid workspace directory');
  const ids = new Set<string>();
  const roots: string[] = [];
  for (const w of result.workspaces) {
    if (!validWorkspaceId(w?.workspace_id) || ids.has(w.workspace_id) || typeof w.display_name !== 'string' || !validBundle(w.current_bundle)) throw new Error('Invalid workspace directory');
    ids.add(w.workspace_id);
    for (const root of [w.paths?.files, w.paths?.sessions]) {
      if (typeof root !== 'string' || !path.isAbsolute(root) || path.normalize(root) !== root || root === '/') throw new Error('Invalid workspace root');
      checkedPath(root, root);
      if (roots.some(other => inside(other, root) || inside(root, other))) throw new Error('Workspace roots overlap');
      roots.push(root);
    }
  }
  return { revision: result.revision, workspaces: result.workspaces };
}
export async function requireWorkspace(id: unknown): Promise<Workspace> {
  if (!validWorkspaceId(id)) throw new Error('workspace_id is required');
  const w = (await listWorkspaces()).workspaces.find(w => w.workspace_id === id);
  if (!w) throw new Error('Unknown workspace');
  return w;
}
export function inside(root: string, target: string) {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
}
/** Reject symlinks in every existing component, including the registered root. */
export function checkedPath(root: string, input: string, allowMissing = false) {
  if (input.includes('\0') || input.split('/').includes('..')) throw new Error('Path is outside the workspace');
  const target = path.resolve(root, input);
  if (!inside(path.resolve(root), target)) throw new Error('Path is outside the workspace');
  let current = path.parse(target).root;
  const parts = target.slice(current.length).split(path.sep).filter(Boolean);
  for (let i = 0; i < parts.length; i++) {
    current = path.join(current, parts[i]);
    try {
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink()) throw new Error('Symbolic links are not allowed');
      if (i < parts.length - 1 && !stat.isDirectory()) throw new Error('Invalid directory');
    } catch (error: any) {
      if (allowMissing && error.code === 'ENOENT') continue;
      throw error;
    }
  }
  return target;
}
export function toPiPath(w: Workspace, input: string, kind: 'files' | 'sessions', allowMissing = false) {
  const local = checkedPath(w.paths[kind], input, allowMissing);
  return path.posix.join(kind === 'files' ? PI_FILES : PI_SESSIONS, path.relative(w.paths[kind], local));
}
export function fromPiPath(w: Workspace, input: string, kind: 'files' | 'sessions', allowMissing = false) {
  const root = kind === 'files' ? PI_FILES : PI_SESSIONS;
  if (!path.isAbsolute(input) || path.posix.normalize(input) !== input || !inside(root, path.resolve(input))) throw new Error('Invalid Pi path');
  return checkedPath(w.paths[kind], path.relative(root, input), allowMissing);
}
export function historyPath(w: Workspace, input: string) {
  const file = checkedPath(w.paths.sessions, input);
  if (!file.endsWith('.jsonl') || !fs.statSync(file).isFile()) throw new Error('Invalid session file');
  return file;
}
export function workspaceFiles(w: Workspace, input: string, allowMissing = false) {
  return inside(PI_FILES, path.resolve(input)) ? fromPiPath(w, input, 'files', allowMissing) : checkedPath(w.paths.files, input, allowMissing);
}
export function validateReady(frame: any, w: Workspace): Ready {
  validateControl(frame);
  if (frame?.type !== 'ready' || frame.protocol_version !== 1 || frame.workspace_id !== w.workspace_id || frame.kind !== 'rpc' || typeof frame.run_id !== 'string' || !frame.run_id || typeof frame.session_id !== 'string' || !frame.session_id || typeof frame.session_file !== 'string' || !frame.session_file || frame.seq !== 0 || !validBundle(frame.actual_bundle) || typeof frame.started_at !== 'string' || !Number.isFinite(Date.parse(frame.started_at))) throw new Error('Invalid runtime ready metadata');
  return frame;
}

export function validateHistoryIdentity(w: Workspace, id: string, file: string) {
  const local = fromPiPath(w, file, 'sessions');
  historyPath(w, local);
  const fd = fs.openSync(local, 'r');
  try {
    const buffer = Buffer.alloc(FRAME_LIMIT);
    const length = fs.readSync(fd, buffer, 0, buffer.length, 0);
    const end = buffer.subarray(0, length).indexOf(10);
    if (end < 0 && length === FRAME_LIMIT) throw protocolError('History header is too large', 'FRAME_TOO_LARGE');
    const first = buffer.subarray(0, end < 0 ? length : end).toString('utf8');
    const header = JSON.parse(first || '{}');
    if (header.type !== 'session' || header.id !== id) throw protocolError('History identity does not match', 'SESSION_ID_MISMATCH');
  } finally { fs.closeSync(fd); }
  return local;
}
