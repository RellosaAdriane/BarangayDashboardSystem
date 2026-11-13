const byId = (id) => document.getElementById(id);
let currentUser = null;
let setupMode = false;
let authMode = 'login';
let cameraFeeds = [];
const localDateKey = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
let calendarMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
let calendarSelectedDate = localDateKey(new Date());
let calendarEvents = [];
let lastPendingProofCount = null;

async function api(path, options = {}) {
  const response = await fetch(path, { credentials: 'same-origin', ...options, headers: options.body instanceof FormData ? { ...(options.headers || {}) } : { 'Content-Type': 'application/json', ...(options.headers || {}) } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}
function showAuthError(message) { byId('authError').textContent = message; }
const firstUseTranslations = {
  fil: {
    close: 'Isara ang gabay', help: 'Buksan ulit ang tutorial', welcome: 'WELCOME SA BARANGAYPOB-3A',
    title: 'Mabilis na gabay sa camera at alerts', intro: 'Buksan ang <strong>Live camera feed</strong> at <strong>Alerts</strong> mula sa menu.',
    step1: '<strong>Manood ng live:</strong> Buksan ang Live camera feed at pindutin ang <strong>Connect Camera</strong>. Pindutin ang Full para palakihin ang view.',
    step2: '<strong>Palakihin ang view:</strong> Pindutin ang Full sa live camera feed.',
    step3: '<strong>Tingnan ang alerts:</strong> Buksan ang Alerts para makita ang camera status at mga snapshot.', done: 'Sige, simulan na'
  },
  en: {
    close: 'Close guide', help: 'Open the tutorial again', welcome: 'WELCOME TO BARANGAYPOB-3A',
    title: 'Quick guide to cameras and alerts', intro: 'Open <strong>Live camera feed</strong> and <strong>Alerts</strong> from the menu.',
    step1: '<strong>Watch live:</strong> Open Live camera feed and press <strong>Connect Camera</strong>. Press Full to enlarge the view.',
    step2: '<strong>Enlarge the view:</strong> Press Full on the live camera feed.',
    step3: '<strong>Check alerts:</strong> Open Alerts to see camera status updates and snapshots.', done: 'Got it, let’s start'
  },
  ceb: {
    close: 'Sirad-i ang giya', help: 'Ablihi pag-usab ang tutorial', welcome: 'WELCOME SA BARANGAYPOB-3A',
    title: 'Mubo nga giya sa camera ug alerts', intro: 'Ablihi ang <strong>Live camera feed</strong> ug <strong>Alerts</strong> gikan sa menu.',
    step1: '<strong>Motan-aw og live:</strong> Ablihi ang Live camera feed ug pindota ang <strong>Connect Camera</strong>. Pindota ang Full aron palapdon ang hulagway.',
    step2: '<strong>Padak-a ang hulagway:</strong> Pindota ang Full sa live camera feed.',
    step3: '<strong>Tan-awa ang alerts:</strong> Ablihi ang Alerts aron makita ang camera status ug mga snapshot.', done: 'Sige, sugdan na'
  }
};
function applyFirstUseLanguage(language) {
  const copy = firstUseTranslations[language] || firstUseTranslations.fil;
  byId('closeFirstUseGuide').setAttribute('aria-label', copy.close);
  byId('openFirstUseGuide').setAttribute('aria-label', copy.help);
  byId('openFirstUseGuide').title = copy.help;
  byId('firstUseKicker').textContent = copy.welcome;
  byId('firstUseTitle').textContent = copy.title;
  byId('firstUseDescription').innerHTML = copy.intro;
  byId('firstUseStep1').innerHTML = copy.step1;
  byId('firstUseStep2').innerHTML = copy.step2;
  byId('firstUseStep3').innerHTML = copy.step3;
  byId('dismissFirstUseGuide').textContent = copy.done;
}
function showFirstUseGuide(user, reopen = false) {
  const key = `barangay-dashboard:first-use-guide:${user.id}`;
  try { if (!reopen && localStorage.getItem(key)) return; } catch { /* Show the guide if browser storage is unavailable. */ }
  let language = 'fil';
  try { language = localStorage.getItem(`barangay-dashboard:tutorial-language:${user.id}`) || 'fil'; } catch { /* Filipino is the default when browser storage is unavailable. */ }
  byId('firstUseLanguage').value = firstUseTranslations[language] ? language : 'fil';
  applyFirstUseLanguage(byId('firstUseLanguage').value);
  const close = () => {
    byId('firstUseGuide').hidden = true;
    try { localStorage.setItem(key, 'seen'); } catch { /* The guide may reappear if browser storage is unavailable. */ }
  };
  byId('closeFirstUseGuide').onclick = close;
  byId('dismissFirstUseGuide').onclick = close;
  byId('firstUseGuide').hidden = false;
  byId('dismissFirstUseGuide').focus();
}
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
function isAtLeast18(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return false;
  const [year, month, day] = value.split('-').map(Number);
  const birthDate = new Date(year, month - 1, day);
  if (birthDate.getFullYear() !== year || birthDate.getMonth() !== month - 1 || birthDate.getDate() !== day) return false;
  const today = new Date();
  let age = today.getFullYear() - year;
  if (today.getMonth() < month - 1 || (today.getMonth() === month - 1 && today.getDate() < day)) age -= 1;
  return age >= 18;
}
function setBirthDateLimit() {
  const today = new Date();
  const latestAdultBirthDate = new Date(today.getFullYear() - 18, today.getMonth(), today.getDate());
  const maxDate = localDateKey(latestAdultBirthDate);
  byId('registerDob').max = maxDate;
  byId('setupDob').max = maxDate;
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
  byId('enableTaskNotificationsBtn').hidden = !['captain', 'admin'].includes(user.role) || !('Notification' in window) || Notification.permission === 'granted';
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
    import(`/dashboards/${user.role}.js?v=20261112-face-management`),
    import('/dashboards/layout.js?v=20261112-tanod-reports-only')
  ]);
  applyDashboardLayout(user, dashboard);
  window.ReportNotifications.start();
  window.FaceManagement.invalidate();
  if (dashboard.isAdmin) void window.FaceManagement.loadPeople();
  showFirstUseGuide(user);
  const canAssignTasks = dashboard.canAssignTasks;
    loadAlerts(); loadAnnouncements(); loadTasks(); loadCalendarEvents(); loadStats(); loadCameras();
    if (window.taskRefreshTimer) clearInterval(window.taskRefreshTimer);
    window.taskRefreshTimer = setInterval(loadTasks, 30000);
    if (window.cameraRefreshTimer) clearInterval(window.cameraRefreshTimer);
    window.cameraRefreshTimer = setInterval(() => loadCameras(true), 20000);
  if (dashboard.isAdmin) { loadUsers(); loadRegistrationRequests(); } else if (canAssignTasks) loadTanods();
}
function openAuth(mode = 'login') {
  if (setupMode) mode = 'setup';
  authMode = mode;
  setBirthDateLimit();
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
  byId('authSwitch').hidden = mode !== 'register';
  byId('loginPassword').autocomplete = mode === 'login' ? 'current-password' : 'new-password';
  byId('loginPassword').minLength = ['setup', 'register'].includes(mode) ? 8 : 0;
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
    ? 'Already have an account? <a id="switchToLogin" href="/?auth=login">Log in</a>'
    : 'New to BarangayPOB-3A? <a id="switchToRegister" href="/?auth=register">Request an account</a>';
}
async function checkAuth() {
  try {
    const status = await api('/api/auth/status');
    setupMode = status.setupRequired;
    if (status.user) return setRoleUI(status.user);
    byId('app').hidden = true;
    byId('landing').hidden = false;
    byId('authCover').hidden = true;
    const authRequest = new URLSearchParams(window.location.search).get('auth');
    if (authRequest === 'login' || authRequest === 'register') openAuth(authRequest);
  } catch { byId('app').hidden = true; byId('landing').hidden = false; byId('authCover').hidden = true; }
}
byId('authForm').addEventListener('submit', async (event) => {
  event.preventDefault(); showAuthError('');
  if (!validateRequiredFields(event.currentTarget)) return;
  if (['setup', 'register'].includes(authMode)) {
    const birthDate = byId(authMode === 'register' ? 'registerDob' : 'setupDob');
    if (!isAtLeast18(birthDate.value)) {
      showFieldError(birthDate, 'You must be at least 18 years old to create an account.');
      birthDate.focus();
      return;
    }
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
    const submittedMode = authMode;
    const route = submittedMode === 'setup' ? '/api/auth/setup' : submittedMode === 'register' ? '/api/auth/register' : '/api/auth/login';
    const result = await api(route, { method: 'POST', body: JSON.stringify(payload) });
    if (submittedMode === 'register') {
      byId('authForm').reset();
      openAuth('login');
      const loginUrl = new URL(window.location.href);
      loginUrl.searchParams.set('auth', 'login');
      history.replaceState(null, '', loginUrl);
      byId('authMessage').textContent = result.message;
      byId('loginUsername').focus();
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
  byId('settingsPasswordForm').reset();
  byId('settingsPasswordStatus').textContent = '';
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
byId('logoutBtn').addEventListener('click', async () => { await api('/api/auth/logout', { method: 'POST' }).catch(() => {}); location.assign('/?auth=login'); });
byId('settingsPasswordForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('button[type="submit"]');
  const status = byId('settingsPasswordStatus');
  status.textContent = '';
  button.disabled = true;
  try {
    const result = await api('/api/auth/password', {
      method: 'PATCH',
      body: JSON.stringify({
        currentPassword: byId('currentAccountPassword').value,
        newPassword: byId('newAccountPassword').value,
        confirmPassword: byId('confirmAccountPassword').value
      })
    });
    form.reset();
    status.textContent = result.message;
  } catch (error) {
    status.textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

async function loadStats() {
  try { const stats = await api('/api/stats'); byId('totalCams').textContent = stats.cameras; byId('onlineCams').textContent = stats.online; byId('activeCount').textContent = stats.active; byId('todayCount').textContent = stats.today; }
  catch (error) { showAuthError(error.message); }
}
window.refreshAlertStats = loadStats;
async function loadCameras(statusCheckOnly = false) {
  try {
    cameraFeeds = await api('/api/cameras');
    window.dispatchEvent(new CustomEvent('cameras:updated', { detail: cameraFeeds }));
    if (statusCheckOnly) return;
    const selectedCamera = cameraFeeds.find((camera) => Number(camera.id) === Number(window.activeCameraId)) || cameraFeeds[0];
    if (selectedCamera) {
      window.activeCameraId = Number(selectedCamera.id);
      if (!byId('cameraUrl').value) byId('cameraUrl').value = selectedCamera.streamUrl;
    } else {
      window.activeCameraId = null;
    }
    const select = byId('cameraList');
    if (select) select.innerHTML = cameraFeeds.length ? cameraFeeds.map((cam) => `<div class="alert"><div class="alert-text"><strong>${escapeHtml(cam.name)}</strong><p>${escapeHtml(cam.location || 'No location')} · ${escapeHtml(cam.status)}</p></div><button class="btn" data-camera-id="${cam.id}" data-camera-url="${escapeHtml(cam.streamUrl)}">View</button></div>`).join('') : '<div class="empty">No cameras configured.</div>';
    select?.querySelectorAll('[data-camera-id]').forEach((button) => button.addEventListener('click', () => window.CameraGrid.focus(button.dataset.cameraId)));
    if (currentUser?.role === 'admin') for (const cam of cameraFeeds) { const line = document.createElement('div'); line.className = 'alert'; line.innerHTML = `<span>${escapeHtml(cam.name)} · ${escapeHtml(cam.status)}</span><button class="btn" data-archive-camera="${cam.id}">Archive</button>`; select.appendChild(line); }
    select?.querySelectorAll('[data-archive-camera]').forEach((button) => button.addEventListener('click', async () => { await api(`/api/cameras/${button.dataset.archiveCamera}/archive`, { method: 'PATCH' }); loadCameras(); loadStats(); }));
  } catch (error) { showAuthError(error.message); }
}
window.addEventListener('camera:saved', () => loadCameras());
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
  byId('calendarDayEvents').innerHTML = dayEvents.length ? dayEvents.map((event) => `<article class="calendar-event-card"><div class="calendar-event-card-top"><strong>${escapeHtml(event.title)}</strong>${(currentUser?.role === 'admin' || (currentUser?.role === 'captain' && String(event.createdBy) === String(currentUser.id))) && event.createdByRole === 'captain' ? `<button type="button" class="btn" data-edit-calendar-event="${Number(event.id)}">Edit</button>` : ''}</div><p>${escapeHtml(event.details || 'No additional details.')}</p><span class="sub">${escapeHtml(new Date(String(event.startsAt).replace(' ', 'T')).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }))} – ${escapeHtml(new Date(String(event.endsAt).replace(' ', 'T')).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }))}${event.location ? ` · ${escapeHtml(event.location)}` : ''}</span><span class="sub calendar-event-author">Added by Capt. ${escapeHtml(event.creatorName || 'Barangay Captain')}</span></article>`).join('') : '<div class="empty">No events scheduled for this day.</div>';
  byId('calendarDayEvents').querySelectorAll('[data-edit-calendar-event]').forEach((button) => button.addEventListener('click', () => openCalendarEventForm(calendarEvents.find((event) => Number(event.id) === Number(button.dataset.editCalendarEvent)))));
}
async function loadCalendarEvents() {
  const month = `${calendarMonth.getFullYear()}-${String(calendarMonth.getMonth() + 1).padStart(2, '0')}`;
  try {
    calendarEvents = await api(`/api/events?month=${month}`);
    renderCalendarEvents();
  } catch (error) {
    calendarEvents = [];
    renderCalendarEvents();
    byId('calendarDayEvents').innerHTML = `<div class="empty" role="alert">Calendar is available, but events could not be loaded: ${escapeHtml(error.message)}</div>`;
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
    const pendingProofs = tasks.filter((task) => task.proofStatus === 'Pending').length;
    if (currentUser?.role !== 'tanod') {
      byId('taskReviewCount').textContent = pendingProofs ? `${pendingProofs} proof${pendingProofs === 1 ? '' : 's'} waiting for review` : 'Assigned duties and proof reviews';
      if (lastPendingProofCount !== null && pendingProofs > lastPendingProofCount && 'Notification' in window && Notification.permission === 'granted') new Notification('Task proof submitted', { body: `${pendingProofs} task proof${pendingProofs === 1 ? '' : 's'} waiting for your review.` });
      lastPendingProofCount = pendingProofs;
    }
    byId('tasksList').innerHTML = tasks.length ? tasks.map((task) => {
      const start = task.dutyStartsAt ? new Date(String(task.dutyStartsAt).replace(' ', 'T')) : null;
      const end = task.dutyEndsAt ? new Date(String(task.dutyEndsAt).replace(' ', 'T')) : null;
      const dutyTime = start && end ? `${start.toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })} – ${end.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}` : 'Duty hours not set';
      const submitted = task.proofSubmittedAt ? new Date(String(task.proofSubmittedAt).replace(' ', 'T')).toLocaleString() : '';
      const review = currentUser?.role !== 'tanod' && task.proofStatus === 'Pending' ? `<details class="task-proof"><summary><strong>Review submitted proof</strong> · ${escapeHtml(submitted)}</summary><p>${escapeHtml(task.proofDescription || '')}</p><a href="/api/tasks/${Number(task.id)}/proof" target="_blank" rel="noopener"><img class="task-proof-image" src="/api/tasks/${Number(task.id)}/proof" alt="Completion proof for ${escapeHtml(task.title)}"></a><div class="approval-actions"><button class="btn primary" data-review-task="approved" data-task-id="${Number(task.id)}">Approve</button><button class="btn" data-review-task="rejected" data-task-id="${Number(task.id)}">Reject</button></div></details>` : task.proofImage ? `<details class="task-proof"><summary>${task.proofStatus === 'Approved' ? 'Proof approved' : task.proofStatus === 'Rejected' ? 'Proof rejected — please submit a new proof.' : 'Proof submitted'}${submitted ? ` · ${escapeHtml(submitted)}` : ''}</summary><p>${escapeHtml(task.proofDescription || '')}</p><a href="/api/tasks/${Number(task.id)}/proof" target="_blank" rel="noopener"><img class="task-proof-image" src="/api/tasks/${Number(task.id)}/proof" alt="Task proof"></a></details>` : '';
      const proofForm = currentUser?.role === 'tanod' && task.status !== 'Completed' && task.status !== 'Cancelled' && task.proofStatus !== 'Pending' ? `<form class="task-proof-form" data-proof-task="${Number(task.id)}"><label class="sub">Completion description<textarea class="form-control" name="description" maxlength="2000" required></textarea></label><label class="sub">Completion picture<input class="form-control" type="file" name="picture" accept="image/jpeg,image/png,image/webp" required></label><button class="btn primary" type="submit">${task.proofStatus === 'Rejected' ? 'Resubmit proof' : 'Submit proof for review'}</button><span role="status"></span></form>` : '';
      const displayStatus = task.proofStatus === 'Pending' ? 'Awaiting approval' : task.status;
      return `<div class="alert task-card"><div class="alert-text"><strong>${escapeHtml(task.title)}</strong><p>${escapeHtml(task.details || '')}${task.assignee ? ` · Assigned to ${escapeHtml(task.assignee)}` : ''}</p><span class="sub task-duty-time">Duty: ${escapeHtml(dutyTime)}</span><span class="tag ${task.status === 'Completed' ? 'green' : task.proofStatus === 'Pending' ? 'amber' : ''}">${escapeHtml(displayStatus)}</span>${review}${proofForm}</div></div>`;
    }).join('') : '<div class="empty">No tasks assigned.</div>';
    byId('tasksList').querySelectorAll('[data-proof-task]').forEach((form) => form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const button = form.querySelector('button[type="submit"]');
      const status = form.querySelector('[role="status"]');
      button.disabled = true;
      try { const data = new FormData(form); await api(`/api/tasks/${form.dataset.proofTask}/proof`, { method: 'POST', body: data }); await loadTasks(); }
      catch (error) { status.textContent = error.message; button.disabled = false; }
    }));
    byId('tasksList').querySelectorAll('[data-review-task]').forEach((button) => button.addEventListener('click', async () => {
      button.disabled = true;
      try { await api(`/api/tasks/${button.dataset.taskId}/review`, { method: 'POST', body: JSON.stringify({ decision: button.dataset.reviewTask }) }); await loadTasks(); }
      catch (error) { alert(error.message); button.disabled = false; }
    }));
  } catch (error) { byId('tasksList').innerHTML = `<div class="empty">${escapeHtml(error.message)}</div>`; }
}
byId('enableTaskNotificationsBtn').addEventListener('click', async () => {
  if (!('Notification' in window)) return;
  const permission = await Notification.requestPermission();
  byId('enableTaskNotificationsBtn').hidden = permission === 'granted';
  if (permission === 'granted') byId('taskReviewCount').textContent = 'Task proof notifications enabled';
});
async function loadUsers() {
  try {
    const users = await api('/api/users');
    byId('userRows').innerHTML = users.length ? users.map((user) => `<tr><td>${escapeHtml(user.fullName)}</td><td>${escapeHtml(user.username)}</td><td><select data-role-user="${user.id}" class="form-control"><option value="tanod" ${user.role === 'tanod' ? 'selected' : ''}>Tanod</option><option value="captain" ${user.role === 'captain' ? 'selected' : ''}>Captain</option></select></td><td><button class="btn" type="button" data-reset-password-user="${user.id}">Reset Password</button></td></tr>`).join('') : '<tr><td colspan="4" class="empty">No approved Tanod or Captain accounts.</td></tr>';
    byId('taskAssignee').innerHTML = users.filter((u) => u.role === 'tanod').map((u) => `<option value="${u.id}">${escapeHtml(u.fullName)}</option>`).join('');
    byId('userRows').querySelectorAll('[data-role-user]').forEach((select) => select.addEventListener('change', async () => { await api(`/api/users/${select.dataset.roleUser}/role`, { method: 'PATCH', body: JSON.stringify({ role: select.value }) }); }));
    byId('userRows').querySelectorAll('[data-reset-password-user]').forEach((button) => button.addEventListener('click', () => {
      const user = users.find((item) => String(item.id) === button.dataset.resetPasswordUser);
      if (user) window.AccountPasswords.open(user);
    }));
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
byId('refreshAccountRequestsBtn')?.addEventListener('click', async () => {
  const button = byId('refreshAccountRequestsBtn');
  button.disabled = true;
  try { await Promise.all([loadRegistrationRequests(), loadUsers()]); }
  finally { button.disabled = false; }
});
async function loadTanods() {
  try { const users = await api('/api/tanods'); byId('taskAssignee').innerHTML = users.map((u) => `<option value="${u.id}">${escapeHtml(u.fullName)}</option>`).join(''); }
  catch (error) { showAuthError(error.message); }
}
byId('addCameraBtn').addEventListener('click', async () => { try { await api('/api/cameras', { method: 'POST', body: JSON.stringify({ name: byId('newCameraName').value.trim(), streamUrl: byId('newCameraUrl').value.trim(), location: byId('newCameraLocation').value.trim() }) }); byId('newCameraName').value = ''; byId('newCameraUrl').value = ''; byId('newCameraLocation').value = ''; await loadCameras(); loadStats(); } catch (error) { alert(error.message); } });
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
byId('openFirstUseGuide').addEventListener('click', () => { if (currentUser) showFirstUseGuide(currentUser, true); });
byId('firstUseLanguage').addEventListener('change', (event) => {
  applyFirstUseLanguage(event.target.value);
  if (currentUser) {
    try { localStorage.setItem(`barangay-dashboard:tutorial-language:${currentUser.id}`, event.target.value); } catch { /* Keep the selected language for this popup session. */ }
  }
});
window.addEventListener('camera:status', loadStats);
