export function applyDashboardLayout(user, dashboard) {
  const byId = (id) => document.getElementById(id);
  byId('roleLabel').textContent = dashboard.roleName;
  byId('navSectionLabel').textContent = dashboard.navHeading;
  byId('dashboardTitle').textContent = `${dashboard.roleName} Dashboard`;
  byId('dashboardSubtitle').textContent = dashboard.description;
  byId('app').dataset.role = user.role;
  byId('reportBtn').hidden = !dashboard.canReport;
  byId('eventType').disabled = !dashboard.canReport;
  byId('eventNote').disabled = !dashboard.canReport;
  byId('quickIncidentPanel').hidden = !dashboard.canReport;
  byId('testAlertBtn').hidden = !dashboard.isAdmin;
  byId('cameraUrl').disabled = !dashboard.isAdmin;
  byId('saveUrlBtn').hidden = !dashboard.isAdmin;
  byId('cameraUrlSettings').hidden = !dashboard.isAdmin;
  byId('cameraControls').hidden = !dashboard.isAdmin;
  byId('cameraAdminPanel').hidden = !dashboard.isAdmin;
  byId('userAdminPanel').hidden = !dashboard.isAdmin;
  byId('announcementForm').hidden = !dashboard.canPublish;
  byId('taskForm').hidden = !dashboard.canAssignTasks;
  byId('createCalendarEventBtn').hidden = user.role !== 'captain';
  const nav = byId('mainNav');
  nav.innerHTML = dashboard.navigation
    .map(([icon, label, href], index) => `<a class="${index === 0 ? 'active' : ''}" href="${href}"><span class="ico">${icon}</span>${label}</a>`)
    .join('');
  const renderRoute = () => {
    const defaultRoute = dashboard.navigation[0][2];
    let route = window.location.hash || defaultRoute;
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
      panel.classList.toggle('route-selected', singlePanel && panel.id === route.slice(1));
      panel.classList.toggle('route-inactive', singlePanel && panel.id !== route.slice(1));
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
