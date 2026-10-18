const $ = (id) => document.getElementById(id);
const API_BASE = '/api';
let incidents = [];
let connected = false;
let cameraLoadTimer = null;
let cameraAttempt = 0;

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
function renderIncidents() {
  const rows = $('incidentRows');
  const list = $('alertList');
  if (!incidents.length) {
    rows.innerHTML = '<tr><td colspan="5" class="empty">No incidents recorded yet.</td></tr>';
    list.innerHTML = '<div class="empty">No alerts yet. Use “Test alert” to preview an alert.</div>';
  } else {
    rows.innerHTML = incidents.map(i => {
      const date = formatDate(i.date || i.createdAt);
      const status = i.status || 'Active';
      return `<tr><td>${escapeHtml(i.id || 'INC')}</td><td>${escapeHtml(i.type || i.eventType || 'Incident')}</td><td>${escapeHtml(i.camera || 'ESP32-CAM 01')}</td><td>${escapeHtml(date)}</td><td><span class="tag ${status === 'Active' ? 'red' : 'green'}">${escapeHtml(status)}</span> ${window.currentRole === 'admin' ? `<button class="btn" data-archive-incident="${escapeHtml(i.dbId || i.id)}">Archive</button>` : ''}</td></tr>`;
    }).join('');
    list.innerHTML = incidents.slice(0, 6).map(i => {
      const status = i.status || 'Active';
      return `<div class="alert"><div class="alert-dot ${status === 'Resolved' ? 'safe' : ''}"></div><div class="alert-text"><strong>${escapeHtml(i.type || i.eventType || 'Incident')}</strong><p>${escapeHtml(i.note || i.details || 'Camera: ESP32-CAM 01')}</p><span class="tag ${status === 'Active' ? 'red' : 'green'}">${escapeHtml(status)}</span></div><span class="alert-time">${escapeHtml(formatDate(i.date || i.createdAt))}</span></div>`;
    }).join('');
  }
  rows.querySelectorAll('[data-archive-incident]').forEach((button) => button.addEventListener('click', async () => {
    try { const response = await fetch(`${API_BASE}/incidents/${button.dataset.archiveIncident}/archive`, { method: 'PATCH' }); if (!response.ok) throw new Error('Could not archive incident'); await loadIncidents(); }
    catch (error) { $('cameraStatus').textContent = error.message; }
  }));
  updateStats();
}
async function loadIncidents() {
  try {
    const response = await fetch(`${API_BASE}/incidents`);
    if (!response.ok) throw new Error('API not ready');
    const data = await response.json();
    incidents = Array.isArray(data) ? data : (data.incidents || []);
    renderIncidents();
  } catch (error) {
    incidents = [];
    renderIncidents();
  }
}
async function createIncident(type, note) {
  const incident = { type, note, cameraId: window.activeCameraId || null, status: 'Active', date: new Date().toISOString() };
  try {
    const response = await fetch(`${API_BASE}/incidents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(incident)
    });
    if (!response.ok) throw new Error('API request failed');
    const saved = await response.json();
    incidents.unshift(saved.incident || saved);
  } catch (error) {
    $('cameraStatus').textContent = `Unable to save report: ${error.message}`;
    return;
  }
  renderIncidents();
}
function connectCamera() {
  const url = $('cameraUrl').value.trim();
  if (!url) { $('cameraStatus').textContent = 'Status: Enter the ESP32-CAM stream URL first'; return; }
  try {
    const parsedUrl = new URL(url);
    if (!['http:', 'https:'].includes(parsedUrl.protocol)) throw new Error('Invalid protocol');
  } catch {
    $('cameraStatus').textContent = 'Status: Enter a valid HTTP or HTTPS URL';
    return;
  }
  const img = $('cameraImg');
  const attempt = ++cameraAttempt;
  if (cameraLoadTimer) clearInterval(cameraLoadTimer);
  connected = false;
  updateStats();
  $('cameraStatus').textContent = 'Status: Trying to load camera feed…';
  img.style.display = 'block';
  $('cameraPlaceholder').style.display = 'none';
  $('liveTag').style.display = 'none';
  const markCameraConnected = () => {
    if (attempt !== cameraAttempt || connected || !img.naturalWidth || !img.naturalHeight) return;
    if (cameraLoadTimer) clearInterval(cameraLoadTimer);
    cameraLoadTimer = null;
    connected = true;
    if (window.activeCameraId) fetch(`${API_BASE}/cameras/${window.activeCameraId}/status`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'online' }) }).then(() => window.dispatchEvent(new Event('camera:status')));
    $('cameraPlaceholder').style.display = 'none';
    $('liveTag').style.display = 'block';
    $('cameraStatus').textContent = 'Status: Feed loaded';
    updateStats();
    window.dispatchEvent(new Event('camera:connected'));
  };
  // Multipart MJPEG streams may not fire `load` until the stream ends.
  // Detect the first decoded frame so recognition can start while it is live.
  img.onload = markCameraConnected;
  img.onerror = () => {
    if (attempt !== cameraAttempt) return;
    if (cameraLoadTimer) clearInterval(cameraLoadTimer);
    cameraLoadTimer = null;
    connected = false;
    if (window.activeCameraId) fetch(`${API_BASE}/cameras/${window.activeCameraId}/status`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'offline' }) }).then(() => window.dispatchEvent(new Event('camera:status')));
    img.style.display = 'none';
    $('cameraPlaceholder').style.display = 'flex';
    $('cameraPlaceholder').innerHTML = '<div class="cam-icon">⚠</div><strong>Unable to load stream</strong><span>Check the camera IP, stream path, network,<br>and whether the endpoint works as an image stream.</span>';
    $('cameraStatus').textContent = 'Status: Connection failed — verify stream URL';
    $('liveTag').style.display = 'none';
    updateStats();
    window.dispatchEvent(new Event('camera:disconnected'));
  };
  img.src = url;
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

$('connectBtn').addEventListener('click', connectCamera);
window.addEventListener('camera:url-updated', connectCamera);
$('saveUrlBtn').addEventListener('click', async () => {
  const url = $('cameraUrl').value.trim();
  if (!url) return;
  try {
    const response = await fetch(`${API_BASE}/camera-stream`, { method: 'PUT', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ streamUrl: url, cameraId: window.activeCameraId || null }) });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || 'Could not save camera URL');
    window.activeCameraId = Number(result.id);
    $('cameraUrl').value = result.streamUrl;
  } catch (error) { $('cameraStatus').textContent = `Status: ${error.message}`; return; }
  connectCamera();
});
$('disconnectBtn').addEventListener('click', () => {
  cameraAttempt += 1;
  if (cameraLoadTimer) clearInterval(cameraLoadTimer);
  cameraLoadTimer = null;
  connected = false;
  if (window.activeCameraId) fetch(`${API_BASE}/cameras/${window.activeCameraId}/status`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'offline' }) });
  $('cameraImg').removeAttribute('src');
  $('cameraImg').style.display = 'none';
  $('cameraPlaceholder').style.display = 'flex';
  $('cameraPlaceholder').innerHTML = '<div class="cam-icon">▣</div><strong>Camera feed disconnected</strong><span>Enter your ESP32-CAM stream URL below,<br>then select Connect Camera.</span>';
  $('liveTag').style.display = 'none';
  $('cameraStatus').textContent = 'Status: Disconnected';
  updateStats();
  window.dispatchEvent(new Event('camera:disconnected'));
});
$('testAlertBtn').addEventListener('click', () => createIncident('Test Intruder Alert', 'Demo alert generated manually; no sensor event was received.'));
$('reportBtn').addEventListener('click', () => {
  createIncident($('eventType').value, $('eventNote').value.trim() || 'Manually recorded by barangay dashboard operator.');
  $('eventNote').value = '';
});
$('reloadIncidentsBtn').addEventListener('click', loadIncidents);
$('refreshBtn').addEventListener('click', () => { setDate(); loadIncidents(); });
setDate();
loadIncidents();
