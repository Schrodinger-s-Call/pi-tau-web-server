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
  assert.deepEqual(errors, []);
  await context.close();
  console.log('PASS real browser workspace selection, reload, and WebSocket reconnect retain the Pi run');
} finally { await browser.close(); }
