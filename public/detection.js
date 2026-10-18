const detectButton = document.getElementById('detectFaceBtn');
const detectionBadge = document.getElementById('detectionBadge');
const detectionResult = document.getElementById('detectionResult');
const detectionDetails = document.getElementById('detectionDetails');
const cameraImg = document.getElementById('cameraImg');
const faceOverlay = document.getElementById('faceOverlay');
const SVG_NS = 'http://www.w3.org/2000/svg';

let cameraConnected = false;
let requestInProgress = false;
let currentFaces = [];
let trackedFaces = [];
let nextTrackId = 1;
let animationFrame = 0;

function boxForFace(face) {
  const box = face.box;
  if (!box) return null;
  const x = Number(box.x_min);
  const y = Number(box.y_min);
  const width = Number(box.x_max) - x;
  const height = Number(box.y_max) - y;
  if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return null;
  return { x, y, width, height };
}

function matchCost(a, b) {
  const distance = Math.hypot(a.x + a.width / 2 - b.x - b.width / 2, a.y + a.height / 2 - b.y - b.height / 2) / Math.max(a.width, a.height, b.width, b.height, 1);
  const sizeChange = Math.abs(Math.log((b.width * b.height) / (a.width * a.height)));
  return distance + sizeChange * 0.35;
}

function updateTracks(faces) {
  const candidates = faces.map((face) => ({ face, box: boxForFace(face) })).filter((item) => item.box);
  const unmatched = new Set(trackedFaces.map((_, index) => index));
  for (const candidate of candidates) {
    let bestIndex = -1;
    let bestCost = 1.15;
    for (const index of unmatched) {
      const cost = matchCost(trackedFaces[index].box, candidate.box);
      if (cost < bestCost) { bestCost = cost; bestIndex = index; }
    }
    if (bestIndex < 0) {
      const track = { id: nextTrackId++, box: candidate.box, target: candidate.box, face: candidate.face, missed: 0 };
      trackedFaces.push(track);
    } else {
      unmatched.delete(bestIndex);
      const track = trackedFaces[bestIndex];
      track.target = candidate.box;
      track.face = candidate.face;
      track.missed = 0;
    }
  }
  for (const index of unmatched) trackedFaces[index].missed += 1;
  trackedFaces = trackedFaces.filter((track) => track.missed < 2);
}

function animateFaces() {
  if (!cameraConnected) { animationFrame = 0; return; }
  for (const track of trackedFaces) {
    for (const key of ['x', 'y', 'width', 'height']) track.box[key] += (track.target[key] - track.box[key]) * 0.42;
  }
  renderFaces(trackedFaces.map((track) => ({ ...track.face, box: {
    x_min: track.box.x, y_min: track.box.y,
    x_max: track.box.x + track.box.width, y_max: track.box.y + track.box.height
  } })));
  animationFrame = window.requestAnimationFrame(animateFaces);
}

function renderFaces(faces, processing = false) {
  faceOverlay.replaceChildren();
  if (!cameraImg.naturalWidth || !cameraImg.naturalHeight) return;

  faceOverlay.setAttribute('viewBox', `0 0 ${cameraImg.naturalWidth} ${cameraImg.naturalHeight}`);

  faces.forEach((face) => {
    const box = face.box;
    if (!box) return;
    const { x, y, width, height } = boxForFace(face) || {};
    if (![x, y, width, height].every(Number.isFinite)) return;

    const color = processing ? 'processing' : (face.recognized ? 'recognized' : 'unknown');
    const rectangle = document.createElementNS(SVG_NS, 'rect');
    rectangle.setAttribute('x', String(x));
    rectangle.setAttribute('y', String(y));
    rectangle.setAttribute('width', String(width));
    rectangle.setAttribute('height', String(height));
    rectangle.setAttribute('class', `face-box ${color}`);
    faceOverlay.appendChild(rectangle);

    const text = document.createElementNS(SVG_NS, 'text');
    text.setAttribute('x', String(x));
    text.setAttribute('y', String(Math.max(24, y - 8)));
    text.setAttribute('class', `face-label ${color}`);
    const similarity = face.recognized && face.similarity != null && Number.isFinite(Number(face.similarity))
      ? ` (${(Number(face.similarity) * 100).toFixed(1)}%)`
      : '';
    text.textContent = processing
      ? 'Processing...'
      : `${face.recognized ? face.name : 'Unfamiliar'}${similarity}`;
    faceOverlay.appendChild(text);
  });
}

