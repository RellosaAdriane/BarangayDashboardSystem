(() => {
  const byId = (id) => document.getElementById(id);
  const MATCH_DISTANCE = 0.5;
  let enrolled = [];
  let matcher = null;
  let refreshedAt = 0;
  let refreshing = null;
  let revision = 0;
  let saving = false;

  async function request(path, options = {}) {
    const response = await fetch(path, { credentials: 'same-origin', cache: 'no-store', ...options });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Face management request failed.');
    return data;
  }
  function invalidate() {
    revision++;
    refreshedAt = 0;
    matcher = null;
    enrolled = [];
  }
  async function refreshMatcher() {
    if (Date.now() - refreshedAt < 3000) return;
    if (refreshing) { await refreshing; if (!refreshedAt) return refreshMatcher(); return; }
    const version = revision;
    refreshing = (async () => {
      const people = await request('/api/faces/descriptors');
      if (version !== revision) return;
      const labels = people.map((person) => new faceapi.LabeledFaceDescriptors(String(person.id), [new Float32Array(person.descriptor)]));
      matcher = labels.length ? new faceapi.FaceMatcher(labels, MATCH_DISTANCE) : null;
      enrolled = people;
      refreshedAt = Date.now();
    })();
    try { await refreshing; } finally { refreshing = null; }
    if (version !== revision) await refreshMatcher();
  }
  async function classify(detections) {
    await refreshMatcher(); // Never use stale enrollments when refresh fails.
    return detections.map((face) => {
      const match = matcher?.findBestMatch(face.descriptor);
      const person = match && match.label !== 'unknown' ? enrolled.find((item) => String(item.id) === match.label) : null;
      return { ...face, matched: Boolean(person), matchName: person?.fullName || '' };
    });
  }
  async function loadPeople() {
    if (window.currentRole !== 'admin') return;
    const list = byId('enrolledFaceList');
    try {
      const people = await request('/api/faces');
      byId('enrolledFaceCount').textContent = `${people.length} enrolled`;
      list.replaceChildren();
      if (!people.length) {
        const empty = document.createElement('p');
        empty.className = 'empty';
        empty.textContent = 'No enrolled persons yet. Add a name and a clear picture to begin.';
        list.appendChild(empty);
      }
      for (const person of people) {
        const card = document.createElement('article');
        card.className = 'enrolled-face';
        const photo = document.createElement('img');
        photo.src = `/api/faces/${person.id}/photo`;
        photo.alt = `Enrollment picture of ${person.fullName}`;
        photo.loading = 'lazy';
        const info = document.createElement('div');
        const name = document.createElement('strong');
        name.textContent = person.fullName;
        const date = document.createElement('p');
        date.className = 'sub';
        date.textContent = `Enrolled ${new Date(person.enrolledAt).toLocaleString()}`;
        info.append(name, date);
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'btn';
        remove.textContent = 'Remove Person';
        remove.addEventListener('click', async () => {
          if (!confirm(`Remove ${person.fullName} from enrolled faces? Their picture and enrollment will be deleted.`)) return;
          remove.disabled = true;
          try {
            await request(`/api/faces/${person.id}`, { method: 'DELETE' });
            invalidate();
            byId('faceManagementStatus').textContent = `${person.fullName} removed from enrolled faces.`;
            await loadPeople();
          } catch (error) { byId('faceManagementStatus').textContent = error.message; }
          finally { remove.disabled = false; }
        });
        card.append(photo, info, remove);
        list.appendChild(card);
      }
    } catch (error) { byId('faceManagementStatus').textContent = error.message; }
  }
  byId('addPersonForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (saving || window.currentRole !== 'admin') return;
    const file = byId('personPhoto').files[0];
    const fullName = byId('personName').value.trim();
    const status = byId('faceManagementStatus');
    if (!fullName || !file || !['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > 4194304) {
      status.textContent = 'Enter a name and choose a JPEG, PNG or WebP picture, 4 MB or smaller.';
      return;
    }
    saving = true;
    byId('addPersonBtn').disabled = true;
    try {
      status.textContent = 'Loading face models and checking the picture...';
      await loadFaceModels();
      const image = await faceapi.bufferToImage(file);
      const canvas = document.createElement('canvas');
      const scale = Math.min(1, 1280 / Math.max(image.naturalWidth, image.naturalHeight));
      canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
      canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
      const faces = await faceapi.detectAllFaces(canvas, new faceapi.TinyFaceDetectorOptions({ inputSize: 416, scoreThreshold: 0.65 })).withFaceLandmarks().withFaceDescriptors();
      if (faces.length !== 1) throw new Error(faces.length ? 'More than one face found. Upload a picture of one person only.' : 'No clear face found. Use a well-lit, front-facing picture.');
      const photo = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.9));
      if (!photo) throw new Error('Could not prepare the enrollment picture.');
      const body = new FormData();
      body.append('fullName', fullName);
      body.append('descriptor', JSON.stringify(Array.from(faces[0].descriptor)));
      body.append('picture', photo, 'enrollment.jpg');
      status.textContent = 'Saving enrollment...';
      await request('/api/faces', { method: 'POST', body });
      invalidate();
      byId('addPersonForm').reset();
      status.textContent = `${fullName} enrolled successfully.`;
      await loadPeople();
    } catch (error) { status.textContent = error.message; }
    finally { saving = false; byId('addPersonBtn').disabled = false; }
  });
  byId('refreshFacesBtn').addEventListener('click', loadPeople);
  window.FaceManagement = { classify, loadPeople, invalidate };
})();
