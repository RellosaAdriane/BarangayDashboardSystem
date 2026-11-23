const express = require('express');
const path = require('node:path');
let canvasApi, tf, wasm, faceapi;
const modelDirectory = path.join(__dirname, 'public', 'models');
const MAX_SNAPSHOT_BYTES = 1536 * 1024;
const MATCH_DISTANCE = 0.48;
const MULTI_PHOTO_SCORE_LIMIT = 0.44;
const SINGLE_PHOTO_LIMIT = 0.38;
const MIN_IDENTITY_GAP = 0.07;
let modelsReady;

function loadRuntime() {
  if (faceapi) return;
  canvasApi = require('@napi-rs/canvas');
  tf = require('@tensorflow/tfjs');
  wasm = require('@tensorflow/tfjs-backend-wasm');
  faceapi = require('@vladmandic/face-api/dist/face-api.node-wasm.js');
  faceapi.env.monkeyPatch({ Canvas: canvasApi.Canvas, Image: canvasApi.Image, ImageData: canvasApi.ImageData });
}

async function loadModels() {
  if (!modelsReady) {
    modelsReady = (async () => {
      loadRuntime();
      wasm.setWasmPaths(modelDirectory + path.sep);
      await tf.setBackend('wasm');
      await tf.ready();
      await Promise.all([
        faceapi.nets.tinyFaceDetector.loadFromDisk(modelDirectory),
        faceapi.nets.faceLandmark68Net.loadFromDisk(modelDirectory),
        faceapi.nets.faceRecognitionNet.loadFromDisk(modelDirectory)
      ]);
    })().catch((error) => { modelsReady = null; throw error; });
  }
  await modelsReady;
}

function faceIdentity(face) {
  return String(face.matchName || face.nearestName || '').trim().normalize('NFKC').toLocaleLowerCase();
}

function overlapRatio(a, b) {
  const area = Math.min(a.width * a.height, b.width * b.height);
  if (!(area > 0)) return 0;
  const intersection = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x))
    * Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  return intersection / area;
}

function classifyDescriptor(descriptor, enrolled) {
  const byIdentity = new Map();
  for (const person of enrolled) {
    let sum = 0;
    for (let index = 0; index < 128; index++) {
      const delta = descriptor[index] - Number(person.descriptor[index]);
      sum += delta * delta;
    }
    const distance = Math.sqrt(sum);
    const key = person.full_name.trim().normalize('NFKC').toLocaleLowerCase();
    const current = byIdentity.get(key);
    if (current) current.distances.push(distance);
    else byIdentity.set(key, { fullName: person.full_name, distances: [distance] });
  }
  const ranked = [...byIdentity.values()].map((identity) => {
    identity.distances.sort((a, b) => a - b);
    const required = identity.distances.length >= 2 ? 2 : 1;
    const score = required === 2 ? (identity.distances[0] + identity.distances[1]) / 2 : identity.distances[0];
    const limit = required === 2 ? MULTI_PHOTO_SCORE_LIMIT : SINGLE_PHOTO_LIMIT;
    return { ...identity, score, limit, required, support: identity.distances.filter((distance) => distance <= MATCH_DISTANCE).length };
  }).sort((a, b) => a.score - b.score);
  const nearest = ranked[0];
  const gap = (ranked[1]?.score ?? Infinity) - (nearest?.score ?? Infinity);
  const matched = Boolean(nearest && nearest.support >= nearest.required && nearest.score <= nearest.limit && gap >= MIN_IDENTITY_GAP);
  return {
    matched,
    matchName: matched ? nearest.fullName : '',
    nearestName: nearest?.fullName || '',
    matchDistance: nearest?.score ?? null,
    matchLimit: nearest?.limit ?? null,
    matchSupport: nearest ? `${nearest.support}/${nearest.required}` : null,
    identityGap: Number.isFinite(gap) ? gap : null
  };
}

