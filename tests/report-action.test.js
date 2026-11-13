const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const script = fs.readFileSync(path.join(__dirname, '../public/script.js'), 'utf8');
const context = vm.createContext({ window: { currentRole: 'captain' }, formatDate: String });
vm.runInContext(script.slice(script.indexOf('function escapeHtml('), script.indexOf('function formatDate(')), context);
vm.runInContext(script.slice(script.indexOf('function alertStatusClass('), script.indexOf('function bindSnapshotReview(')), context);

test('unactioned reports display their status and an action form without auto-completing', () => {
  const html = context.snapshotPreviewMarkup({ id: 1, status: 'report', cameraName: 'Gate', faceCount: 1 });
  assert.match(html, /Awaiting action/);
  assert.match(html, /data-action-report="1"/);
  assert.match(html, /Mark as actioned/);
  assert.equal(context.reportActionBadge({ status: 'pending' }), '');
});

test('completed reports show the actor, time and escaped action notes instead of an action form', () => {
  const html = context.snapshotPreviewMarkup({ id: 1, status: 'report', cameraName: 'Gate', actionedAt: '2026-11-12T02:00:00Z', actionedBy: 'Tanod One', actionNote: 'Checked <gate>', faceCount: 1 });
  assert.match(html, /Actioned/);
  assert.match(html, /Automatically archived/);
  assert.match(html, /Tanod One/);
  assert.match(html, /2026-11-12T02:00:00Z/);
  assert.match(html, /Checked &lt;gate&gt;/);
  assert.doesNotMatch(html, /data-action-report|Flagged for follow-up/);
});
