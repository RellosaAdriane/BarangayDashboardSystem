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
function formatRecordingTime(value) {
  const date = new Date(String(value || '').replace(' ', 'T'));
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString();
}
function formatRecordingSize(bytes) {
  const size = Number(bytes) || 0;
  return size < 1024 * 1024 ? `${Math.max(1, Math.round(size / 1024))} KB` : `${(size / (1024 * 1024)).toFixed(1)} MB`;
}
let activeRecordingId = null;
function playRecordingClip(clip) {
  const player = $('recordingPlayer');
  player.pause();
  player.removeAttribute('src');
  player.load();
  activeRecordingId = Number(clip.id);
  player.src = `${API_BASE}/recordings/${activeRecordingId}/video?play=${Date.now()}`;
  player.hidden = false;
  $('recordingPreview').querySelector('.recording-preview-empty').hidden = true;
  $('recordingNowPlaying').textContent = `${clip.cameraName} · ${formatRecordingTime(clip.startedAt)}`;
  player.load();
  $('recordingTimeline').querySelectorAll('[data-timeline-recording]').forEach((button) => button.classList.toggle('is-active', Number(button.dataset.timelineRecording) === activeRecordingId));
  player.play().catch(() => {});
}
function renderRecordingTimeline(clips) {
  const channels = $('recordingChannels');
  const initialized = channels.dataset.initialized === 'true';
  const selected = new Set([...channels.querySelectorAll('input:checked')].map((input) => input.value));
  const cameras = [...new Map(clips.map((clip) => [String(clip.cameraId), clip.cameraName])).entries()];
  $('recordingChannelCount').textContent = `${cameras.length} camera${cameras.length === 1 ? '' : 's'}`;
  channels.innerHTML = cameras.length ? cameras.map(([id, name], index) => `<label class="recording-channel"><input type="checkbox" value="${escapeHtml(id)}" ${!initialized || selected.has(id) ? 'checked' : ''}><span class="recording-channel-dot recording-channel-dot-${index % 4}"></span><span>${escapeHtml(name)}</span><small>${clips.filter((clip) => String(clip.cameraId) === id).length} clips</small></label>`).join('') : '<div class="empty">No cameras have clips for this date.</div>';
  channels.dataset.initialized = 'true';
  const visible = clips.filter((clip) => !initialized || selected.has(String(clip.cameraId)));
  $('recordingTimelineDate').textContent = $('recordingDate').value ? new Date(`${$('recordingDate').value}T12:00:00`).toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' }) : '';
  if (!visible.length) { $('recordingTimeline').innerHTML = '<div class="empty">No clips match this date and channel selection.</div>'; return; }
  const byCamera = [...new Map(visible.map((clip) => [String(clip.cameraId), clip.cameraName])).entries()];
  const starts = visible.map((clip) => new Date(String(clip.startedAt).replace(' ', 'T')).getTime()).filter(Number.isFinite);
  const ends = visible.map((clip) => new Date(String(clip.startedAt).replace(' ', 'T')).getTime() + Math.max(1, Number(clip.durationSeconds) || 300) * 1000).filter(Number.isFinite);
  let rangeStart = Math.min(...starts) - 10 * 60 * 1000;
  let rangeEnd = Math.max(...ends) + 10 * 60 * 1000;
  const minimumRange = 60 * 60 * 1000;
  if (rangeEnd - rangeStart < minimumRange) {
    const extra = (minimumRange - (rangeEnd - rangeStart)) / 2;
    rangeStart -= extra;
    rangeEnd += extra;
  }
  const range = rangeEnd - rangeStart;
  const rangeLabel = (time) => new Date(time).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  $('recordingTimeline').innerHTML = `<div class="recording-time-axis"><span>${rangeLabel(rangeStart)}</span><span>${rangeLabel((rangeStart + rangeEnd) / 2)}</span><span>${rangeLabel(rangeEnd)}</span></div>${byCamera.map(([id, name]) => `<div class="recording-track"><strong>${escapeHtml(name)}</strong><div class="recording-track-line">${visible.filter((clip) => String(clip.cameraId) === id).map((clip) => { const start = new Date(String(clip.startedAt).replace(' ', 'T')).getTime(); const duration = Math.max(1, Number(clip.durationSeconds) || 300) * 1000; const left = Math.max(0, (start - rangeStart) / range * 100); const width = Math.max(2, duration / range * 100); const active = Number(clip.id) === activeRecordingId ? ' is-active' : ''; return `<button class="recording-clip-block${active}" type="button" title="${escapeHtml(formatRecordingTime(clip.startedAt))}" aria-label="Play ${escapeHtml(name)} clip from ${escapeHtml(formatRecordingTime(clip.startedAt))}" data-timeline-recording="${Number(clip.id)}" style="left:${left}%;width:${width}%"></button>`; }).join('')}</div></div>`).join('')}`;
  $('recordingTimeline').querySelectorAll('[data-timeline-recording]').forEach((button) => button.addEventListener('click', () => {
    const clip = clips.find((item) => Number(item.id) === Number(button.dataset.timelineRecording));
    if (clip) playRecordingClip(clip);
  }));
  $('recordingChannels').querySelectorAll('input').forEach((input) => input.addEventListener('change', () => renderRecordingTimeline(clips)));
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
async function loadRecordedFootage() {
  const params = new URLSearchParams();
  if (!$('recordingDate').value) {
    const today = new Date();
    $('recordingDate').value = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  }
  const selectedDate = $('recordingDate').value;
  $('recordingFrom').value = `${selectedDate}T00:00`;
  $('recordingTo').value = `${selectedDate}T23:59`;
  if ($('recordingCameraFilter').value) params.set('cameraId', $('recordingCameraFilter').value);
  if ($('recordingFrom').value) params.set('from', $('recordingFrom').value);
  if ($('recordingTo').value) params.set('to', $('recordingTo').value);
  $('recordingStatus').textContent = 'Loading recorded clips…';
  try {
    const response = await fetch(`${API_BASE}/recordings?${params}`);
    const clips = await response.json().catch(() => []);
    if (!response.ok) throw new Error(clips.error || 'Could not load recordings.');
    renderRecordingTimeline(clips);
    $('recordingRows').innerHTML = clips.length ? clips.map((clip) => `<tr><td>${escapeHtml(clip.cameraName)}</td><td>${escapeHtml(formatRecordingTime(clip.startedAt))}</td><td>${escapeHtml(formatRecordingTime(clip.endedAt))}</td><td>${Math.floor(Number(clip.durationSeconds) / 60)}m ${Number(clip.durationSeconds) % 60}s</td><td>${formatRecordingSize(clip.fileSizeBytes)}</td><td><button type="button" class="btn" data-play-recording="${Number(clip.id)}" data-recording-title="${escapeHtml(`${clip.cameraName} · ${formatRecordingTime(clip.startedAt)}`)}">Play</button> ${window.currentRole === 'admin' ? `<button type="button" class="btn" data-archive-recording="${Number(clip.id)}">Archive</button>` : ''}</td></tr>`).join('') : '<tr><td colspan="6" class="empty">No clips match this date/time range.</td></tr>';
    $('recordingStatus').textContent = `${clips.length} clip${clips.length === 1 ? '' : 's'} found. Up to 500 clips are shown.`;
    $('recordingRows').querySelectorAll('[data-play-recording]').forEach((button) => button.addEventListener('click', () => {
      const clip = clips.find((item) => Number(item.id) === Number(button.dataset.playRecording));
      if (clip) playRecordingClip(clip);
    }));
    $('recordingRows').querySelectorAll('[data-archive-recording]').forEach((button) => button.addEventListener('click', async () => {
      try { const response = await fetch(`${API_BASE}/recordings/${button.dataset.archiveRecording}/archive`, { method: 'PATCH' }); await readRecordingResponse(response); await loadRecordedFootage(); if (!$('recordingArchiveWrap').hidden) await loadArchivedRecordings(); }
      catch (error) { $('recordingStatus').textContent = error.message || 'Could not archive recording.'; }
    }));
  } catch (error) {
    $('recordingRows').innerHTML = '<tr><td colspan="6" class="empty">Recording list is unavailable.</td></tr>';
    $('recordingStatus').textContent = error.message;
  }
}
async function loadArchivedRecordings() {
  const rows = $('recordingArchiveRows');
  rows.innerHTML = '<tr><td colspan="6" class="empty">Loading archived clips…</td></tr>';
  try {
    const response = await fetch(`${API_BASE}/recordings?archived=true`);
    const clips = await readRecordingResponse(response);
    rows.innerHTML = clips.length ? clips.map((clip) => `<tr><td>${escapeHtml(clip.cameraName)}</td><td>${escapeHtml(formatRecordingTime(clip.startedAt))}</td><td>${escapeHtml(formatRecordingTime(clip.endedAt))}</td><td>${escapeHtml(formatRecordingTime(clip.archivedAt))}</td><td>${formatRecordingSize(clip.fileSizeBytes)}</td><td>${window.currentRole === 'admin' ? `<button type="button" class="btn" data-restore-recording="${Number(clip.id)}">Restore</button> <button type="button" class="btn" data-delete-recording="${Number(clip.id)}">Delete</button>` : ''}</td></tr>`).join('') : '<tr><td colspan="6" class="empty">No archived clips.</td></tr>';
    rows.querySelectorAll('[data-restore-recording]').forEach((button) => button.addEventListener('click', async () => {
      try { const response = await fetch(`${API_BASE}/recordings/${button.dataset.restoreRecording}/restore`, { method: 'PATCH' }); await readRecordingResponse(response); await loadArchivedRecordings(); await loadRecordedFootage(); }
      catch (error) { window.alert(error.message || 'Could not restore recording.'); }
    }));
    rows.querySelectorAll('[data-delete-recording]').forEach((button) => button.addEventListener('click', async () => {
      if (!window.confirm('Permanently delete this archived clip?')) return;
      try { const response = await fetch(`${API_BASE}/recordings/${button.dataset.deleteRecording}`, { method: 'DELETE' }); await readRecordingResponse(response); await loadArchivedRecordings(); }
      catch (error) { window.alert(error.message || 'Could not delete recording.'); }
    }));
  } catch (error) { rows.innerHTML = `<tr><td colspan="6" class="empty">${escapeHtml(error.message)}</td></tr>`; }
}
async function refreshRecorderStatus() {
  try {
    const response = await fetch(`${API_BASE}/recording/status`);
    const cameras = await response.json();
    if (!response.ok) throw new Error(cameras.error || 'Recorder status unavailable.');
    const recordingCount = cameras.filter((camera) => camera.status === 'recording').length;
    const reconnecting = cameras.some((camera) => ['reconnecting', 'error', 'starting'].includes(camera.status));
    $('recorderStatusBadge').textContent = cameras.length && recordingCount === cameras.length ? 'RECORDING' : reconnecting ? 'CHECK CAMERA' : recordingCount ? 'PARTIAL' : 'NO CAMERAS';
    $('recorderStatusBadge').className = `tag ${recordingCount && !reconnecting ? 'green' : 'amber'}`;
    if (reconnecting) {
      const issue = cameras.find((camera) => camera.error);
      $('recordingStatus').textContent = issue ? `Recorder issue for ${issue.name}: ${issue.error}` : 'Starting camera recorders…';
    }
  } catch {
    $('recorderStatusBadge').textContent = 'UNAVAILABLE';
    $('recorderStatusBadge').className = 'tag amber';
  }
}
window.loadRecordedFootage = loadRecordedFootage;
window.refreshRecorderStatus = refreshRecorderStatus;
$('searchRecordingsBtn').addEventListener('click', loadRecordedFootage);
$('recordingCameraFilter').addEventListener('change', loadRecordedFootage);
$('recordingDate').addEventListener('change', loadRecordedFootage);
$('closeRecordingPlayerBtn').addEventListener('click', () => {
  const player = $('recordingPlayer');
  player.pause();
  player.removeAttribute('src');
  player.load();
  player.hidden = true;
  $('recordingPreview').querySelector('.recording-preview-empty').hidden = false;
  $('recordingNowPlaying').textContent = 'No clip selected';
});
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
setInterval(refreshRecorderStatus, 15000);
setDate();
loadIncidents();
