'use strict';

(async () => {
  const errorBox = document.querySelector('.error');
  const showError = (msg) => {
    errorBox.textContent = msg;
    errorBox.hidden = !msg;
  };

  try {
    const res = await fetch('/api/me', { credentials: 'same-origin' });
    if (res.status === 401) {
      window.location.href = '/login';
      return;
    }
    const { user } = await res.json();
    document.getElementById('username').textContent = user.username;
    document.getElementById('email').textContent = user.email;
    // SQLite stores UTC as "YYYY-MM-DD HH:MM:SS".
    const created = new Date(user.createdAt.replace(' ', 'T') + 'Z');
    document.getElementById('created').textContent = created.toLocaleString('th-TH');
  } catch {
    showError('โหลดข้อมูลผู้ใช้ไม่สำเร็จ');
  }

  document.getElementById('logout').addEventListener('click', async () => {
    try {
      await fetch('/api/logout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: '{}',
      });
    } finally {
      window.location.href = '/login';
    }
  });
})();
