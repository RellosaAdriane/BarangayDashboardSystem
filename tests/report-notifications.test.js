const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function inbox(role = 'tanod', permission = 'granted') {
  const elements = new Map();
  const notices = [];
  const opened = [];
  const items = [{ id: '45', notificationId: '10', cameraName: 'CAM 01', location: 'Gate', notifiedAt: '2026-11-12T02:00:00Z', readAt: null, reviewNote: 'Please check' }];
  const announcements = [];
  let requests = 0;
  let desktopFails = false;
  let announcementsFail = false;
  const node = () => ({
    handlers: {}, children: [], attrs: {},
    addEventListener(name, fn) { this.handlers[name] = fn; },
    setAttribute(name, value) { this.attrs[name] = value; },
    append(...children) { this.children.push(...children); },
    appendChild(child) { this.children.push(child); },
    replaceChildren() { this.children = []; },
    showModal() { this.open = true; }, close() { this.open = false; }
  });
  const byId = (id) => { if (!elements.has(id)) elements.set(id, node()); return elements.get(id); };
  class Notification {
    static permission = permission;
    static async requestPermission() { return permission; }
    constructor(title, options) { if (desktopFails) throw new Error('Not supported'); this.title = title; this.options = options; notices.push(this); }
    close() {}
  }
  const window = { currentRole: role, Notification, focus() {}, openReportedSnapshot: async (item) => opened.push(item.id) };
  const context = vm.createContext({
    window, Notification, Date, Set,
    setInterval() { return 1; }, clearInterval() {},
    document: { getElementById: byId, createElement: node },
    fetch: async (url, options = {}) => {
      requests++;
      if (url === '/api/announcements') return { ok: true, json: async () => announcements.map((item) => ({ ...item, publishedAt: item.notifiedAt })) };
      if (url.startsWith('/api/announcement-notifications')) {
        if (announcementsFail) throw new Error('Announcement service unavailable');
        if (options.method === 'PATCH') announcements.find((item) => url.includes(`/${item.id}/read`)).readAt = new Date().toISOString();
        return { ok: true, json: async () => ({ unread: announcements.filter((item) => !item.readAt).length, announcements: announcements.map((item) => ({ ...item })) }) };
      }
      if (options.method === 'PATCH') items.find((item) => url.includes(`/${item.notificationId}/read`)).readAt = new Date().toISOString();
      return { ok: true, json: async () => ({ unread: items.filter((item) => !item.readAt).length, notifications: items.map((item) => ({ ...item })) }) };
    }
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/report-notifications.js'), 'utf8'), context);
  return { api: window.ReportNotifications, elements, notices, opened, items, announcements, get requests() { return requests; }, blockDesktop() { desktopFails = true; }, failAnnouncements() { announcementsFail = true; } };
}

test('Tanod and Captain get an unread badge and one browser notification per newly received report', async () => {
  for (const role of ['tanod', 'captain']) {
    const c = inbox(role);
    await c.api.load();
    await c.api.load();
    assert.equal(c.elements.get('reportUnreadCount').textContent, '1');
    assert.equal(c.notices.length, 1);
    assert.match(c.notices[0].options.body, /CAM 01 - Gate/);
    c.items.push({ ...c.items[0], id: '46', notificationId: '11' });
    await c.api.load();
    assert.equal(c.notices.length, 2);
  }
});

test('opening a notification opens its exact snapshot and acknowledges it without repeated alerts', async () => {
  const c = inbox();
  await c.api.load();
  await c.elements.get('reportNotificationList').children[0].handlers.click();
  assert.deepEqual(c.opened, ['45']);
  assert.ok(c.items[0].readAt);
  assert.equal(c.elements.get('reportUnreadCount').hidden, true);
  await c.api.load();
  assert.equal(c.notices.length, 1);
});

test('in-app notifications work when browser permission is denied or desktop notifications fail', async () => {
  const denied = inbox('captain', 'denied');
  await denied.api.load();
  assert.equal(denied.notices.length, 0);
  assert.equal(denied.elements.get('reportNotificationList').children.length, 1);
  const blocked = inbox();
  blocked.blockDesktop();
  await blocked.api.load();
  assert.equal(blocked.elements.get('reportUnreadCount').textContent, '1');
});

test('admin and signed-out sessions do not poll the recipient inbox', async () => {
  for (const role of ['admin', null]) {
    const c = inbox(role);
    c.api.start();
    await c.api.load();
    assert.equal(c.requests, 0);
    assert.equal(c.elements.get('reportNotifications').hidden, true);
  }
});

test('header inbox combines announcements and reports and opens announcements with a separate read state', async () => {
  const c = inbox('captain');
  c.announcements.push({ id: '10', title: 'Community meeting', body: 'Meet at the barangay hall.', author: 'Captain', notifiedAt: '2026-11-12T03:00:00Z', readAt: null });
  await c.api.load();
  assert.equal(c.elements.get('reportUnreadCount').textContent, '2');
  const rows = c.elements.get('reportNotificationList').children;
  assert.equal(rows.length, 2);
  assert.match(rows[0].children[0].textContent, /Announcement - Community meeting/);
  await rows[0].handlers.click();
  assert.equal(c.elements.get('notificationAnnouncementPreview').open, true);
  assert.equal(c.elements.get('notificationAnnouncementBody').textContent, 'Meet at the barangay hall.');
  assert.ok(c.announcements[0].readAt);
  assert.equal(c.items[0].readAt, null);
  assert.equal(c.elements.get('reportUnreadCount').textContent, '1');
  assert.equal(c.opened.length, 0);
});

test('report inbox still works if announcements cannot refresh', async () => {
  const c = inbox();
  c.failAnnouncements();
  await c.api.load();
  assert.equal(c.elements.get('reportUnreadCount').textContent, '1');
  assert.equal(c.elements.get('reportNotificationList').children.length, 1);
  assert.match(c.elements.get('reportNotificationStatus').textContent, /Some notifications/);
});
