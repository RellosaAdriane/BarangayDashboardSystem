(() => {
  const byId = (id) => document.getElementById(id);
  let timer = null;
  let loading = false;
  let generation = 0;
  let reports = { unread: 0, notifications: [] };
  let announcements = { unread: 0, announcements: [] };
  const seen = new Set();
  const eligible = () => ['tanod', 'captain', 'admin'].includes(window.currentRole);
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
      else if (item.kind === 'report') await window.openReportedSnapshot(item);
      else await window.openPendingSnapshot(item);
      const endpoint = item.kind === 'announcement' ? `/api/announcement-notifications/${item.id}/read`
        : item.kind === 'report' ? `/api/report-notifications/${item.notificationId}/read`
        : `/api/snapshot-notifications/${item.notificationId}/read`;
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
    byId('reportNotificationBtn').setAttribute('aria-label', `Dashboard notifications: ${data.unread} unread notifications`);
    const list = byId('reportNotificationList');
    list.replaceChildren();
    for (const item of data.notifications) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `report-notification-item${item.readAt ? '' : ' unread'}`;
      const title = document.createElement('strong');
      title.textContent = item.kind === 'announcement' ? `Announcement - ${item.title}`
        : item.kind === 'report' ? `Reported face snapshot - ${item.cameraName}`
        : `Unknown face detected - ${item.cameraName}`;
      const details = document.createElement('span');
      details.textContent = `${item.kind === 'announcement' ? item.author || 'Barangay office' : item.location || 'Location not set'} · ${new Date(item.notifiedAt).toLocaleString()}`;
      const note = document.createElement('span');
      note.textContent = item.kind === 'announcement' ? item.body.slice(0, 160)
        : item.kind === 'report' ? item.reviewNote || 'Open snapshot for details and follow-up.'
        : `${item.faceCount} unfamiliar face(s) captured. Open the snapshot for review.`;
      button.append(title, details, note);
      if (item.kind === 'report') {
        const action = document.createElement('span');
        action.textContent = item.actionedAt ? 'Actioned' : 'Awaiting action';
        button.appendChild(action);
      } else if (item.kind === 'snapshot') {
        const action = document.createElement('span');
        action.textContent = 'Awaiting review';
        button.appendChild(action);
      }
      button.addEventListener('click', () => openNotification(item));
      list.appendChild(button);
    }
    if (!data.notifications.length) {
      const empty = document.createElement('p');
      empty.className = 'empty';
      empty.textContent = 'No new notifications for your role.';
      list.appendChild(empty);
    }
  }
  async function load() {
    if (!eligible() || loading) return;
    const version = generation;
    loading = true;
    try {
      const sources = [
        ...(window.currentRole === 'admin' || window.currentRole === 'captain' ? [['snapshot', '/api/snapshot-notifications']] : []),
        ...(window.currentRole !== 'admin' ? [['report', '/api/report-notifications'], ['announcement', '/api/announcement-notifications']] : [])
      ];
      const results = await Promise.allSettled(sources.map(async ([, url]) => {
        const response = await fetch(url, { cache: 'no-store' });
        if (!response.ok) throw new Error('Could not load notifications.');
        return response.json();
      }));
      if (version !== generation || !eligible()) return;
      if (results.every((result) => result.status === 'rejected')) throw new Error('Could not load notifications. Retrying automatically.');
      let unread = 0;
      const notifications = [];
      results.forEach((result, index) => {
        if (result.status !== 'fulfilled') return;
        const [kind] = sources[index];
        const value = result.value;
        unread += Number(value.unread) || 0;
        if (kind === 'report') reports = value;
        else if (kind === 'announcement') announcements = value;
        const items = kind === 'announcement' ? value.announcements : value.notifications;
        notifications.push(...items.map((item) => ({ ...item, kind })));
      });
      const data = { unread, notifications: notifications.sort((a, b) => Number(Boolean(a.readAt)) - Number(Boolean(b.readAt)) || new Date(b.notifiedAt) - new Date(a.notifiedAt)) };
      render(data);
      byId('reportNotificationStatus').textContent = results.some((result) => result.status === 'rejected') ? 'Some notifications could not refresh. Retrying automatically.' : '';
      const incoming = data.notifications.filter((item) => !item.readAt && !seen.has(key(item)));
      data.notifications.forEach((item) => seen.add(key(item)));
      if (incoming.length && 'Notification' in window && Notification.permission === 'granted') {
        try {
          const item = incoming[0];
          const notification = new Notification('BarangayWatch: new notification', {
            body: incoming.length === 1 ? item.kind === 'announcement' ? item.title : `${item.cameraName} - ${item.location || (item.kind === 'snapshot' ? 'Unknown face snapshot needs review' : 'Open for details')}` : `${incoming.length} new notifications need your attention.`,
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
