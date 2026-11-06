import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { WebSocket } from 'ws';

const [base, sessionId, runId] = process.argv.slice(2);
const authorization = `Basic ${Buffer.from('alice:fixture-only').toString('base64')}`;
async function connect() {
  const socket = new WebSocket(base.replace('http:', 'ws:') + '/ws', { headers: { Authorization: authorization } });
  try {
    const state: any = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('WebSocket state timed out')), 10000);
      socket.once('error', error => { clearTimeout(timer); reject(error); });
      socket.once('message', data => { clearTimeout(timer); resolve(JSON.parse(String(data))); });
    });
    assert.equal(state.liveSessions.find((s: any) => s.id === sessionId)?.run.run_id, runId);
    const id = 'live-models-' + Date.now();
    const response: any = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Live models response timed out')), 10000);
      socket.on('message', data => {
        const message = JSON.parse(String(data));
        if (message.type !== 'response' || message.command !== 'get_available_models') return;
        clearTimeout(timer);
        resolve(message);
      });
      socket.send(JSON.stringify({ type: 'get_available_models', sessionId, id }));
    });
    assert.equal(response.id, id);
    assert.equal(response.success, true);
    assert.ok(Array.isArray(response.data.models));

  } finally { socket.close(); }
}
await connect();
await connect();
const browser = await chromium.launch();
try {
  const context = await browser.newContext({ httpCredentials: { username: 'alice', password: 'fixture-only' }, serviceWorkers: 'block' });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(base);
  await page.locator(`.live-tab[data-session-id="${sessionId}"]`).click();
  await page.locator('.workspace-version').filter({ hasText: 'Running: v1' }).waitFor();
  await page.locator('#sidebar > .workspace-select').selectOption('exp1');
  assert.match(await page.locator('.workspace-version').textContent() || '', /debug.*Running: v1/);
  await page.reload();
  await page.locator(`.live-tab[data-session-id="${sessionId}"]`).click();
  await page.locator('.workspace-version').filter({ hasText: 'Running: v1' }).waitFor();
  const sessions = await (await context.request.get(base + '/api/live-sessions')).json();
  assert.equal(sessions.sessions.find((s: any) => s.id === sessionId)?.run.run_id, runId);
  await page.click('#file-sidebar-toggle');
  for (const name of ['AGENTS.md', 'RUNTIME.json']) {
    const item = page.locator(`.file-item[data-name="${name}"]`);
    await item.waitFor();
    assert.match(await item.textContent() || '', /运行时只读文件/);
    assert.doesNotMatch(await item.textContent() || '', /Unavailable|0B/);
    await item.click();
    await page.waitForFunction(() => !!document.querySelector('#file-preview button') && [...document.querySelectorAll<HTMLButtonElement>('#file-preview button')].some(b => b.textContent === 'Download' && !b.disabled));
    assert.match(await page.locator('.file-preview-toolbar').textContent() || '', /运行时只读文件/);
    const expected = await (await context.request.get(base + '/api/file/text?' + new URLSearchParams({ sessionId, path: '/workspace/' + name, run_id: runId }))).json();
    if (name === 'RUNTIME.json') assert.equal(JSON.parse(await page.locator('.file-preview-source').textContent() || '').session_id, runId);
    else assert.ok((await page.locator('.file-preview-content').textContent())?.includes('Offline fixture only.'));
    await page.locator('#sidebar > .workspace-select').selectOption('exp1');
    const downloading = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download', exact: true }).click();
    const download = await downloading;
    const stream = await download.createReadStream();
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    assert.equal(Buffer.concat(chunks).toString(), expected.text);
  }
  console.log('PASS real browser runtime file labels, previews, and downloads remain scoped after sidebar switching');
  assert.deepEqual(errors, []);
  await context.close();
  console.log('PASS real browser workspace selection, reload, and WebSocket reconnect retain the Pi run');
} finally { await browser.close(); }
