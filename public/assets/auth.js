'use strict';

(() => {
  const form = document.querySelector('form[data-endpoint]');
  if (!form) return;
  const errorBox = form.querySelector('.error');
  const button = form.querySelector('button[type="submit"]');

  function showError(message) {
    errorBox.textContent = message;
    errorBox.hidden = !message;
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    showError('');

    const data = Object.fromEntries(new FormData(form));
    if (data.confirmPassword !== undefined && data.confirmPassword !== data.password) {
      return showError('รหัสผ่านยืนยันไม่ตรงกัน');
    }

    button.disabled = true;
    try {
      const res = await fetch(form.dataset.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(data),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) return showError(body.error || 'เกิดข้อผิดพลาด กรุณาลองใหม่');
      window.location.href = '/dashboard';
    } catch {
      showError('ไม่สามารถเชื่อมต่อเซิร์ฟเวอร์ได้');
    } finally {
      button.disabled = false;
    }
  });
})();
