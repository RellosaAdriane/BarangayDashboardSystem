(() => {
  const byId = (id) => document.getElementById(id);
  let timer = null;
  let loading = false;
  let generation = 0;
  let reports = { unread: 0, notifications: [] };
  let announcements = { unread: 0, announcements: [] };
  const seen = new Set();
  const eligible = () => ['tanod', 'captain'].includes(window.currentRole);
  const key = (item) => `${item.kind}:${item.kind === 'announcement' ? item.id : item.notificationId}`;

  async function openAnnouncement(item) {
    const response = await fetch('/api/announcements', { cache: 'no-store' });
    if (!response.ok) throw new Error('Could not open announcement.');
    const available = await response.json();
    const current = available.find((row) => String(row.id) === String(item.id));
    if (!current) throw new Error('Announcement is no longer available.');
    byId('notificationAnnouncementTitle').textContent = current.title;
    byId('notificationAnnouncementMeta').textContent = `${current.author || 'Barangay office'} · ${new Date(current.publishedAt).toLocaleString()}`;
    byId('notificationAnnouncementBody').textContent = current.body;
    const dialog = byId('notificationAnnouncementPreview');
    if (!dialog.open) dialog.showModal();
  }
  async function openNotification(item) {
    try {
      if (item.kind === 'announcement') await openAnnouncement(item);
      else await window.openReportedSnapshot(item);
      const endpoint = item.kind === 'announcement' ? `/api/announcement-notifications/${item.id}/read` : `/api/report-notifications/${item.notificationId}/read`;
      const response = await fetch(endpoint, { method: 'PATCH' });
      if (!response.ok) throw new Error('Could not mark notification as read.');
      byId('reportNotificationPanel').hidden = true;
      byId('reportNotificationBtn').setAttribute('aria-expanded', 'false');
      await load();
    } catch (error) { byId('reportNotificationStatus').textContent = error.message; }
  }
  function render(data) {
    byId('reportUnreadCount').textContent = String(data.unread);
    byId('reportUnreadCount').hidden = data.unread === 0;
    byId('reportNotificationBtn').setAttribute('aria-label', `Announcements and reports: ${data.unread} unread notifications`);
    const list = byId('reportNotificationList');
    list.replaceChildren();
    for (const item of data.notifications) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `report-notification-item${item.readAt ? '' : ' unread'}`;
      const title = document.createElement('strong');
      title.textContent = item.kind === 'announcement' ? `Announcement - ${item.title}` : `Reported face snapshot - ${item.cameraName}`;
      const details = document.createElement('span');
      details.textContent = `${item.kind === 'announcement' ? item.author || 'Barangay office' : item.location || 'Location not set'} · ${new Date(item.notifiedAt).toLocaleString()}`;
      const note = document.createElement('span');
      note.textContent = item.kind === 'announcement' ? item.body.slice(0, 160) : item.reviewNote || 'Open snapshot for details and follow-up.';
      button.append(title, details, note);
      if (item.kind !== 'announcement') {
        const action = document.createElement('span');
        action.textContent = item.actionedAt ? 'Actioned' : 'Awaiting action';
        button.appendChild(action);
      }
      button.addEventListener('click', () => openNotification(item));
      list.appendChild(button);
    }
    if (!data.notifications.length) {
      const empty = document.createElement('p');
      empty.className = 'empty';
      empty.textContent = 'No announcements or report notifications yet.';
      list.appendChild(empty);
    }
  }
  async function load() {
    if (!eligible() || loading) return;
    const version = generation;
    loading = true;
    try {
      const results = await Promise.allSettled(['/api/report-notifications', '/api/announcement-notifications'].map(async (url) => {
        const response = await fetch(url, { cache: 'no-store' });
        if (!response.ok) throw new Error('Could not load notifications.');
        return response.json();
      }));
      if (version !== generation || !eligible()) return;
      if (results.every((result) => result.status === 'rejected')) throw new Error('Could not load notifications. Retrying automatically.');
      if (results[0].status === 'fulfilled') reports = results[0].value;
      if (results[1].status === 'fulfilled') announcements = results[1].value;
      const data = {
        unread: reports.unread + announcements.unread,
        notifications: [
          ...reports.notifications.map((item) => ({ ...item, kind: 'report' })),
          ...announcements.announcements.map((item) => ({ ...item, kind: 'announcement' }))
        ].sort((a, b) => Number(Boolean(a.readAt)) - Number(Boolean(b.readAt)) || new Date(b.notifiedAt) - new Date(a.notifiedAt))
      };
      render(data);
      byId('reportNotificationStatus').textContent = results.some((result) => result.status === 'rejected') ? 'Some notifications could not refresh. Retrying automatically.' : '';
      const incoming = data.notifications.filter((item) => !item.readAt && !seen.has(key(item)));
      data.notifications.forEach((item) => seen.add(key(item)));
      if (incoming.length && 'Notification' in window && Notification.permission === 'granted') {
        try {
          const item = incoming[0];
          const notification = new Notification('BarangayWatch: new notification', {
            body: incoming.length === 1 ? item.kind === 'announcement' ? item.title : `${item.cameraName} - ${item.location || 'Open for details'}` : `${incoming.length} new announcements or reports need your attention.`,
            tag: `barangay-${key(item)}`
          });
          notification.onclick = () => { window.focus(); void openNotification(item); notification.close(); };
        } catch { /* The in-app inbox remains available if the browser blocks desktop notifications. */ }
      }
    } catch (error) { if (version === generation) byId('reportNotificationStatus').textContent = error.message; }
    finally { loading = false; }
  }
  function start() {
    generation++;
    if (timer) clearInterval(timer);
    timer = null;
    seen.clear();
    reports = { unread: 0, notifications: [] };
    announcements = { unread: 0, announcements: [] };
    byId('reportNotifications').hidden = !eligible();
    byId('reportNotificationPanel').hidden = true;
    byId('reportNotificationBtn').setAttribute('aria-expanded', 'false');
    byId('enableReportNotificationsBtn').hidden = !('Notification' in window) || Notification.permission === 'granted';
    if (!eligible()) return;
    void load();
    timer = setInterval(load, 5000);
  }
  byId('reportNotificationBtn').addEventListener('click', () => {
    const panel = byId('reportNotificationPanel');
    panel.hidden = !panel.hidden;
    byId('reportNotificationBtn').setAttribute('aria-expanded', String(!panel.hidden));
    if (!panel.hidden) void load();
  });
  byId('enableReportNotificationsBtn').addEventListener('click', async () => {
    try {
      const permission = await Notification.requestPermission();
      byId('enableReportNotificationsBtn').hidden = permission === 'granted';
      byId('reportNotificationStatus').textContent = permission === 'granted'
        ? 'Browser notifications enabled. Keep this dashboard open to receive them.'
        : 'Use the Notifications inbox here, or allow notifications in browser site settings.';
    } catch { byId('reportNotificationStatus').textContent = 'Browser notifications are unavailable. Report notifications still appear here.'; }
  });
  byId('closeNotificationAnnouncementBtn').addEventListener('click', () => byId('notificationAnnouncementPreview').close());
  window.ReportNotifications = { start, load };
})();
