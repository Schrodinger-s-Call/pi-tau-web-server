import { splitFences } from './markdown-fences.js';

export type Select = { type: 'select'; message: string; multiple?: boolean; options: { label: string; is_other?: boolean }[] };
export type Confirm = { type: 'confirm'; message: string; actions: { label: string; submit: boolean }[] };
export type Form = { type: 'form'; message: string; items: Select[] };
export type Progress = { type: 'progress'; taskId: string; status: string; sampleId?: string; sampleName?: string };
export type Radar = { type: 'radar'; title: string; axes: { label: string; value: number; raw: string }[] };
export type Sankey = { type: 'sankey'; title: string; links: { source: string; target: string; value: number }[] };
export type Nexus = Select | Confirm | Form | Progress | Radar | Sankey;
export type NexusPart = { text: string } | { component: Nexus; raw: string };
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= 2000;
const list = (v: unknown, max: number): v is unknown[] => Array.isArray(v) && v.length > 0 && v.length <= max;
const number = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
function select(v: unknown): v is Select {
  return object(v) && v.type === 'select' && text(v.message) && (v.multiple === undefined || typeof v.multiple === 'boolean') &&
    list(v.options, 50) && v.options.every(o => object(o) && text(o.label) && (o.is_other === undefined || typeof o.is_other === 'boolean'));
}

export function parseNexus(info: string, code: string): Nexus | null {
  const header = /^(?:json\s+)?\[nexus-ui\](?:\s+(\w+))?$/.exec(info);
  if (!header || code.length > 64 * 1024 || new TextEncoder().encode(code).length > 64 * 1024) return null;
  try {
    const v: unknown = JSON.parse(code);
    if (!object(v)) return null;
    if (header[1] && v.type !== undefined && v.type !== header[1]) return null;
    const value = { ...v, type: v.type ?? header[1] };
    switch (value.type) {
      case 'select': return select(value) ? value : null;
      case 'confirm':
        if (text(v.message) && list(v.actions, 20) && v.actions.every(a => object(a) && text(a.label) && typeof a.submit === 'boolean') && v.actions.some(a => object(a) && a.submit === true)) return value as Confirm;
        break;
      case 'form':
        if (text(v.message) && list(v.items, 20) && v.items.every(select)) return value as Form;
        break;
      case 'progress':
        if (text(v.taskId) && text(v.status) && [v.sampleId, v.sampleName].every(x => x === undefined || text(x))) return value as Progress;
        break;
      case 'radar':
        if (text(v.title) && list(v.axes, 12) && v.axes.length >= 3 && v.axes.every(a => object(a) && text(a.label) && number(a.value) && a.value <= 1 && text(a.raw))) return value as Radar;
        break;
      case 'sankey':
        if (text(v.title) && list(v.links, 200) && v.links.every(l => object(l) && text(l.source) && text(l.target) && number(l.value))) return value as Sankey;
        break;
    }
  } catch {}
  return null;
}

export function parseNexusMessage(text: string): NexusPart[] {
  let count = 0;
  return splitFences(text).map(part => {
    if (part.kind === 'text') return { text: part.text };
    const component = part.closed && count < 30 ? parseNexus(part.info, part.code) : null;
    if (component) { count++; return { component, raw: part.raw }; }
    return { text: part.raw };
  });
}

/** Preserve node order and assign columns only for acyclic graphs. */
export function sankeyColumns(links: Sankey['links']): Map<string, number> | null {
  const columns = new Map<string, number>();
  const degree = new Map<string, number>();
  const edges = new Map<string, string[]>();
  for (const l of links) {
    for (const name of [l.source, l.target]) {
      if (!columns.has(name)) { columns.set(name, 0); degree.set(name, 0); edges.set(name, []); }
    }
    degree.set(l.target, degree.get(l.target)! + 1);
    edges.get(l.source)!.push(l.target);
  }
  const queue = [...columns.keys()].filter(n => degree.get(n) === 0);
  for (let i = 0; i < queue.length; i++) {
    const node = queue[i];
    for (const next of edges.get(node)!) {
      columns.set(next, Math.max(columns.get(next)!, columns.get(node)! + 1));
      degree.set(next, degree.get(next)! - 1);
      if (!degree.get(next)) queue.push(next);
    }
  }
  return queue.length === columns.size ? columns : null;
}

/** Text parts can split a marked fence or its JSON at any character. */
export function assistantText(content: string | { type?: string; text?: string }[] | undefined): string {
  if (typeof content === 'string') return content;
  const texts = (content || []).filter(b => b.type === 'text').map(b => b.text || '');
  if (!texts.join('').includes('[nexus-ui]')) return texts.join('\n');
  return texts.reduce((result, next) => {
    if (!result) return next;
    const last = splitFences(result).at(-1);
    const inFence = last?.kind === 'code' && !last.closed;
    const partialFence = /(?:^|\n) {0,3}`{1,2}$/.test(result);
    return result + (!inFence && !partialFence && !result.endsWith('\n') && !next.startsWith('\n') ? '\n' : '') + next;
  }, '');
}
