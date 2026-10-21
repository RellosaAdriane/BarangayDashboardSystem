const byId = (id) => document.getElementById(id);
let currentUser = null;
let setupMode = false;
let authMode = 'login';
let cameraFeeds = [];
let sharedCameraRefreshTimer = null;
const localDateKey = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
let calendarMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
let calendarSelectedDate = localDateKey(new Date());
let calendarEvents = [];

async function api(path, options = {}) {
  const response = await fetch(path, { credentials: 'same-origin', ...options, headers: { 'Content-Type': 'application/json', ...(options.headers || {}) } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}
function showAuthError(message) { byId('authError').textContent = message; }
function clearRequiredError(input) {
  input.removeAttribute('aria-invalid');
  input.requiredErrorElement?.remove();
  delete input.requiredErrorElement;
}
function showFieldError(input, text) {
  clearRequiredError(input);
  input.setAttribute('aria-invalid', 'true');
  const message = document.createElement('span');
  message.className = 'required-error';
  message.textContent = text;
  const control = input.closest('.password-control') || input;
  control.insertAdjacentElement('afterend', message);
  input.requiredErrorElement = message;
}
function validateRequiredFields(form) {
  const required = [...form.querySelectorAll(':required')]
    .filter((input) => !input.closest('[hidden]'));
  let firstInvalid = null;

  required.forEach((input) => {
    clearRequiredError(input);
    if (input.value.trim()) return;

    showFieldError(input, 'Please fill out this field.');
    firstInvalid ||= input;
  });

  firstInvalid?.focus();
  return !firstInvalid;
}
document.addEventListener('input', (event) => {
  if (event.target.matches('#authForm :required') && event.target.value.trim()) clearRequiredError(event.target);
});
document.addEventListener('change', (event) => {
  if (event.target.matches('#authForm :required') && event.target.value.trim()) clearRequiredError(event.target);
});
async function setRoleUI(user) {
  currentUser = user;
  window.currentRole = user.role;
  byId('authCover').hidden = true;
  byId('landing').hidden = true;
  byId('app').hidden = false;
  byId('userName').textContent = user.fullName;
  byId('userAvatar').textContent = user.fullName.split(/\s+/).map((part) => part[0]).join('').slice(0, 2).toUpperCase();
  byId('settingsName').textContent = user.fullName;
  byId('settingsUsername').textContent = user.username;
  byId('settingsRole').textContent = ({ tanod: 'Tanod', captain: 'Barangay Captain', admin: 'Admin' })[user.role];
  const [{ default: dashboard }, { applyDashboardLayout }] = await Promise.all([
    import(`/dashboards/${user.role}.js`),
    import('/dashboards/layout.js')
  ]);
  applyDashboardLayout(user, dashboard);
  const canAssignTasks = dashboard.canAssignTasks;
  loadIncidents(); loadAnnouncements(); loadTasks(); loadCalendarEvents(); loadStats(); loadCameras();
  if (sharedCameraRefreshTimer) clearInterval(sharedCameraRefreshTimer);
  if (!dashboard.isAdmin) sharedCameraRefreshTimer = setInterval(refreshSharedCameraUrl, 10000);
  if (dashboard.isAdmin) { loadUsers(); loadRegistrationRequests(); } else if (canAssignTasks) loadTanods();
}
function openAuth(mode = 'login') {
  if (setupMode) mode = 'setup';
  authMode = mode;
  byId('authCover').hidden = false;
  byId('authError').textContent = '';
  byId('authForm').querySelectorAll('[aria-invalid="true"]').forEach(clearRequiredError);
  byId('setupFields').hidden = mode !== 'setup';
  byId('registerFields').hidden = mode !== 'register';
  byId('confirmPasswordField').hidden = mode !== 'register';
  byId('confirmPassword').required = mode === 'register';
  byId('confirmPassword').maxLength = 16;
  byId('confirmPassword').value = '';
  byId('setupConfirmPasswordField').hidden = mode !== 'setup';
  byId('setupConfirmPassword').required = mode === 'setup';
  byId('setupConfirmPassword').maxLength = 16;
  byId('setupConfirmPassword').value = '';
  document.querySelectorAll('[data-toggle-password]').forEach((button) => {
    const input = byId(button.dataset.togglePassword);
    input.type = 'password';
    button.textContent = 'Show';
    button.setAttribute('aria-label', `Show ${button.dataset.togglePassword === 'confirmPassword' ? 'confirm password' : 'password'}`);
  });
  byId('credentialFields').hidden = false;
  byId('authSubmit').hidden = false;
  byId('authSwitch').hidden = mode === 'setup';
  byId('loginPassword').autocomplete = mode === 'login' ? 'current-password' : 'new-password';
  byId('loginPassword').minLength = ['setup', 'register'].includes(mode) ? 8 : -1;
  byId('loginPassword').maxLength = ['setup', 'register'].includes(mode) ? 16 : 128;
  byId('loginUsername').required = true;
  byId('loginPassword').required = true;
  if (mode === 'setup') {
    byId('authHeading').textContent = 'Set up the first admin account';
    byId('authMessage').textContent = 'This one-time setup creates the administrator who can review account requests.';
    byId('usernameLabel').textContent = 'Admin username';
    byId('passwordLabel').textContent = 'Admin password (8–16 characters)';
    byId('authSubmit').textContent = 'Create admin account';
  } else if (mode === 'register') {
    byId('authHeading').textContent = 'Request an account';
    byId('authMessage').textContent = 'An administrator will review your details and approve or decline access.';
    byId('usernameLabel').textContent = 'Choose a username';
    byId('passwordLabel').textContent = 'Choose a password (8–16 characters)';
    byId('authSubmit').textContent = 'Send for admin review';
  } else {
    byId('authHeading').textContent = 'Log in to BarangayPOB-3A';
    byId('authMessage').textContent = 'Sign in with an approved barangay account.';
    byId('usernameLabel').textContent = 'Username';
    byId('passwordLabel').textContent = 'Password';
    byId('authSubmit').textContent = 'Log in';
  }
  byId('authSwitch').innerHTML = mode === 'register'
    ? 'Already have an account? <button type="button" id="switchToLogin">Log in</button>'
    : 'New to BarangayPOB-3A? <button type="button" id="switchToRegister">Request an account</button>';
  byId('switchToLogin')?.addEventListener('click', () => openAuth('login'));
  byId('switchToRegister')?.addEventListener('click', () => openAuth('register'));
}
async function checkAuth() {
  try {
    const status = await api('/api/auth/status');
    setupMode = status.setupRequired;
    if (status.user) return setRoleUI(status.user);
    byId('app').hidden = true;
    byId('landing').hidden = false;
    byId('authCover').hidden = true;
  } catch { byId('app').hidden = true; byId('landing').hidden = false; byId('authCover').hidden = true; }
}
byId('authForm').addEventListener('submit', async (event) => {
  event.preventDefault(); showAuthError('');
  if (!validateRequiredFields(event.currentTarget)) return;
  if (['setup', 'register'].includes(authMode)) {
    const password = byId('loginPassword');
    if (password.value.length < 8 || password.value.length > 16) {
      showFieldError(password, 'Password must be 8 to 16 characters.');
      password.focus();
      return;
    }
  }
  const confirmation = authMode === 'setup' ? byId('setupConfirmPassword') : byId('confirmPassword');
  if (['setup', 'register'].includes(authMode) && byId('loginPassword').value !== confirmation.value) {
    showAuthError('Passwords do not match.');
    confirmation.focus();
    return;
  }
  const payload = authMode === 'setup'
    ? { firstName: byId('setupFirstName').value.trim(), middleName: byId('setupMiddleName').value.trim(), lastName: byId('setupLastName').value.trim(), gender: byId('setupGender').value, dateOfBirth: byId('setupDob').value, username: byId('loginUsername').value.trim(), password: byId('loginPassword').value }
    : authMode === 'register'
      ? { firstName: byId('registerFirstName').value.trim(), middleName: byId('registerMiddleName').value.trim(), lastName: byId('registerLastName').value.trim(), gender: byId('registerGender').value, dateOfBirth: byId('registerDob').value, username: byId('loginUsername').value.trim(), password: byId('loginPassword').value, requestedRole: byId('registerRole').value }
      : { username: byId('loginUsername').value.trim(), password: byId('loginPassword').value };
  try {
    const route = authMode === 'setup' ? '/api/auth/setup' : authMode === 'register' ? '/api/auth/register' : '/api/auth/login';
    const result = await api(route, { method: 'POST', body: JSON.stringify(payload) });
    if (authMode === 'register') {
      byId('authHeading').textContent = 'Request submitted';
      byId('authMessage').textContent = result.message;
      byId('loginUsername').value = '';
      byId('loginPassword').value = '';
      byId('confirmPassword').value = '';
      byId('setupConfirmPassword').value = '';
      byId('registerFirstName').value = '';
      byId('registerLastName').value = '';
      byId('registerFields').hidden = true;
      byId('credentialFields').hidden = true;
      byId('authSubmit').hidden = true;
      byId('authSwitch').hidden = true;
      return;
    }
    await setRoleUI(result.user);
  } catch (error) { showAuthError(error.message); }
});
document.querySelectorAll('[data-toggle-password]').forEach((button) => button.addEventListener('click', () => {
  const input = byId(button.dataset.togglePassword);
  const show = input.type === 'password';
  input.type = show ? 'text' : 'password';
  button.textContent = show ? 'Hide' : 'Show';
  button.setAttribute('aria-label', `${show ? 'Hide' : 'Show'} ${button.dataset.togglePassword === 'confirmPassword' ? 'confirm password' : 'password'}`);
}));
byId('openLoginBtn').addEventListener('click', () => openAuth('login'));
byId('heroLoginBtn').addEventListener('click', () => openAuth('login'));
byId('openRegisterBtn').addEventListener('click', () => openAuth('register'));
byId('heroRegisterBtn').addEventListener('click', () => openAuth('register'));
byId('closeAuthBtn').addEventListener('click', () => { byId('authCover').hidden = true; });
byId('authCover').addEventListener('click', (event) => { if (event.target === byId('authCover')) byId('authCover').hidden = true; });
byId('userAvatar').addEventListener('click', () => {
  const menu = byId('userMenu');
  menu.hidden = !menu.hidden;
  byId('userAvatar').setAttribute('aria-expanded', String(!menu.hidden));
});
document.addEventListener('click', (event) => {
  if (!event.target.closest('.user-menu')) {
    byId('userMenu').hidden = true;
    byId('userAvatar').setAttribute('aria-expanded', 'false');
  }
});
byId('openSettingsBtn').addEventListener('click', () => {
  byId('userMenu').hidden = true;
  byId('userAvatar').setAttribute('aria-expanded', 'false');
  byId('settingsCover').hidden = false;
  byId('closeSettingsBtn').focus();
});
byId('closeSettingsBtn').addEventListener('click', () => { byId('settingsCover').hidden = true; });
byId('settingsCover').addEventListener('click', (event) => { if (event.target === byId('settingsCover')) byId('settingsCover').hidden = true; });
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    byId('userMenu').hidden = true;
    byId('userAvatar').setAttribute('aria-expanded', 'false');
    byId('settingsCover').hidden = true;
  }
});
byId('logoutBtn').addEventListener('click', async () => { await api('/api/auth/logout', { method: 'POST' }).catch(() => {}); location.reload(); });

