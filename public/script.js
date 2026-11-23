const $ = (id) => document.getElementById(id);
const API_BASE = '/api';
let cameraStatuses = null;
let cameraAlerts = [];
let connected = false;
let cameraLoadTimer = null;
let cameraFirstFrameTimer = null;
let cameraAttempt = 0;
let snapshotAlerts = [];
let alertView = 'pending';
let alertPage = 0;
let alertHasMore = false;
let alertLoadRequest = 0;
let lastSnapshotAt = 0;
let alertReviewSaving = false;
let faceModelsReady = false;
let faceApiLoadPromise = null;
let faceModelLoadPromise = null;
let faceRecognitionActive = false;
let faceRecognitionProcessing = false;
let faceRecognitionTimer = null;
let faceRecognitionGeneration = 0;
try { sessionStorage.removeItem('barangay-recognition-faces'); } catch { /* Storage may be unavailable. */ }
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}
function formatDate(value) {
  const date = value ? new Date(value) : new Date();
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
}
function setDate() {
  const now = new Date();
  $('sideDate').textContent = now.toLocaleDateString(undefined, {year:'numeric',month:'short',day:'numeric'});
  $('todayText').textContent = now.toLocaleDateString(undefined, {weekday:'long',year:'numeric',month:'long',day:'numeric'}) + ' · Security overview';
}
function updateStats() {
  $('deviceStatus').textContent = connected ? 'Connected' : 'Offline';
  $('deviceStatus').className = connected ? 'online' : 'offline';
  $('feedBadge').textContent = connected ? 'CONNECTED' : 'NOT CONNECTED';
  $('feedBadge').className = 'tag ' + (connected ? 'green' : 'amber');
}
async function loadAlerts() {
  if (!window.currentRole) return;
  if (window.currentRole === 'tanod' && alertView !== 'reports') { alertView = 'reports'; alertPage = 0; }
  const request = ++alertLoadRequest;
  try {
    const response = await fetch(`${API_BASE}/alerts?view=${alertView}&offset=${alertPage * 20}`, { cache: 'no-store' });
    const data = await response.json();
    if (request !== alertLoadRequest) return;
    if (!response.ok) throw new Error(data.error || 'Could not load alerts.');
    // Back up if another reviewer emptied the final page.
    if (!data.length && alertPage > 0) { alertPage--; return loadAlerts(); }
    alertHasMore = data.length > 20;
    snapshotAlerts = data.slice(0, 20);
    $('previousAlertsBtn').disabled = alertPage === 0;
    $('nextAlertsBtn').disabled = !alertHasMore;
    $('alertPageStatus').textContent = `${alertView === 'archived' ? 'Archive' : alertView === 'reports' ? 'Reports' : 'Pending'} - Page ${alertPage + 1}`;
    renderAlertFeed();
    window.refreshAlertStats?.();
  } catch (error) { if (request === alertLoadRequest) $('alertLoadStatus').textContent = error.message; }
}
function renderAlertFeed() {
  const list = $('alertList');
  if (!list || alertReviewSaving || (list.contains(document.activeElement) && document.activeElement?.matches('textarea, input, select'))) return;
  $('alertLoadStatus').textContent = '';
  const cards = snapshotAlerts.map((item) => {
    const id = Number(item.id);
    return `<article class="snapshot-alert snapshot-alert-summary"><button type="button" class="snapshot-thumbnail" data-preview-alert="${id}" aria-label="Preview snapshot"><img src="/api/alerts/${id}/snapshot" loading="lazy" alt="Camera snapshot"></button><div class="snapshot-summary-text"><strong>Face snapshot</strong><p>${escapeHtml(item.cameraName)}</p><time>${escapeHtml(formatDate(item.detectedAt))}</time><span class="tag ${alertStatusClass(item.status)}">${escapeHtml(item.status)}</span>${reportActionBadge(item)}</div><button class="btn" type="button" data-preview-alert="${id}">Preview</button></article>`;
  });
  const statusCards = alertView === 'pending' && alertPage === 0 ? cameraAlerts.slice(0, 5).map((entry) => `<div class="alert"><div class="alert-text"><strong>${escapeHtml(entry.title)}</strong><p>${escapeHtml(entry.details)}</p></div><span class="alert-time">${escapeHtml(formatDate(entry.time))}</span></div>`) : [];
  list.innerHTML = [...cards, ...statusCards].join('') || `<div class="empty">${alertView === 'archived' ? 'No archived snapshots yet. Reviewed snapshots appear here automatically.' : alertView === 'reports' ? 'No snapshots marked Report.' : 'No snapshots waiting for review.'}</div>`;
  list.querySelectorAll('[data-preview-alert]').forEach((button) => button.addEventListener('click', () => openSnapshotPreview(Number(button.dataset.previewAlert))));
}
const snapshotPreviewNotes = new Map();
function alertStatusClass(status) {
  return ['approved', 'recognized'].includes(status) ? 'green' : status === 'pending' || status === 'unrecognized' ? 'amber' : status === 'report' ? 'report' : '';
}
function reportActionBadge(item) {
  if (item.status !== 'report') return '';
  return `<span class="tag ${item.actionedAt ? 'green' : 'amber'}">${item.actionedAt ? 'Actioned' : 'Awaiting action'}</span>`;
}
function reportActionMarkup(item) {
  if (item.status !== 'report') return '';
  if (item.actionedAt) return `${reportActionBadge(item)}<p>Actioned by ${escapeHtml(item.actionedBy || 'Authorized personnel')} - ${escapeHtml(formatDate(item.actionedAt))}</p><p>${escapeHtml(item.actionNote)}</p><p>Automatically archived.</p>`;
  return `${reportActionBadge(item)}<form data-action-report="${Number(item.id)}">
    <label class="sub" for="report-action-note">Action taken</label>
    <textarea id="report-action-note" name="actionNote" class="form-control" maxlength="1000" rows="3" required placeholder="Describe the action taken or the outcome of your check."></textarea>
    <button class="btn primary" type="submit">Mark as actioned</button><p class="sub" role="status"></p></form>`;
}
function snapshotPreviewMarkup(item) {
  const id = Number(item.id);
  const pending = item.status === 'pending';
  const canReview = ['captain', 'admin'].includes(window.currentRole);
  return `<article class="snapshot-alert"><img class="alert-snapshot" src="/api/alerts/${id}/snapshot" loading="lazy" alt="Camera snapshot from ${escapeHtml(formatDate(item.detectedAt))}">
    <div class="snapshot-alert-body"><strong>Review face snapshot</strong><p>${escapeHtml(item.cameraName)} - ${escapeHtml(item.location || 'No location')}</p>
    <time>${escapeHtml(formatDate(item.detectedAt))}</time><p>${Number(item.faceCount)} face(s) captured</p>
    <span class="tag ${alertStatusClass(item.status)}">${escapeHtml(item.status)}</span>${reportActionMarkup(item)}
    ${item.reviewedBy ? `<p>Reviewed by ${escapeHtml(item.reviewedBy)} - ${escapeHtml(formatDate(item.reviewedAt))}</p>` : ''}
    ${item.reviewNote ? `<p>${escapeHtml(item.reviewNote)}</p>` : ''}
    ${pending && canReview ? `<form data-review-alert="${id}"><label class="sub" for="alert-note-${id}">Review notes (optional)</label>
      <textarea id="alert-note-${id}" name="note" class="form-control" maxlength="1000" rows="2"></textarea>
      <div class="alert-review-actions"><button class="btn primary" name="status" value="recognized" type="submit">Recognized</button>
      <button class="btn" name="status" value="report" type="submit">Report</button></div>
      <p class="hint">Recognized snapshots move to Archive. Reports stay active for follow-up until marked as actioned, then archive automatically. To enroll a person, use Face Management.</p>
      <span class="sub" role="status"></span></form>` : pending ? '<p>Awaiting captain or admin review.</p>' : item.status === 'report' && !item.actionedAt ? '<p>Flagged for follow-up.</p>' : ''}</div></article>`;
}
function bindSnapshotReview(root) {
  root.querySelectorAll('[data-action-report]').forEach((form) => form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (alertReviewSaving) return;
    const note = form.querySelector('[name="actionNote"]').value.trim();
    if (!note) return;
    alertReviewSaving = true;
    const button = form.querySelector('button');
    button.disabled = true;
    try {
      const response = await fetch(`${API_BASE}/alerts/${form.dataset.actionReport}/action`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ note }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Could not save report action.');
      renderSnapshotPreview(result.alert);
      alertReviewSaving = false;
      await loadAlerts();
      $('alertLoadStatus').textContent = 'Report marked as actioned and automatically moved to Archive.';
      void window.ReportNotifications?.load();
    } catch (error) { form.querySelector('[role="status"]').textContent = error.message; }
    finally { alertReviewSaving = false; button.disabled = false; }
  }));
  root.querySelectorAll('[data-review-alert]').forEach((form) => form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (alertReviewSaving) return;
    alertReviewSaving = true;
    const buttons = [...form.querySelectorAll('button')];
    buttons.forEach((button) => { button.disabled = true; });
    try {
      const response = await fetch(`${API_BASE}/alerts/${form.dataset.reviewAlert}/review`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: event.submitter?.value, note: form.elements.note.value }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Could not review alert.');
      document.activeElement?.blur();
      alertReviewSaving = false;
      snapshotPreviewNotes.delete(Number(form.dataset.reviewAlert));
      $('snapshotPreview').close();
      await loadAlerts();
      $('alertLoadStatus').textContent = event.submitter?.value === 'report'
        ? `Report saved. ${result.notified || 0} active Tanod/Captain account(s) notified. This report stays active until actioned.`
        : 'Review saved. Snapshot moved to Archive automatically.';
      void window.ReportNotifications?.load();
    } catch (error) { form.querySelector('[role="status"]').textContent = error.message; }
    finally { alertReviewSaving = false; buttons.forEach((button) => { button.disabled = false; }); }
  }));
}
function saveSnapshotPreviewNote() {
  const note = $('snapshotPreviewBody').querySelector('textarea[name="note"]');
  if (note) snapshotPreviewNotes.set(Number($('snapshotPreview').dataset.alertId), note.value);
}
function renderSnapshotPreview(item) {
  $('snapshotPreviewBody').innerHTML = snapshotPreviewMarkup(item);
  const note = $('snapshotPreviewBody').querySelector('textarea[name="note"]');
  if (note) note.value = snapshotPreviewNotes.get(Number(item.id)) || '';
  bindSnapshotReview($('snapshotPreviewBody'));
}
function openSnapshotPreview(id) {
  const item = snapshotAlerts.find((alert) => Number(alert.id) === id);
  if (!item) return;
  const dialog = $('snapshotPreview');
  saveSnapshotPreviewNote();
  dialog.dataset.alertId = String(id);
  renderSnapshotPreview(item);
  dialog.classList.remove('is-maximized');
  $('maximizeSnapshotPreview').textContent = 'Maximize';
  $('maximizeSnapshotPreview').setAttribute('aria-pressed', 'false');
  if (!dialog.open) dialog.showModal();
}
window.openReportedSnapshot = async (item) => {
  const response = await fetch(`${API_BASE}/alerts/${item.id}/report`, { cache: 'no-store' });
  if (!response.ok) throw new Error('Could not load the latest report details.');
  item = await response.json();
  window.location.hash = '#alerts';
  alertView = 'reports';
  alertPage = 0;
  $('alertView').value = 'reports';
  await loadAlerts();
  // Notifications may refer to snapshots outside the first page of reports.
  saveSnapshotPreviewNote();
  const dialog = $('snapshotPreview');
  dialog.dataset.alertId = String(item.id);
  renderSnapshotPreview(item);
  dialog.classList.remove('is-maximized');
  $('maximizeSnapshotPreview').textContent = 'Maximize';
  $('maximizeSnapshotPreview').setAttribute('aria-pressed', 'false');
  if (!dialog.open) dialog.showModal();
};
$('closeSnapshotPreview').addEventListener('click', () => $('snapshotPreview').close());
$('snapshotPreview').addEventListener('close', () => {
  saveSnapshotPreviewNote();
  $('snapshotPreview').classList.remove('is-maximized');
  const button = $('alertList').querySelector(`[data-preview-alert="${$('snapshotPreview').dataset.alertId}"]`);
  button?.focus({ preventScroll: true });
});
$('maximizeSnapshotPreview').addEventListener('click', () => {
  const maximized = $('snapshotPreview').classList.toggle('is-maximized');
  $('maximizeSnapshotPreview').textContent = maximized ? 'Restore' : 'Maximize';
  $('maximizeSnapshotPreview').setAttribute('aria-pressed', String(maximized));
});
function observeCameraStatuses(cameras) {
  const nextStatuses = new Map(cameras.map((camera) => [String(camera.id), { status: camera.status, name: camera.name, location: camera.location, lastCheckedAt: camera.lastCheckedAt }]));
  if (cameraStatuses) {
    for (const [id, camera] of nextStatuses) {
      const previous = cameraStatuses.get(id)?.status;
      if (!['online', 'offline'].includes(camera.status) || camera.status === previous) continue;
      const isOnline = camera.status === 'online';
      cameraAlerts.unshift({
        type: isOnline ? 'camera-online' : 'camera-offline',
        title: isOnline ? 'Camera back online' : 'Camera offline',
        details: [camera.name, camera.location].filter(Boolean).join(' · '),
        time: camera.lastCheckedAt || new Date().toISOString()
      });
    }
    cameraAlerts = cameraAlerts.slice(0, 20);
  }
  cameraStatuses = nextStatuses;
  renderAlertFeed();
}
window.addEventListener('cameras:updated', (event) => observeCameraStatuses(event.detail || []));
function showCameraUnavailable(url) {
  const mixedContent = window.location.protocol === 'https:' && new URL(url).protocol === 'http:';
  $('cameraPlaceholder').style.display = 'flex';
  $('cameraPlaceholder').innerHTML = '<div class="cam-icon">!</div><strong>Camera feed unavailable</strong><span>' + (mixedContent
    ? 'Connect this device and the camera to the same Wi-Fi. In updated Chrome or Edge, allow Local network access in this site\'s settings, then reconnect. Check the camera IP and close other camera viewers. If your browser does not support local access from HTTPS, open the local dashboard instead.'
    : 'Open the camera stream URL on the same Wi-Fi to check its IP. Close other camera viewers, then reconnect.') + '</span>';
  $('cameraStatus').textContent = 'Status: Camera feed unavailable';
}
function isLocalCameraUrl(url) {
  const host = url.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true;
  if (/^\[(?:f[cd][0-9a-f]{2}:|fe[89ab][0-9a-f]:|::1\])/i.test(host)) return true;
  const parts = host.split('.').map(Number);
  return parts.length === 4 && parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)
    && (parts[0] === 10 || parts[0] === 127
      || (parts[0] === 192 && parts[1] === 168)
      || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
      || (parts[0] === 169 && parts[1] === 254));
}
async function connectCamera() {
  stopFaceRecognition();
  const url = $('cameraUrl').value.trim();
  if (!url) {
    $('cameraStatus').textContent = window.currentRole === 'admin'
      ? 'Status: Enter the ESP32-CAM stream URL first'
      : 'Status: No shared camera is saved yet. Ask an admin to save the camera URL.';
    return;
  }
  try {
    const parsedUrl = new URL(url);
    if (!['http:', 'https:'].includes(parsedUrl.protocol)) throw new Error('Invalid protocol');
  } catch {
    $('cameraStatus').textContent = 'Status: Enter a valid HTTP or HTTPS URL';
    return;
  }
  const img = $('cameraImg');
  const attempt = ++cameraAttempt;
  // Release the previous MJPEG request before opening another one. The ESP32
  // stream server handles one long-running request at a time.
  img.onload = null;
  img.onerror = null;
  img.removeAttribute('src');
  if (cameraLoadTimer) clearInterval(cameraLoadTimer);
  if (cameraFirstFrameTimer) clearTimeout(cameraFirstFrameTimer);
  connected = false;
  $('toggleFaceRecognitionBtn').disabled = true;
  updateStats();
  $('cameraStatus').textContent = 'Status: Trying to load camera feed…';
  img.style.display = 'block';
  $('cameraPlaceholder').style.display = 'none';
  $('liveTag').style.display = 'none';
  const markCameraConnected = () => {
    if (attempt !== cameraAttempt || connected || !img.naturalWidth || !img.naturalHeight) return;
    if (cameraLoadTimer) clearInterval(cameraLoadTimer);
    cameraLoadTimer = null;
    if (cameraFirstFrameTimer) clearTimeout(cameraFirstFrameTimer);
    cameraFirstFrameTimer = null;
    connected = true;
    if (window.activeCameraId) fetch(`${API_BASE}/cameras/${window.activeCameraId}/status`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'online' }) }).then(() => window.dispatchEvent(new Event('camera:status')));
    $('cameraPlaceholder').style.display = 'none';
    $('liveTag').style.display = 'block';
    $('cameraStatus').textContent = window.activeCameraId
      ? 'Status: ESP32-CAM feed connected'
      : 'Status: Feed connected. Select Save camera URL to enable snapshot alerts.';
    $('toggleFaceRecognitionBtn').disabled = !window.activeCameraId;
    updateStats();
    window.dispatchEvent(new Event('camera:connected'));
  };
  // Multipart MJPEG streams may not fire `load` until the stream ends.
  // Detect the first decoded frame while the MJPEG stream is live.
  img.onload = markCameraConnected;
  const failCamera = () => {
    if (attempt !== cameraAttempt) return;
    if (cameraLoadTimer) clearInterval(cameraLoadTimer);
    cameraLoadTimer = null;
    if (cameraFirstFrameTimer) clearTimeout(cameraFirstFrameTimer);
    cameraFirstFrameTimer = null;
    img.onload = null;
    img.onerror = null;
    img.removeAttribute('src');
    connected = false;
    stopFaceRecognition();
    $('toggleFaceRecognitionBtn').disabled = true;
    if (window.activeCameraId) fetch(`${API_BASE}/cameras/${window.activeCameraId}/status`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'offline' }) }).then(() => window.dispatchEvent(new Event('camera:status')));
    img.style.display = 'none';
    showCameraUnavailable(url);
    $('liveTag').style.display = 'none';
    updateStats();
    window.dispatchEvent(new Event('camera:disconnected'));
  };
  const directUrl = new URL(url);
  const proxyUrl = window.activeCameraId
    ? new URL(`${API_BASE}/cameras/${window.activeCameraId}/stream`, window.location.origin)
    : null;
  // Modern browsers allow HTTPS pages to reach local HTTP devices after the
  // user grants Local Network Access. The viewer, not Vercel, reaches the LAN.
  // ESP32 CORS headers also allow face detection to read the decoded frames.
  const localCamera = isLocalCameraUrl(directUrl);
  const sources = window.location.protocol === 'http:' || localCamera
    ? [directUrl, proxyUrl].filter(Boolean)
    : [proxyUrl, directUrl.protocol === 'https:' ? directUrl : null].filter(Boolean);
  let sourceIndex = 0;
  const loadNextSource = () => {
    if (attempt !== cameraAttempt) return;
    if (cameraFirstFrameTimer) clearTimeout(cameraFirstFrameTimer);
    cameraFirstFrameTimer = null;
    img.onerror = null;
    img.removeAttribute('src');
    const source = sources[sourceIndex++];
    if (!source) { failCamera(); return; }
    connected = false;
    updateStats();
    $('liveTag').style.display = 'none';
    $('toggleFaceRecognitionBtn').disabled = true;
    stopFaceRecognition();
    img.crossOrigin = 'anonymous';
    img.onerror = () => {
      if (attempt !== cameraAttempt) return;
      if (connected) failCamera();
      else loadNextSource();
    };
    source.searchParams.set('_t', Date.now());
    const awaitingLocalPermission = window.location.protocol === 'https:' && source.protocol === 'http:' && isLocalCameraUrl(source);
    $('cameraStatus').textContent = awaitingLocalPermission
      ? 'Status: Connecting on your Wi-Fi. Select Allow when asked for Local network access.'
      : 'Status: Trying to load camera feed...';
    // Leave time to answer the permission prompt before trying a fallback.
    cameraFirstFrameTimer = setTimeout(loadNextSource, awaitingLocalPermission ? 60000 : 12000);
    img.src = source.toString();
  };
  loadNextSource();
  if (attempt !== cameraAttempt || !img.getAttribute('src')) return;
  const loadTimer = setInterval(() => {
    if (attempt !== cameraAttempt) {
      clearInterval(loadTimer);
      if (cameraLoadTimer === loadTimer) cameraLoadTimer = null;
      return;
    }
    markCameraConnected();
  }, 200);
  cameraLoadTimer = loadTimer;
}

