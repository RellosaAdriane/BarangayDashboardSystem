(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const dialog = $('recordingPlayerDialog');
  const canvas = $('aviRecordingCanvas'), video = $('standardRecordingVideo');
  const seek = $('aviRecordingSeek'), play = $('aviRecordingPlay'), status = $('recordingPlayerStatus');
  let clip, playing = false, animation = 0, position = 0, origin = 0, lastFrame = -1, busy = false, generation = 0, abort;
  const cell = (row, value) => { const td = row.insertCell(); td.textContent = value; return td; };
  async function api(url, options) {
    const response = await fetch(url, options);
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Request failed.');
    return result;
  }
  const button = (label, fn) => { const b = document.createElement('button'); b.type = 'button'; b.className = 'btn'; b.textContent = label; b.addEventListener('click', fn); return b; };
  const timestamp = (value, provider) => {
    const text = String(value || '').replace(' ', 'T');
    const date = new Date(provider === 'r2' && !/[Zz]|[+-]\d\d:\d\d$/.test(text) ? `${text}Z` : text);
    return Number.isNaN(date.getTime()) ? 'Unknown' : date.toLocaleString();
  };
  function reset() {
    generation++; playing = false; cancelAnimationFrame(animation); abort?.abort(); abort = null;
    video.pause(); video.removeAttribute('src'); video.load(); clip = null; position = 0; lastFrame = -1; busy = false;
    canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
    play.textContent = 'Play'; seek.value = 0;
  }
  async function drawFrame(index) {
    if (!clip || index === lastFrame || busy) return;
    const version = generation, current = clip;
    busy = true;
    let bitmap;
    try {
      const frame = current.frames[index];
      bitmap = await createImageBitmap(new Blob([current.bytes.subarray(frame.offset, frame.offset + frame.size)], { type: 'image/jpeg' }));
      if (version !== generation) return;
      canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      lastFrame = index;
    } catch (error) {
      if (version === generation) { playing = false; status.textContent = `Unable to decode frame: ${error.message}`; }
    } finally { bitmap?.close(); if (version === generation) busy = false; }
  }
  function tick(now) {
    if (!playing || !clip) return;
    position = Math.min(clip.duration, (now - origin) / 1000);
    seek.value = position;
    $('aviRecordingTime').textContent = `${position.toFixed(1)} / ${clip.duration.toFixed(1)} s`;
    void drawFrame(Math.min(clip.frames.length - 1, Math.floor(position / clip.frameSeconds)));
    if (position >= clip.duration) { playing = false; play.textContent = 'Play'; return; }
    animation = requestAnimationFrame(tick);
  }
  play.addEventListener('click', () => {
    if (!clip) return;
    playing = !playing; play.textContent = playing ? 'Pause' : 'Play';
    if (playing) { if (position >= clip.duration) position = 0; origin = performance.now() - position * 1000; animation = requestAnimationFrame(tick); }
    else cancelAnimationFrame(animation);
  });
  seek.addEventListener('input', () => {
    if (!clip) return;
    position = Number(seek.value); origin = performance.now() - position * 1000;
    $('aviRecordingTime').textContent = `${position.toFixed(1)} / ${clip.duration.toFixed(1)} s`;
    void drawFrame(Math.min(clip.frames.length - 1, Math.floor(position / clip.frameSeconds)));
  });
  async function openRecording(id) {
    reset(); dialog.showModal(); status.textContent = 'Loading recording…';
    canvas.hidden = true; video.hidden = true; $('aviRecordingControls').hidden = true;
    const version = generation;
    abort = new AbortController();
    try {
      const source = await api(`/api/recordings/${id}/source`, { signal: abort.signal });
      if (version !== generation) return;
      $('recordingDownload').href = `/api/recordings/${id}/video`;
      if (source.format === 'video') { video.hidden = false; video.src = source.url; status.textContent = ''; return; }
      status.textContent = 'Downloading clip for playback…';
      const loaded = await MjpegAvi.readClip(await fetch(source.url, { signal: abort.signal, credentials: 'omit' }));
      if (version !== generation) return;
      clip = loaded; canvas.width = clip.width; canvas.height = clip.height;
      canvas.hidden = false; $('aviRecordingControls').hidden = false;
      seek.max = clip.duration; seek.step = clip.frameSeconds;
      status.textContent = 'Camera recording · No audio';
      $('aviRecordingTime').textContent = `0.0 / ${clip.duration.toFixed(1)} s`;
      await drawFrame(0);
    } catch (error) { if (version === generation && error.name !== 'AbortError') status.textContent = error.message; }
  }
  $('closeRecordingPlayer').addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', reset);
  let loading = false;
  async function history() {
    if (!window.currentRole || loading) return;
    loading = true;
    const rows = $('deviceRecordingRows');
    rows.replaceChildren(); $('recordingHistoryStatus').textContent = 'Loading…';
    try {
      const query = new URLSearchParams();
      if ($('recordingCameraFilter').value) query.set('cameraId', $('recordingCameraFilter').value);
      if ($('recordingFrom').value) query.set('from', $('recordingFrom').value);
      if ($('recordingTo').value) query.set('to', $('recordingTo').value);
      const clips = await api(`/api/recordings?${query}`);
      for (const item of clips) {
        const row = rows.insertRow();
        cell(row, item.cameraName); cell(row, timestamp(item.startedAt, item.storageProvider));
        cell(row, `${item.durationSeconds} s`); cell(row, `${(Number(item.fileSizeBytes) / 1048576).toFixed(1)} MB`);
        const actions = cell(row, ''); actions.append(button('Play', () => void openRecording(item.id)));
        if (window.currentRole === 'admin') actions.append(button('Archive', async () => {
          try { await api(`/api/recordings/${item.id}/archive`, { method: 'PATCH' }); await history(); }
          catch (error) { $('recordingHistoryStatus').textContent = error.message; }
        }));
      }
      $('recordingHistoryStatus').textContent = clips.length ? `${clips.length} recordings (latest 500). Date filters use Philippine time.` : 'No uploaded recordings found.';
    } catch (error) { $('recordingHistoryStatus').textContent = error.message; }
    finally { loading = false; }
  }
  $('recordingHistoryForm').addEventListener('submit', (event) => { event.preventDefault(); void history(); });
  $('clearDeviceToken').addEventListener('click', () => { $('deviceTokenResult').textContent = ''; });
  $('createDeviceToken').addEventListener('click', async () => {
    const id = $('deviceCameraSelect').value;
    if (!id || !confirm('Generate a device token? This replaces any existing token for this camera.')) return;
    try { const result = await api(`/api/cameras/${id}/device-token`, { method: 'POST' }); $('deviceTokenResult').textContent = result.token; }
    catch (error) { $('deviceTokenResult').textContent = error.message; }
  });
  $('revokeDeviceToken').addEventListener('click', async () => {
    const id = $('deviceCameraSelect').value;
    if (!id || !confirm('Revoke this camera’s upload token?')) return;
    try { await api(`/api/cameras/${id}/device-token`, { method: 'DELETE' }); $('deviceTokenResult').textContent = 'Device token revoked.'; }
    catch (error) { $('deviceTokenResult').textContent = error.message; }
  });
  window.addEventListener('cameras:updated', (event) => {
    for (const id of ['recordingCameraFilter', 'deviceCameraSelect']) {
      const select = $(id), previous = select.value; select.replaceChildren();
      if (id === 'recordingCameraFilter') select.add(new Option('All cameras', ''));
      for (const camera of event.detail || []) select.add(new Option(`${camera.name} (ID ${camera.id})`, camera.id));
      if ([...select.options].some((option) => option.value === previous)) select.value = previous;
    }
    $('deviceCameraTools').hidden = window.currentRole !== 'admin';
  });
  window.addEventListener('hashchange', () => { if (location.hash === '#recordingHistoryPanel') void history(); else if (dialog.open) dialog.close(); });
  // Clear the one-time token and release video memory when a user signs out.
  new MutationObserver(() => {
    if ($('app').hidden || getComputedStyle($('app')).display === 'none') { $('deviceTokenResult').textContent = ''; if (dialog.open) dialog.close(); }
  }).observe($('app'), { attributes: true, attributeFilter: ['hidden', 'style'] });
})();
