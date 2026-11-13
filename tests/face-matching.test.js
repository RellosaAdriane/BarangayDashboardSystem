const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const faceapi = require('face-api.js');

function client() {
  const elements = new Map();
  let people = [{ id: '1', fullName: 'Enrolled Person', descriptor: Array(128).fill(0.1) }];
  let clock = 10000;
  let failed = false;
  let requests = 0;
  const context = vm.createContext({
    window: {}, faceapi, Float32Array, FormData,
    Date: class extends Date { static now() { return clock; } },
    document: { getElementById(id) { if (!elements.has(id)) elements.set(id, { addEventListener() {} }); return elements.get(id); } },
    fetch: async () => {
      requests++;
      if (failed) throw new Error('Offline');
      return { ok: true, json: async () => people };
    }
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/faces.js'), 'utf8'), context);
  return {
    api: context.window.FaceManagement,
    get requests() { return requests; },
    remove() { people = []; },
    fail() { failed = true; },
    advance() { clock += 4000; }
  };
}

test('face-api.js matcher recognizes enrolled descriptors and leaves distant faces unmatched', async () => {
  const c = client();
  const results = await c.api.classify([{ descriptor: new Float32Array(128).fill(0.1) }, { descriptor: new Float32Array(128).fill(0.8) }]);
  assert.equal(results[0].matched, true);
  assert.equal(results[0].matchName, 'Enrolled Person');
  assert.equal(results[1].matched, false);
  assert.equal(results[1].matchName, '');
});

test('removing enrollment invalidates matching and other viewers refresh within the polling interval', async () => {
  const c = client();
  const face = [{ descriptor: new Float32Array(128).fill(0.1) }];
  assert.equal((await c.api.classify(face))[0].matched, true);
  await c.api.classify(face);
  assert.equal(c.requests, 1);
  c.remove();
  c.api.invalidate();
  assert.equal((await c.api.classify(face))[0].matched, false);
  c.advance();
  await c.api.classify(face);
  assert.equal(c.requests, 3);
});

test('failed enrollment refresh rejects classification instead of using stale identities', async () => {
  const c = client();
  await c.api.classify([]);
  c.advance();
  c.fail();
  await assert.rejects(c.api.classify([{ descriptor: new Float32Array(128).fill(0.1) }]), /Offline/);
});

function enrollmentClient(faceCount) {
  const elements = new Map();
  const posts = [];
  const element = (id) => {
    if (!elements.has(id)) elements.set(id, {
      value: id === 'personName' ? '  Test Person  ' : '',
      files: [new Blob(['photo'], { type: 'image/jpeg' })],
      handlers: {}, addEventListener(name, fn) { this.handlers[name] = fn; },
      reset() { this.resetCalled = true; }, replaceChildren() {}, appendChild() {}
    });
    return elements.get(id);
  };
  const context = vm.createContext({
    window: { currentRole: 'admin' }, FormData, Float32Array, Date,
    loadFaceModels: async () => {},
    faceapi: {
      TinyFaceDetectorOptions: class {},
      bufferToImage: async () => ({ naturalWidth: 640, naturalHeight: 480 }),
      detectAllFaces: () => ({ withFaceLandmarks: () => ({ withFaceDescriptors: async () => Array.from({ length: faceCount }, () => ({ descriptor: new Float32Array(128).fill(0.1) })) }) })
    },
    document: {
      getElementById: element,
      createElement: () => ({ getContext: () => ({ drawImage() {} }), toBlob(fn) { fn(new Blob(['photo'], { type: 'image/jpeg' })); } })
    },
    fetch: async (_path, options) => {
      if (options.method === 'POST') posts.push(options.body);
      return { ok: true, json: async () => options.method === 'POST' ? { id: 1 } : [] };
    }
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/faces.js'), 'utf8'), context);
  return { elements, posts, submit: () => element('addPersonForm').handlers.submit({ preventDefault() {} }) };
}

test('Add Person refuses pictures with no face or multiple faces before sending an enrollment', async () => {
  for (const count of [0, 2]) {
    const c = enrollmentClient(count);
    await c.submit();
    assert.equal(c.posts.length, 0);
    assert.match(c.elements.get('faceManagementStatus').textContent, count === 0 ? /No clear face/ : /More than one face/);
    assert.equal(c.elements.get('addPersonBtn').disabled, false);
  }
});

test('Add Person sends one descriptor and normalized photo, then refreshes the enrolled list', async () => {
  const c = enrollmentClient(1);
  await c.submit();
  assert.equal(c.posts.length, 1);
  assert.equal(c.posts[0].get('fullName'), 'Test Person');
  assert.equal(JSON.parse(c.posts[0].get('descriptor')).length, 128);
  assert.equal(c.posts[0].get('picture').type, 'image/jpeg');
  assert.equal(c.elements.get('addPersonForm').resetCalled, true);
  assert.match(c.elements.get('faceManagementStatus').textContent, /enrolled successfully/);
});
