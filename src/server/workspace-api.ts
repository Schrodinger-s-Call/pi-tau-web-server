import fs from 'node:fs';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { liveManager } from './sessions.js';
import { bridgeQuery, checkedPath, historyPath, listWorkspaces, requireWorkspace, workspaceFiles, type Workspace } from './workspaces.js';
import type { RpcCommand } from './types.js';

const json = (res: ServerResponse, status: number, value: unknown) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
export function readHistory(file: string): any[] {
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
}
export function historyFiles(w: Workspace): string[] {
  const found: string[] = [];
  const visit = (dir: string) => {
    for (const entry of fs.readdirSync(checkedPath(w.paths.sessions, dir), { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) found.push(historyPath(w, file));
    }
  };
  visit(w.paths.sessions);
  return found;
}
function sessionSummary(w: Workspace, file: string) {
  const entries = readHistory(file);
  const header = entries.find(e => e.type === 'session');
  if (!header?.id) return null;
  const messageText = (entry: any) => typeof entry.message?.content === 'string' ? entry.message.content : (entry.message?.content || []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join(' ');
  return { id: header.id, workspace_id: w.workspace_id, cwd: w.paths.files, timestamp: header.timestamp, file: path.relative(w.paths.sessions, file), filePath: file, mtime: fs.statSync(file).mtimeMs, name: [...entries].reverse().find(e => e.type === 'session_info')?.name || null, firstMessage: messageText(entries.find(e => e.message?.role === 'user') || {}).slice(0, 120) };
}

export async function handleWorkspaceApi(req: IncomingMessage, res: ServerResponse, url: URL, readBody: (req: IncomingMessage) => Promise<RpcCommand>): Promise<boolean> {
  const route = url.pathname;
  const parameter = url.searchParams.get('workspace_id');
  if (route === '/api/workspaces') { json(res, 200, { enabled: true, ...(await listWorkspaces()) }); return true; }
  if (route === '/api/run-info') {
    const run_id = url.searchParams.get('run_id');
    if (!run_id) throw new Error('run_id required');
    json(res, 200, await bridgeQuery({ type: 'run-info', run_id })); return true;
  }
  if (route === '/api/session-defaults') { json(res, 200, { cwd: '', workspaceRequired: true }); return true; }
  if (route === '/api/complete/directories') { json(res, 200, { items: [] }); return true; }
  if (route === '/api/projects') {
    const { workspaces } = await listWorkspaces();
    json(res, 200, { projects: workspaces.map(w => ({ workspace_id: w.workspace_id, name: w.display_name, path: w.paths.files })) }); return true;
  }
  if ((route === '/api/sessions' || route === '/api/search') && req.method === 'GET') {
    const all = parameter ? [await requireWorkspace(parameter)] : (await listWorkspaces()).workspaces;
    const projects = all.map(w => ({ workspace_id: w.workspace_id, name: w.display_name, path: w.paths.files, dirName: w.workspace_id, sessions: historyFiles(w).map(file => sessionSummary(w, file)).filter(s => s !== null).sort((a, b) => b.mtime - a.mtime) }));
    if (route === '/api/sessions') json(res, 200, { projects });
    else {
      const query = (url.searchParams.get('q') || '').toLowerCase();
      const results = [];
      if (query.length >= 2) for (const project of projects) for (const session of project.sessions) {
        if (results.length >= 30) break;
        const matches = readHistory(session.filePath).filter(e => e.type === 'message').flatMap(e => {
          const content = typeof e.message?.content === 'string' ? e.message.content : (e.message?.content || []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join(' ');
          const index = content.toLowerCase().indexOf(query);
          return index < 0 ? [] : [{ snippet: content.slice(Math.max(0, index - 60), index + query.length + 60) }];
        }).slice(0, 3);
        if (matches.length) results.push({ ...session, project: project.path, sessionName: session.name, matches });
      }
      json(res, 200, { results });
    }
    return true;
  }
  if (route === '/api/live-sessions' && req.method === 'POST') {
    const body = await readBody(req);
    const session = await liveManager.create({ workspace_id: body.workspace_id, model: body.model });
    json(res, 200, { session: session.metadata() }); return true;
  }
  if (route === '/api/live-sessions/resume' && req.method === 'POST') {
    const body = await readBody(req);
    const w = await requireWorkspace(body.workspace_id);
    const file = historyPath(w, String(body.filePath || ''));
    const entries = readHistory(file);
    const reused = !!liveManager.findBySessionFile(file) || liveManager.hasPendingResume(file);
    const session = await liveManager.resume({ workspace: w, cwd: w.paths.files, sessionFile: file, model: body.model, entries, sessionName: [...entries].reverse().find(e => e.type === 'session_info')?.name });
    json(res, 200, { session: session.metadata(), reused }); return true;
  }
  if (route === '/api/sessions/delete' && req.method === 'POST') {
    const body = await readBody(req);
    const w = await requireWorkspace(body.workspace_id);
    const file = historyPath(w, String(body.filePath || ''));
    if (liveManager.findBySessionFile(file) || liveManager.hasPendingResume(file) || liveManager.hasTerminatingResume(file)) throw new Error('Close the live session before deleting its history');
    fs.unlinkSync(file);
    json(res, 200, { success: true }); return true;
  }
  if (route.startsWith('/api/sessions/') && req.method === 'GET') {
    const w = await requireWorkspace(parameter);
    const file = historyPath(w, url.searchParams.get('filePath') || decodeURIComponent(route.slice('/api/sessions/'.length)));
    json(res, 200, { entries: readHistory(file) }); return true;
  }
  if (route === '/api/file/upload' && req.method === 'POST') {
    const body = await readBody(req);
    const live = body.sessionId ? liveManager.get(body.sessionId) : undefined;
    if (body.sessionId && !live) throw new Error('Live session not found');
    if (live && (live.terminating || live.identityPending)) throw new Error('Session identity synchronization is pending');
    if (live && body.workspace_id && live.workspace?.workspace_id !== body.workspace_id) throw new Error('Workspace does not match the live session');
    const w = await requireWorkspace(live?.workspace?.workspace_id || body.workspace_id);
    if (typeof body.name !== 'string' || !body.name || body.name === '.' || body.name === '..' || /[\\/\x00]/.test(body.name)) throw new Error('Invalid file name');
    if (typeof body.data !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(body.data)) throw new Error('Invalid file data');
    const bytes = Buffer.from(body.data, 'base64');
    if (bytes.length > 10 * 1024 * 1024) throw new Error('Files must be at most 10 MiB');
    const directory = workspaceFiles(w, String(body.path || w.paths.files));
    const file = checkedPath(w.paths.files, path.join(directory, body.name), true);
    fs.writeFileSync(file, bytes, { flag: 'wx', mode: 0o600 });
    json(res, 200, { path: file, workspace_id: w.workspace_id }); return true;
  }
  if (route === '/api/file/image' && req.method === 'GET') {
    const w = await requireWorkspace(parameter);
    const file = workspaceFiles(w, url.searchParams.get('path') || '');
    if (!fs.statSync(file).isFile()) throw new Error('Not a file');
    const types: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif', '.svg': 'image/svg+xml', '.bmp': 'image/bmp', '.ico': 'image/x-icon' };
    const mime = types[path.extname(file).toLowerCase()];
    if (!mime) throw new Error('Unsupported image type');
    res.writeHead(200, { 'Content-Type': mime, 'Content-Disposition': 'inline', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store', 'Content-Security-Policy': "sandbox; default-src 'none'; style-src 'unsafe-inline'" });
    const stream = fs.createReadStream(file); stream.on('error', () => res.destroy()); stream.pipe(res); return true;
  }
  if (route === '/api/file/download' && req.method === 'GET') {
    const live = liveManager.get(url.searchParams.get('sessionId') || '');
    if (live && (live.terminating || live.identityPending)) throw new Error('Session identity synchronization is pending');
    if (live && parameter && live.workspace?.workspace_id !== parameter) throw new Error('Workspace does not match the live session');
    if (url.searchParams.get('sessionId') && !live) throw new Error('Live session not found');
    const w = await requireWorkspace(live?.workspace?.workspace_id || parameter);
    const input = url.searchParams.get('path') || '';
    const file = url.searchParams.get('history') === '1' ? checkedPath(w.paths.sessions, input) : workspaceFiles(w, input);
    if (!fs.statSync(file).isFile()) throw new Error('Not a file');
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(file))}`, 'X-Content-Type-Options': 'nosniff' });
    const stream = fs.createReadStream(file); stream.on('error', () => res.destroy()); stream.pipe(res); return true;
  }
  return false;
}
