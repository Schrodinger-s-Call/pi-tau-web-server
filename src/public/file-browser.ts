import { workspaceEnabled, downloadWorkspaceFile } from './workspaces.js';
/**
 * File Browser — right sidebar file tree with drag-and-drop
 */

const FILE_ICONS: Record<string, string> = {
  // Folders
  directory: '📁',
  // Code
  js: '📄', ts: '📄', jsx: '📄', tsx: '📄',
  py: '🐍', rb: '💎', go: '📄', rs: '🦀',
  // Web
  html: '🌐', css: '🎨', svg: '🎨',
  // Data
  json: '📋', yaml: '📋', yml: '📋', toml: '📋',
  xml: '📋', csv: '📋',
  // Docs
  md: '📝', txt: '📝', rst: '📝',
  // Images
  png: '🖼️', jpg: '🖼️', jpeg: '🖼️', gif: '🖼️',
  webp: '🖼️', ico: '🖼️',
  // Config
  env: '🔒', gitignore: '🔒', lock: '🔒',
  // Default
  default: '📄',
};

type FileItem = {
  name: string;
  path: string;
  isDirectory: boolean;
  size?: number | null;
  mtime?: number;
};

export function getFileIcon(name: string, isDirectory: boolean) {
  if (isDirectory) return FILE_ICONS.directory;
  const ext = name.split('.').pop()?.toLowerCase() || '';
  return FILE_ICONS[ext] || FILE_ICONS.default;
}

function formatSize(bytes?: number | null) {
  if (bytes == null) return '';
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}K`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}M`;
}

export class FileBrowser {
  container: HTMLElement;
  pathEl: HTMLElement;
  messageInput: HTMLElement;
  onFileInserted: ((filePath: string) => void) | null;
  getSessionId: (() => string | null) | null;
  currentPath: string | null;
  onPreview: ((path: string) => void) | null = null;
  private loadRevision = 0;

  constructor(
    container: HTMLElement,
    pathEl: HTMLElement,
    messageInput: HTMLElement,
    onFileInserted: ((filePath: string) => void) | null = null,
    getSessionId: (() => string | null) | null = null
  ) {
    this.container = container;
    this.pathEl = pathEl;
    this.messageInput = messageInput;
    this.onFileInserted = onFileInserted;
    this.getSessionId = getSessionId;
    this.currentPath = null;

    this.setupDropTarget();
  }

  async load(dirPath?: string | null) {
    const revision = ++this.loadRevision;
    this.container.innerHTML = '<div class="file-loading">Loading…</div>';

    try {
      const params = new URLSearchParams();
      const sessionId = this.getSessionId?.();
      if (!sessionId) {
        this.currentPath = null;
        this.pathEl.textContent = '';
        this.pathEl.title = '';
        this.container.innerHTML = '<div class="file-loading">Select a Tau tab to browse files</div>';
        return;
      }
      params.set('sessionId', sessionId);
      if (dirPath) params.set('path', dirPath);
      const qs = params.toString();
      const url = qs ? `/api/files?${qs}` : '/api/files';
      const res = await fetch(url);
      const data = await res.json();
      if (revision !== this.loadRevision || sessionId !== this.getSessionId?.()) return;

      if (data.error) {
        this.container.textContent = data.error;
        return;
      }

      this.currentPath = data.path;
      this.pathEl.textContent = data.path;
      this.pathEl.title = data.path;
      this.render(data.items);
    } catch (err) {
      if (revision !== this.loadRevision) return;
      this.container.innerHTML = '<div class="file-loading">Failed to load</div>';
    }
  }

  getParentPath() {
    if (!this.currentPath) return null;
    const sep = this.currentPath.includes('\\') ? '\\' : '/';
    const normalized = this.currentPath.endsWith(sep) ? this.currentPath.slice(0, -1) : this.currentPath;
    const lastSep = normalized.lastIndexOf(sep);
    if (lastSep <= 0) return sep === '/' ? '/' : null;
    const parent = normalized.slice(0, lastSep);
    return /^[A-Za-z]:$/.test(parent) ? parent + sep : parent;
  }

