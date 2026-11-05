import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupHistoryE2E, skipUnlessBrowser, openNestedPage, assertNoPageErrors, smallFile, sessionItemSelector } from './history-harness.ts';

setupHistoryE2E();
const fence = (value: unknown, info = 'json [nexus-ui]') => `\`\`\`${info}\n${JSON.stringify(value)}\n\`\`\``;
const select = { type: 'select', message: '选择方向', multiple: true, options: [{ label: '可信度' }, { label: '关系' }, { label: '其他', is_other: true }] };
const radar = { type: 'radar', title: '可信度', axes: [{ label: '丰度', value: .02, raw: '0.4%' }, { label: '覆盖', value: .6, raw: '60%' }, { label: '匹配', value: 1, raw: '774' }] };
const assistant = (text: string, timestamp = Date.now()) => ({
  role: 'assistant' as const, content: [{ type: 'text' as const, text }], api: 'openai-completions' as const,
  provider: 'test', model: 'test', stopReason: 'stop' as const, timestamp,
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
});

test('all six cards render alongside text; charts retain raw values and unsafe graphs use tables', async t => {
  if (skipUnlessBrowser(t)) return;
  const { page, broadcast, errors } = await openNestedPage(t, { blockServiceWorkers: true });
  const text = ['Before', fence(select), fence({ type: 'confirm', message: '<img src=x onerror=alert(1)>', actions: [{ label: '继续', submit: true }, { label: '关闭', submit: false }] }),
    fence({ type: 'form', message: '解读重点', items: [{ ...select, multiple: false }] }),
    fence({ taskId: 'one', status: 'QUEUING', sampleName: '样本' }, '[nexus-ui] progress'),
    fence({ taskId: 'two', status: 'FUTURE' }, 'json [nexus-ui] progress'), fence(radar),
    fence({ ...radar, title: '六轴', axes: [...radar.axes, ...radar.axes] }),
    fence({ type: 'sankey', title: '关系图', links: [{ source: '界', target: '属', value: 20 }, { source: '属', target: '种', value: 12 }] }),
    fence({ type: 'sankey', title: '循环', links: [{ source: 'a', target: 'a', value: 1 }] }), 'After'].join('\n\n');
  broadcast({ type: 'message_end', message: assistant(text) });
  await page.waitForSelector('.nexus-radar');
  assert.equal(await page.locator('.nexus-card').count(), 9);
  assert.equal(await page.locator('.nexus-progress').count(), 2);
  assert.equal(await page.locator('.nexus-radar svg').count(), 2);
  assert.equal(await page.locator('.nexus-sankey svg').count(), 1);
  assert.equal(await page.locator('.nexus-card img').count(), 0);
  assert.match(await page.locator('.nexus-radar circle title').first().textContent() || '', /0.4%/);
  const content = await page.locator('#messages > .assistant').last().textContent();
  assert.match(content || '', /Before.*After/s);
  assert.doesNotMatch(content || '', /%%CODEBLOCK/);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.locator('.nexus-radar svg').first().isVisible());
  assertNoPageErrors(errors);
});

test('streaming stays inert and shorter final text supplies split components exactly once', async t => {
  if (skipUnlessBrowser(t)) return;
  const { page, broadcast, errors } = await openNestedPage(t);
  const start = assistant('');
  broadcast({ type: 'message_start', message: start });
  const draft = fence(select) + '\nDraft '.repeat(100);
  for (const delta of draft.match(/.{1,30}|\n/g)!) {
    broadcast({ type: 'message_update', usage: start.usage, assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta } });
  }
  await page.waitForFunction(() => document.querySelector('.streaming')?.textContent?.includes('Draft'));
  assert.equal(await page.locator('.nexus-card').count(), 0);
  const final = fence({ taskId: 'final-only', status: 'FINISHED' }, '[nexus-ui] progress');
  const split = final.indexOf('final-only') + 3;
  broadcast({ type: 'message_end', message: { ...start, content: [{ type: 'text', text: final.slice(0, split) }, { type: 'text', text: final.slice(split) }] } });
  await page.waitForSelector('.nexus-progress');
  assert.equal(await page.locator('.nexus-card').count(), 1);
  assert.match(await page.locator('.nexus-progress').textContent() || '', /final-only/);
  assert.doesNotMatch(await page.locator('#messages > .assistant').last().textContent() || '', /Draft/);
  assertNoPageErrors(errors);
});

