require('dotenv').config();

const multer = require('multer');
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }
});

const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Demo in-memory store: data resets when the server restarts.
// Replace this with MySQL/SQLite before using real incident records.
const incidents = [];

app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'barangay-dashboard-api' });
});

app.get('/api/incidents', (_req, res) => {
  res.json(incidents);
});

app.post('/api/incidents', (req, res) => {
  const { type, note = '', camera = 'ESP32-CAM 01' } = req.body || {};
  if (!type || typeof type !== 'string') {
    return res.status(400).json({ error: 'type is required' });
  }
  const incident = {
    id: `INC-${Date.now().toString().slice(-8)}`,
    type: type.slice(0, 100),
    note: String(note).slice(0, 1000),
    camera: String(camera).slice(0, 100),
    status: 'Active',
    date: new Date().toISOString()
  };
  incidents.unshift(incident);
  res.status(201).json({ incident });
});

app.get('/api/faces/recognize', async (req, res) => {
  try {
    const cameraUrl = process.env.ESP32_CAPTURE_URL?.trim();
    const comprefaceUrl = process.env.COMPREFACE_URL?.trim();
    const apiKey = process.env.COMPREFACE_API_KEY?.trim();
    const configuredThreshold = Number(process.env.COMPREFACE_DET_PROB_THRESHOLD ?? 0.5);
    const configuredRecognitionThreshold = Number(process.env.COMPREFACE_RECOGNITION_THRESHOLD ?? 0.8);
    const detectionThreshold = Number.isFinite(configuredThreshold)
      ? Math.max(0, Math.min(1, configuredThreshold))
      : 0.5;
    const recognitionThreshold = Number.isFinite(configuredRecognitionThreshold)
      ? Math.max(0, Math.min(1, configuredRecognitionThreshold))
      : 0.8;

    if (!cameraUrl || !comprefaceUrl || !apiKey) {
      return res.status(500).json({
        success: false,
        error: 'Missing ESP32_CAPTURE_URL, COMPREFACE_URL, or COMPREFACE_API_KEY in .env'
      });
    }

    const cameraResponse = await fetch(cameraUrl);

    if (!cameraResponse.ok) {
      throw new Error(`Camera returned HTTP ${cameraResponse.status}`);
    }

    const image = Buffer.from(await cameraResponse.arrayBuffer());

    const form = new FormData();
    form.append(
      'file',
      new Blob([image], { type: 'image/jpeg' }),
      'capture.jpg'
    );

    const recognizeUrl = new URL(
      `${comprefaceUrl.replace(/\/+$/, '')}/api/v1/recognition/recognize`
    );
    recognizeUrl.searchParams.set('det_prob_threshold', String(detectionThreshold));

    const apiResponse = await fetch(
      recognizeUrl,
      {
        method: 'POST',
        headers: { 'x-api-key': apiKey },
        body: form
      }
    );

    const data = await apiResponse.json();

    if (!apiResponse.ok) {
      if (
        data.code === 28 ||
        (data.message || '').toLowerCase().includes('no face')
      ) {
        return res.json({ success: true, detected: false, faces: [] });
      }
      throw new Error(JSON.stringify(data));
    }

    const faces = (Array.isArray(data.result) ? data.result : []).map((face) => {
      const bestMatch = (Array.isArray(face.subjects) ? face.subjects : [])
        .reduce((best, subject) => (
          !best || Number(subject.similarity) > Number(best.similarity) ? subject : best
        ), null);
      return {
        box: face.box || null,
        recognized: Boolean(bestMatch) && Number(bestMatch.similarity) >= recognitionThreshold,
        name: bestMatch?.subject || null,
        similarity: bestMatch?.similarity ?? null
      };
    });

    res.json({
      success: true,
      detected: faces.length > 0,
      detectionThreshold,
      recognitionThreshold,
      faces
    });
  } catch (error) {
    console.error('Face recognition error:', error.message);

    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Barangay dashboard running at http://localhost:${PORT}`);
});
