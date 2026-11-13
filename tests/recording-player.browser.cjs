// Optional real-browser check: node tests/recording-player.browser.cjs <path-to-playwright-core>
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const express = require('express');
const { chromium } = require(process.argv[2] || 'playwright-core');
const fixture = require('./helpers/avi-fixture');

(async () => {
  const app = express();
  const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
  const historyStart = html.indexOf('<section class="panel" id="recordingHistoryPanel">');
  const historyEnd = html.indexOf('<section class="panel" id="faceManagementPanel"', historyStart);
  const history = html.slice(historyStart, historyEnd);
  app.get('/', (_req, res) => res.send(`<div id="app">${history}</div><script>window.currentRole='admin';</script><script src="/mjpeg-avi.js"></script><script src="/device-recordings.js"></script>`));
  app.get('/api/recordings', (_req, res) => res.json([
    { id: '2', cameraName: 'Test camera', startedAt: '2026-11-14T00:00:02Z', durationSeconds: 2, fileSizeBytes: fixture(10).length, storageProvider: 'r2' },
    { id: '1', cameraName: 'Test camera', startedAt: '2026-11-14T00:00:00Z', durationSeconds: 2, fileSizeBytes: fixture(10).length, storageProvider: 'r2' }
  ]));
  app.get('/api/recordings/1/source', (_req, res) => res.json({ format: 'mjpeg-avi', url: '/fixture.avi' }));
  app.get('/api/recordings/2/source', (_req, res) => res.json({ format: 'mjpeg-avi', url: '/fixture.avi' }));
  app.get('/fixture.avi', (_req, res) => res.type('video/x-msvideo').send(fixture(10)));
  app.post('/api/cameras/1/device-token', (_req, res) => res.json({ token: 'one-time-test-token' }));
  app.use(express.static(path.join(__dirname, '../public')));
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  let browser;
  try {
    browser = await chromium.launch({ channel: 'msedge', headless: true });
    const page = await browser.newPage(); const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/#pastFootagePanel`);
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('cameras:updated', { detail: [{ id: 1, name: 'Test camera' }] })));
    await page.getByRole('button', { name: 'Load recordings' }).click();
    await page.waitForFunction(() => document.getElementById('recordingPlayerStatus').textContent.includes('No audio'));
    await page.waitForFunction(() => document.getElementById('recordingReplayPosition').textContent === 'Clip 2 of 2');
    await page.waitForFunction(() => {
      const data = document.getElementById('aviRecordingCanvas').getContext('2d').getImageData(0, 0, 1, 1).data;
      return data[3] === 255;
    });
    await page.waitForFunction(() => Number(document.getElementById('aviRecordingSeek').value) > 0.2);
    await page.locator('#aviRecordingPlay').click();
    await page.locator('#aviRecordingSeek').evaluate((element) => { element.value = '1.6'; element.dispatchEvent(new Event('input')); });
    assert.match(await page.locator('#aviRecordingTime').textContent(), /1.6/);
    await page.locator('#replayRecordings').click();
    await page.waitForFunction(() => document.getElementById('recordingPlayerStatus').textContent.includes('No audio'));
    await page.waitForFunction(() => document.getElementById('recordingReplayPosition').textContent === 'Clip 1 of 2');
    await page.waitForFunction(() => document.getElementById('recordingReplayPosition').textContent === 'Clip 2 of 2', null, { timeout: 8000 });
    page.once('dialog', (dialog) => dialog.accept());
    await page.locator('#createDeviceToken').click();
    await page.waitForFunction(() => document.getElementById('deviceTokenResult').textContent === 'one-time-test-token');
    await page.evaluate(() => { document.getElementById('app').hidden = true; });
    await page.waitForFunction(() => document.getElementById('deviceTokenResult').textContent === '');
    assert.deepEqual(errors, []);
    console.log('PASS: inline real JPEG playback, sequential replay, controls, and token cleanup in Edge.');
  } finally { await browser?.close(); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
