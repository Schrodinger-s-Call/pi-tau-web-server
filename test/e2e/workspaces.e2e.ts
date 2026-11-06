import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupHistoryE2E, skipUnlessBrowser, openNestedPage, liveManager, assertNoPageErrors } from './history-harness.ts';
setupHistoryE2E();

test('workspace selection cannot change a conversation report link or its running bundle', async t => {
  if (skipUnlessBrowser(t)) return;
  const { page, session, errors, broadcast } = await openNestedPage(t, { blockServiceWorkers: true });
  let currentName = 'bundle-one';
  const bundle = { name: 'bundle-one', sha256: 'a'.repeat(64), commit: null };
  const workspace = { workspace_id: 'debug', display_name: 'Debug', paths: { files: session.cwd, sessions: '/test/history' }, current_bundle: bundle };
  session.workspace = workspace;
  session.run = { run_id: 'run-original', actual_bundle: { ...bundle } };
  t.after(() => { session.workspace = undefined; session.run = undefined; });
  await page.route('**/api/workspaces', route => route.fulfill({ json: { enabled: true, revision: 1, workspaces: [
    { ...workspace, current_bundle: { ...bundle, name: currentName } },
    { ...workspace, workspace_id: 'exp1', display_name: 'Experiment', paths: { files: '/test/exp1', sessions: '/test/history-exp1' } },
  ] } }));
  await page.evaluate(async () => { const module = await import(String('/workspaces.js')); await module.refreshWorkspaces(); });
  liveManager.broadcastUpdated(session.id);
  await page.waitForFunction(() => document.querySelector('.workspace-version')?.textContent?.includes('Running: bundle-one'));
  await page.route('**/api/file/image?**', route => route.fulfill({ contentType: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aO1sAAAAASUVORK5CYII=', 'base64') }));
  const message: any = { role: 'assistant', content: [{ type: 'text', text: '[Report](output/report.html) ![Chart](/workspace/chart.png)' }], timestamp: Date.now() };
  broadcast({ type: 'message_end', message });
  const report = page.locator('#messages a').filter({ hasText: 'Report' }).last();
  await report.waitFor();
  assert.match(await report.getAttribute('href') || '', /workspace_id=debug/);
  const chart = page.locator('#messages img[alt="Chart"]').last();
  await chart.waitFor();
  assert.match(await chart.getAttribute('src') || '', /workspace_id=debug/);
  await chart.evaluate((image: HTMLImageElement) => image.decode());
  await page.locator('#sidebar > .workspace-select').selectOption('exp1');
  assert.match(await chart.getAttribute('src') || '', /workspace_id=debug/);

  assert.match(await report.getAttribute('href') || '', /workspace_id=debug/);
  assert.match(await page.locator('.workspace-version').textContent() || '', /Debug.*Running: bundle-one/);
  currentName = 'bundle-two';
  await page.evaluate(async () => { const module = await import(String('/workspaces.js')); await module.refreshWorkspaces(); });
  assert.match(await page.locator('.workspace-version').textContent() || '', /Running: bundle-one.*Current: bundle-two/);
  assert.equal(session.run.run_id, 'run-original');
  let created: any;
  await page.route('**/api/live-sessions', async route => {
    if (route.request().method() !== 'POST') { await route.continue(); return; }
    created = route.request().postDataJSON();
    await route.fulfill({ json: { session: session.metadata() } });
  });
  await page.click('#new-session-btn');
  await page.locator('#new-live-session-modal .workspace-select').selectOption('exp1');
  await page.click('#new-live-session-submit');
  await page.waitForFunction(() => document.getElementById('new-live-session-modal')?.classList.contains('hidden'));
  assert.equal(created.workspace_id, 'exp1');
  await assertNoPageErrors(errors);
});

test('runtime file previews and downloads retain their run and explain unavailable contents', async t => {
  if (skipUnlessBrowser(t)) return;
  const { page, session, errors } = await openNestedPage(t, { blockServiceWorkers: true });
  const bundle = { name: 'old-bundle', sha256: 'a'.repeat(64), commit: null };
  const workspace = { workspace_id: 'debug', display_name: 'Debug', paths: { files: session.cwd, sessions: '/test/history' }, current_bundle: bundle };
  session.workspace = workspace;
  session.run = { run_id: 'd'.repeat(32), actual_bundle: bundle };
  t.after(() => { session.workspace = undefined; session.run = undefined; });
  await page.route('**/api/workspaces', route => route.fulfill({ json: { enabled: true, revision: 1, workspaces: [workspace, { ...workspace, workspace_id: 'exp1' }] } }));
  await page.evaluate(async () => { const module = await import(String('/workspaces.js')); await module.refreshWorkspaces(); });
  liveManager.broadcastUpdated(session.id);
  await page.route('**/api/files?**', route => route.fulfill({ json: { path: '/workspace', items: [
    { name: 'AGENTS.md', path: '/workspace/AGENTS.md', isDirectory: false, size: 16, runtime_readonly: true },
    { name: 'RUNTIME.json', path: '/workspace/RUNTIME.json', isDirectory: false, size: null, runtime_readonly: true, unavailable: 'Runtime file unavailable: run_tau does not support run-file' },
  ] } }));
  const requests: URL[] = [];
  await page.route('**/api/file/text?**', route => {
    const url = new URL(route.request().url()); requests.push(url);
    return route.fulfill(url.searchParams.get('path') === '/workspace/AGENTS.md'
      ? { json: { text: '# Old bundle', runtime_readonly: true, run_id: session.run.run_id, workspace_id: 'debug' } }
      : { status: 400, json: { error: 'Runtime file unavailable: run_tau does not support run-file' } });
  });
  let downloaded: URL | undefined;
  await page.route('**/api/file/download?**', route => {
    downloaded = new URL(route.request().url());
    return route.fulfill({ body: '# Old bundle', contentType: 'text/plain' });
  });
  await page.click('#file-sidebar-toggle');
  await page.locator('.file-item[data-name="AGENTS.md"]').click();
  await page.locator('#file-preview h1').waitFor();
  assert.match(await page.locator('.file-preview-toolbar').textContent() || '', /运行时只读文件/);
  await page.locator('#sidebar > .workspace-select').selectOption('exp1');
  const downloadEvent = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download', exact: true }).click();
  await downloadEvent;
  assert.equal(downloaded?.searchParams.get('sessionId'), session.id);
  assert.equal(downloaded?.searchParams.get('run_id'), session.run.run_id);
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await page.locator('#file-preview h1').waitFor();
  assert.equal(requests.at(-1)?.searchParams.get('run_id'), session.run.run_id);
  assert.ok(requests.every(url => url.searchParams.get('sessionId') === session.id));
  const unavailable = page.locator('.file-item[data-name="RUNTIME.json"]');
  assert.match(await unavailable.textContent() || '', /Unavailable/);
  assert.doesNotMatch(await unavailable.textContent() || '', /0B/);
  await unavailable.click();
  await page.waitForFunction(() => document.querySelector('.file-preview-status')?.textContent?.includes('run_tau does not support'));
  assert.equal(await page.getByRole('button', { name: 'Download', exact: true }).isDisabled(), true);
  await assertNoPageErrors(errors);
});
