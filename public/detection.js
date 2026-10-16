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

function renderFaces(faces, processing = false) {
  faceOverlay.replaceChildren();
  if (!cameraImg.naturalWidth || !cameraImg.naturalHeight) return;

  faceOverlay.setAttribute('viewBox', `0 0 ${cameraImg.naturalWidth} ${cameraImg.naturalHeight}`);

  // Keep a visible processing state in the camera panel even before any face
  // boxes have been returned by the first recognition request.
  if (processing && faces.length === 0) {
    const status = document.createElementNS(SVG_NS, 'text');
    status.setAttribute('x', '16');
    status.setAttribute('y', '36');
    status.setAttribute('class', 'face-label processing');
    status.textContent = 'Checking for faces...';
    faceOverlay.appendChild(status);
  }

  faces.forEach((face) => {
    const box = face.box;
    if (!box) return;
    const x = Number(box.x_min);
    const y = Number(box.y_min);
    const width = Number(box.x_max) - x;
    const height = Number(box.y_max) - y;
    if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return;

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
  renderFaces(currentFaces, true);
  try {
    const response = await fetch('/api/faces/recognize', {
      cache: 'no-store'
    });

    const data = await response.json();

    if (!response.ok || !data.success) {
      throw new Error(data.error || 'Detection request failed');
    }

    currentFaces = Array.isArray(data.faces) ? data.faces : [];
    renderFaces(currentFaces);

    if (currentFaces.length === 0) {
      detectionBadge.textContent = 'NO FACE';
      detectionBadge.className = 'tag amber';
      detectionResult.textContent = 'No face detected';
      detectionDetails.textContent = `No face found in the camera snapshot. Improve the lighting, face the camera, and keep your face centered. Detection threshold: ${Math.round((data.detectionThreshold ?? 0.5) * 100)}%.`;
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
    renderFaces(currentFaces);
  } finally {
    requestInProgress = false;
    detectButton.disabled = false;
  }
}

detectButton.addEventListener('click', checkCamera);
window.addEventListener('camera:connected', () => {
  cameraConnected = true;
  checkCamera();
});
window.addEventListener('camera:disconnected', () => {
  cameraConnected = false;
  currentFaces = [];
  faceOverlay.replaceChildren();
  detectionBadge.textContent = 'READY';
  detectionBadge.className = 'tag amber';
  detectionResult.textContent = 'Waiting for camera...';
  detectionDetails.textContent = 'Connect the camera to start face tracking.';
});
window.setInterval(() => {
  if (cameraConnected) checkCamera();
}, 3000);
