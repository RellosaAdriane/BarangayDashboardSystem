export function applyDashboardLayout(user, dashboard) {
  const byId = (id) => document.getElementById(id);
  byId('roleLabel').textContent = dashboard.roleName;
  byId('navSectionLabel').textContent = dashboard.navHeading;
  byId('dashboardTitle').textContent = `${dashboard.roleName} Dashboard`;
  byId('dashboardSubtitle').textContent = dashboard.description;
  byId('app').dataset.role = user.role;
  byId('quickIncidentPanel').hidden = !dashboard.canReport;
  byId('cameraUrl').disabled = !dashboard.isAdmin;
  byId('saveUrlBtn').hidden = !dashboard.isAdmin;
  byId('cameraUrlSettings').hidden = !dashboard.isAdmin;
  byId('cameraControls').hidden = false;
  byId('cameraAdminPanel').hidden = !dashboard.isAdmin;
  byId('faceManagementPanel').hidden = !dashboard.isAdmin;
  byId('adminFaceTools').hidden = true;
  byId('userAdminPanel').hidden = !dashboard.isAdmin;
  const reportsOnly = user.role === 'tanod';
  const hideArchive = user.role !== 'admin';
  byId('openRecordingArchiveBtn').hidden = hideArchive;
  if (hideArchive) byId('recordingArchiveWrap').hidden = true;
  const archiveOption = byId('alertView').querySelector('option[value="archived"]');
  archiveOption.hidden = hideArchive;
  archiveOption.disabled = hideArchive;
  const pendingOption = byId('alertView').querySelector('option[value="pending"]');
  pendingOption.hidden = reportsOnly;
  pendingOption.disabled = reportsOnly;
  byId('alertView').disabled = reportsOnly;
  if (reportsOnly) byId('alertView').value = 'reports';
  else if (hideArchive && byId('alertView').value === 'archived') byId('alertView').value = 'pending';
  byId('alertViewHint').textContent = reportsOnly
    ? 'Reported snapshots awaiting action. Open Preview to record the action taken. Actioned reports archive automatically.'
    : 'Review unmatched snapshots as Recognized or Report. Reports remain active until actioned, then move to Archive automatically.';
  byId('announcementForm').hidden = !dashboard.canPublish;
  byId('taskForm').hidden = !dashboard.canAssignTasks;
  byId('createCalendarEventBtn').hidden = user.role !== 'captain';
  const nav = byId('mainNav');
  nav.innerHTML = dashboard.navigation
    .map(([icon, label, href], index) => `<a class="${index === 0 ? 'active' : ''}" href="${href}"><span class="ico">${icon}</span>${label}</a>`)
    .join('');
  let useDashboardDefault = Boolean(dashboard.defaultRoute);
  const renderRoute = () => {
    const defaultRoute = dashboard.defaultRoute || dashboard.navigation[0][2];
    let route = useDashboardDefault ? defaultRoute : window.location.hash || defaultRoute;
    useDashboardDefault = false;
    const allowedRoute = dashboard.navigation.some(([, , href]) => href === route);
    const routePanel = byId(route.slice(1));
    if (!window.location.hash || !allowedRoute || !routePanel || routePanel.hidden) {
      route = defaultRoute;
      history.replaceState(null, '', `${location.pathname}${location.search}${defaultRoute}`);
    }
    const content = byId('overview');
    const singlePanel = true;
    content.classList.toggle('single-route', singlePanel);
    content.querySelectorAll('.panel').forEach((panel) => {
      const selected = panel.id === route.slice(1);
      panel.classList.toggle('route-selected', singlePanel && selected);
      panel.classList.toggle('route-inactive', singlePanel && !selected);
    });
    nav.querySelectorAll('a').forEach((link) => {
      const active = link.getAttribute('href') === route;
      link.classList.toggle('active', active);
      if (active) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    });
  };
  nav.querySelectorAll('a').forEach((link) => link.addEventListener('click', (event) => {
    event.preventDefault();
    if (window.location.hash === link.getAttribute('href')) renderRoute();
    else window.location.hash = link.getAttribute('href');
  }));
  window.onhashchange = renderRoute;
  renderRoute();
}
