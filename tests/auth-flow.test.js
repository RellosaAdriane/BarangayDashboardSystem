const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../public/auth.js'), 'utf8');
const formCode = source.slice(source.indexOf('function openAuth('), source.indexOf("\ndocument.querySelectorAll('[data-toggle-password]').forEach((button) => button.addEventListener"));

function auth() {
  const elements = new Map();
  const calls = [];
  const signedIn = [];
  const destinations = [];
  let historyUrl;
  const byId = (id) => {
    if (!elements.has(id)) {
      let minimum = 0;
      const element = {
        value: '', hidden: false, handlers: {},
        querySelectorAll() { return []; },
        setAttribute() {}, focus() { this.focused = true; },
        addEventListener(event, fn) { this.handlers[event] = fn; },
        reset() { for (const item of elements.values()) item.value = ''; }
      };
      // Match the real browser's nonnegative minLength requirement.
      Object.defineProperty(element, 'minLength', { get: () => minimum, set(value) { if (value < 0) throw new RangeError('IndexSizeError'); minimum = value; } });
      elements.set(id, element);
    }
    return elements.get(id);
  };
  const context = vm.createContext({
    setupMode: false, authMode: 'login', byId, URL, URLSearchParams,
    window: { location: { href: 'http://localhost:3001/?auth=register', search: '?auth=register' } },
    location: { assign: (url) => destinations.push(url) },
    history: { replaceState(_state, _title, url) { historyUrl = String(url); } },
    document: { querySelectorAll: () => [] },
    setBirthDateLimit() {}, clearRequiredError() {}, showAuthError() {}, showFieldError() {},
    validateRequiredFields: () => true, isAtLeast18: () => true,
    setRoleUI: async (user) => signedIn.push(user),
    api: async (route, options) => {
      calls.push({ route, body: options?.body ? JSON.parse(options.body) : null });
      return route === '/api/auth/register' ? { message: 'Your account request is awaiting administrator approval.' } : { user: { id: 1, fullName: 'Existing User', role: 'captain' } };
    }
  });
  vm.runInContext(formCode, context);
  const submit = () => byId('authForm').handlers.submit({ preventDefault() {}, currentTarget: byId('authForm') });
  return { context, byId, calls, signedIn, submit, destinations, get historyUrl() { return historyUrl; } };
}

test('switching from registration to login fully updates the form without an invalid minLength', () => {
  const c = auth();
  c.context.openAuth('register');
  assert.equal(c.byId('authHeading').textContent, 'Request an account');
  assert.equal(c.byId('loginPassword').minLength, 8);
  c.context.openAuth('login');
  assert.equal(c.byId('authHeading').textContent, 'Log in to BarangayPOB-3A');
  assert.equal(c.byId('authSubmit').textContent, 'Log in');
  assert.equal(c.byId('usernameLabel').textContent, 'Username');
  assert.equal(c.byId('loginPassword').minLength, 0);
  assert.equal(c.byId('loginPassword').autocomplete, 'current-password');
  assert.equal(c.byId('registerFields').hidden, true);
  assert.equal(c.byId('confirmPassword').required, false);
});

test('successful account request returns to login and submits another account to the login endpoint', async () => {
  const c = auth();
  c.context.openAuth('register');
  c.byId('loginUsername').value = 'new-person';
  c.byId('loginPassword').value = 'example-pass';
  c.byId('confirmPassword').value = 'example-pass';
  for (const id of ['registerFirstName', 'registerLastName', 'registerDob', 'registerGender', 'registerRole']) c.byId(id).value = 'test';
  await c.submit();
  assert.equal(c.calls[0].route, '/api/auth/register');
  assert.equal(c.signedIn.length, 0);
  assert.equal(c.context.authMode, 'login');
  assert.equal(c.byId('loginPassword').value, '');
  assert.equal(c.byId('loginUsername').value, '');
  assert.equal(c.byId('credentialFields').hidden, false);
  assert.equal(c.byId('authSubmit').hidden, false);
  assert.equal(c.byId('authSubmit').textContent, 'Log in');
  assert.match(c.byId('authMessage').textContent, /awaiting administrator approval/);
  assert.equal(new URL(c.historyUrl).searchParams.get('auth'), 'login');
  c.byId('loginUsername').value = 'existing-user';
  c.byId('loginPassword').value = 'existing-pass';
  await c.submit();
  assert.equal(c.calls[1].route, '/api/auth/login');
  assert.deepEqual(c.calls[1].body, { username: 'existing-user', password: 'existing-pass' });
  assert.equal(c.signedIn.length, 1);
});

test('first-admin setup still uses setup mode and logout always navigates to login', async () => {
  const c = auth();
  c.context.setupMode = true;
  c.context.openAuth('login');
  assert.equal(c.context.authMode, 'setup');
  assert.equal(c.byId('loginPassword').minLength, 8);
  assert.equal(c.byId('authSubmit').textContent, 'Create admin account');
  vm.runInContext(source.split('\n').find((line) => line.startsWith("byId('logoutBtn').addEventListener")), c.context);
  await c.byId('logoutBtn').handlers.click();
  assert.equal(c.calls[0].route, '/api/auth/logout');
  assert.deepEqual(c.destinations, ['/?auth=login']);
});