function updateFaceRecognitionCount() {
  $('faceRecognitionStatus').textContent = faceRecognitionActive
    ? 'Snapshot detection on'
    : connected && !window.activeCameraId
      ? 'Save camera URL first to enable snapshot alerts'
      : 'Snapshot detection off';
}
function videoFrameReady() {
  const stream = $('cameraImg');
  return Boolean(connected && stream?.src && stream.naturalWidth > 0 && stream.naturalHeight > 0);
}
async function loadFaceModels() {
  if (faceModelsReady) return;
  if (faceModelLoadPromise) return faceModelLoadPromise;
  faceModelLoadPromise = (async () => {
    $('faceRecognitionStatus').textContent = 'Loading face models...';
    if (!window.faceapi) {
      faceApiLoadPromise ||= new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = '/vendor/face-api.min.js';
        script.onload = resolve;
        script.onerror = () => { faceApiLoadPromise = null; reject(new Error('Could not load detection library.')); };
        document.head.appendChild(script);
      });
      await faceApiLoadPromise;
    }
    await Promise.all([
      faceapi.nets.tinyFaceDetector.loadFromUri('/models'),
      faceapi.nets.faceLandmark68Net.loadFromUri('/models'),
      faceapi.nets.faceRecognitionNet.loadFromUri('/models')
    ]);
    faceModelsReady = true;
    updateFaceRecognitionCount();
  })();
  try { await faceModelLoadPromise; }
  catch (error) { faceModelLoadPromise = null; throw error; }
}
function drawDetectedFaces(detections, width, height, overlay = $('recognitionOverlay')) {
  if (!overlay) return;
  // Match the captured image's dimensions. CSS contains both the video image
  // and this canvas in the same area, including any black bars.
  overlay.width = width;
  overlay.height = height;
  overlay.classList.add('is-active');
  const ctx = overlay.getContext('2d');
  ctx.clearRect(0, 0, width, height);
  ctx.lineWidth = 3;
  ctx.font = 'bold 16px Arial';
  for (const face of detections) {
    const box = face.detection?.box || face.box;
    if (!box) continue;
    const side = Math.min(Math.max(box.width, box.height), width, height);
    const x = Math.max(0, Math.min(width - side, box.x + (box.width - side) / 2));
    const y = Math.max(0, Math.min(height - side, box.y + (box.height - side) / 2));
    ctx.strokeStyle = face.matched ? '#18875b' : '#ff9800';
    ctx.strokeRect(x, y, side, side);
    const label = face.matched ? `Recognized: ${face.matchName}` : 'Unrecognized';
    const labelWidth = Math.min(width, ctx.measureText(label).width + 12);
    const labelX = Math.min(x, width - labelWidth);
    const labelY = Math.max(0, y - 25);
    ctx.fillStyle = face.matched ? '#18875b' : '#ff9800';
    ctx.fillRect(labelX, labelY, labelWidth, 25);
    ctx.fillStyle = '#111827';
    ctx.fillText(label, labelX + 6, labelY + 18);
  }
}
function clearDetectedFaces() {
  const overlay = $('recognitionOverlay');
  if (!overlay) return;
  overlay.getContext('2d').clearRect(0, 0, overlay.width, overlay.height);
  overlay.classList.remove('is-active');
}
async function recognizeCameraFaces() {
  if (!faceRecognitionActive || faceRecognitionProcessing || !videoFrameReady()) return;
  faceRecognitionProcessing = true;
  const attempt = cameraAttempt;
  const generation = faceRecognitionGeneration;
  const cameraId = Number(window.activeCameraId);
  try {
    // Match the same captured frame that is used for the unmatched-face alert.
    const stream = $('cameraImg');
    const canvas = document.createElement('canvas');
    const scale = Math.min(1, 960 / stream.naturalWidth);
    canvas.width = Math.round(stream.naturalWidth * scale);
    canvas.height = Math.round(stream.naturalHeight * scale);
    canvas.getContext('2d').drawImage(stream, 0, 0, canvas.width, canvas.height);
    const faces = await faceapi.detectAllFaces(canvas, new faceapi.TinyFaceDetectorOptions({ scoreThreshold: 0.65 })).withFaceLandmarks().withFaceDescriptors();
    const detections = await window.FaceManagement.classify(faces);
    if (!faceRecognitionActive || generation !== faceRecognitionGeneration || attempt !== cameraAttempt || cameraId !== Number(window.activeCameraId)) return;
    const unmatched = detections.filter((face) => !face.matched);
    drawDetectedFaces(detections, canvas.width, canvas.height);
    $('faceRecognitionStatus').textContent = `${detections.length - unmatched.length} recognized, ${unmatched.length} unrecognized - Monitoring on`;
    if (!unmatched.length || Date.now() - lastSnapshotAt < 60000) return;
    let snapshot = canvas.toDataURL('image/jpeg', 0.75);
    if (snapshot.length > 540000) snapshot = canvas.toDataURL('image/jpeg', 0.4);
    const response = await fetch(`${API_BASE}/alerts`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cameraId, snapshot, faceCount: Math.min(50, unmatched.length) }) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Could not save snapshot alert.');
    lastSnapshotAt = Date.now();
    $('faceRecognitionStatus').textContent = result.duplicate ? 'Recent snapshot already queued for review' : 'Snapshot saved to Alerts for review';
    await loadAlerts();
  } catch (error) {
    if (attempt !== cameraAttempt || generation !== faceRecognitionGeneration) return;
    if (attempt === cameraAttempt) clearDetectedFaces();
    lastSnapshotAt = Date.now() - 50000;
    $('faceRecognitionStatus').textContent = `Snapshot detection: ${error.message}`;
  } finally { faceRecognitionProcessing = false; }
}
async function startFaceRecognition() {
  if (!window.currentRole || !connected || !window.activeCameraId || faceRecognitionActive) return;
  const attempt = cameraAttempt;
  const generation = ++faceRecognitionGeneration;
  const button = $('toggleFaceRecognitionBtn');
  button.disabled = true;
  try {
    await loadFaceModels();
    await window.FaceManagement.classify([]);
    if (!connected || cameraAttempt !== attempt || generation !== faceRecognitionGeneration) return;
    faceRecognitionActive = true;
    button.textContent = 'Stop snapshot detection';
    faceRecognitionTimer = setInterval(recognizeCameraFaces, 800);
    updateFaceRecognitionCount();
    void recognizeCameraFaces();
  } catch (error) { $('faceRecognitionStatus').textContent = `Could not start detection: ${error.message}`; }
  finally { button.disabled = !connected || !window.activeCameraId; }
}
function stopFaceRecognition() {
  faceRecognitionGeneration++;
  faceRecognitionActive = false;
  if (faceRecognitionTimer) clearInterval(faceRecognitionTimer);
  faceRecognitionTimer = null;
  clearDetectedFaces();
  const button = $('toggleFaceRecognitionBtn');
  if (button) button.textContent = 'Start snapshot detection';
  updateFaceRecognitionCount();
}
$('toggleFaceRecognitionBtn').addEventListener('click', () => faceRecognitionActive ? stopFaceRecognition() : startFaceRecognition());
window.addEventListener('camera:connected', startFaceRecognition);
$('reloadAlertsBtn').addEventListener('click', loadAlerts);
$('alertView').addEventListener('change', () => {
  alertView = $('alertView').value;
  alertPage = 0;
  void loadAlerts();
});
$('previousAlertsBtn').addEventListener('click', () => {
  if (alertPage === 0) return;
  alertPage--;
  void loadAlerts();
});
$('nextAlertsBtn').addEventListener('click', () => {
  if (!alertHasMore) return;
  alertPage++;
  void loadAlerts();
});
updateFaceRecognitionCount();
$('toggleFaceRecognitionBtn').disabled = true;

