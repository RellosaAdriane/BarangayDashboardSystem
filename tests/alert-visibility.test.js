const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function layout(role) {
  const nodes = new Map();
  const options = { pending: {}, archived: {}, reports: {} };
  const byId = (id) => {
    if (!nodes.has(id)) nodes.set(id, { dataset: {}, value: 'pending', querySelector(selector) { return options[selector.match(/value="([^"]+)"/)[1]]; } });
    return nodes.get(id);
  };
  const source = fs.readFileSync(path.join(__dirname, '../public/dashboards/layout.js'), 'utf8');
  const context = vm.createContext({ document: { getElementById: byId } });
  vm.runInContext(source.slice(0, source.indexOf("  const nav = byId('mainNav');")).replace('export function', 'function') + '\n}', context);
  context.applyDashboardLayout({ role }, { isAdmin: role === 'admin' });
  return { byId, options };
}

test('Tanod Alerts selector shows Reports only and hides the archive menu', () => {
  const c = layout('tanod');
  assert.equal(c.byId('alertView').value, 'reports');
  assert.equal(c.byId('alertView').disabled, true);
  assert.equal(c.options.pending.hidden, true);
  assert.equal(c.options.pending.disabled, true);
  assert.equal(c.options.archived.hidden, true);
  assert.equal(c.options.archived.disabled, true);
  assert.equal(c.byId('openRecordingArchiveBtn').hidden, true);
});

test('Captain keeps Pending and Reports while Admin keeps every alert view', () => {
  const captain = layout('captain');
  assert.equal(captain.options.pending.hidden, false);
  assert.equal(captain.options.archived.hidden, true);
  assert.equal(captain.byId('alertView').disabled, false);
  const admin = layout('admin');
  assert.equal(admin.options.pending.hidden, false);
  assert.equal(admin.options.archived.hidden, false);
  assert.equal(admin.byId('alertView').disabled, false);
});