async function loadStats() {
  try { const stats = await api('/api/stats'); byId('totalCams').textContent = stats.cameras; byId('onlineCams').textContent = stats.online; byId('activeCount').textContent = stats.active; byId('todayCount').textContent = stats.today; }
  catch (error) { showAuthError(error.message); }
}
async function loadCameras() {
  try {
    cameraFeeds = await api('/api/cameras');
    const recordingCameraFilter = byId('recordingCameraFilter');
    if (recordingCameraFilter) recordingCameraFilter.innerHTML = '<option value="">All cameras</option>' + cameraFeeds.map((camera) => `<option value="${Number(camera.id)}">${escapeHtml(camera.name)}</option>`).join('');
    window.loadRecordedFootage?.();
    window.refreshRecorderStatus?.();
    const select = byId('cameraList');
    if (select) select.innerHTML = cameraFeeds.length ? cameraFeeds.map((cam) => `<div class="alert"><div class="alert-text"><strong>${escapeHtml(cam.name)}</strong><p>${escapeHtml(cam.location || 'No location')} · ${escapeHtml(cam.status)}</p></div><button class="btn" data-camera-id="${cam.id}" data-camera-url="${escapeHtml(cam.streamUrl)}">View</button></div>`).join('') : '<div class="empty">No cameras configured.</div>';
    select?.querySelectorAll('[data-camera-id]').forEach((button) => button.addEventListener('click', () => { window.activeCameraId = Number(button.dataset.cameraId); byId('cameraUrl').value = button.dataset.cameraUrl; connectCamera(); }));
    if (cameraFeeds.length && !byId('cameraUrl').value) { window.activeCameraId = Number(cameraFeeds[0].id); byId('cameraUrl').value = cameraFeeds[0].streamUrl; }
    if (currentUser?.role !== 'admin' && cameraFeeds.length && byId('cameraUrl').value) connectCamera();
    if (currentUser?.role === 'admin') for (const cam of cameraFeeds) { const line = document.createElement('div'); line.className = 'alert'; line.innerHTML = `<span>${escapeHtml(cam.name)} · ${escapeHtml(cam.status)}</span><button class="btn" data-archive-camera="${cam.id}">Archive</button>`; select.appendChild(line); }
    select?.querySelectorAll('[data-archive-camera]').forEach((button) => button.addEventListener('click', async () => { await api(`/api/cameras/${button.dataset.archiveCamera}/archive`, { method: 'PATCH' }); loadCameras(); loadStats(); }));
  } catch (error) { showAuthError(error.message); }
}
async function refreshSharedCameraUrl() {
  try {
    const cameras = await api('/api/cameras');
    const camera = cameras.find((item) => Number(item.id) === Number(window.activeCameraId)) || cameras[0];
    if (!camera) return;
    const input = byId('cameraUrl');
    if (input.value !== camera.streamUrl) {
      input.value = camera.streamUrl;
      window.activeCameraId = Number(camera.id);
      window.dispatchEvent(new Event('camera:url-updated'));
    }
  } catch { /* Keep the last saved URL if the API is temporarily unavailable. */ }
}
async function loadAnnouncements() {
  try { const items = await api('/api/announcements'); byId('announcementsList').innerHTML = items.length ? items.map((item) => `<div class="alert"><div class="alert-text"><strong>${escapeHtml(item.title)}</strong><p>${escapeHtml(item.body)}</p><span class="sub">${escapeHtml(item.author || 'Barangay office')} · ${escapeHtml(formatDate(item.publishedAt))}</span></div>${currentUser.role === 'admin' ? `<button class="btn" data-hide-announcement="${item.id}">Hide</button>` : ''}</div>`).join('') : '<div class="empty">No announcements posted.</div>'; byId('announcementsList').querySelectorAll('[data-hide-announcement]').forEach((button) => button.addEventListener('click', async () => { await api(`/api/announcements/${button.dataset.hideAnnouncement}/archive`, { method: 'PATCH' }); loadAnnouncements(); })); }
  catch (error) { byId('announcementsList').innerHTML = `<div class="empty">${escapeHtml(error.message)}</div>`; }
}
function renderCalendarEvents() {
  const year = calendarMonth.getFullYear();
  const month = calendarMonth.getMonth();
  const monthName = calendarMonth.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  byId('calendarMonthTitle').textContent = monthName;
  const firstWeekday = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const todayKey = localDateKey(new Date());
  const startDate = new Date(year, month, 1 - firstWeekday);
  byId('eventsCalendarGrid').innerHTML = Array.from({ length: 42 }, (_, index) => {
    const date = new Date(startDate.getFullYear(), startDate.getMonth(), startDate.getDate() + index);
    const key = localDateKey(date);
    const count = calendarEvents.filter((event) => String(event.startsAt).slice(0, 10) === key).length;
    const classes = ['calendar-day', date.getMonth() !== month ? 'outside-month' : '', key === calendarSelectedDate ? 'selected' : '', key === todayKey ? 'today' : ''].filter(Boolean).join(' ');
    return `<button class="${classes}" type="button" role="gridcell" data-calendar-date="${key}" aria-label="${escapeHtml(date.toLocaleDateString(undefined, { dateStyle: 'full' }))}${count ? `, ${count} event${count === 1 ? '' : 's'}` : ''}"><span>${date.getDate()}</span>${count ? `<i class="calendar-day-marker" aria-label="${count} events"></i>` : ''}</button>`;
  }).join('');
  byId('eventsCalendarGrid').querySelectorAll('[data-calendar-date]').forEach((button) => button.addEventListener('click', () => {
    calendarSelectedDate = button.dataset.calendarDate;
    renderCalendarEvents();
  }));
  const dayStart = new Date(`${calendarSelectedDate}T00:00:00`);
  const nextDay = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);
  const dayEvents = calendarEvents.filter((event) => new Date(String(event.startsAt).replace(' ', 'T')) < nextDay && new Date(String(event.endsAt).replace(' ', 'T')) >= dayStart);
  byId('calendarSelectedDate').textContent = dayStart.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  byId('calendarDayEvents').innerHTML = dayEvents.length ? dayEvents.map((event) => `<article class="calendar-event-card"><div class="calendar-event-card-top"><strong>${escapeHtml(event.title)}</strong>${currentUser?.role === 'admin' && event.createdByRole === 'captain' ? `<button type="button" class="btn" data-edit-calendar-event="${Number(event.id)}">Edit</button>` : ''}</div><p>${escapeHtml(event.details || 'No additional details.')}</p><span class="sub">${escapeHtml(new Date(String(event.startsAt).replace(' ', 'T')).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }))} – ${escapeHtml(new Date(String(event.endsAt).replace(' ', 'T')).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }))}${event.location ? ` · ${escapeHtml(event.location)}` : ''}</span><span class="sub calendar-event-author">Added by Capt. ${escapeHtml(event.creatorName || 'Barangay Captain')}</span></article>`).join('') : '<div class="empty">No events scheduled for this day.</div>';
  byId('calendarDayEvents').querySelectorAll('[data-edit-calendar-event]').forEach((button) => button.addEventListener('click', () => openCalendarEventForm(calendarEvents.find((event) => Number(event.id) === Number(button.dataset.editCalendarEvent)))));
}
async function loadCalendarEvents() {
  const month = `${calendarMonth.getFullYear()}-${String(calendarMonth.getMonth() + 1).padStart(2, '0')}`;
  try {
    calendarEvents = await api(`/api/events?month=${month}`);
    renderCalendarEvents();
  } catch (error) {
    byId('calendarDayEvents').innerHTML = `<div class="empty">${escapeHtml(error.message)}</div>`;
    byId('eventsCalendarGrid').innerHTML = '';
  }
}
function openCalendarEventForm(event = null) {
  const form = byId('calendarEventForm');
  form.reset();
  form.dataset.eventId = event ? String(event.id) : '';
  byId('calendarFormTitle').textContent = event ? 'Edit captain event' : 'Create event';
  byId('calendarEventName').value = event?.title || '';
  byId('calendarEventStart').value = event ? String(event.startsAt).replace(' ', 'T').slice(0, 16) : `${calendarSelectedDate}T09:00`;
  byId('calendarEventEnd').value = event ? String(event.endsAt).replace(' ', 'T').slice(0, 16) : `${calendarSelectedDate}T10:00`;
  byId('calendarEventLocation').value = event?.location || '';
  byId('calendarEventDescription').value = event?.details || '';
  byId('calendarEventFormStatus').textContent = '';
  form.hidden = false;
  byId('calendarEventName').focus();
}
byId('createCalendarEventBtn').addEventListener('click', () => openCalendarEventForm());
byId('cancelCalendarEventBtn').addEventListener('click', () => { byId('calendarEventForm').hidden = true; });
byId('previousCalendarMonthBtn').addEventListener('click', () => { calendarMonth = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() - 1, 1); calendarSelectedDate = localDateKey(calendarMonth); loadCalendarEvents(); });
byId('nextCalendarMonthBtn').addEventListener('click', () => { calendarMonth = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() + 1, 1); calendarSelectedDate = localDateKey(calendarMonth); loadCalendarEvents(); });
byId('calendarEventForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const eventId = form.dataset.eventId;
  const payload = { title: byId('calendarEventName').value.trim(), startsAt: byId('calendarEventStart').value, endsAt: byId('calendarEventEnd').value, location: byId('calendarEventLocation').value.trim(), details: byId('calendarEventDescription').value.trim() };
  try {
    await api(eventId ? `/api/events/${eventId}` : '/api/events', { method: eventId ? 'PATCH' : 'POST', body: JSON.stringify(payload) });
    calendarSelectedDate = payload.startsAt.slice(0, 10);
    const [year, month] = calendarSelectedDate.split('-').map(Number);
    calendarMonth = new Date(year, month - 1, 1);
    form.hidden = true;
    await loadCalendarEvents();
  } catch (error) { byId('calendarEventFormStatus').textContent = error.message; }
});
async function loadTasks() {
  try {
    const tasks = await api('/api/tasks');
    byId('tasksList').innerHTML = tasks.length ? tasks.map((task) => {
      const start = task.dutyStartsAt ? new Date(String(task.dutyStartsAt).replace(' ', 'T')) : null;
      const end = task.dutyEndsAt ? new Date(String(task.dutyEndsAt).replace(' ', 'T')) : null;
      const dutyTime = start && end ? `${start.toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })} – ${end.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}` : 'Duty hours not set';
      return `<div class="alert"><div class="alert-text"><strong>${escapeHtml(task.title)}</strong><p>${escapeHtml(task.details || '')}${task.assignee ? ` · Assigned to ${escapeHtml(task.assignee)}` : ''}</p><span class="sub task-duty-time">Duty: ${escapeHtml(dutyTime)}</span><span class="tag ${task.status === 'Completed' ? 'green' : 'amber'}">${escapeHtml(task.status)}</span></div>${currentUser?.role === 'tanod' && task.status !== 'Completed' ? `<button class="btn" data-complete-task="${task.id}">Complete</button>` : ''}</div>`;
    }).join('') : '<div class="empty">No tasks assigned.</div>';
    byId('tasksList').querySelectorAll('[data-complete-task]').forEach((button) => button.addEventListener('click', async () => { await api(`/api/tasks/${button.dataset.completeTask}`, { method: 'PATCH', body: JSON.stringify({ status: 'Completed' }) }); loadTasks(); }));
  } catch (error) { byId('tasksList').innerHTML = `<div class="empty">${escapeHtml(error.message)}</div>`; }
}
async function loadUsers() {
  try {
    const users = await api('/api/users');
    byId('userRows').innerHTML = users.map((user) => `<tr><td>${escapeHtml(user.fullName)}</td><td>${escapeHtml(user.username)}</td><td><select data-role-user="${user.id}" class="form-control"><option value="tanod" ${user.role === 'tanod' ? 'selected' : ''}>Tanod</option><option value="captain" ${user.role === 'captain' ? 'selected' : ''}>Captain</option><option value="admin" ${user.role === 'admin' ? 'selected' : ''}>Admin</option></select></td></tr>`).join('');
    byId('taskAssignee').innerHTML = users.filter((u) => u.role === 'tanod').map((u) => `<option value="${u.id}">${escapeHtml(u.fullName)}</option>`).join('');
    byId('userRows').querySelectorAll('[data-role-user]').forEach((select) => select.addEventListener('change', async () => { await api(`/api/users/${select.dataset.roleUser}/role`, { method: 'PATCH', body: JSON.stringify({ role: select.value }) }); }));
  } catch (error) { showAuthError(error.message); }
}
async function loadRegistrationRequests() {
  try {
    const requests = await api('/api/users/requests');
    byId('pendingUserRows').innerHTML = requests.length ? requests.map((request) => `<tr><td>${escapeHtml(request.fullName)}</td><td>${escapeHtml(request.username)}</td><td>${request.requestedRole === 'captain' ? 'Barangay Captain' : 'Tanod'}</td><td>${escapeHtml(formatDate(request.requestedAt))}</td><td><div class="approval-actions"><button class="btn primary" data-request-decision="approved" data-user-id="${request.id}">Approve</button><button class="btn" data-request-decision="declined" data-user-id="${request.id}">Decline</button></div></td></tr>`).join('') : '<tr><td colspan="5" class="empty">No account requests waiting for review.</td></tr>';
    byId('pendingUserRows').querySelectorAll('[data-request-decision]').forEach((button) => button.addEventListener('click', async () => {
      const action = button.dataset.requestDecision;
      const requestId = button.dataset.userId;
      try {
        await api(`/api/users/${requestId}/decision`, { method: 'POST', body: JSON.stringify({ decision: action }) });
        await loadRegistrationRequests();
        await loadUsers();
        await loadTanods();
      } catch (error) { alert(error.message); }
    }));
  } catch (error) { showAuthError(error.message); }
}
async function loadTanods() {
  try { const users = await api('/api/tanods'); byId('taskAssignee').innerHTML = users.map((u) => `<option value="${u.id}">${escapeHtml(u.fullName)}</option>`).join(''); }
  catch (error) { showAuthError(error.message); }
}
byId('addCameraBtn').addEventListener('click', async () => { try { await api('/api/cameras', { method: 'POST', body: JSON.stringify({ name: byId('newCameraName').value.trim(), streamUrl: byId('newCameraUrl').value.trim(), location: byId('newCameraLocation').value.trim() }) }); byId('newCameraName').value = ''; byId('newCameraUrl').value = ''; byId('newCameraLocation').value = ''; loadCameras(); loadStats(); } catch (error) { alert(error.message); } });
byId('publishAnnouncementBtn').addEventListener('click', async () => { try { await api('/api/announcements', { method: 'POST', body: JSON.stringify({ title: byId('announcementTitle').value.trim(), body: byId('announcementBody').value.trim() }) }); byId('announcementTitle').value = ''; byId('announcementBody').value = ''; loadAnnouncements(); } catch (error) { alert(error.message); } });
byId('taskForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const status = byId('taskFormStatus');
  status.textContent = '';
  try {
    await api('/api/tasks', { method: 'POST', body: JSON.stringify({ title: byId('taskTitle').value.trim(), details: byId('taskDetails').value.trim(), assignedTo: byId('taskAssignee').value, dutyStartsAt: byId('taskDutyStart').value, dutyEndsAt: byId('taskDutyEnd').value }) });
    byId('taskForm').reset();
    await loadTasks();
  } catch (error) { status.textContent = error.message; }
});
checkAuth();
window.addEventListener('camera:status', loadStats);
