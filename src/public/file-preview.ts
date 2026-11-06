import { workspaceEnabled, downloadWorkspaceFile } from './workspaces.js';
async function copyText(text: string) {
  if (navigator.clipboard) return navigator.clipboard.writeText(text);
  const previousFocus = document.activeElement;
  const input = document.createElement('textarea');
  input.value = text;
  input.style.cssText = 'position:fixed;left:-9999px';
  document.body.append(input);
  try {
    input.select();
    if (!document.execCommand('copy')) throw new Error('Could not copy text');
  } finally {
    input.remove();
    if (previousFocus instanceof HTMLElement) previousFocus.focus();
  }
}

type FileTab = { sessionId: string; path: string; runId?: string };

/** File tabs belong to a live session and show only while that session is selected. */
export class FilePreview {
  private tabs: FileTab[] = [];
  private selected: FileTab | null = null;
  private sessionId: string | null = null;
  private controller: AbortController | null = null;
  private worker: Worker | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private revision = 0;
  private panel = document.createElement('section');

  constructor(private changed: () => void, private insert: (path: string) => void) {
    this.panel.id = 'file-preview';
    this.panel.className = 'file-preview hidden';
    this.panel.setAttribute('aria-label', 'File preview');
    document.getElementById('messages')!.before(this.panel);
  }

  get active() { return this.selected !== null; }

  sync(sessionId: string | null, liveIds: string[]) {
    this.tabs = this.tabs.filter(tab => liveIds.includes(tab.sessionId));
    if (this.sessionId !== sessionId || (this.selected && !this.tabs.includes(this.selected))) this.hide(false);
    this.sessionId = sessionId;
    const list = document.getElementById('live-tabs-list')!;
    list.querySelectorAll('.file-tab').forEach(tab => tab.remove());
    for (const file of this.tabs.filter(tab => tab.sessionId === sessionId)) {
      const tab = document.createElement('button');
      tab.type = 'button';
      tab.className = `live-tab file-tab${file === this.selected ? ' active' : ''}`;
      tab.title = file.path;
      const label = document.createElement('span');
      label.className = 'live-tab-title';
      label.textContent = file.path.split(/[/\\]/).pop() || file.path;
      const close = document.createElement('span');
      close.className = 'live-tab-close';
      close.textContent = '×';
      close.title = 'Close file tab';
      close.addEventListener('click', event => {
        event.stopPropagation();
        this.tabs = this.tabs.filter(item => item !== file);
        if (this.selected === file) this.hide(false);
        this.changed();
      });
      tab.append(label, close);
      tab.addEventListener('click', () => { void this.open(file.path, file.sessionId); });
      tab.addEventListener('keydown', event => {
        if (event.key === 'Delete') { event.preventDefault(); close.click(); }
      });
      list.append(tab);
    }
  }

  hide(notify = true) {
    this.revision++;
    this.controller?.abort();
    this.stopWorker();
    this.selected = null;
    this.panel.replaceChildren();
    this.panel.classList.add('hidden');
    document.body.classList.remove('viewing-file');
    if (notify) this.changed();
  }

