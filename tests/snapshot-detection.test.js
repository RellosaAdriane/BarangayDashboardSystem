const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const script = fs.readFileSync(path.join(__dirname, '../public/script.js'), 'utf8');
const code = script.slice(script.indexOf('function updateFaceRecognitionCount()'), script.indexOf("$('toggleFaceRecognitionBtn').addEventListener"));

function detector(faces) {
  const posted = [];
  const elements = { cameraImg: { src: 'camera', naturalWidth: 640, naturalHeight: 480 }, faceRecognitionStatus: {}, toggleFaceRecognitionBtn: {} };
  const context = vm.createContext({
    $: (id) => elements[id], API_BASE: '/api', connected: true, cameraAttempt: 1,
    faceRecognitionActive: true, faceRecognitionProcessing: false, lastSnapshotAt: 0,
    faceRecognitionGeneration: 0, faceRecognitionTimer: null,
    window: { activeCameraId: 1, FaceManagement: { classify: async (faces) => faces.map((face) => ({ ...face, matched: Boolean(face.matched) })) } }, Date,
    document: { createElement: () => ({ getContext: () => ({ drawImage() {} }), toDataURL: () => 'data:image/jpeg;base64,/9j/2Q==' }) },
    faceapi: { TinyFaceDetectorOptions: class {}, detectAllFaces: () => ({ withFaceLandmarks: () => ({ withFaceDescriptors: async () => faces }) }) },
    fetch: async (url, options) => { posted.push({ url, data: JSON.parse(options.body) }); return { ok: true, json: async () => ({ id: '1' }) }; },
    loadAlerts: async () => {}
  });
  vm.runInContext(code, context);
  return { context, posted, elements };
}

test('orange face boxes use image coordinates and clear when a face leaves during cooldown', async () => {
  const { context, elements } = detector([{ box: { x: 100, y: 80, width: 60, height: 80 } }]);
  const strokes = [];
  let cleared = 0;
  const drawing = {
    clearRect() { cleared++; strokes.length = 0; },
    strokeRect(...box) { strokes.push({ box, color: this.strokeStyle }); },
    measureText: () => ({ width: 100 }), fillRect() {}, fillText() {}
  };
  elements.recognitionOverlay = { classList: { add() {}, remove() {} }, getContext: () => drawing };
  await context.recognizeCameraFaces();
  assert.equal(elements.recognitionOverlay.width, 640);
  assert.equal(elements.recognitionOverlay.height, 480);
  assert.deepEqual(strokes, [{ box: [90, 80, 80, 80], color: '#ff9800' }]);
  context.faceapi.detectAllFaces = () => ({ withFaceLandmarks: () => ({ withFaceDescriptors: async () => [] }) });
  await context.recognizeCameraFaces();
  assert.equal(strokes.length, 0);
  assert.equal(cleared, 2);
});

test('unmatched-face detection saves a snapshot without descriptors, then throttles repeated frames', async () => {
  const { context, posted } = detector([{ score: 0.9 }]);
  await context.recognizeCameraFaces();
  await context.recognizeCameraFaces();
  assert.equal(posted.length, 1);
  assert.equal(posted[0].url, '/api/alerts');
  assert.deepEqual(Object.keys(posted[0].data).sort(), ['cameraId', 'faceCount', 'snapshot']);
});
test('frames without faces do not create alerts', async () => {
  const { context, posted } = detector([]);
  await context.recognizeCameraFaces();
  assert.equal(posted.length, 0);
});
test('an old detection result cannot upload after the camera changes', async () => {
  const { context, posted } = detector([{}]);
  context.faceapi.detectAllFaces = () => ({ withFaceLandmarks: () => ({ withFaceDescriptors: async () => { context.cameraAttempt++; return [{}]; } }) });
  await context.recognizeCameraFaces();
  assert.equal(posted.length, 0);
});

test('recognized faces do not create snapshots; mixed frames count unmatched faces only', async () => {
  const known = detector([{ matched: true, matchName: 'Authorized Person' }]);
  await known.context.recognizeCameraFaces();
  assert.equal(known.posted.length, 0);
  assert.match(known.elements.faceRecognitionStatus.textContent, /1 recognized, 0 unrecognized/);
  const mixed = detector([{ matched: true }, { matched: false }, { matched: false }]);
  await mixed.context.recognizeCameraFaces();
  assert.equal(mixed.posted.length, 1);
  assert.equal(mixed.posted[0].data.faceCount, 2);
});

test('descriptor refresh failure does not mislabel enrolled people as unknown or save alerts', async () => {
  const { context, posted, elements } = detector([{}]);
  context.window.FaceManagement.classify = async () => { throw new Error('Enrollment list unavailable'); };
  await context.recognizeCameraFaces();
  assert.equal(posted.length, 0);
  assert.match(elements.faceRecognitionStatus.textContent, /Enrollment list unavailable/);
});

test('stopping and restarting monitoring discards the previous inference result', async () => {
  const { context, posted } = detector([{}]);
  context.window.FaceManagement.classify = async (faces) => { context.faceRecognitionGeneration++; return faces; };
  await context.recognizeCameraFaces();
  assert.equal(posted.length, 0);
});
test('all roles omit incident navigation and use snapshot detection controls', () => {
  for (const role of ['captain', 'admin', 'tanod']) {
    const source = fs.readFileSync(path.join(__dirname, `../public/dashboards/${role}.js`), 'utf8');
    assert.doesNotMatch(source, /#incidents|Report incident/);
  }
  const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
  assert.doesNotMatch(html, /id="incidents"|Quick Incident Report|registerFaceBtn/);
});
