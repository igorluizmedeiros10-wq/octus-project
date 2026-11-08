'use strict';

/**
 * Interface do Executive AI Studio.
 * Toda autenticação passa pelo processo principal (autenticação oficial do OCTOS).
 * O renderer nunca vê token, cookie ou senha persistida.
 */

const api = window.octos;
const $ = (id) => document.getElementById(id);

const els = {
  status: $('status'),
  statusLabel: $('status-label'),
  views: {
    disconnected: $('view-disconnected'),
    connecting: $('view-connecting'),
    connected: $('view-connected'),
    blocked: $('view-blocked'),
    otp: $('view-otp'),
    error: $('view-error'),
  },
  connectingText: $('connecting-text'),
  blockedText: $('blocked-text'),
  errorText: $('error-text'),
  profileAvatar: $('profile-avatar'),
  profileName: $('profile-name'),
  profileEmail: $('profile-email'),
  profileStatus: $('profile-status'),
  profileRole: $('profile-role'),
  metaAccount: $('meta-account'),
  metaSync: $('meta-sync'),
  metaServer: $('meta-server'),
  otpEmail: $('otp-email'),
  otpCode: $('otp-code'),
  formLogin: $('form-login'),
  loginEmail: $('login-email'),
  loginPassword: $('login-password'),
  btnLogin: $('btn-login'),
  btnConnect: $('btn-connect'),
  btnGoogle: $('btn-google'),
  btnRefresh: $('btn-refresh'),
  btnDisconnect: $('btn-disconnect'),
  btnBlockedDisconnect: $('btn-blocked-disconnect'),
  btnErrorRetry: $('btn-error-retry'),
  btnReloadSite: $('btn-reload-site'),
  btnOpenSite: $('btn-open-site'),
  btnSettings: $('btn-settings'),
  modalSettings: $('modal-settings'),
  formSettings: $('form-settings'),
  settingsUrl: $('settings-url'),
  settingsAppId: $('settings-appid'),
  settingsError: $('settings-error'),
  btnSettingsCancel: $('btn-settings-cancel'),
  modalForgot: $('modal-forgot'),
  formForgot: $('form-forgot'),
  forgotEmail: $('forgot-email'),
  forgotMessage: $('forgot-message'),
  btnForgotCancel: $('btn-forgot-cancel'),
  btnForgot: $('btn-forgot'),
  modalRegister: $('modal-register'),
  formRegister: $('form-register'),
  registerName: $('register-name'),
  registerEmail: $('register-email'),
  registerPassword: $('register-password'),
  registerMessage: $('register-message'),
  btnRegisterCancel: $('btn-register-cancel'),
  btnRegisterSite: $('btn-register-site'),
  btnRegister: $('btn-register'),
  stagePlaceholder: $('stage-placeholder'),
  stagePlaceholderText: $('stage-placeholder-text'),
  siteSlot: $('site-slot'),
  footerUrl: $('footer-url'),
  footerStorage: $('footer-storage'),
  toast: $('toast'),
};

const STATUS_UI = {
  disconnected: { label: 'Desconectado', view: 'disconnected' },
  connecting: { label: 'Conectando…', view: 'connecting' },
  connected: { label: 'Conectado ao OCTOS', view: 'connected' },
  blocked: { label: 'Conta bloqueada', view: 'blocked' },
  otp_required: { label: 'Verificação necessária', view: 'otp' },
  error: { label: 'Falha de conexão', view: 'error' },
};

let snapshot = null;
let toastTimer = null;
let busy = false;

/* ----------------------------- utilidades ----------------------------- */

function showView(name) {
  Object.entries(els.views).forEach(([key, node]) => {
    if (node) node.hidden = key !== name;
  });
}

function setBusy(value, label) {
  busy = value;
  [els.btnLogin, els.btnConnect, els.btnGoogle, els.btnRefresh].forEach((button) => {
    if (button) button.disabled = value;
  });
  if (els.btnLogin) els.btnLogin.textContent = value && label === 'login' ? 'Entrando…' : 'Entrar';
}

function toast(message, kind = 'info') {
  if (!els.toast) return;
  els.toast.textContent = message;
  els.toast.dataset.kind = kind;
  els.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    els.toast.hidden = true;
  }, 6000);
}

function formatDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
}

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return url || '—';
  }
}

function safeAvatar(url) {
  if (typeof url !== 'string' || !url) return '../assets/octos-logo.svg';
  if (/^https:\/\//i.test(url) || /^data:image\//i.test(url)) return url;
  return '../assets/octos-logo.svg';
}

function errorMessage(result) {
  const code = result && result.error && result.error.code;
  const messages = {
    invalid_credentials: 'E-mail ou senha incorretos no OCTOS.',
    invalid_input: result && result.error && result.error.message,
    network_error: 'Não foi possível alcançar o OCTOS. Verifique sua internet.',
    timeout: 'O OCTOS demorou para responder. Tente novamente.',
    unauthorized: 'Sua sessão expirou. Entre novamente.',
    account_blocked: 'Sua conta está bloqueada no OCTOS.',
    email_taken: 'Este e-mail já possui conta no OCTOS. Use "Entrar".',
    rate_limited: 'Muitas tentativas. Aguarde alguns instantes.',
    invalid_route: 'Rota do OCTOS não permitida.',
    invalid_url: 'A URL informada não é válida.',
  };
  if (messages[code]) return messages[code];
  if (result && result.error && result.error.message) return result.error.message;
  return 'Não foi possível concluir a operação.';
}

/* ----------------------------- renderização ---------------------------- */

function render(next) {
  if (!next || !next.state) return;
  snapshot = next;
  const state = next.state;
  const config = next.config || {};
  const ui = STATUS_UI[state.status] || STATUS_UI.disconnected;

  els.status.dataset.state = state.status;
  els.statusLabel.textContent = ui.label;
  showView(ui.view);

  if (els.footerUrl) els.footerUrl.textContent = config.octosUrl || '—';
  if (els.footerStorage) {
    const storage = next.storage;
    els.footerStorage.textContent =
      storage === 'safeStorage' ? 'Sessão cifrada (DPAPI)' : storage === 'aes-256-gcm' ? 'Sessão cifrada (AES-256-GCM)' : 'Sessão cifrada';
  }
  if (els.settingsAppId) els.settingsAppId.textContent = `App ID Base44: ${config.appId || '—'}`;

  if (state.status === 'connected' && state.user) {
    const user = state.user;
    els.profileName.textContent = user.fullName || 'Usuário OCTOS';
    els.profileEmail.textContent = user.email || '';
    els.profileAvatar.src = safeAvatar(user.avatarUrl);
    els.profileStatus.textContent = user.isBlocked ? 'Conta bloqueada' : 'Sessão ativa';
    els.profileStatus.classList.toggle('chip--ok', !user.isBlocked);
    els.profileRole.hidden = !user.role || user.role === 'user';
    els.profileRole.textContent = user.role || '';
    els.metaAccount.textContent = user.status || 'active';
    els.metaSync.textContent = formatDate(state.lastSyncAt);
    els.metaServer.textContent = hostOf(config.octosUrl);
  }

  if (state.status === 'blocked') {
    els.blockedText.textContent =
      (state.error && state.error.message) ||
      'Sua conta está bloqueada ou suspensa no OCTOS. O aplicativo respeita as permissões definidas no site.';
  }

  if (state.status === 'otp_required') {
    els.otpEmail.textContent = state.pendingEmail || 'seu e-mail';
    if (els.otpCode) els.otpCode.focus();
  }

  if (state.status === 'error') {
    els.errorText.textContent =
      (state.error && state.error.message) || 'Não foi possível falar com o OCTOS.';
  }

  if (state.status === 'connecting') {
    els.connectingText.textContent = state.tokenPresent
      ? 'Validando sua sessão oficial no OCTOS…'
      : 'Conectando ao OCTOS…';
  }

  if (els.settingsUrl && document.activeElement !== els.settingsUrl) {
    els.settingsUrl.value = config.octosUrl || '';
  }

  // Placeholder apenas em falha explícita de carregamento do site.
  const site = next.site || null;
  const failed = Boolean(site && site.lastError);
  els.stagePlaceholder.hidden = !failed;
  if (failed) {
    els.stagePlaceholderText.textContent = `Falha ao carregar o site OCTOS: ${site.lastError}`;
  }
}

function syncBounds() {
  if (!els.siteSlot || !api || !api.setViewBounds) return;
  const rect = els.siteSlot.getBoundingClientRect();
  api.setViewBounds({
    x: Math.round(rect.left),
    y: Math.round(rect.top),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
  });
}

/* ----------------------------- ações ---------------------------------- */

async function withResult(promise, { okMessage, busyLabel } = {}) {
  setBusy(true, busyLabel);
  try {
    const result = await promise;
    if (!result || result.ok === false) {
      toast(errorMessage(result), 'error');
      return null;
    }
    if (result.state) render(result);
    if (okMessage) toast(okMessage, 'ok');
    return result;
  } catch (error) {
    toast('Falha inesperada na comunicação com o OCTOS.', 'error');
    return null;
  } finally {
    setBusy(false);
  }
}

async function signIn(event) {
  event.preventDefault();
  const email = els.loginEmail.value.trim();
  const password = els.loginPassword.value;
  if (!email || !password) {
    toast('Informe e-mail e senha do OCTOS.', 'error');
    return;
  }
  const result = await withResult(api.signIn({ email, password }), { busyLabel: 'login' });
  if (result) {
    els.loginPassword.value = '';
    if (result.state && result.state.status === 'connected') {
      toast('Conectado com a sua conta OCTOS.', 'ok');
    }
  }
}

async function openSiteLogin() {
  const result = await withResult(api.openRoute('/login'), { busyLabel: 'site' });
  if (result) {
    syncBounds();
    api.setViewVisible(true);
    toast('Use o site oficial do OCTOS para entrar com Google.', 'info');
  }
}

async function register(event) {
  event.preventDefault();
  const email = els.registerEmail.value.trim();
  const password = els.registerPassword.value;
  const fullName = els.registerName.value.trim();
  if (!email || password.length < 8) {
    els.registerMessage.hidden = false;
    els.registerMessage.className = 'hint hint--error';
    els.registerMessage.textContent = 'Informe um e-mail válido e uma senha com pelo menos 8 caracteres.';
    return;
  }
  const result = await withResult(api.register({ email, password, fullName }), { busyLabel: 'register' });
  if (!result) return;
  els.modalRegister.hidden = true;
  els.registerPassword.value = '';
  const requiresVerification = result.registration && result.registration.requiresVerification;
  toast(
    requiresVerification
      ? 'Conta criada no OCTOS. Confirme o código enviado ao seu e-mail.'
      : 'Conta criada no OCTOS. Você já está conectado.',
    'ok'
  );
}

async function requestReset(event) {
  event.preventDefault();
  const email = els.forgotEmail.value.trim();
  if (!email) {
    els.forgotMessage.hidden = false;
    els.forgotMessage.className = 'hint hint--error';
    els.forgotMessage.textContent = 'Informe o e-mail da sua conta OCTOS.';
    return;
  }
  const result = await withResult(api.requestPasswordReset(email), { busyLabel: 'reset' });
  if (!result) return;
  els.forgotMessage.hidden = false;
  els.forgotMessage.className = 'hint hint--ok';
  els.forgotMessage.textContent = result.message || 'Solicitação enviada ao OCTOS.';
}

async function verifyOtp(event) {
  event.preventDefault();
  const otp = els.otpCode.value.trim();
  const email = (snapshot && snapshot.state && snapshot.state.pendingEmail) || els.loginEmail.value.trim();
  if (!otp) {
    toast('Informe o código recebido.', 'error');
    return;
  }
  const result = await withResult(api.verifyOtp({ email, otp }), { busyLabel: 'otp' });
  if (result) {
    els.otpCode.value = '';
    toast('Verificação concluída no OCTOS.', 'ok');
  }
}

async function signOut() {
  const result = await withResult(api.signOut(), { busyLabel: 'signout' });
  if (result) {
    els.loginPassword.value = '';
    toast('Você saiu da conta OCTOS neste aplicativo.', 'info');
  }
}

async function saveSettings(event) {
  event.preventDefault();
  const octosUrl = els.settingsUrl.value.trim();
  if (!octosUrl) {
    els.settingsError.hidden = false;
    els.settingsError.textContent = 'Informe a URL oficial do OCTOS.';
    return;
  }
  const result = await withResult(api.saveConfig({ octosUrl }), { busyLabel: 'config' });
  if (!result) {
    els.settingsError.hidden = false;
    els.settingsError.textContent = 'URL inválida. Use HTTPS, por exemplo https://octos-access-core.base44.app.';
    return;
  }
  els.settingsError.hidden = true;
  els.modalSettings.hidden = true;
  syncBounds();
  toast('Configuração salva. Aplicativo sincronizado com o OCTOS.', 'ok');
}

function openModal(node) {
  if (!node) return;
  node.hidden = false;
  const focusable = node.querySelector('input, button');
  if (focusable) focusable.focus();
}

function closeModal(node) {
  if (node) node.hidden = true;
}

/* ----------------------------- eventos -------------------------------- */

function bind() {
  els.formLogin.addEventListener('submit', signIn);
  els.btnConnect.addEventListener('click', openSiteLogin);
  els.btnGoogle.addEventListener('click', openSiteLogin);
  els.btnOpenSite.addEventListener('click', async () => {
    await withResult(api.openRoute('/'), { busyLabel: 'site' });
    syncBounds();
    api.setViewVisible(true);
  });
  els.btnRefresh.addEventListener('click', async () => {
    await withResult(api.refresh(), { okMessage: 'Sessão sincronizada com o OCTOS.' });
  });
  els.btnDisconnect.addEventListener('click', signOut);
  els.btnBlockedDisconnect.addEventListener('click', signOut);
  els.btnErrorRetry.addEventListener('click', async () => {
    await withResult(api.refresh());
  });
  els.btnReloadSite.addEventListener('click', async () => {
    await withResult(api.openRoute('/'));
    syncBounds();
    api.setViewVisible(true);
  });

  els.btnSettings.addEventListener('click', () => {
    if (snapshot && snapshot.config) els.settingsUrl.value = snapshot.config.octosUrl;
    els.settingsError.hidden = true;
    openModal(els.modalSettings);
  });
  els.btnSettingsCancel.addEventListener('click', () => closeModal(els.modalSettings));
  els.formSettings.addEventListener('submit', saveSettings);

  els.btnForgot.addEventListener('click', () => {
    els.forgotMessage.hidden = true;
    if (els.loginEmail.value) els.forgotEmail.value = els.loginEmail.value;
    openModal(els.modalForgot);
  });
  els.btnForgotCancel.addEventListener('click', () => closeModal(els.modalForgot));
  els.formForgot.addEventListener('submit', requestReset);

  els.btnRegister.addEventListener('click', () => {
    els.registerMessage.hidden = true;
    if (els.loginEmail.value) els.registerEmail.value = els.loginEmail.value;
    openModal(els.modalRegister);
  });
  els.btnRegisterCancel.addEventListener('click', () => closeModal(els.modalRegister));
  els.formRegister.addEventListener('submit', register);
  els.btnRegisterSite.addEventListener('click', async () => {
    closeModal(els.modalRegister);
    await withResult(api.openRoute('/register'), { busyLabel: 'site' });
    syncBounds();
    api.setViewVisible(true);
  });

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    closeModal(els.modalSettings);
    closeModal(els.modalForgot);
    closeModal(els.modalRegister);
  });

  const onLayoutChange = () => syncBounds();
  window.addEventListener('resize', onLayoutChange);
  if (window.ResizeObserver && els.siteSlot) {
    new ResizeObserver(onLayoutChange).observe(els.siteSlot);
  }
}

async function init() {
  bind();
  api.onState((next) => render(next));
  const initial = await api.getState();
  if (initial && initial.ok === false) {
    els.status.dataset.state = 'error';
    els.statusLabel.textContent = 'Falha de conexão';
    showView('error');
    els.errorText.textContent = errorMessage(initial);
  } else if (initial) {
    render(initial.state ? initial : initial);
  }
  api.setViewVisible(true);
  requestAnimationFrame(syncBounds);
  setTimeout(syncBounds, 240);
  setTimeout(syncBounds, 900);
}

init().catch(() => {
  els.status.dataset.state = 'error';
  els.statusLabel.textContent = 'Falha de conexão';
  showView('error');
});