test('select requires an answer, preserves option order and other input, and retries only rejected sends', async t => {
  if (skipUnlessBrowser(t)) return;
  const { page, broadcast, session, errors } = await openNestedPage(t);
  const sent: any[] = [];
  await page.route('**/api/rpc', async route => {
    const data = route.request().postDataJSON();
    if (data.type !== 'prompt') { await route.continue(); return; }
    sent.push(data);
    await route.fulfill({ json: sent.length === 1 ? { success: false, error: 'Try again', delivery: 'rejected' } : { success: true } });
  });
  broadcast({ type: 'message_end', message: assistant(fence(select)) });
  const card = page.locator('.nexus-select');
  await card.getByRole('button', { name: '提交', exact: true }).click();
  assert.match(await card.locator('.nexus-status').textContent() || '', /请选择/);
  await card.getByRole('checkbox', { name: '其他', exact: true }).check();
  await card.getByRole('textbox').fill('我的方向');
  await card.getByRole('checkbox', { name: '可信度', exact: true }).check();
  await card.getByRole('button', { name: '提交', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.nexus-status')?.textContent === 'Try again');
  await card.getByRole('button', { name: '提交', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.nexus-status')?.textContent === '已提交');
  assert.equal(sent.length, 2);
  assert.equal(sent[1].sessionId, session.id);
  assert.match(sent[1].message, /可信度；其他：我的方向/);
  assert.equal(await card.getByRole('button').isDisabled(), true);
  assertNoPageErrors(errors);
});

test('confirm close sends nothing and forms send one answer with question context', async t => {
  if (skipUnlessBrowser(t)) return;
  const { page, broadcast, errors } = await openNestedPage(t);
  const sent: any[] = [];
  await page.route('**/api/rpc', async route => {
    const data = route.request().postDataJSON();
    if (data.type !== 'prompt') { await route.continue(); return; }
    sent.push(data); await route.fulfill({ json: { success: true } });
  });
  broadcast({ type: 'message_end', message: assistant(fence({ type: 'confirm', message: '继续吗', actions: [{ label: '继续', submit: true }, { label: '关闭', submit: false }] })) });
  await page.locator('.nexus-confirm').getByRole('button', { name: '关闭', exact: true }).click();
  assert.equal(sent.length, 0);
  assert.match(await page.locator('.nexus-confirm .nexus-status').textContent() || '', /未发送/);
  broadcast({ type: 'message_end', message: assistant(fence({ type: 'form', message: '选择解读', items: [
    { type: 'select', message: '范围', options: [{ label: '全部' }, { label: '全部' }] },
    { type: 'select', message: '角度', multiple: true, options: [{ label: '丰度' }, { label: '覆盖度' }] },
  ] })) });
  const form = page.locator('.nexus-form');
  await form.getByRole('radio').nth(1).check();
  await form.getByRole('checkbox').nth(1).check();
  await form.getByRole('button').click();
  await page.waitForFunction(() => document.querySelector('.nexus-form .nexus-status')?.textContent === '已提交');
  assert.equal(sent.length, 1);
  assert.match(sent[0].message, /选择解读.*范围：全部.*角度：覆盖度/s);
  assertNoPageErrors(errors);
});

test('history cards stay read-only and ordinary code examples do not activate', async t => {
  if (skipUnlessBrowser(t)) return;
  const { page, errors } = await openNestedPage(t);
  await page.evaluate(async text => {
    const modulePath = '/message-renderer.js';
    const { MessageRenderer } = await import(modulePath);
    const renderer = new MessageRenderer(document.getElementById('messages')!);
    renderer.renderAssistantMessage({ content: [{ type: 'text', text }] }, false, true);
  }, fence(select) + '\n\n````text\n' + fence(select) + '\n````\n\n' + fence(select, 'json'));
  assert.equal(await page.locator('.nexus-card').count(), 1);
  assert.equal(await page.locator('.nexus-card button').isDisabled(), true);
  assert.equal(await page.locator('.nexus-card input:enabled').count(), 0);
  assertNoPageErrors(errors);
});

test('a card keeps its session on tab changes and an uncertain send cannot be repeated', async t => {
  if (skipUnlessBrowser(t)) return;
  const { page, session, broadcast, errors } = await openNestedPage(t);
  const sent: any[] = [];
  await page.route('**/api/rpc', async route => {
    const data = route.request().postDataJSON();
    if (data.type !== 'prompt') { await route.continue(); return; }
    sent.push(data); await route.fulfill({ json: { success: false, delivery: 'uncertain' } });
  });
  broadcast({ type: 'message_end', message: assistant(fence({ ...select, multiple: false })) });
  await page.locator('.nexus-select input').first().check();
  await page.click(sessionItemSelector(smallFile));
  await page.waitForFunction(() => !document.querySelector('.nexus-select') && document.querySelectorAll('#messages > .message').length === 6);
  await page.click(`.live-tab[data-session-id="${session.id}"]`);
  await page.locator('.nexus-select button').click();
  await page.waitForFunction(() => document.querySelector('.nexus-status')?.textContent?.includes('尚未确认'));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].sessionId, session.id);
  assert.equal(await page.locator('.nexus-select button').isDisabled(), true);
  assertNoPageErrors(errors);
});

test('confirm sends once while pending, repeated final events keep inputs, and newer turns disable old cards', async t => {
  if (skipUnlessBrowser(t)) return;
  const { page, broadcast, errors } = await openNestedPage(t);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  t.after(() => release());
  let count = 0;
  await page.route('**/api/rpc', async route => {
    const data = route.request().postDataJSON();
    if (data.type !== 'prompt') { await route.continue(); return; }
    count++;
    assert.match(data.message, /继续吗.*继续/s);
    await gate;
    await route.fulfill({ json: { success: true } });
  });
  const message = assistant(fence({ type: 'confirm', message: '继续吗', actions: [{ label: '继续', submit: true }, { label: '关闭', submit: false }] }));
  broadcast({ type: 'message_end', message });
  await page.waitForSelector('.nexus-confirm');
  broadcast({ type: 'message_end', message });
  await page.locator('.nexus-confirm button').first().click();
  await page.waitForFunction(() => document.querySelector('.nexus-status')?.textContent === '正在发送…');
  assert.equal(await page.locator('.nexus-confirm').count(), 1);
  await page.locator('.nexus-confirm button').first().evaluate((button: HTMLButtonElement) => button.click());
  release();
  await page.waitForFunction(() => document.querySelector('.nexus-status')?.textContent === '已提交');
  assert.equal(count, 1);
  broadcast({ type: 'message_end', message: assistant(fence(select)) });
  await page.waitForSelector('.nexus-select');
  broadcast({ type: 'message_start', message: { role: 'user', content: 'New turn', timestamp: Date.now() } });
  await page.waitForFunction(() => document.querySelector('.nexus-select')?.getAttribute('data-nexus-state') === 'history');
  assert.equal(await page.locator('.nexus-select input:enabled').count(), 0);
  assertNoPageErrors(errors);
});

test('reload restores charts and text from the snapshot without sending or activating history cards', async t => {
  if (skipUnlessBrowser(t)) return;
  const { page, session, errors } = await openNestedPage(t);
  const text = ['History before', fence(select), fence(radar), fence({ type: 'progress', taskId: 'saved', status: 'ANALYSING' }), 'History after'].join('\n');
  session.entries.push({ type: 'message', message: assistant(text) });
  let prompts = 0;
  page.on('request', request => {
    if (request.url().endsWith('/api/rpc') && request.postDataJSON()?.type === 'prompt') prompts++;
  });
  await page.reload();
  await page.waitForSelector('.nexus-radar');
  assert.equal(await page.locator('.nexus-progress').count(), 1);
  assert.equal(await page.locator('.nexus-select button').isDisabled(), true);
  assert.match(await page.locator('#messages').textContent() || '', /History before.*History after/s);
  assert.equal(prompts, 0);
  assertNoPageErrors(errors);
});