async function checkCamera() {
  if (requestInProgress) return;
  if (!cameraConnected) {
    detectionBadge.textContent = 'OFFLINE';
    detectionBadge.className = 'tag amber';
    detectionResult.textContent = 'Camera is not connected';
    detectionDetails.textContent = 'Connect the ESP32-CAM stream before checking for faces.';
    return;
  }

  requestInProgress = true;
  detectButton.disabled = true;
  detectionBadge.textContent = 'PROCESSING';
  detectionBadge.className = 'tag amber';
  detectionResult.textContent = 'Checking camera image...';
  detectionDetails.textContent = 'Face locations and identities are being updated.';
  try {
    const response = await fetch('/api/faces/recognize', {
      cache: 'no-store',
      signal: AbortSignal.timeout(10000)
    });

    const data = await response.json();

    if (!response.ok || !data.success) {
      throw new Error(data.error || 'Detection request failed');
    }

    currentFaces = Array.isArray(data.faces) ? data.faces : [];
    updateTracks(currentFaces);
    if (!animationFrame) animateFaces();

    if (currentFaces.length === 0) {
      detectionBadge.textContent = 'NO FACE';
      detectionBadge.className = 'tag amber';
      detectionResult.textContent = 'No face detected';
      detectionDetails.textContent = `No face found in the camera snapshot. Improve lighting, face the camera, and keep your face centered. Detection confidence threshold: ${Math.round((data.detectionThreshold ?? 0.7) * 100)}%.`;
    } else {
      const recognized = currentFaces.filter((face) => face.recognized);
      detectionBadge.textContent = recognized.length
        ? `${recognized.length} RECOGNIZED`
        : 'UNFAMILIAR';
      detectionBadge.className = `tag ${recognized.length ? 'green' : 'amber'}`;
      detectionResult.textContent = `${currentFaces.length} face${currentFaces.length === 1 ? '' : 's'} detected`;
      detectionDetails.textContent = currentFaces.map((face) => {
        if (!face.recognized) return 'Unfamiliar';
        const similarity = Number.isFinite(Number(face.similarity))
          ? ` (${(Number(face.similarity) * 100).toFixed(1)}% similarity)`
          : '';
        return `${face.name}${similarity}`;
      }).join(' · ');
    }
  } catch (error) {
    detectionBadge.textContent = 'ERROR';
    detectionBadge.className = 'tag red';
    detectionResult.textContent = 'Detection failed';
    detectionDetails.textContent = error.message || 'The recognition request failed.';
    currentFaces = [];
    renderFaces(currentFaces);
  } finally {
    requestInProgress = false;
    detectButton.disabled = false;
  }
}

detectButton.addEventListener('click', checkCamera);
window.addEventListener('camera:connected', () => {
  cameraConnected = true;
  if (!animationFrame) animateFaces();
  checkCamera();
});
window.addEventListener('camera:disconnected', () => {
  cameraConnected = false;
  if (animationFrame) window.cancelAnimationFrame(animationFrame);
  animationFrame = 0;
  currentFaces = [];
  trackedFaces = [];
  faceOverlay.replaceChildren();
  detectionBadge.textContent = 'READY';
  detectionBadge.className = 'tag amber';
  detectionResult.textContent = 'Waiting for camera...';
  detectionDetails.textContent = 'Connect the camera to start face tracking.';
});
window.setInterval(() => {
  if (cameraConnected) checkCamera();
}, 1000);
