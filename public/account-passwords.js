(() => {
  const byId = (id) => document.getElementById(id);
  let version = 0;
  let saving = false;
  const dialog = byId('resetAccountPasswordDialog');
  const form = byId('resetAccountPasswordForm');
  function open(user) {
    if (window.currentRole !== 'admin' || saving) return;
    version++;
    form.reset();
    form.dataset.userId = String(user.id);
    byId('resetAccountPasswordTarget').textContent = `${user.fullName} (@${user.username})`;
    byId('resetAccountPasswordStatus').textContent = '';
    if (!dialog.open) dialog.showModal();
    byId('resetNewPassword').focus();
  }
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (saving || window.currentRole !== 'admin') return;
    const newPassword = byId('resetNewPassword').value;
    const confirmPassword = byId('resetConfirmPassword').value;
    const status = byId('resetAccountPasswordStatus');
    if (newPassword.length < 8 || newPassword.length > 16 || newPassword !== confirmPassword) {
      status.textContent = 'Enter matching new passwords of 8 to 16 characters.';
      return;
    }
    saving = true;
    const request = version;
    byId('saveResetAccountPasswordBtn').disabled = true;
    status.textContent = 'Resetting password...';
    try {
      const response = await fetch(`/api/users/${form.dataset.userId}/reset-password`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ newPassword, confirmPassword })
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Could not reset password.');
      if (request !== version) return;
      byId('accountManagementStatus').textContent = result.message;
      dialog.close();
    } catch (error) { if (request === version) status.textContent = error.message; }
    finally { saving = false; byId('saveResetAccountPasswordBtn').disabled = false; }
  });
  dialog.addEventListener('close', () => { version++; form.reset(); delete form.dataset.userId; });
  byId('closeResetAccountPasswordBtn').addEventListener('click', () => dialog.close());
  byId('cancelResetAccountPasswordBtn').addEventListener('click', () => dialog.close());
  window.AccountPasswords = { open };
})();