async function saveSharedCameraUrl() {
  const streamUrl = $('cameraUrl').value.trim();
  if (!streamUrl) throw new Error('Enter the ESP32-CAM stream URL first.');
  const response = await fetch(`${API_BASE}/camera-stream`, {
    method: 'PUT',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ streamUrl, cameraId: window.activeCameraId || null })
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || 'Could not save camera URL.');
  window.activeCameraId = Number(result.id);
  $('cameraUrl').value = result.streamUrl;
  window.dispatchEvent(new Event('camera:saved'));
}
$('cameraUrl').addEventListener('input', () => { window.activeCameraId = null; $('toggleFaceRecognitionBtn').disabled = true; });
$('connectBtn').addEventListener('click', connectCamera);
window.addEventListener('camera:url-updated', connectCamera);
$('saveUrlBtn').addEventListener('click', async () => {
  try {
    await saveSharedCameraUrl();
  } catch (error) { $('cameraStatus').textContent = `Status: ${error.message}`; return; }
  connectCamera();
});
$('disconnectBtn').addEventListener('click', () => {
  cameraAttempt += 1;
  if (cameraLoadTimer) clearInterval(cameraLoadTimer);
  cameraLoadTimer = null;
  if (cameraFirstFrameTimer) clearTimeout(cameraFirstFrameTimer);
  cameraFirstFrameTimer = null;
  connected = false;
  $('toggleFaceRecognitionBtn').disabled = true;
  $('cameraImg').removeAttribute('src');
  $('cameraImg').style.display = 'none';
  $('cameraPlaceholder').style.display = 'flex';
  $('cameraPlaceholder').innerHTML = '<div class="cam-icon">▣</div><strong>Camera feed disconnected</strong><span>Enter your ESP32-CAM stream URL below,<br>then select Connect Camera.</span>';
  $('liveTag').style.display = 'none';
  $('cameraStatus').textContent = 'Status: Disconnected';
  stopFaceRecognition();
  updateStats();
  window.dispatchEvent(new Event('camera:disconnected'));
});
$('cameraFullscreenBtn').addEventListener('click', async () => {
  const frame = document.querySelector('.camera-frame');
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await frame.requestFullscreen();
  } catch { $('cameraStatus').textContent = 'Status: Fullscreen is unavailable in this browser'; }
});
$('refreshBtn').addEventListener('click', () => { setDate(); loadAlerts(); });
function formatRecordingTime(value) {
  const date = new Date(String(value || '').replace(' ', 'T'));
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString();
}
function formatRecordingSize(bytes) {
  const size = Number(bytes) || 0;
  return size < 1024 * 1024 ? `${Math.max(1, Math.round(size / 1024))} KB` : `${(size / (1024 * 1024)).toFixed(1)} MB`;
}
async function readRecordingResponse(response) {
  const body = await response.text();
  let result;
  try { result = body ? JSON.parse(body) : {}; }
  catch {
    const message = response.status === 404
      ? 'The recording endpoint was not found. Restart the Node.js server so it loads the latest recording routes.'
      : `The server returned an unexpected response (HTTP ${response.status}). Restart the Node.js server and try again.`;
    throw new Error(message);
  }
  if (!response.ok) throw new Error(result.error || `Request failed (HTTP ${response.status}).`);
  return result;
}
async function loadArchivedRecordings() {
  const rows = $('recordingArchiveRows');
  rows.innerHTML = '<tr><td colspan="6" class="empty">Loading archived clips…</td></tr>';
  try {
    const response = await fetch(`${API_BASE}/recordings?archived=true`);
    const clips = await readRecordingResponse(response);
    rows.innerHTML = clips.length ? clips.map((clip) => `<tr><td>${escapeHtml(clip.cameraName)}</td><td>${escapeHtml(formatRecordingTime(clip.startedAt))}</td><td>${escapeHtml(formatRecordingTime(clip.endedAt))}</td><td>${escapeHtml(formatRecordingTime(clip.archivedAt))}</td><td>${formatRecordingSize(clip.fileSizeBytes)}</td><td>${window.currentRole === 'admin' ? `<button type="button" class="btn" data-restore-recording="${Number(clip.id)}">Restore</button> <button type="button" class="btn" data-delete-recording="${Number(clip.id)}">Delete</button>` : ''}</td></tr>`).join('') : '<tr><td colspan="6" class="empty">No archived clips.</td></tr>';
    rows.querySelectorAll('[data-restore-recording]').forEach((button) => button.addEventListener('click', async () => {
      try { const response = await fetch(`${API_BASE}/recordings/${button.dataset.restoreRecording}/restore`, { method: 'PATCH' }); await readRecordingResponse(response); await loadArchivedRecordings(); }
      catch (error) { window.alert(error.message || 'Could not restore recording.'); }
    }));
    rows.querySelectorAll('[data-delete-recording]').forEach((button) => button.addEventListener('click', async () => {
      if (!window.confirm('Permanently delete this archived clip?')) return;
      try { const response = await fetch(`${API_BASE}/recordings/${button.dataset.deleteRecording}`, { method: 'DELETE' }); await readRecordingResponse(response); await loadArchivedRecordings(); }
      catch (error) { window.alert(error.message || 'Could not delete recording.'); }
    }));
  } catch (error) { rows.innerHTML = `<tr><td colspan="6" class="empty">${escapeHtml(error.message)}</td></tr>`; }
}
$('openRecordingArchiveBtn').addEventListener('click', async () => {
  $('userMenu').hidden = true;
  $('userAvatar').setAttribute('aria-expanded', 'false');
  $('recordingArchiveWrap').hidden = false;
  await loadArchivedRecordings();
  $('closeRecordingArchiveBtn').focus();
});
$('closeRecordingArchiveBtn').addEventListener('click', () => { $('recordingArchiveWrap').hidden = true; });
$('recordingArchiveWrap').addEventListener('click', (event) => {
  if (event.target === $('recordingArchiveWrap')) $('recordingArchiveWrap').hidden = true;
});
setDate();
loadAlerts();
// Refresh the shared snapshot review queue for signed-in users.
setInterval(loadAlerts, 10000);