  render(items: FileItem[]) {
    this.container.innerHTML = '';

    if (items.length === 0) {
      this.container.innerHTML = '<div class="file-loading">Empty directory</div>';
      return;
    }

    for (const item of items) {
      const el = document.createElement('div');
      el.className = `file-item${item.isDirectory ? ' directory' : ''}`;
      el.draggable = true;
      el.dataset.path = item.path;
      el.dataset.name = item.name;
      el.dataset.isDirectory = String(item.isDirectory);

      const icon = getFileIcon(item.name, item.isDirectory);
      const size = item.isDirectory ? '' : formatSize(item.size);

      const iconEl = document.createElement('span');
      iconEl.className = 'file-icon';
      iconEl.textContent = icon;
      const nameEl = document.createElement('span');
      nameEl.className = 'file-name';
      nameEl.title = item.name;
      nameEl.textContent = item.name;
      const sizeEl = document.createElement('span');
      sizeEl.className = 'file-size';
      sizeEl.textContent = size;
      el.append(iconEl, nameEl, sizeEl);
      el.tabIndex = 0;
      el.setAttribute('role', 'button');
      const activate = () => {
        if (item.isDirectory) {
          void this.load(item.path);
        } else if (this.onPreview && !/\.(png|jpe?g|gif|webp|ico|svg)$/i.test(item.path)) {
          this.onPreview(item.path);
        } else {
          this.insertPath(item.path);
        }
      };
      el.addEventListener('click', activate);
      el.addEventListener('dblclick', event => {
        if (!item.isDirectory && /\.(png|jpe?g|gif|webp|ico|svg)$/i.test(item.path)) {
          event.preventDefault();
          void this.openNatively(item.path);
        }
      });
      el.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          activate();
        }
      });

      // Drag start
      el.addEventListener('dragstart', (e) => {
        if (!e.dataTransfer) return;
        e.dataTransfer.setData('text/plain', item.path);
        e.dataTransfer.effectAllowed = 'copy';
        el.classList.add('dragging');
      });

      el.addEventListener('dragend', () => {
        el.classList.remove('dragging');
      });

      this.container.appendChild(el);
    }
  }

  async openNatively(filePath: string) {
    try {
      const sessionId = this.getSessionId?.();
      if (!sessionId) return;
      if (workspaceEnabled) { downloadWorkspaceFile(sessionId, filePath); return; }
      await fetch('/api/open', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filePath, sessionId }),
      });
    } catch (err) {
      console.error('[FileBrowser] Failed to open:', err);
    }
  }

  insertPath(filePath: string) {
    const input = this.messageInput;
    const start = input.selectionStart ?? 0;
    const end = input.selectionEnd ?? 0;
    input.value = input.value.substring(0, start) + filePath + ' ' + input.value.substring(end);
    input.selectionStart = input.selectionEnd = start + filePath.length + 1;
    input.focus();
    input.dispatchEvent(new Event('input'));
    if (this.onFileInserted) this.onFileInserted(filePath);
  }

  setupDropTarget() {
    const input = this.messageInput;

    input.addEventListener('dragover', (e) => {
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
      input.classList.add('file-drop-hover');
    });

    input.addEventListener('dragleave', () => {
      input.classList.remove('file-drop-hover');
    });

    input.addEventListener('drop', (e) => {
      e.preventDefault();
      input.classList.remove('file-drop-hover');

      const filePath = e.dataTransfer?.getData('text/plain') ?? '';
      // Accept Unix paths (/) and Windows paths (C:\ or C:/)
      if (filePath && (filePath.startsWith('/') || /^[A-Za-z]:[\\\/]/.test(filePath))) {
        this.insertPath(filePath);
      }
    });
  }
}
