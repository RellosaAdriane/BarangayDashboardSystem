(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const dialog = $('recordingPlayerDialog');
  const canvas = $('aviRecordingCanvas'), video = $('standardRecordingVideo');
  const seek = $('aviRecordingSeek'), play = $('aviRecordingPlay'), status = $('recordingPlayerStatus');
  let clip, playing = false, animation = 0, position = 0, origin = 0, lastFrame = -1, busy = false, generation = 0, abort;
  let historyClips = [], replayQueue = [], replayIndex = -1, replayAuto = false;
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
  const duration = (seconds) => `${Number(seconds || 0).toFixed(Number(seconds || 0) % 1 ? 1 : 0)} s`;
  function renderCurrentRecording(item) {
    $('recordingCurrentCamera').textContent = item?.cameraName || '—';
    $('recordingCurrentStarted').textContent = item ? timestamp(item.startedAt, item.storageProvider) : '—';
    $('recordingCurrentDuration').textContent = item ? duration(item.durationSeconds) : '—';
    $('recordingPlayerSubtitle').textContent = item ? `${item.cameraName} · ${timestamp(item.startedAt, item.storageProvider)}` : 'Review recorded camera footage';
  }
  function renderReplayList() {
    const list = $('recordingReplayList');
    list.replaceChildren();
    $('recordingReplayCount').textContent = `${replayQueue.length} ${replayQueue.length === 1 ? 'clip' : 'clips'}`;
    if (!replayQueue.length) { list.textContent = 'No recordings loaded.'; return; }
    replayQueue.forEach((item, index) => {
      const itemButton = document.createElement('button');
      itemButton.type = 'button'; itemButton.className = 'recording-replay-item';
      itemButton.setAttribute('role', 'listitem'); itemButton.setAttribute('aria-current', index === replayIndex ? 'true' : 'false');
      const time = document.createElement('strong'); time.textContent = timestamp(item.startedAt, item.storageProvider);
      const meta = document.createElement('span'); meta.textContent = `${item.cameraName} · ${duration(item.durationSeconds)}`;
      const action = document.createElement('span'); action.className = 'recording-replay-action'; action.textContent = index === replayIndex ? 'Playing' : 'Play';
      itemButton.append(time, meta, action);
      itemButton.addEventListener('click', () => void openReplayAt(index, true));
      list.append(itemButton);
    });
  }
  function renderReplay() {
    const enabled = replayQueue.length > 1 && replayIndex >= 0;
    $('recordingReplayMeta').hidden = !enabled;
    const item = replayQueue[replayIndex];
    if (enabled) {
      $('recordingReplayPosition').textContent = `Clip ${replayIndex + 1} of ${replayQueue.length}`;
      $('recordingReplayDetails').textContent = `${item.cameraName} · ${timestamp(item.startedAt, item.storageProvider)}`;
      $('previousRecording').disabled = replayIndex === 0;
      $('nextRecording').disabled = replayIndex === replayQueue.length - 1;
    }
    renderCurrentRecording(item); renderReplayList();
  }
  function reset(clearReplay = false) {
    generation++; playing = false; cancelAnimationFrame(animation); abort?.abort(); abort = null;
    video.pause(); video.removeAttribute('src'); video.load(); clip = null; position = 0; lastFrame = -1; busy = false;
    canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
    play.textContent = 'Play'; seek.value = 0;
    if (clearReplay) { replayQueue = []; replayIndex = -1; replayAuto = false; renderCurrentRecording(null); renderReplayList(); }
    renderReplay();
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
    if (position >= clip.duration) {
      playing = false; play.textContent = 'Play';
      if (replayAuto && replayIndex < replayQueue.length - 1) void openReplayAt(replayIndex + 1, true);
      return;
    }
    animation = requestAnimationFrame(tick);
  }
  function resumeAviPlayback() {
    if (!clip) return;
    if (position >= clip.duration) position = 0;
    playing = true; play.textContent = 'Pause'; origin = performance.now() - position * 1000;
    animation = requestAnimationFrame(tick);
  }
  play.addEventListener('click', () => {
    if (!clip) return;
    playing = !playing; play.textContent = playing ? 'Pause' : 'Play';
    if (playing) resumeAviPlayback();
    else cancelAnimationFrame(animation);
  });
  seek.addEventListener('input', () => {
    if (!clip) return;
    position = Number(seek.value); origin = performance.now() - position * 1000;
    $('aviRecordingTime').textContent = `${position.toFixed(1)} / ${clip.duration.toFixed(1)} s`;
    void drawFrame(Math.min(clip.frames.length - 1, Math.floor(position / clip.frameSeconds)));
  });
  async function openReplayAt(index, autoPlay) {
    if (index < 0 || index >= replayQueue.length) return;
    replayIndex = index; replayAuto = autoPlay; renderReplay();
    await openRecording(replayQueue[index].id, autoPlay);
  }
  async function startReplay(items, selectedId = null) {
    replayQueue = [...items].sort((a, b) => new Date(a.startedAt) - new Date(b.startedAt));
    replayIndex = selectedId === null ? 0 : Math.max(0, replayQueue.findIndex((item) => String(item.id) === String(selectedId)));
    await openReplayAt(replayIndex, true);
  }
  async function openRecording(id, autoPlay = false) {
    if (dialog.open) { dialog.dataset.replayTransition = '1'; dialog.close(); }
    reset(); dialog.showModal(); status.textContent = 'Loading recording…';
    canvas.hidden = true; video.hidden = true; $('aviRecordingControls').hidden = true; $('recordingEmptyState').hidden = false;
    const version = generation;
    abort = new AbortController();
    try {
      const source = await api(`/api/recordings/${id}/source`, { signal: abort.signal });
      if (version !== generation) return;
      $('recordingDownload').href = `/api/recordings/${id}/video`;
      if (source.format === 'video') {
        video.hidden = false; $('recordingEmptyState').hidden = true; video.src = source.url; status.textContent = '';
        if (autoPlay) await video.play().catch(() => { replayAuto = false; status.textContent = 'Press play to start this clip.'; });
        return;
      }
      status.textContent = 'Downloading clip for playback…';
      const loaded = await MjpegAvi.readClip(await fetch(source.url, { signal: abort.signal, credentials: 'omit' }));
      if (version !== generation) return;
      clip = loaded; canvas.width = clip.width; canvas.height = clip.height;
      canvas.hidden = false; $('recordingEmptyState').hidden = true; $('aviRecordingControls').hidden = false;
      seek.max = clip.duration; seek.step = clip.frameSeconds;
      status.textContent = 'Camera recording · No audio';
      $('aviRecordingTime').textContent = `0.0 / ${clip.duration.toFixed(1)} s`;
      await drawFrame(0);
      if (autoPlay) resumeAviPlayback();
    } catch (error) { if (version === generation && error.name !== 'AbortError') status.textContent = error.message; }
  }
  $('closeRecordingPlayer').addEventListener('click', () => dialog.close());
  $('previousRecording').addEventListener('click', () => void openReplayAt(replayIndex - 1, false));
  $('nextRecording').addEventListener('click', () => void openReplayAt(replayIndex + 1, false));
  video.addEventListener('ended', () => { if (replayAuto && replayIndex < replayQueue.length - 1) void openReplayAt(replayIndex + 1, true); });
  dialog.addEventListener('close', () => {
    if (dialog.dataset.replayTransition) { delete dialog.dataset.replayTransition; return; }
    reset(true);
  });
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
      historyClips = clips;
      $('replayRecordings').disabled = clips.length === 0;
      if (clips.length) {
        replayQueue = [...clips].sort((a, b) => new Date(a.startedAt) - new Date(b.startedAt));
        replayIndex = -1; renderReplayList();
      } else { replayQueue = []; renderReplayList(); }
      for (const item of clips) {
        const row = rows.insertRow();
        cell(row, item.cameraName); cell(row, timestamp(item.startedAt, item.storageProvider));
        cell(row, `${item.durationSeconds} s`); cell(row, `${(Number(item.fileSizeBytes) / 1048576).toFixed(1)} MB`);
        const actions = cell(row, ''); actions.append(button('Play', () => void startReplay(historyClips, item.id)));
        if (window.currentRole === 'admin') actions.append(button('Archive', async () => {
          try { await api(`/api/recordings/${item.id}/archive`, { method: 'PATCH' }); await history(); }
          catch (error) { $('recordingHistoryStatus').textContent = error.message; }
        }));
      }
      $('recordingHistoryStatus').textContent = clips.length ? `${clips.length} recordings (latest 500). Date filters use Philippine time.` : 'No uploaded recordings found.';
    } catch (error) { historyClips = []; $('replayRecordings').disabled = true; $('recordingHistoryStatus').textContent = error.message; }
    finally { loading = false; }
  }
  $('recordingHistoryForm').addEventListener('submit', (event) => { event.preventDefault(); void history(); });
  $('replayRecordings').addEventListener('click', () => void startReplay(historyClips));
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
