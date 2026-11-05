import { parseNexusMessage, sankeyColumns, type Nexus, type Select, type Radar, type Sankey } from './nexus-data.js';
import { renderMarkdown } from './markdown.js';

export type NexusContext = {
  sessionId: string;
  canSubmit: () => boolean;
  send: (sessionId: string, text: string) => Promise<'accepted' | 'uncertain'>;
};
function element<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string) {
  const el = document.createElement(tag);
  if (text !== undefined) el.textContent = text;
  return el;
}
function svgElement(tag: string, attributes: Record<string, string | number> = {}, text?: string) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [key, value] of Object.entries(attributes)) el.setAttribute(key, String(value));
  if (text !== undefined) el.textContent = text;
  return el;
}
function table(headers: string[], rows: string[][]) {
  const wrap = element('div'); wrap.className = 'table-wrapper';
  const table = element('table');
  const head = element('tr');
  headers.forEach(h => head.append(element('th', h)));
  const thead = element('thead'); thead.append(head); table.append(thead);
  const body = element('tbody');
  rows.forEach(row => { const tr = element('tr'); row.forEach(cell => tr.append(element('td', cell))); body.append(tr); });
  table.append(body); wrap.append(table); return wrap;
}
function chart(title: string, width: number, height: number) {
  const svg = svgElement('svg', { viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': title, class: 'nexus-chart' });
  svg.append(svgElement('title', {}, title));
  return svg;
}
function radar(value: Radar, card: HTMLElement) {
  const svg = chart(value.title, 600, 430);
  const cx = 300, cy = 210, radius = 140;
  const point = (i: number, r: number) => {
    const angle = -Math.PI / 2 + i * 2 * Math.PI / value.axes.length;
    return [cx + Math.cos(angle) * r, cy + Math.sin(angle) * r];
  };
  for (const level of [0.25, 0.5, 0.75, 1]) {
    svg.append(svgElement('polygon', { points: value.axes.map((_, i) => point(i, radius * level).join(',')).join(' '), class: 'nexus-grid' }));
    svg.append(svgElement('text', { x: cx + 5, y: cy - radius * level, class: 'nexus-scale' }, String(level)));
  }
  value.axes.forEach((axis, i) => {
    const [x, y] = point(i, radius);
    svg.append(svgElement('line', { x1: cx, y1: cy, x2: x, y2: y, class: 'nexus-grid' }));
    const [lx, ly] = point(i, radius + 27);
    const label = svgElement('text', { x: lx, y: ly, 'text-anchor': 'middle', 'dominant-baseline': 'middle', class: 'nexus-axis' }, axis.label.length > 18 ? `${axis.label.slice(0, 18)}…` : axis.label);
    label.append(svgElement('title', {}, `${axis.label}: ${axis.raw}`));
    svg.append(label);
  });
  svg.append(svgElement('polygon', { points: value.axes.map((a, i) => point(i, radius * a.value).join(',')).join(' '), class: 'nexus-radar-area' }));
  value.axes.forEach((axis, i) => {
    const [cx, cy] = point(i, radius * axis.value);
    const dot = svgElement('circle', { cx, cy, r: 5, class: 'nexus-dot', tabindex: 0, 'aria-label': `${axis.label}: ${axis.raw}` });
    dot.append(svgElement('title', {}, `${axis.label}: ${axis.raw}`)); svg.append(dot);
  });
  card.append(svg, table(['维度', '原值', '归一化值（0–1）'], value.axes.map(a => [a.label, a.raw, String(a.value)])));
}
function sankey(value: Sankey, card: HTMLElement) {
  const columns = sankeyColumns(value.links);
  const maxColumn = columns ? Math.max(...columns.values()) : 0;
  // Dense graphs remain available as a table, with every original link intact.
  if (!columns || columns.size > 60 || maxColumn > 10 || value.links.every(l => l.value === 0)) {
    card.append(element('p', '此图包含循环、自环、零权重或过多节点，以下表格保留全部数据。'));
  } else {
    const weights = new Map<string, number>();
    const incoming = new Map<string, number>();
    const outgoing = new Map<string, number>();
    columns.forEach((_, name) => { incoming.set(name, 0); outgoing.set(name, 0); });
    value.links.forEach(l => {
      incoming.set(l.target, incoming.get(l.target)! + l.value);
      outgoing.set(l.source, outgoing.get(l.source)! + l.value);
    });
    columns.forEach((_, name) => weights.set(name, Math.max(incoming.get(name)!, outgoing.get(name)!)));
    const groups = Array.from({ length: maxColumn + 1 }, (_, i) => [...columns.keys()].filter(n => columns.get(n) === i));
    const sums = groups.map(g => g.reduce((sum, n) => sum + weights.get(n)!, 0));
    const maxSum = Math.max(...sums);
    if (!Number.isFinite(maxSum) || maxSum <= 0) {
      card.append(element('p', '权重总和超出绘图范围，显示原始数据。'));
    } else {
      const height = Math.max(420, ...groups.map(g => g.length * 32 + 80));
      const width = Math.max(700, (maxColumn + 1) * 170);
      const scale = Math.min(...groups.map((g, i) => sums[i] ? (height - 80 - g.length * 16) / sums[i] : Infinity));
      const svg = chart(value.title, width, height);
      const positions = new Map<string, { x: number; y: number }>();
      groups.forEach((group, col) => {
        let y = 40;
        group.forEach(name => {
          positions.set(name, { x: 30 + col * (width - 180) / Math.max(1, maxColumn), y });
          y += Math.max(1, weights.get(name)! * scale) + 16;
        });
      });
      const inputOffsets = new Map<string, number>(), outputOffsets = new Map<string, number>();
      value.links.forEach(l => {
        const from = positions.get(l.source)!, to = positions.get(l.target)!;
        const thickness = l.value * scale;
        const y1 = from.y + (outputOffsets.get(l.source) || 0) + thickness / 2;
        const y2 = to.y + (inputOffsets.get(l.target) || 0) + thickness / 2;
        outputOffsets.set(l.source, (outputOffsets.get(l.source) || 0) + thickness);
        inputOffsets.set(l.target, (inputOffsets.get(l.target) || 0) + thickness);
        const mid = (from.x + 12 + to.x) / 2;
        const link = svgElement('path', { d: `M ${from.x + 12} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${to.x} ${y2}`, 'stroke-width': thickness, class: 'nexus-flow' });
        link.append(svgElement('title', {}, `${l.source} → ${l.target}: ${l.value}`)); svg.append(link);
      });
      positions.forEach((p, name) => {
        svg.append(svgElement('rect', { x: p.x, y: p.y, width: 12, height: Math.max(1, weights.get(name)! * scale), class: 'nexus-dot' }));
        const label = svgElement('text', { x: p.x + 17, y: p.y + 12, class: 'nexus-axis' }, name.length > 12 ? name.slice(0, 12) + '…' : name);
        label.append(svgElement('title', {}, name)); svg.append(label);
      });
      const scroll = element('div'); scroll.className = 'nexus-chart-scroll'; scroll.append(svg); card.append(scroll);
    }
  }
  card.append(table(['来源', '目标', '权重'], value.links.map(l => [l.source, l.target, String(l.value)])));
}
let controlId = 0;
function selectFields(value: Select, parent: HTMLElement): () => string {
  const fieldset = element('fieldset'); fieldset.append(element('legend', value.message));
  const name = `nexus-choice-${++controlId}`;
  const controls = value.options.map(option => {
    const label = element('label'); label.className = 'nexus-option';
    const input = element('input'); input.type = value.multiple ? 'checkbox' : 'radio'; input.name = name;
    label.append(input, element('span', option.label)); fieldset.append(label);
    let other: HTMLInputElement | undefined;
    if (option.is_other) {
      other = element('input'); other.type = 'text'; other.maxLength = 2000; other.placeholder = '请输入其他内容';
      other.setAttribute('aria-label', `${value.message}：${option.label}`);
      other.disabled = true;
      fieldset.append(other);
    }
    return { input, other, option };
  });
  fieldset.addEventListener('change', () => controls.forEach(c => { if (c.other) c.other.disabled = !c.input.checked; }));
  parent.append(fieldset);
  return () => {
    const selected = controls.filter(c => c.input.checked);
    if (!selected.length) throw new Error(`请选择「${value.message}」的答案。`);
    return selected.map(c => {
      if (!c.other) return c.option.label;
      const custom = c.other.value.trim();
      if (!custom) throw new Error(`请填写「${c.option.label}」的内容。`);
      return `${c.option.label}：${custom}`;
    }).join('；');
  };
}
function componentView(value: Nexus, context?: NexusContext) {
  const card = element('section'); card.className = `nexus-card nexus-${value.type}`;
  card.append(element('h3', 'title' in value ? value.title : 'message' in value ? value.message : '任务状态'));
  if (value.type === 'radar') radar(value, card);
  else if (value.type === 'sankey') sankey(value, card);
  else if (value.type === 'progress') {
    card.append(element('p', `任务：${value.taskId}`));
    if (value.sampleName) card.append(element('p', `样本：${value.sampleName}`));
    if (value.sampleId) card.append(element('p', `样本编号：${value.sampleId}`));
    card.append(element('strong', value.status), element('p', '消息生成时的状态'));
  } else {
    const status = element('p'); status.className = 'nexus-status'; status.setAttribute('role', 'status');
    card.dataset.nexusState = context ? 'ready' : 'history';
    let pending = false, done = false;
    let enabledControls: (HTMLInputElement | HTMLButtonElement)[] = [];
    const disable = () => card.querySelectorAll<HTMLInputElement | HTMLButtonElement>('input, button').forEach(c => { c.disabled = true; });
    const submit = async (answer: () => string) => {
      if (pending || done || !context) return;
      if (!context.canSubmit()) { status.textContent = '此卡片已不是当前回复，不能提交。'; return; }
      try {
        const text = answer();
        pending = true;
        card.dataset.nexusState = 'pending';
        enabledControls = [...card.querySelectorAll<HTMLInputElement | HTMLButtonElement>('input:enabled, button:enabled')];
        enabledControls.forEach(control => { control.disabled = true; });
        status.textContent = '正在发送…';
        const result = await context.send(context.sessionId, text);
        done = true;
        card.dataset.nexusState = 'done';
        disable();
        deactivateNexus(card.closest('.message') || card);
        status.textContent = result === 'accepted' ? '已提交' : '发送结果尚未确认。请先查看会话，避免重复提交。';
      } catch (error) {
        status.textContent = error instanceof Error ? error.message : '发送失败，请重试。';
      } finally {
        pending = false;
        if (!done) {
          card.dataset.nexusState = 'ready';
          if (context.canSubmit()) enabledControls.forEach(control => { control.disabled = false; });
          else deactivateNexus(card.parentElement || card);
        }
      }
    };
    const button = (label: string, action: () => void) => {
      const b = element('button', label); b.type = 'button'; b.addEventListener('click', action); card.append(b);
    };
    if (value.type === 'confirm') {
      value.actions.forEach(action => button(action.label, () => {
        if (!context || !context.canSubmit() || pending || done) return;
        if (!action.submit) {
          done = true;
          card.dataset.nexusState = 'done';
          card.querySelectorAll('button').forEach(button => button.remove());
          status.textContent = '已关闭，未发送消息。';
        }
        else void submit(() => `对于「${value.message}」我选择：${action.label}`);
      }));
    } else if (value.type === 'select') {
      const answer = selectFields(value, card);
      button('提交', () => { void submit(() => `对于「${value.message}」我选择：${answer()}`); });
    } else {
      const answers = value.items.map(item => ({ message: item.message, read: selectFields(item, card) }));
      button('提交', () => { void submit(() => `对于「${value.message}」我的回答是：\n${answers.map(a => `${a.message}：${a.read()}`).join('\n')}`); });
    }
    card.append(status);
    if (!context) { disable(); status.textContent = '历史卡片仅供查看，请在消息框中回复。'; }
    else status.textContent = '仅可回答当前会话的最新回复。';
  }
  return card;
}

export function renderNexusMessage(text: string, target: HTMLElement, context?: NexusContext) {
  for (const part of parseNexusMessage(text)) {
    if ('component' in part) target.append(componentView(part.component, context));
    else {
      const template = element('template'); template.innerHTML = renderMarkdown(part.text); target.append(template.content);
    }
  }
}

/** A later conversation turn makes unanswered cards read-only. */
export function deactivateNexus(container: Element) {
  container.querySelectorAll<HTMLElement>('.nexus-card[data-nexus-state="ready"]').forEach(card => {
    card.dataset.nexusState = 'history';
    card.querySelectorAll<HTMLInputElement | HTMLButtonElement>('input, button').forEach(control => { control.disabled = true; });
    const status = card.querySelector('.nexus-status');
    if (status) status.textContent = '此卡片已被后续对话取代，仅供查看。';
  });
}
