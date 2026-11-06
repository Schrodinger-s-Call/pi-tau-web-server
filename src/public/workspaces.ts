import type { LiveSession } from './app-types.js';

type Bundle = { name: string; sha256: string; commit: string | null };
type Workspace = { workspace_id: string; display_name: string; paths: { files: string; sessions: string }; current_bundle: Bundle };
export let workspaceEnabled = false;
export let selectedWorkspace = '';
let workspaces: Workspace[] = [];
let loading: Promise<void> | undefined;
let error = '';
const selectors: HTMLSelectElement[] = [];
let versionLabel: HTMLElement | undefined;
let currentLive: LiveSession | undefined;

export async function refreshWorkspaces() {
  if (loading) return loading;
  loading = (async () => {
    try {
      const response = await fetch('/api/workspaces');
      if (!response.ok) throw new Error('Workspaces unavailable');
      const data = await response.json();
      workspaceEnabled = data.enabled === true;
      workspaces = data.workspaces || [];
      if (selectedWorkspace && !workspaces.some(w => w.workspace_id === selectedWorkspace)) selectedWorkspace = '';
      error = '';
    } catch { error = 'Workspaces unavailable'; }
    render();
  })().finally(() => { loading = undefined; });
  return loading;
}
export const workspacesReady = refreshWorkspaces();
export async function workspaceForPath(cwd?: string) {
  await refreshWorkspaces();
  if (error) throw new Error(error);
  if (!workspaceEnabled) return undefined;
  const workspace = cwd ? workspaces.find(w => w.paths.files === cwd) : workspaces.find(w => w.workspace_id === selectedWorkspace);
  if (!workspace) throw new Error('Select a workspace');
  return workspace.workspace_id;
}
export function workspaceQuery() { return selectedWorkspace ? `workspace_id=${encodeURIComponent(selectedWorkspace)}` : ''; }
export function selectWorkspace(id: string) {
  selectedWorkspace = id;
  render();
  document.dispatchEvent(new Event('tau-workspace-selected'));
  void refreshWorkspaces();
}
function render() {
  for (const select of selectors) {
    select.hidden = !workspaceEnabled && !error;
    select.replaceChildren(new Option(error || 'Select a workspace', ''));
    for (const w of workspaces) select.add(new Option(w.display_name, w.workspace_id));
    select.value = selectedWorkspace;
  }
  if (versionLabel) {
    versionLabel.hidden = !workspaceEnabled;
    const w = workspaces.find(w => w.workspace_id === currentLive?.workspace_id);
    versionLabel.textContent = currentLive?.workspace_id
      ? `${currentLive.workspace_name || currentLive.workspace_id} · Running: ${currentLive.run?.actual_bundle.name || 'Unknown'} (${currentLive.run?.actual_bundle.sha256.slice(0, 12) || '?'}) · Current: ${w?.current_bundle.name || 'Unavailable'} (${w?.current_bundle.sha256.slice(0, 12) || '?'})${currentLive.identity_sync_pending ? ' · Run record update pending' : ''}${currentLive.history_sync_pending ? ' · Loading current history' : ''}${error ? ` · ${error}` : ''}`
      : selectedWorkspace ? `${workspaces.find(w => w.workspace_id === selectedWorkspace)?.display_name || selectedWorkspace} · Select or create a conversation` : 'Select a workspace to create a conversation';
    if (currentLive?.pi_session_id) {
      const identity = document.createElement('div');
      identity.className = 'session-identity';
      const label = document.createElement('span');
      label.textContent = 'Pi session ID: ';
      const value = document.createElement('code');
      value.textContent = currentLive.pi_session_id;
      const copy = document.createElement('button');
      copy.type = 'button';
      copy.textContent = 'Copy ID';
      copy.setAttribute('aria-label', 'Copy Pi session ID');
      const sessionId = currentLive.pi_session_id;
      copy.addEventListener('click', async () => {
        try {
          await copySessionId(sessionId);
          copy.textContent = 'Copied';
        } catch {
          copy.textContent = 'Copy failed';
        }
      });
      identity.append(label, value, copy);
      if (currentLive.sessionFile) {
        const file = document.createElement('div');
        file.textContent = `Session file: ${currentLive.sessionFile}`;
        identity.append(file);
      }
      versionLabel.append(identity);
    }
  }
}

async function copySessionId(id: string) {
  if (navigator.clipboard) return navigator.clipboard.writeText(id);
  const previousFocus = document.activeElement;
  const input = document.createElement('textarea');
  input.value = id;
  input.style.cssText = 'position:fixed;left:-9999px';
  document.body.append(input);
  try {
    input.select();
    if (!document.execCommand('copy')) throw new Error('Could not copy session ID');
  } finally {
    input.remove();
    if (previousFocus instanceof HTMLElement) previousFocus.focus();
  }
}
export function showWorkspaceVersion(session?: LiveSession) { currentLive = session; render(); }
export function setupWorkspaces(cwdInput: HTMLInputElement) {
  const addSelect = (parent: HTMLElement, before?: HTMLElement) => {
    const select = document.createElement('select');
    select.setAttribute('aria-label', 'Workspace');
    select.className = 'workspace-select';
    select.hidden = true;
    if (before) parent.insertBefore(select, before); else parent.prepend(select);
    select.addEventListener('change', () => {
      selectWorkspace(select.value);
      cwdInput.value = workspaces.find(w => w.workspace_id === select.value)?.paths.files || '';
    });
    selectors.push(select);
  };
  addSelect(document.getElementById('sidebar')!);
  addSelect(cwdInput.parentElement!, cwdInput);
  versionLabel = document.createElement('div');
  versionLabel.className = 'workspace-version';
  versionLabel.setAttribute('role', 'status');
  document.getElementById('messages')!.before(versionLabel);
  const update = () => { cwdInput.hidden = workspaceEnabled; cwdInput.required = !workspaceEnabled; render(); };
  void workspacesReady.then(update);
  setInterval(() => { if (document.visibilityState === 'visible') void refreshWorkspaces().then(update); }, 5000);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') void refreshWorkspaces().then(update); });
}
export async function downloadWorkspaceFile(sessionId: string, file: string, runId?: string) {
  const link = document.createElement('a');
  const params = new URLSearchParams({ sessionId, path: file });
  if (runId) params.set('run_id', runId);
  link.href = `/api/file/download?${params}`;
  if (runId) {
    const response = await fetch(link.href);
    if (!response.ok) {
      const data = await response.json();
      throw new Error(data.error || 'Runtime file download failed');
    }
    link.href = URL.createObjectURL(await response.blob());
    link.download = file.split('/').pop() || '';
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    return;
  }
  link.download = '';
  link.click();
}