  private stopWorker() {
    this.worker?.terminate();
    this.worker = null;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  async open(path: string, sessionId: string) {
    if (sessionId !== this.sessionId) return;
    this.hide(false);
    let file = this.tabs.find(tab => tab.path === path && tab.sessionId === sessionId);
    if (!file) {
      // Only descriptors are retained; file contents are released when the view closes.
      if (this.tabs.length >= 12) this.tabs.shift();
      file = { path, sessionId };
      this.tabs.push(file);
    }
    this.selected = file;
    const revision = this.revision;
    this.controller = new AbortController();
    this.panel.classList.remove('hidden');
    document.body.classList.add('viewing-file');
    this.changed();

    const toolbar = document.createElement('div');
    toolbar.className = 'file-preview-toolbar';
    const title = document.createElement('span');
    title.className = 'file-preview-path';
    title.textContent = path;
    title.title = path;
    toolbar.append(title);
    const button = (label: string, action: () => void) => {
      const element = document.createElement('button');
      element.type = 'button';
      element.textContent = label;
      element.addEventListener('click', action);
      toolbar.append(element);
      return element;
    };
    button('Add to message', () => { this.hide(); this.insert(path); });
    const runtime = workspaceEnabled && /^\/workspace\/(AGENTS\.md|RUNTIME\.json)$/.test(path);
    if (runtime) {
      const badge = document.createElement('span');
      badge.className = 'runtime-file-label';
      badge.textContent = '运行时只读文件';
      toolbar.append(badge);
    }
    const download = workspaceEnabled ? button('Download', () => {
      void downloadWorkspaceFile(sessionId, path, file.runId).catch(error => { status.textContent = error.message; });
    }) : null;
    if (download && runtime) download.disabled = true;
    button('Refresh', () => { void this.open(path, sessionId); });
    button('Back to chat', () => this.hide());
    const status = document.createElement('p');
    status.className = 'file-preview-status';
    status.setAttribute('role', 'status');
    status.textContent = 'Loading…';
    const content = document.createElement('div');
    content.className = 'file-preview-content message assistant';
    this.panel.append(toolbar, status, content);
    try {
      const params = new URLSearchParams({ sessionId, path });
      if (file.runId) params.set('run_id', file.runId);
      const response = await fetch(`/api/file/text?${params}`, { signal: this.controller.signal });
      const data = await response.json();
      if (revision !== this.revision) return;
      if (!response.ok) throw new Error(data.error || 'Failed to read file');
      if (typeof data.text !== 'string' || data.text.length > 256 * 1024) throw new Error('File exceeds the preview limit');
      if (runtime) {
        if (!data.runtime_readonly || typeof data.run_id !== 'string') throw new Error('Runtime file unavailable: server did not identify its Pi run');
        file.runId = data.run_id;
        if (download) download.disabled = false;
      }
      const source: string = data.text;
      status.textContent = runtime ? '运行时只读文件 · UTF-8 · Files up to 128 KiB' : 'Read-only · UTF-8 · Files up to 256 KiB';
      button('Copy', () => {
        void copyText(source).then(() => {
          status.textContent = 'Copied';
        }).catch(() => { status.textContent = 'Could not copy text'; });
      });
      const showSource = () => {
        this.stopWorker();
        const pre = document.createElement('pre');
        pre.className = 'file-preview-source';
        pre.textContent = source;
        content.replaceChildren(pre);
      };
      showSource();
      if (/\.(md|markdown)$/i.test(path)) {
        const lines = source.split('\n');
        const canRender = new TextEncoder().encode(source).length <= 32 * 1024 && lines.length <= 1500 && lines.every(line => line.length <= 2000);
        if (!canRender) {
          status.textContent = 'Showing source: Markdown formatting is limited to 32 KiB, 1,500 lines, and 2,000 characters per line.';
          return;
        }
        let formatted = false;
        const toggle = button('Preview', () => {
          if (formatted) {
            formatted = false;
            toggle.textContent = 'Preview';
            showSource();
          } else showMarkdown();
        });
        const showMarkdown = () => {
          this.stopWorker();
          const fallback = () => {
            showSource();
            formatted = false;
            toggle.textContent = 'Preview';
            status.textContent = 'Markdown formatting was unavailable or took too long. Showing source.';
          };
          try {
            const worker = new Worker(new URL('./file-preview-worker.js', import.meta.url), { type: 'module' });
            this.worker = worker;
            this.timer = setTimeout(fallback, 1000);
            worker.onerror = event => { event.preventDefault(); fallback(); };
            worker.onmessage = (event: MessageEvent<string>) => {
              if (revision !== this.revision || this.worker !== worker) return;
              this.stopWorker();
              if (event.data.length > 1024 * 1024) { fallback(); return; }
              const body = document.createElement('div');
              body.className = 'message-content';
              // Parse without loading images; file previews do not fetch document resources.
              const template = document.createElement('template');
              template.innerHTML = event.data;
              template.content.querySelectorAll('img').forEach(img => img.replaceWith(document.createTextNode(`[Image: ${img.alt}]`)));
              template.content.querySelectorAll('a').forEach(link => {
                if (!/^(https?:\/\/|mailto:)/i.test(link.getAttribute('href') || '')) {
                  link.replaceWith(document.createTextNode(link.textContent || ''));
                }
              });
              template.content.querySelectorAll<HTMLButtonElement>('.copy-btn').forEach(copy => {
                copy.removeAttribute('onclick');
                copy.addEventListener('click', () => {
                  const text = copy.closest('.code-block-wrapper')?.querySelector('code')?.textContent || '';
                  void copyText(text).then(() => { copy.textContent = 'Copied'; }).catch(() => { copy.textContent = 'Copy failed'; });
                });
              });
              body.append(template.content);
              content.replaceChildren(body);
              formatted = true;
              toggle.textContent = 'Source';
              status.textContent = 'Read-only · Images and relative links are shown as text';
            };
            worker.postMessage(source);
          } catch { fallback(); }
        };
        showMarkdown();
      }
    } catch (error) {
      if (revision !== this.revision) return;
      status.textContent = error instanceof Error ? error.message : 'Failed to read file';
    }
  }
}
