const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function dashboard(protocol = 'http:') {
  const elements = new Map();
  const listeners = new Map();
  const intervals = new Map();
  const timeouts = new Map();
  const posts = [];
  let timerId = 0;
  let faces = [{ matched: false }];
  const create = (tag) => ({
    tag, children: [], dataset: {}, style: {}, attrs: {}, handlers: {}, naturalWidth: 0, naturalHeight: 0,
    classList: { add() {}, remove() {}, toggle() {} },
    append(...nodes) { for (const node of nodes) { this.children.push(node); node.parent = this; } },
    appendChild(node) { this.append(node); },
    remove() { if (this.parent) this.parent.children = this.parent.children.filter((child) => child !== this); },
    setAttribute(name, value) { this.attrs[name] = value; },
    getAttribute(name) { return name === 'src' ? this.src : this.attrs[name]; },
    removeAttribute(name) { delete this[name]; if (name === 'src') this.naturalWidth = this.naturalHeight = 0; },
    addEventListener(name, fn) { this.handlers[name] = fn; },
    getContext() { return { drawImage() {} }; },
    toDataURL() { return 'data:image/jpeg;base64,/9j/2Q=='; },
    scrollIntoView() {}, focus() {}, requestFullscreen: async () => {}
  });
  const byId = (id) => { if (!elements.has(id)) elements.set(id, create('div')); return elements.get(id); };
  const window = {
    currentRole: 'admin', location: { protocol, origin: `${protocol}//localhost:3001` },
    addEventListener: (name, fn) => listeners.set(name, fn), dispatchEvent() {},
    FaceManagement: { classify: async (results) => results }
  };
  const context = vm.createContext({
    window, URL, Date, Map, Set, Event,
    document: { getElementById: byId, createElement: create },
    isLocalCameraUrl: (url) => url.hostname.startsWith('192.168.'),
    loadFaceModels: async () => {}, drawDetectedFaces() {}, loadAlerts: async () => {},
    faceapi: { TinyFaceDetectorOptions: class {}, detectAllFaces: () => ({ withFaceLandmarks: () => ({ withFaceDescriptors: async () => faces }) }) },
    setInterval(fn, delay) { intervals.set(delay, fn); return ++timerId; },
    setTimeout(fn) { timeouts.set(++timerId, fn); return timerId; },
    clearTimeout(id) { timeouts.delete(id); },
    fetch: async (url, options) => { posts.push({ url, data: JSON.parse(options.body) }); return { ok: true, json: async () => ({ id: 1 }) }; }
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/camera-grid.js'), 'utf8'), context);
  const tile = (id) => byId('cameraLiveGrid').children.find((node) => node.dataset.cameraId === String(id));
  const image = (id) => tile(id).children[1].children[0];
  return {
    window, context, byId, tile, image, posts,
    render(cameras) { listeners.get('cameras:updated')({ detail: cameras }); },
    connect(id) { const img = image(id); img.naturalWidth = 640; img.naturalHeight = 480; img.onload(); },
    detect: () => intervals.get(1000)(),
    setFaces(value) { faces = value; }
  };
}
const camera = (id, extra = {}) => ({ id, name: `Camera ${id}`, location: 'Gate', streamUrl: `http://192.168.1.${id}:81/stream`, isEnabled: true, ...extra });

test('adding a saved camera immediately adds its own window without restarting existing streams', () => {
  const c = dashboard();
  c.render([camera(1)]);
  const first = c.image(1);
  const source = first.src;
  c.render([camera(1), camera(2)]);
  assert.equal(c.byId('cameraLiveGrid').children.length, 2);
  assert.equal(c.image(1), first);
  assert.equal(first.src, source);
  assert.equal(new URL(c.image(2).src).hostname, '192.168.1.2');
  assert.equal(c.byId('singleCameraPreview').hidden, true);
  c.render([camera(1, { name: 'Renamed' }), camera(2)]);
  assert.equal(c.tile(1).children[0].children[0].textContent, 'Renamed');
  assert.equal(first.src, source);
});

test('each camera connects independently and one failed camera leaves other streams running', () => {
  const c = dashboard('https:');
  c.render([camera(1), camera(2)]);
  assert.equal(new URL(c.image(1).src).protocol, 'http:');
  c.connect(1); c.connect(2);
  assert.equal(c.byId('feedBadge').textContent, '2 / 2 CONNECTED');
  const secondSource = c.image(2).src;
  c.image(1).onerror();
  assert.equal(new URL(c.image(1).src).pathname, '/api/cameras/1/stream');
  c.image(1).onerror();
  assert.equal(c.image(2).src, secondSource);
  assert.equal(c.byId('feedBadge').textContent, '1 / 2 CONNECTED');
});

test('archived or disabled cameras release their stream and their window; URL changes reconnect only that camera', () => {
  const c = dashboard();
  c.render([camera(1), camera(2)]);
  const first = c.image(1);
  const secondSource = c.image(2).src;
  c.render([camera(1, { streamUrl: 'http://192.168.1.99:81/stream' }), camera(2)]);
  assert.equal(new URL(first.src).hostname, '192.168.1.99');
  assert.equal(c.image(2).src, secondSource);
  c.render([camera(1, { isEnabled: false }), camera(2)]);
  assert.equal(first.src, undefined);
  assert.equal(c.tile(1), undefined);
  c.render([]);
  assert.equal(c.byId('singleCameraPreview').hidden, false);
});

test('face monitoring snapshots use each camera ID and independent capture cooldowns', async () => {
  const c = dashboard();
  c.render([camera(1), camera(2)]);
  c.connect(1); c.connect(2);
  await c.detect(); await c.detect(); await c.detect();
  const alerts = c.posts.filter((post) => post.url === '/api/alerts');
  assert.deepEqual(alerts.map((post) => post.data.cameraId), [1, 2]);
  assert.ok(alerts.every((post) => post.data.faceCount === 1));
});

test('matched faces do not save alerts and disconnecting a camera discards its unfinished inference', async () => {
  const c = dashboard();
  c.render([camera(1)]); c.connect(1);
  c.setFaces([{ matched: true }]);
  await c.detect();
  assert.equal(c.posts.filter((post) => post.url === '/api/alerts').length, 0);
  let finish;
  c.window.FaceManagement.classify = () => new Promise((resolve) => { finish = resolve; });
  const pending = c.detect();
  await new Promise(setImmediate);
  c.tile(1).children[2].children[1].children[1].handlers.click();
  finish([{ matched: false }]);
  await pending;
  assert.equal(c.posts.filter((post) => post.url === '/api/alerts').length, 0);
});

test('Camera Setup Add Camera refreshes Live Camera Feed through the actual save handler', async () => {
  const c = dashboard();
  const saved = [camera(1)];
  c.context.byId = c.byId;
  c.context.cameraFeeds = [];
  c.context.currentUser = { role: 'admin' };
  c.context.escapeHtml = String;
  c.context.showAuthError = (message) => { throw new Error(message); };
  c.context.alert = (message) => { throw new Error(message); };
  c.context.loadStats = () => {};
  c.context.api = async (url, options) => {
    assert.equal(url, '/api/cameras');
    if (options?.method === 'POST') {
      const data = JSON.parse(options.body);
      saved.push(camera(2, data));
      return saved[1];
    }
    return saved.map((item) => ({ ...item }));
  };
  c.window.dispatchEvent = (event) => { if (event.type === 'cameras:updated') c.render(event.detail); };
  c.context.CustomEvent = class { constructor(type, options) { this.type = type; this.detail = options.detail; } };
  c.byId('cameraList').querySelectorAll = () => [];
  const source = fs.readFileSync(path.join(__dirname, '../public/auth.js'), 'utf8');
  vm.runInContext(source.slice(source.indexOf('async function loadCameras('), source.indexOf("window.addEventListener('camera:saved'")), c.context);
  vm.runInContext(source.slice(source.indexOf("byId('addCameraBtn').addEventListener"), source.indexOf("byId('publishAnnouncementBtn').addEventListener")), c.context);
  await c.context.loadCameras();
  const first = c.image(1);
  c.byId('newCameraName').value = 'Second camera';
  c.byId('newCameraUrl').value = 'http://192.168.1.2:81/stream';
  c.byId('newCameraLocation').value = 'Entrance';
  await c.byId('addCameraBtn').handlers.click();
  assert.equal(c.byId('cameraLiveGrid').children.length, 2);
  assert.equal(c.tile(2).children[0].children[0].textContent, 'Second camera');
  assert.equal(c.image(1), first);
  assert.equal(c.byId('newCameraName').value, '');
});
