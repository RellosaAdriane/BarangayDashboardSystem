const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function ui(role = 'admin') {
  const nodes = new Map();
  const posts = [];
  const byId = (id) => {
    if (!nodes.has(id)) nodes.set(id, {
      value: '', dataset: {}, handlers: {},
      addEventListener(name, fn) { this.handlers[name] = fn; },
      showModal() { this.open = true; },
      close() { this.open = false; this.handlers.close?.(); },
      focus() {}, reset() { for (const name of ['resetNewPassword', 'resetConfirmPassword']) if (nodes.has(name)) nodes.get(name).value = ''; }
    });
    return nodes.get(id);
  };
  const window = { currentRole: role };
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/account-passwords.js'), 'utf8'), vm.createContext({
    window, document: { getElementById: byId },
    fetch: async (url, options) => { posts.push({ url, data: JSON.parse(options.body) }); return { ok: true, json: async () => ({ ok: true, message: 'Password reset successfully.' }) }; }
  }));
  return { api: window.AccountPasswords, byId, posts, submit: () => byId('resetAccountPasswordForm').handlers.submit({ preventDefault() {} }) };
}
const user = { id: '2', fullName: 'Test Tanod', username: 'test.tanod' };

test('admin reset form validates confirmation, submits the selected user and clears password fields', async () => {
  const c = ui();
  c.api.open(user);
  assert.equal(c.byId('resetAccountPasswordDialog').open, true);
  assert.equal(c.byId('resetAccountPasswordTarget').textContent, 'Test Tanod (@test.tanod)');
  c.byId('resetNewPassword').value = 'new-password';
  c.byId('resetConfirmPassword').value = 'different';
  await c.submit();
  assert.equal(c.posts.length, 0);
  c.byId('resetConfirmPassword').value = 'new-password';
  await c.submit();
  assert.equal(c.posts[0].url, '/api/users/2/reset-password');
  assert.equal(c.byId('resetAccountPasswordDialog').open, false);
  assert.equal(c.byId('resetNewPassword').value, '');
  assert.equal(c.byId('resetConfirmPassword').value, '');
  assert.match(c.byId('accountManagementStatus').textContent, /reset successfully/);
});

test('non-admin cannot open the reset form or submit a reset', async () => {
  const c = ui('captain');
  c.api.open(user);
  assert.notEqual(c.byId('resetAccountPasswordDialog').open, true);
  await c.submit();
  assert.equal(c.posts.length, 0);
});