async function recognizeSnapshot(jpeg, enrolled) {
  await loadModels();
  const image = await canvasApi.loadImage(jpeg);
  const scale = Math.min(1, 960 / image.width);
  const canvas = canvasApi.createCanvas(Math.round(image.width * scale), Math.round(image.height * scale));
  canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
  const detections = await faceapi.detectAllFaces(canvas, new faceapi.TinyFaceDetectorOptions({ inputSize: 608, scoreThreshold: 0.18 }))
    .withFaceLandmarks().withFaceDescriptors();
  const classified = detections.map((face) => ({
    ...face.detection.box,
    ...classifyDescriptor(face.descriptor, enrolled),
    score: face.detection.score
  }));
  const unique = [];
  for (const face of classified) {
    const duplicate = unique.findIndex((candidate) => faceIdentity(face) && faceIdentity(face) === faceIdentity(candidate)
      && overlapRatio(face, candidate) >= 0.35);
    if (duplicate < 0) unique.push(face);
    else {
      const previous = unique[duplicate];
      const bestBox = face.score > previous.score ? face : previous;
      const match = face.matched ? face : previous.matched ? previous : null;
      unique[duplicate] = match ? { ...bestBox, matched: true, matchName: match.matchName,
        matchDistance: match.matchDistance, matchLimit: match.matchLimit, matchSupport: match.matchSupport,
        identityGap: match.identityGap } : bestBox;
    }
  }
  return unique;
}

module.exports = function registerCloudFaceMonitor(app, pool, deviceAuth, ensureDeviceSchema, ensureAlertSchema) {
  const parseSnapshot = express.raw({ type: 'image/jpeg', limit: '1536kb' });
  app.post('/api/device/face-frame', deviceAuth, (req, res, next) => parseSnapshot(req, res, (error) => {
    if (!error) return next();
    return res.status(error.status === 413 ? 413 : 400).json({ error: error.status === 413 ? 'Camera frame must be 1.5 MB or smaller.' : 'Send a valid JPEG frame.' });
  }), async (req, res) => {
    try {
      await ensureDeviceSchema();
      await ensureAlertSchema();
      const jpeg = req.body;
      if (!Buffer.isBuffer(jpeg) || jpeg.length < 4 || jpeg.length > MAX_SNAPSHOT_BYTES
        || jpeg[0] !== 0xff || jpeg[1] !== 0xd8 || jpeg[jpeg.length - 2] !== 0xff || jpeg[jpeg.length - 1] !== 0xd9) {
        return res.status(400).json({ error: 'Send a valid JPEG frame no larger than 1.5 MB.' });
      }
      const { rows: enrolled } = await pool.query('SELECT full_name, descriptor FROM enrolled_faces ORDER BY id');
      const faces = await recognizeSnapshot(jpeg, enrolled.filter((person) => Array.isArray(person.descriptor) && person.descriptor.length === 128));
      const unknown = faces.filter((face) => !face.matched);
      if (!unknown.length) return res.json({ faces: faces.length, unknown: 0, alertCreated: false });

      const client = await pool.connect();
      let alert;
      let duplicate = false;
      try {
        await client.query('BEGIN');
        const cameraId = req.deviceCameraId;
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`camera-alert:${cameraId}`]);
        const { rows: [camera] } = await client.query('SELECT id, name, location FROM cameras WHERE id = $1 AND is_enabled = true AND is_archived = false', [cameraId]);
        if (!camera) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Camera is not available.' }); }
        const { rows: [recent] } = await client.query("SELECT id FROM camera_alerts WHERE camera_id = $1 AND detected_at > NOW() - INTERVAL '60 seconds' LIMIT 1", [cameraId]);
        if (recent) duplicate = true;
        else {
          const { rows: [saved] } = await client.query('INSERT INTO camera_alerts (camera_id, created_by, face_count, snapshot) VALUES ($1, NULL, $2, $3) RETURNING id, detected_at', [cameraId, Math.min(50, unknown.length), jpeg]);
          alert = { ...saved, camera };
        }
        await client.query('COMMIT');
      } catch (error) { await client.query('ROLLBACK'); throw error; }
      finally { client.release(); }

      let emailSent = false;
      if (alert && ensureAlertSchema.ownerEmailConfigured()) {
        try { emailSent = await ensureAlertSchema.sendUnknownFaceEmail(alert.camera.name, alert.camera.location, Math.min(50, unknown.length), alert.detected_at, jpeg); }
        catch (error) { console.error('Cloud camera alert email:', error.message); }
      }
      res.status(alert ? 201 : 200).json({ faces: faces.length, unknown: unknown.length, alertCreated: Boolean(alert), duplicate, emailConfigured: ensureAlertSchema.ownerEmailConfigured(), emailSent });
    } catch (error) {
      console.error('Cloud face monitor:', error.code || error.name || 'processing error');
      if (!res.headersSent) res.status(503).json({ error: 'Cloud face monitoring could not process this frame.' });
    }
  });
};
