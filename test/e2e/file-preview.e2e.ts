import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { TestContext } from 'node:test';
import { setupHistoryE2E, skipUnlessBrowser, openPage, sessionItemSelector, writeSession, liveManager, assertNoPageErrors } from './history-harness.ts';

setupHistoryE2E();

async function workspace(t: TestContext) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-file-preview-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  fs.writeFileSync(path.join(cwd, 'notes.md'), '# 阅读文件\n\n**Hello**\n\n<script>window.previewInjected = true</script>\n\n![local](image.png)\n\n[local](other.md)');
  fs.writeFileSync(path.join(cwd, 'data.json'), '{ "value": "<script>" }');
  fs.writeFileSync(path.join(cwd, 'large.txt'), 'x'.repeat(256 * 1024 + 1));
  fs.writeFileSync(path.join(cwd, 'long.md'), '# Source only\n' + 'x'.repeat(33 * 1024));
  const file = writeSession(`${path.basename(cwd)}.jsonl`, [
    { type: 'session', id: path.basename(cwd), cwd, timestamp: '2026-01-03T00:00:00.000Z' },
    { type: 'message', message: { role: 'user', content: 'First question' } },
    { type: 'message', message: { role: 'user', content: 'Keep this conversation' } },
    { type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'Conversation reply' }] } },
  ]);
  const { page, errors } = await openPage(t, { blockServiceWorkers: true });
  await page.click(sessionItemSelector(file));
  await page.waitForSelector('#messages .message');
  await page.click('#file-sidebar-toggle');
  await page.waitForSelector('.file-item[data-name="notes.md"]');
  return { page, errors, file, cwd };
}

test('file tabs render Markdown and source, preserve chat, and open from attachment cards', async t => {
  if (skipUnlessBrowser(t)) return;
  const { page, errors, file, cwd } = await workspace(t);
  await page.evaluate(() => { document.querySelector<HTMLElement>('#messages .message')!.dataset.kept = 'yes'; });
  const sessionCount = liveManager.sessions.size;
  await page.fill('#message-input', 'Draft');
  await page.click('.file-item[data-name="notes.md"]');
  await page.waitForSelector('#file-preview h1');
  assert.equal(await page.locator('#file-preview h1').textContent(), '阅读文件');
  assert.equal(await page.locator('#messages').isVisible(), false);
  assert.equal(await page.locator('#file-preview img').count(), 0);
  assert.equal(await page.evaluate(() => (window as any).previewInjected), undefined);
  await page.getByRole('button', { name: 'Source', exact: true }).click();
  assert.match(await page.locator('.file-preview-source').textContent() || '', /# 阅读文件/);
  const chatTab = `.live-tab[data-session-id="${liveManager.findBySessionFile(file).id}"]`;
  await page.click(chatTab);
  assert.equal(await page.locator('#messages .message').first().getAttribute('data-kept'), 'yes');
  assert.equal(await page.inputValue('#message-input'), 'Draft');
  assert.equal(liveManager.sessions.size, sessionCount);
  await page.click('.file-tab');
  await page.getByRole('button', { name: 'Add to message', exact: true }).click();
  assert.match(await page.inputValue('#message-input'), /notes\.md/);
  await page.getByRole('button', { name: 'Preview notes.md', exact: true }).click();
  await page.waitForSelector('#file-preview h1');
  assert.equal(await page.locator('.file-tab').count(), 1);
  await page.click('.file-item[data-name="data.json"]');
  await page.waitForSelector('.file-preview-source');
  assert.equal(await page.locator('.file-preview-source').textContent(), '{ "value": "<script>" }');
  fs.writeFileSync(path.join(cwd, 'data.json'), 'Updated');
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.file-preview-source')?.textContent === 'Updated');
  await page.locator('.file-tab.active .live-tab-close').click();
  assert.equal(await page.locator('#messages').isVisible(), true);
  assertNoPageErrors(errors);
});

test('large files are rejected and long Markdown stays readable as source', async t => {
  if (skipUnlessBrowser(t)) return;
  const { page, errors } = await workspace(t);
  await page.click('.file-item[data-name="large.txt"]');
  await page.waitForFunction(() => document.querySelector('.file-preview-status')?.textContent?.includes('256 KiB preview limit'));
  await page.click('.file-item[data-name="long.md"]');
  await page.waitForSelector('.file-preview-source');
  assert.match(await page.locator('.file-preview-status').textContent() || '', /Showing source/);
  assert.match(await page.locator('.file-preview-source').textContent() || '', /Source only/);
  assertNoPageErrors(errors);
});

test('a delayed file response cannot replace the selected file', async t => {
  if (skipUnlessBrowser(t)) return;
  const { page, errors } = await workspace(t);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let started!: () => void;
  const requested = new Promise<void>(resolve => { started = resolve; });
  await page.route('**/api/file/text?**', async route => {
    if (new URL(route.request().url()).searchParams.get('path')?.endsWith('notes.md')) {
      started();
      await gate;
      await route.fulfill({ json: { text: '# Stale document' } }).catch(() => {});
    } else await route.continue();
  });
  await page.click('.file-item[data-name="notes.md"]');
  await requested;
  await page.click('.file-item[data-name="data.json"]');
  await page.waitForSelector('.file-preview-source');
  release();
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await page.waitForSelector('.file-preview-source');
  assert.equal(await page.locator('.file-preview-source').textContent(), '{ "value": "<script>" }');
  assertNoPageErrors(errors);
});

test('file tabs stay with their session and disappear when that session closes', async t => {
  if (skipUnlessBrowser(t)) return;
  const { page, errors, file } = await workspace(t);
  await page.click('.file-item[data-name="notes.md"]');
  await page.waitForSelector('#file-preview h1');
  const other = writeSession(`other-${Date.now()}.jsonl`, [
    { type: 'session', id: 'other', cwd: os.tmpdir(), timestamp: '2026-01-03T00:00:00.000Z' },
    { type: 'message', message: { role: 'user', content: 'First question' } },
    { type: 'message', message: { role: 'user', content: 'Other conversation' } },
  ]);
  await page.click('#refresh-sessions-btn');
  await page.click(sessionItemSelector(other));
  await page.waitForFunction(() => document.getElementById('messages')?.textContent?.includes('Other conversation'));
  assert.equal(await page.locator('.file-tab').count(), 0);
  const id = liveManager.findBySessionFile(file).id;
  await page.click(`.live-tab[data-session-id="${id}"]`);
  await page.waitForSelector('.file-tab');
  await page.click('.file-tab');
  await page.waitForSelector('#file-preview h1');
  await page.click(`.live-tab[data-session-id="${id}"] .live-tab-close`);
  await page.waitForFunction(() => !document.body.classList.contains('viewing-file'));
  assert.equal(await page.locator('.file-tab').count(), 0);
  assertNoPageErrors(errors);
});

test('Markdown formatting times out without preventing source reading or navigation', async t => {
  if (skipUnlessBrowser(t)) return;
  const { page, errors } = await workspace(t);
  await page.route('**/file-preview-worker.js', route => route.fulfill({
    contentType: 'text/javascript', body: 'self.onmessage = () => { while (true) {} };',
  }));
  await page.click('.file-item[data-name="notes.md"]');
  await page.waitForFunction(() => document.querySelector('.file-preview-status')?.textContent?.includes('took too long'));
  assert.match(await page.locator('.file-preview-source').textContent() || '', /阅读文件/);
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#messages').isVisible(), true);
  assertNoPageErrors(errors);
});
