/* ═══════════════════════════════════════════════════════
   YABBY — Login View
   ═══════════════════════════════════════════════════════
   Minimal login form. Only shown when auth is enabled
   and user is not authenticated.
*/

import { api } from '../api.js';
import { navigate } from '../router.js';
import { t } from '../i18n.js';

export async function render(container) {
  // Check if auth is even enabled
  let authStatus;
  try {
    const res = await fetch('/api/auth/me');
    authStatus = await res.json();
  } catch {
    authStatus = { enabled: false };
  }

  // If auth disabled or already logged in, go to dashboard
  if (!authStatus.enabled || (authStatus.enabled && authStatus.user)) {
    navigate('/');
    return;
  }

  // Check if we need setup (no users yet)
  let needsSetup = false;
  try {
    const res = await fetch('/api/auth/setup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const data = await res.json();
    // If error is NOT "already exists", we need setup
    if (res.status === 400 && data.error === 'username and password required') {
      needsSetup = true;
    }
  } catch {}

  container.innerHTML = `
    <div class="login-container">
      <div class="login-card">
        <div class="login-logo">
          <svg viewBox="0 0 120 100" width="60" height="50" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round">
            <ellipse cx="60" cy="55" rx="14" ry="20"/>
            <path d="M42 42c-8-5-18-8-23-5-3 2-2 6 3 9l14 8"/>
            <path d="M78 42c8-5 18-8 23-5 3 2 2 6-3 9L84 54"/>
          </svg>
          <h2>${t('login.appName')}</h2>
        </div>

        <p class="login-subtitle">${needsSetup ? t('login.setupTitle') : t('login.loginTitle')}</p>

        <form id="loginForm" class="login-form">
          ${needsSetup ? `
            <div class="form-group">
              <label for="loginUsername">${t('login.username')}</label>
              <input type="text" id="loginUsername" name="username" placeholder="${t('login.usernamePlaceholder')}" required autocomplete="username" />
            </div>
          ` : ''}
          <div class="form-group">
            <label for="loginPassword">${t('login.password')}</label>
            <input type="password" id="loginPassword" name="password" placeholder="${t('login.passwordPlaceholder')}" required autocomplete="current-password" />
          </div>
          <div id="loginError" class="login-error" style="display:none"></div>
          <button type="submit" class="login-btn">
            ${needsSetup ? t('login.setupButton') : t('login.loginButton')}
          </button>
        </form>
      </div>
    </div>
  `;

  const form = document.getElementById('loginForm');
  const errorEl = document.getElementById('loginError');

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errorEl.style.display = 'none';

    const password = document.getElementById('loginPassword').value;
    const usernameEl = document.getElementById('loginUsername');
    const username = usernameEl ? usernameEl.value : null;

    try {
      let data;
      if (needsSetup && username) {
        // Setup flow
        const res = await fetch('/api/auth/setup', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username, password }),
        });
        data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Setup failed');
      } else {
        // Login flow — try gateway password (password only) or username+password
        const body = username ? { username, password } : { password };
        const res = await fetch('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Login failed');
      }

      if (data.token) {
        localStorage.setItem('yabby_token', data.token);
      }
      navigate('/');
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.style.display = 'block';
    }
  });
}
