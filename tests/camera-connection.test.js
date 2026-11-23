const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const script = fs.readFileSync(require('node:path').join(__dirname, '../public/script.js'), 'utf8');
const cameraCode = script.slice(script.indexOf('function showCameraUnavailable('), script.indexOf('function updateFaceRecognitionCount('));

function dashboard(protocol = 'http:', savedCamera = 1) {
  const elements = new Map();
  const timers = new Map();
  let timerId = 0;
  const element = (id) => {
    if (!elements.has(id)) elements.set(id, {
      style: {}, value: 'http://192.168.1.6:81/stream', naturalWidth: 0, naturalHeight: 0,
      removeAttribute(name) { delete this[name]; },
      getAttribute(name) { return this[name]; }
    });
    return elements.get(id);
  };
  const context = vm.createContext({
    $: element, API_BASE: '/api', connected: false, cameraAttempt: 0,
    cameraLoadTimer: null, cameraFirstFrameTimer: null,
    URL, Date, Event, fetch: () => Promise.resolve(),
    window: { activeCameraId: savedCamera, location: { protocol, origin: `${protocol}//localhost:3000` }, dispatchEvent() {} },
    stopRecordingPlayback() {}, stopFaceRecognition() {}, updateStats() {},
    setTimeout(fn) { timers.set(++timerId, fn); return timerId; },
    clearTimeout(id) { timers.delete(id); },
    setInterval(fn) { timers.set(++timerId, fn); return timerId; },
    clearInterval(id) { timers.delete(id); }
  });
  vm.runInContext(cameraCode, context);
  return { context, element, timers };
}

test('local feed uses the entered URL, then falls back to the saved-camera proxy', async () => {
  const { context, element } = dashboard();
  await context.connectCamera();
  const image = element('cameraImg');
  assert.equal(new URL(image.src).hostname, '192.168.1.6');
  assert.equal(image.crossOrigin, 'anonymous');
  image.onerror();
  assert.equal(new URL(image.src).pathname, '/api/cameras/1/stream');
  image.onerror();
  assert.equal(image.src, undefined);
  assert.match(element('cameraStatus').textContent, /unavailable/);
});

test('HTTPS connects directly to a same-Wi-Fi camera before trying the relay', async () => {
  const { context, element } = dashboard('https:');
  await context.connectCamera();
  assert.equal(new URL(element('cameraImg').src).hostname, '192.168.1.6');
  assert.match(element('cameraStatus').textContent, /Local network access/);
  element('cameraImg').onerror();
  assert.equal(new URL(element('cameraImg').src).protocol, 'https:');
  element('cameraImg').onerror();
  assert.equal(element('cameraImg').src, undefined);
  assert.match(element('cameraPlaceholder').innerHTML, /Local network access/);
});

test('HTTPS can connect to an unsaved local camera without a cloud proxy', async () => {
  const { context, element } = dashboard('https:', null);
  await context.connectCamera();
  const image = element('cameraImg');
  assert.equal(new URL(image.src).hostname, '192.168.1.6');
  image.naturalWidth = 640;
  image.naturalHeight = 480;
  image.onload();
  assert.equal(context.connected, true);
});

test('HTTPS does not embed public HTTP URLs as a mixed-content fallback', async () => {
  const { context, element } = dashboard('https:');
  element('cameraUrl').value = 'http://camera.example.com/stream';
  await context.connectCamera();
  assert.equal(new URL(element('cameraImg').src).pathname, '/api/cameras/1/stream');
  element('cameraImg').onerror();
  assert.equal(element('cameraImg').src, undefined);
});

test('local camera detection includes private ranges and excludes public lookalikes', () => {
  const { context } = dashboard('https:');
  for (const host of ['10.0.0.1', '172.16.0.1', '172.31.255.254', '192.168.1.6', '169.254.1.2', 'esp32.local', '[fd12::1]', '[fe80::1]']) {
    assert.equal(context.isLocalCameraUrl(new URL(`http://${host}/stream`)), true, host);
  }
  for (const host of ['172.15.0.1', '172.32.0.1', '192.169.1.1', 'camera.local.example.com', 'example.com']) {
    assert.equal(context.isLocalCameraUrl(new URL(`http://${host}/stream`)), false, host);
  }
});

test('first decoded MJPEG frame cancels connection timeout', async () => {
  const { context, element, timers } = dashboard();
  await context.connectCamera();
  const image = element('cameraImg');
  image.naturalWidth = 640;
  image.naturalHeight = 480;
  image.onload();
  assert.equal(context.connected, true);
  assert.equal(timers.size, 0);
  assert.equal(element('cameraPlaceholder').style.display, 'none');
});

test('timeout advances to fallback and stale callbacks cannot replace a newer connection', async () => {
  const { context, element, timers } = dashboard();
  await context.connectCamera();
  const staleTimeout = timers.get(context.cameraFirstFrameTimer);
  staleTimeout();
  assert.equal(new URL(element('cameraImg').src).pathname, '/api/cameras/1/stream');
  await context.connectCamera();
  const currentSource = element('cameraImg').src;
  staleTimeout();
  assert.equal(element('cameraImg').src, currentSource);
});
