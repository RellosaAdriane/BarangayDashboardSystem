(() => {
  const byId = (id) => document.getElementById(id);
  const MATCH_DISTANCE = 0.45;
  const MIN_IDENTITY_GAP = 0.07;
  let enrolled = [];
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
    enrolled = [];
  }
  function conflictingEnrollment(descriptor, fullName) {
    const name = fullName.trim().normalize('NFKC').toLocaleLowerCase();
    let sameNameDistance = Infinity;
    let sameName = '';
    for (const person of enrolled) {
      let sum = 0;
      for (let index = 0; index < 128; index++) {
        const difference = descriptor[index] - Number(person.descriptor[index]);
        sum += difference * difference;
      }
      const distance = Math.sqrt(sum);
      if (person.fullName.trim().normalize('NFKC').toLocaleLowerCase() === name) {
        if (distance < sameNameDistance) sameNameDistance = distance;
        sameName = person.fullName;
      } else if (distance <= 0.35) {
        return `This face is already enrolled as ${person.fullName}. Use the same name when adding another photo.`;
      }
    }
    if (sameName && sameNameDistance > 0.6) return `This face does not match the existing enrollment for ${sameName}. Use a photo of that person.`;
    return '';
  }
  async function refreshMatcher() {
    if (Date.now() - refreshedAt < 3000) return;
    if (refreshing) { await refreshing; if (!refreshedAt) return refreshMatcher(); return; }
    const version = revision;
    refreshing = (async () => {
      const people = await request('/api/faces/descriptors');
      if (version !== revision) return;
      enrolled = people.filter((person) => Array.isArray(person.descriptor)
        && person.descriptor.length === 128
        && person.descriptor.every((value) => Number.isFinite(Number(value)))
        && person.descriptor.some((value) => Number(value) !== 0));
      refreshedAt = Date.now();
    })();
    try { await refreshing; } finally { refreshing = null; }
    if (version !== revision) await refreshMatcher();
  }
  async function classify(detections) {
    await refreshMatcher();
    const classified = detections.map((face) => {
      const distanceByIdentity = new Map();
      if (face.descriptor?.length === 128) for (const person of enrolled) {
        let sum = 0;
        for (let index = 0; index < 128; index++) {
          const difference = face.descriptor[index] - Number(person.descriptor[index]);
          sum += difference * difference;
        }
        const distance = Math.sqrt(sum);
        const key = person.fullName.trim().normalize('NFKC').toLocaleLowerCase();
        const current = distanceByIdentity.get(key);
        if (current) current.distances.push(distance);
        else distanceByIdentity.set(key, { person, distances: [distance] });
      }
      const ranked = [...distanceByIdentity.values()].map((identity) => {
        const distances = identity.distances.sort((a, b) => a - b);
        // Multiple enrollment photos provide pose coverage. Requiring two photos
        // to match at once rejects valid side views when only one enrollment
        // photo has a similar angle, so rank the identity by its closest photo.
        const requiredSupport = 1;
        const score = distances[0];
        const matchLimit = MATCH_DISTANCE;
        return { ...identity, distance: score, matchLimit, requiredSupport, supportCount: distances.filter((distance) => distance <= MATCH_DISTANCE).length };
      }).sort((a, b) => a.distance - b.distance);
      const nearest = ranked[0] || null;
      const identityGap = (ranked[1]?.distance ?? Infinity) - (nearest?.distance ?? Infinity);
      const matched = Boolean(nearest && nearest.supportCount >= nearest.requiredSupport
        && nearest.distance <= nearest.matchLimit && identityGap >= MIN_IDENTITY_GAP);
      return {
        ...face, matched, matchName: matched ? nearest.person.fullName : '',
        nearestName: nearest?.person.fullName || '', matchDistance: nearest?.distance ?? null,
        matchLimit: nearest?.matchLimit ?? null,
        matchSupport: nearest ? `${nearest.supportCount}/${nearest.requiredSupport}` : null,
        identityGap: Number.isFinite(identityGap) ? identityGap : null, enrollmentCount: enrolled.length
      };
    });
    // TinyFaceDetector can return two differently-sized boxes for the same face.
    // Collapse boxes that cover most of the same area so one person cannot be
    // drawn as both recognized and unknown or counted twice in an alert.
    const areaOverlap = (a, b) => {
      const intersection = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x))
        * Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
      return intersection / Math.min(a.width * a.height, b.width * b.height);
    };
    const unique = [];
    for (const face of classified) {
      const box = face.detection?.box || face.box;
      const duplicateIndex = box ? unique.findIndex((candidate) => {
        const other = candidate.detection?.box || candidate.box;
        // Face detectors can return nested boxes for one face with different
        // nearest-name guesses. Collapse only near-identical boxes so the same
        // person is not drawn twice, while keeping separate nearby people.
        return other && areaOverlap(box, other) >= 0.65;
      }) : -1;
      if (duplicateIndex < 0) {
        unique.push(face);
        continue;
      }
      const existing = unique[duplicateIndex];
      // Keep the stronger face box while carrying forward a valid match for
      // that same identity. A single unknown duplicate must not trigger email.
      const existingScore = Number(existing.detection?.score ?? -1);
      const faceScore = Number(face.detection?.score ?? -1);
      const bestBox = faceScore > existingScore ? face : existing;
      const match = face.matched ? face : existing.matched ? existing : null;
      unique[duplicateIndex] = match
        ? { ...bestBox, matched: true, matchName: match.matchName, matchDistance: match.matchDistance,
          matchLimit: match.matchLimit, matchSupport: match.matchSupport, identityGap: match.identityGap }
        : bestBox;
    }
    return unique;
  }
  async function loadPeople() {
    if (window.currentRole !== 'admin') return;
    const list = byId('enrolledFaceList');
    try {
      const people = await request('/api/faces');
      const groups = new Map();
      for (const person of people) {
        const key = person.fullName.trim().normalize('NFKC').toLocaleLowerCase();
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(person);
      }
      const nameOptions = byId('enrolledFaceNames');
      if (nameOptions) {
        nameOptions.replaceChildren();
        for (const enrollments of groups.values()) {
          const option = document.createElement('option');
          option.value = enrollments[0].fullName;
          nameOptions.appendChild(option);
        }
      }
      byId('enrolledFaceCount').textContent = `${groups.size} people - ${people.length} photos`;
      list.replaceChildren();
      if (!groups.size) {
        const empty = document.createElement('p');
        empty.className = 'empty';
        empty.textContent = 'No enrolled persons yet. Add a name and a clear picture to begin.';
        list.appendChild(empty);
      }
      for (const enrollments of groups.values()) {
        const fullName = enrollments[0].fullName;
        const card = document.createElement('article');
        card.className = 'enrolled-face enrolled-person-group';
        const heading = document.createElement('div');
        heading.className = 'enrolled-person-heading';
        const name = document.createElement('strong');
        name.textContent = fullName;
        const count = document.createElement('span');
        count.className = 'sub';
        count.textContent = `${enrollments.length} registered photo${enrollments.length === 1 ? '' : 's'}`;
        heading.append(name, count);
        const gallery = document.createElement('div');
        gallery.className = 'enrolled-person-photos';
        for (const person of enrollments) {
          const entry = document.createElement('figure');
          entry.className = 'enrolled-person-photo';
          const photo = document.createElement('img');
          photo.src = `/api/faces/${person.id}/photo`;
          photo.alt = `${fullName} enrollment photo`;
          photo.loading = 'lazy';
          const date = document.createElement('figcaption');
          date.textContent = new Date(person.enrolledAt).toLocaleString();
          const remove = document.createElement('button');
          remove.type = 'button';
          remove.className = 'btn';
          remove.textContent = 'Remove photo';
          remove.addEventListener('click', async () => {
            if (!confirm(`Remove this enrollment photo for ${fullName}? Other photos for this person will remain.`)) return;
            remove.disabled = true;
            try {
              await request(`/api/faces/${person.id}`, { method: 'DELETE' });
              invalidate();
              byId('faceManagementStatus').textContent = `Enrollment photo removed for ${fullName}.`;
              await loadPeople();
            } catch (error) { byId('faceManagementStatus').textContent = error.message; }
            finally { remove.disabled = false; }
          });
          entry.append(photo, date, remove);
          gallery.appendChild(entry);
        }
        card.append(heading, gallery);
        list.appendChild(card);
      }
    } catch (error) { byId('faceManagementStatus').textContent = error.message; }
  }
  byId('addPersonForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (saving || window.currentRole !== 'admin') return;
    const files = Array.from(byId('personPhoto').files || []);
    const fullName = byId('personName').value.trim();
    const status = byId('faceManagementStatus');
    if (!fullName || !files.length || files.length > 10 || files.some((file) =>
      !['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > 4194304)) {
      status.textContent = 'Enter a name and select 1 to 10 JPEG, PNG or WebP pictures, 4 MB or smaller each.';
      return;
    }
    saving = true;
    byId('addPersonBtn').disabled = true;
    try {
      status.textContent = `Loading face models for ${files.length} picture${files.length === 1 ? '' : 's'}...`;
      await loadFaceModels();
      let uploaded = 0;
      const failures = [];
      for (let index = 0; index < files.length; index++) {
        const file = files[index];
        status.textContent = `Checking picture ${index + 1} of ${files.length}: ${file.name}`;
        try {
          const image = await faceapi.bufferToImage(file);
          const canvas = document.createElement('canvas');
          const scale = Math.min(1, 1600 / Math.max(image.naturalWidth, image.naturalHeight));
          canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
          canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
          const photoContext = canvas.getContext('2d');
          photoContext.filter = 'brightness(1.2) contrast(1.05)';
          photoContext.drawImage(image, 0, 0, canvas.width, canvas.height);
          photoContext.filter = 'none';
          let faces = [];
          for (const options of [
            { inputSize: 608, scoreThreshold: 0.35 },
            { inputSize: 416, scoreThreshold: 0.3 },
            { inputSize: 320, scoreThreshold: 0.25 }
          ]) {
            const candidate = await faceapi.detectAllFaces(canvas, new faceapi.TinyFaceDetectorOptions(options))
              .withFaceLandmarks().withFaceDescriptors();
            if (candidate.length === 1) { faces = candidate; break; }
            if (candidate.length > 1 && !faces.length) faces = candidate;
          }
          if (faces.length !== 1) throw new Error(faces.length ? 'More than one face detected.' : 'Could not find a face. Try a closer or brighter picture.');
          await refreshMatcher();
          const enrollmentConflict = conflictingEnrollment(faces[0].descriptor, fullName);
          if (enrollmentConflict) throw new Error(enrollmentConflict);
          const photo = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.9));
          if (!photo) throw new Error('Could not prepare the picture.');
          const body = new FormData();
          body.append('fullName', fullName);
          body.append('descriptor', JSON.stringify(Array.from(faces[0].descriptor)));
          body.append('picture', photo, 'enrollment.jpg');
          await request('/api/faces', { method: 'POST', body });
          uploaded++;
          invalidate();
        } catch (error) {
          failures.push(`${file.name}: ${error.message}`);
        }
      }
      if (uploaded) {
        byId('addPersonForm').reset();
        await loadPeople();
      }
      status.textContent = failures.length
        ? `Uploaded ${uploaded} of ${files.length} pictures. ${failures.join(' | ')}`
        : `${uploaded} picture${uploaded === 1 ? '' : 's'} enrolled for ${fullName}.`;
    } catch (error) { status.textContent = error.message; }
    finally { saving = false; byId('addPersonBtn').disabled = false; }
  });
  byId('refreshFacesBtn').addEventListener('click', loadPeople);
  window.FaceManagement = { classify, loadPeople, invalidate };
})();

