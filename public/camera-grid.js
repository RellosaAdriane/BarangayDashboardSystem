(() => {
  const tiles = new Map();
  let processing = false;
  let cursor = 0;
  let ownerEmailConfigured = null;
  const make = (tag, className, text) => {
    const node = document.createElement(tag);
    node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  async function refreshOwnerEmailStatus() {
    if (ownerEmailConfigured !== null) return ownerEmailConfigured;
    try {
      const response = await fetch('/api/alerts/email-status', { credentials: 'same-origin', cache: 'no-store' });
      if (!response.ok) throw new Error('Email status unavailable');
      ownerEmailConfigured = Boolean((await response.json()).configured);
    } catch { ownerEmailConfigured = false; }
    return ownerEmailConfigured;
  }
  function makeAlertSnapshot(canvas) {
    const prefix = 'data:image/jpeg;base64,';
    for (const quality of [0.82, 0.68, 0.54, 0.4, 0.3, 0.2]) {
      const dataUrl = canvas.toDataURL('image/jpeg', quality);
      const base64 = dataUrl.startsWith(prefix) ? dataUrl.slice(prefix.length) : '';
      const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
      if (Math.floor(base64.length * 3 / 4) - padding <= 400 * 1024) return dataUrl;
    }
    throw new Error('Camera snapshot is too large to send.');
  }
  function updateSummary() {
    const count = [...tiles.values()].filter((tile) => tile.connected).length;
    const badge = document.getElementById('feedBadge');
    badge.textContent = tiles.size ? `${count} / ${tiles.size} CONNECTED` : 'NOT CONNECTED';
    badge.className = `tag ${count ? 'green' : 'amber'}`;
    document.getElementById('deviceStatus').textContent = count ? `${count} camera(s) connected` : 'Offline';
  }
  function publishStatus(tile, status) {
    fetch(`/api/cameras/${tile.camera.id}/status`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status }) })
      .then((response) => { if (response.ok) window.dispatchEvent(new Event('camera:status')); }).catch(() => {});
  }
  function stop(tile) {
    tile.version++;
    tile.connected = false;
    if (tile.timeout) clearTimeout(tile.timeout);
    tile.timeout = null;
    tile.image.onload = null;
    tile.image.onerror = null;
    tile.image.removeAttribute('src');
    tile.image.style.display = 'none';
    tile.overlay.classList.remove('is-active');
    window.clearDetectedFaces?.(tile.overlay);
    const overlayContext = tile.overlay.getContext('2d');
    overlayContext?.clearRect?.(0, 0, tile.overlay.width, tile.overlay.height);
    tile.live.style.display = 'none';
    tile.placeholder.hidden = false;
    tile.disconnect.disabled = true;
    tile.monitor.textContent = '';
    tile.faceTracks = [];
  }
  function connect(tile) {
    stop(tile);
    const version = tile.version;
    let direct;
    try {
      direct = new URL(tile.camera.streamUrl);
      if (!['http:', 'https:'].includes(direct.protocol)) throw new Error('Invalid stream URL');
    } catch {
      tile.placeholder.textContent = 'Invalid camera stream URL. Update it in Camera Setup.';
      tile.status.textContent = 'Invalid URL';
      return;
    }
    const proxy = new URL(`/api/cameras/${tile.camera.id}/stream`, window.location.origin);
    const sources = window.location.protocol === 'http:' || isLocalCameraUrl(direct)
      ? [direct, proxy] : [proxy, ...(direct.protocol === 'https:' ? [direct] : [])];
    let index = 0;
    tile.disconnect.disabled = false;
    tile.image.style.display = 'block';
    tile.placeholder.textContent = 'Connecting camera...';
    const next = () => {
      if (version !== tile.version) return;
      tile.connected = false;
      tile.live.style.display = 'none';
      tile.placeholder.hidden = false;
      tile.overlay.classList.remove('is-active');
      window.clearDetectedFaces?.(tile.overlay);
      tile.overlay.getContext('2d')?.clearRect?.(0, 0, tile.overlay.width, tile.overlay.height);
      updateSummary();
      if (tile.timeout) clearTimeout(tile.timeout);
      tile.timeout = null;
      tile.image.onerror = null;
      tile.image.removeAttribute('src');
      const source = sources[index++];
      if (!source) {
        stop(tile);
        tile.status.textContent = 'Camera feed unavailable';
        tile.placeholder.textContent = 'Check the camera IP and Wi-Fi connection. In Chrome or Edge, allow Local network access, then reconnect.';
        publishStatus(tile, 'offline');
        updateSummary();
        return;
      }
      const localPermission = window.location.protocol === 'https:' && source.protocol === 'http:' && isLocalCameraUrl(source);
      tile.status.textContent = localPermission ? 'Select Allow for Local network access' : 'Connecting...';
      tile.image.crossOrigin = 'anonymous';
      tile.image.onerror = next;
      tile.image.onload = () => markConnected(tile, version);
      source.searchParams.set('_t', Date.now());
      tile.timeout = setTimeout(next, localPermission ? 60000 : 12000);
      tile.image.src = source.toString();
    };
    next();
    updateSummary();
  }
  function markConnected(tile, version = tile.version) {
    if (version !== tile.version || tile.connected || !tile.image.getAttribute('src') || !tile.image.naturalWidth || !tile.image.naturalHeight) return;
    if (tile.timeout) clearTimeout(tile.timeout);
    tile.timeout = null;
    tile.connected = true;
    tile.placeholder.hidden = true;
    tile.live.style.display = 'block';
    tile.status.textContent = 'Connected';
    tile.reconnect.textContent = 'Reconnect';
    publishStatus(tile, 'online');
    updateSummary();
  }
  function createTile(camera) {
    const root = make('article', 'camera-tile');
    root.dataset.cameraId = String(camera.id);
    const heading = make('div', 'camera-tile-heading');
    const name = make('strong', '', camera.name);
    const location = make('span', 'sub', camera.location || 'Location not set');
    heading.append(name, location);
    const frame = make('div', 'camera-frame');
    const image = make('img', '');
    image.alt = `${camera.name} live stream`;
    const overlay = make('canvas', 'camera-overlay');
    overlay.setAttribute('aria-hidden', 'true');
    const placeholder = make('div', 'camera-placeholder', 'Connecting camera...');
    const live = make('span', 'live-tag', 'LIVE');
    const full = make('button', 'camera-fullscreen', 'Full');
    full.type = 'button';
    full.setAttribute('aria-label', `Fullscreen ${camera.name}`);
    full.addEventListener('click', async () => { try { await frame.requestFullscreen(); } catch { tile.status.textContent = 'Fullscreen is unavailable'; } });
    frame.append(image, overlay, placeholder, live, full);
    const controls = make('div', 'camera-meta');
    const status = make('span', 'small', 'Connecting...');
    status.setAttribute('role', 'status');
    const buttons = make('div', 'cam-controls');
    const reconnect = make('button', 'btn', 'Connect');
    const disconnect = make('button', 'btn', 'Disconnect');
    reconnect.type = disconnect.type = 'button';
    buttons.append(reconnect, disconnect);
    controls.append(status, buttons);
    const monitor = make('p', 'sub camera-monitor-status', '');
    root.append(heading, frame, controls, monitor);
    const tile = { camera, root, name, location, frame, image, overlay, placeholder, live, status, monitor, reconnect, disconnect, connected: false, version: 0, timeout: null, lastSnapshotAt: 0, faceTracks: [] };
    if (window.currentRole === 'admin') {
      const settings = make('details', 'camera-stream-settings');
      const summary = make('summary', '', 'Edit stream URL');
      const form = make('form', 'field-row');
      const input = make('input', '');
      input.type = 'url';
      input.required = true;
      input.value = camera.streamUrl;
      input.setAttribute('aria-label', `${camera.name} stream URL`);
      const save = make('button', 'btn', 'Save URL');
      save.type = 'submit';
      form.append(input, save);
      settings.append(summary, form);
      root.appendChild(settings);
      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        save.disabled = true;
        try {
          const url = new URL(input.value.trim());
          if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Enter a valid HTTP or HTTPS URL.');
          const response = await fetch('/api/camera-stream', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cameraId: Number(tile.camera.id), streamUrl: url.href }) });
          const result = await response.json();
          if (!response.ok) throw new Error(result.error || 'Could not update camera URL.');
          tile.camera = { ...tile.camera, streamUrl: result.streamUrl };
          connect(tile);
          settings.open = false;
          window.dispatchEvent(new Event('camera:saved'));
        } catch (error) { tile.status.textContent = error.message; }
        finally { save.disabled = false; }
      });
      tile.urlInput = input;
    }
    reconnect.addEventListener('click', () => connect(tile));
    disconnect.addEventListener('click', () => {
      stop(tile);
      tile.status.textContent = 'Disconnected';
      tile.placeholder.textContent = 'Camera disconnected. Select Connect to resume.';
      tile.reconnect.textContent = 'Connect';
      updateSummary();
    });
    return tile;
  }
  function render(cameras) {
    const active = cameras.filter((camera) => camera.isEnabled !== false && camera.isEnabled !== 0);
    const grid = document.getElementById('cameraLiveGrid');
    grid.hidden = active.length === 0;
    grid.classList.toggle('single-camera', active.length === 1);
    document.getElementById('singleCameraPreview').hidden = active.length > 0;
    if (active.length && document.getElementById('cameraImg').getAttribute('src')) document.getElementById('disconnectBtn').click();
    const ids = new Set(active.map((camera) => String(camera.id)));
    for (const [id, tile] of tiles) {
      if (!ids.has(id)) { stop(tile); tile.root.remove(); tiles.delete(id); }
    }
    for (const camera of active) {
      const id = String(camera.id);
      const existing = tiles.get(id);
      if (existing) {
        const changed = existing.camera.streamUrl !== camera.streamUrl;
        existing.camera = camera;
        existing.name.textContent = camera.name;
        existing.location.textContent = camera.location || 'Location not set';
        existing.image.alt = `${camera.name} live stream`;
        if (existing.urlInput && document.activeElement !== existing.urlInput) existing.urlInput.value = camera.streamUrl;
        if (changed) connect(existing);
      } else {
        const tile = createTile(camera);
        tiles.set(id, tile);
        grid.appendChild(tile.root);
        connect(tile);
      }
    }
    if (active.length || !document.getElementById('cameraImg').getAttribute('src')) updateSummary();
  }
  function boxOf(face) { return face.box; }
  function preserveFaceBoxes(faces, width, height) {
    return faces.map((face) => {
      const source = face.detection?.box || face.box;
      let box = source && { x: Number(source.x), y: Number(source.y), width: Number(source.width), height: Number(source.height) };
      if (box && Object.values(box).every(Number.isFinite) && box.x >= 0 && box.y >= 0
        && box.x <= 1 && box.y <= 1 && box.width <= 1 && box.height <= 1) {
        box = { x: box.x * width, y: box.y * height, width: box.width * width, height: box.height * height };
      }
      return box && Object.values(box).every(Number.isFinite) && box.width > 0 && box.height > 0 ? { ...face, box } : face;
    });
  }
  function overlap(a, b) {
    const x1 = Math.max(a.x, b.x), y1 = Math.max(a.y, b.y);
    const x2 = Math.min(a.x + a.width, b.x + b.width), y2 = Math.min(a.y + a.height, b.y + b.height);
    const intersection = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
    return intersection / (a.width * a.height + b.width * b.height - intersection || 1);
  }
  function stabilizeFaces(tile, faces) {
    const previous = tile.faceTracks || [];
    const used = new Set();
    const next = faces.map((face) => {
      const box = boxOf(face);
      if (!box) return face;
      let best = -1, score = 0;
      previous.forEach((track, index) => {
        if (used.has(index)) return;
        const candidate = overlap(track.box, box);
        if (candidate > score) { score = candidate; best = index; }
      });
      const old = score >= 0.2 ? previous[best] : null;
      if (old) used.add(best);
      const smooth = old ? {
        x: old.box.x * 0.78 + box.x * 0.22,
        y: old.box.y * 0.78 + box.y * 0.22,
        width: old.box.width * 0.78 + box.width * 0.22,
        height: old.box.height * 0.78 + box.height * 0.22
      } : { ...box };
      const candidateName = face.matched ? face.matchName : '';
      const sameCandidate = Boolean(old?.face.matched && candidateName && old.face.matchName === candidateName);
      const matchStreak = face.matched ? (sameCandidate ? (old.face.matchStreak || 1) + 1 : 1) : 0;
      const confirmed = Boolean(face.matched && matchStreak >= 3);
      return {
        ...face, matched: confirmed, identityPending: Boolean(face.matched && !confirmed),
        matchName: confirmed ? face.matchName : '', candidateName, matchStreak,
        detection: face.detection ? { ...face.detection, box: smooth } : undefined, box: smooth, missed: 0
      };
    });
    previous.forEach((track, index) => {
      // Hold the last box briefly through skipped/slow ESP32 MJPEG frames.
      if (!used.has(index) && track.missed < 4) next.push({ ...track.face, detection: track.face.detection ? { ...track.face.detection, box: track.box } : undefined, box: track.box, missed: track.missed + 1 });
    });
    tile.faceTracks = next.map((face) => ({ face, box: { ...boxOf(face) }, missed: face.missed || 0 }));
    return next;
  }
  async function detectNext() {
    if (processing || !window.currentRole) return;
    const connected = [...tiles.values()].filter((tile) => tile.connected);
    if (!connected.length) return;
    const tile = connected[cursor++ % connected.length];
    const version = tile.version;
    processing = true;
    try {
      if (!tile.connected || version !== tile.version) return;
      await loadFaceModels();
      if (!tile.connected || version !== tile.version) return;
      const canvas = document.createElement('canvas');
      const scale = Math.min(1, 960 / tile.image.naturalWidth);
      canvas.width = Math.round(tile.image.naturalWidth * scale);
      canvas.height = Math.round(tile.image.naturalHeight * scale);
      const context = canvas.getContext('2d');
      let faces = [];
      for (const variant of [
        { filter: 'none', threshold: 0.18 },
        { filter: 'brightness(1.15) contrast(1.08)', threshold: 0.15 },
        { filter: 'brightness(0.85) contrast(1.12)', threshold: 0.15 }
      ]) {
        context.clearRect?.(0, 0, canvas.width, canvas.height);
        context.filter = variant.filter;
        context.drawImage(tile.image, 0, 0, canvas.width, canvas.height);
        faces = await faceapi.detectAllFaces(canvas, new faceapi.TinyFaceDetectorOptions({ inputSize: 608, scoreThreshold: variant.threshold })).withFaceLandmarks().withFaceDescriptors();
        if (faces.length) break;
      }
      context.filter = 'none';
      const matched = stabilizeFaces(tile, await window.FaceManagement.classify(preserveFaceBoxes(faces, canvas.width, canvas.height)));
      if (!tile.connected || version !== tile.version) return;
      await refreshOwnerEmailStatus();
      if (!tile.connected || version !== tile.version) return;
      const drawableBoxes = matched.filter((face) => {
        const box = boxOf(face);
        return box && [box.x, box.y, box.width, box.height].every(Number.isFinite) && box.width > 0 && box.height > 0;
      }).length;
      drawDetectedFaces(matched, canvas.width, canvas.height, tile.overlay);
      const unmatched = matched.filter((face) => !face.matched && !face.identityPending);
      const closest = unmatched.find((face) => face.nearestName);
      const checking = matched.filter((face) => face.identityPending).length;
      tile.monitor.textContent = !matched.length
        ? 'No face detected in frame. Check camera angle, lighting, and entry-area coverage.'
        : matched[0]?.enrollmentCount === 0
        ? 'No enrolled faces loaded. Add a face in Face Management.'
        : `${matched.filter((face) => face.matched).length} recognized · ${unmatched.length} unknown · ${ownerEmailConfigured ? 'owner email ready' : 'owner email not configured'} · overlay boxes ${drawableBoxes}/${matched.length}${checking ? ` · ${checking} checking identity` : ''}${closest ? ` · closest to ${closest.nearestName}: ${closest.matchDistance.toFixed(2)} (limit ${closest.matchLimit.toFixed(2)}, photo support ${closest.matchSupport})` : ''}`;
      if (!unmatched.length || Date.now() - tile.lastSnapshotAt < 60000) return;
      const snapshot = makeAlertSnapshot(canvas);
      const response = await fetch('/api/alerts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cameraId: Number(tile.camera.id), snapshot, faceCount: Math.min(50, unmatched.length) }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Could not save snapshot.');
      tile.lastSnapshotAt = Date.now();
      ownerEmailConfigured = Boolean(result.emailConfigured);
      tile.monitor.textContent = result.duplicate
        ? 'Recent snapshot already queued; repeat email suppressed for 60 seconds'
        : result.emailSent ? 'Unfamiliar-face snapshot saved and emailed to owner'
        : result.emailConfigured ? 'Snapshot saved, but email delivery failed. Check the Node server log.'
        : 'Snapshot saved; owner email is not configured';
      void loadAlerts();
    } catch (error) {
      if (version === tile.version) {
        tile.monitor.textContent = `Monitoring: ${error.message}`;
        tile.lastSnapshotAt = Math.max(tile.lastSnapshotAt, Date.now() - 50000);
      }
    } finally { processing = false; }
  }
  window.addEventListener('cameras:updated', (event) => render(event.detail || []));
  setInterval(() => { for (const tile of tiles.values()) markConnected(tile); }, 200);
  setInterval(detectNext, 1000);
  window.CameraGrid = {
    focus(id) {
      const tile = tiles.get(String(id));
      if (!tile) return;
      window.location.hash = '#camera';
      tile.root.scrollIntoView({ behavior: 'smooth', block: 'center' });
      tile.reconnect.focus();
    }
  };
})();
