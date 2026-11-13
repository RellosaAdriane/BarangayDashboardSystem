const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const faceapi = require('face-api.js');

test('bundled face-api.js models load and a blank image produces no face enrollment candidates', async () => {
  const models = path.join(__dirname, '../public/models');
  await Promise.all([
    faceapi.nets.tinyFaceDetector.loadFromDisk(models),
    faceapi.nets.faceLandmark68Net.loadFromDisk(models),
    faceapi.nets.faceRecognitionNet.loadFromDisk(models)
  ]);
  const image = faceapi.tf.zeros([160, 160, 3]);
  try {
    const faces = await faceapi.detectAllFaces(image, new faceapi.TinyFaceDetectorOptions({ inputSize: 160 })).withFaceLandmarks().withFaceDescriptors();
    assert.equal(faces.length, 0);
  } finally {
    image.dispose();
    faceapi.nets.tinyFaceDetector.dispose();
    faceapi.nets.faceLandmark68Net.dispose();
    faceapi.nets.faceRecognitionNet.dispose();
  }
});
