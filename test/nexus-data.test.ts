import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseNexus, parseNexusMessage, sankeyColumns, assistantText } from '../public/nexus-data.js';
import { splitFences } from '../public/markdown-fences.js';

const select = { type: 'select', message: 'Choose', options: [{ label: 'A' }, { label: 'A', is_other: true }] };
const block = (value: unknown, info = 'json [nexus-ui]') => `\`\`\`${info}\n${JSON.stringify(value)}\n\`\`\``;
test('all supported fence headers preserve multiple components and prose', () => {
  const text = ['Before', block(select), 'Between', block({ taskId: 'one', status: 'FUTURE' }, '[nexus-ui] progress'),
    block({ taskId: 'two', status: 'FAIL' }, 'json [nexus-ui] progress'), 'After'].join('\n');
  const parts = parseNexusMessage(text);
  assert.equal(parts.filter(p => 'component' in p).length, 3);
  assert.deepEqual(parts.filter(p => 'component' in p).map(p => p.component.type), ['select', 'progress', 'progress']);
  assert.match(JSON.stringify(parts), /Before.*Between.*After/);
});
test('validation rejects malformed, conflicting, oversized, and unknown components', () => {
  for (const [info, data] of [
    ['json', select], ['json [nexus-ui] progress', select], ['json [nexus-ui]', { ...select, options: [] }],
    ['json [nexus-ui]', { ...select, options: Array(51).fill({ label: 'A' }) }],
    ['json [nexus-ui]', { type: 'confirm', message: 'q', actions: [{ label: 'no', submit: false }] }],
    ['json [nexus-ui]', { type: 'form', message: 'q', items: [{ type: 'form', items: [] }] }],
    ['json [nexus-ui]', { type: 'unknown' }],
    ['json [nexus-ui]', { type: 'progress', taskId: 'x', status: '' }],
  ] as const) assert.equal(parseNexus(info, JSON.stringify(data)), null);
  assert.equal(parseNexus('json [nexus-ui]', '{oops'), null);
  assert.equal(parseNexus('json [nexus-ui]', ' '.repeat(65537)), null);
});
test('outer example fences and incomplete fences never activate components', () => {
  const example = '````text\n' + block(select) + '\n````';
  assert.equal(parseNexusMessage(example).filter(p => 'component' in p).length, 0);
  assert.equal(parseNexusMessage(block(select).slice(0, -3)).filter(p => 'component' in p).length, 0);
  assert.equal(splitFences(example).length, 1);
});
test('radar values stay in 0–1 and raw strings are retained', () => {
  const axes = Array.from({ length: 3 }, (_, i) => ({ label: `axis${i}`, value: i / 2, raw: `${i}%` }));
  assert.deepEqual(parseNexus('json [nexus-ui]', JSON.stringify({ type: 'radar', title: 'r', axes })), { type: 'radar', title: 'r', axes });
  for (const value of [-1, 1.1, null, '1']) {
    assert.equal(parseNexus('json [nexus-ui]', JSON.stringify({ type: 'radar', title: 'r', axes: [{ ...axes[0], value }, ...axes.slice(1)] })), null);
  }
});
test('Sankey preserves node order and detects cycles and self links', () => {
  const links = [{ source: 'b', target: 'c', value: 2 }, { source: 'a', target: 'b', value: 3 }];
  assert.deepEqual([...sankeyColumns(links)!], [['b', 1], ['c', 2], ['a', 0]]);
  assert.equal(sankeyColumns([...links, { source: 'c', target: 'a', value: 1 }]), null);
  assert.equal(sankeyColumns([{ source: 'x', target: 'x', value: 1 }]), null);
});
test('text content parts can split marked JSON inside a string', () => {
  const text = block(select);
  const index = text.indexOf('Choose') + 2;
  const joined = assistantText([{ type: 'text', text: text.slice(0, index) }, { type: 'text', text: text.slice(index) }]);
  assert.equal(joined, text);
  assert.equal(parseNexusMessage(joined).filter(p => 'component' in p).length, 1);
  assert.equal(parseNexusMessage(assistantText([{ type: 'text', text }, { type: 'text', text }])).filter(p => 'component' in p).length, 2);
});
test('invalid blocks do not consume later valid blocks and excess blocks remain source', () => {
  const text = '```json [nexus-ui]\ninvalid\n```\n' + Array(32).fill(block(select)).join('\n');
  assert.equal(parseNexusMessage(text).filter(p => 'component' in p).length, 30);
});
