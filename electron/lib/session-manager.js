'use strict';

const { EventEmitter } = require('node:events');
const { sanitizeUser, userFromToken, mergeUsers } = require('./user');

/**
 * Gerencia o ciclo de vida da sessão oficial do OCTOS:
 * restauração, login por e-mail/senha, adoção do token do site (Google/cadastro),
 * sincronização contínua, bloqueios e logout.
 */

const TOKEN_STORAGE_KEYS = ['base44_access_token', 'base44_token', 'access_token'];

const STATUS = Object.freeze({
  DISCONNECTED: 'disconnected',
  CONNECTING: 'connecting',
  CONNECTED: 'connected',
  BLOCKED: 'blocked',
  OTP_REQUIRED: 'otp_required',
  ERROR: 'error',
});

class SessionManager extends EventEmitter {
  /**
   * @param {{api: object, store: object, readStorageToken?: Function, now?: Function}} options
   */
  constructor({ api, store, readStorageToken = async () => null, now = () => new Date() }) {
    super();
    this.api = api;
    this.store = store;
    this.readStorageToken = readStorageToken;
    this.now = now;
    this._token = null;
    this._state = {
      status: STATUS.DISCONNECTED,
      user: null,
      error: null,
      pendingEmail: null,
      tokenPresent: false,
      lastSyncAt: null,
      updatedAt: null,
    };
  }

  get statuses() {
    return STATUS;
  }

  currentToken() {
    return this._token;
  }

  state() {
    return {
      ...this._state,
      user: this._state.user ? { ...this._state.user } : null,
      error: this._state.error ? { ...this._state.error } : null,
    };
  }

  _update(patch) {
    this._state = { ...this._state, ...patch, updatedAt: this.now().toISOString() };
    this.emit('change', this.state());
    return this.state();
  }

  _persist(token, user, source) {
    this._token = token;
    try {
      this.store.write({ token, user, source });
    } catch {
      /* Falha ao persistir não derruba a sessão em memória. */
    }
  }

  async restore() {
    const saved = this.store.read();
    if (!saved || !saved.token) {
      this._token = null;
      return this._update({ status: STATUS.DISCONNECTED, user: null, tokenPresent: false, error: null });
    }
    this._update({ status: STATUS.CONNECTING });
    return this._validate(saved.token, saved.user || null, saved.source || 'stored');
  }

  async _validate(token, fallbackUser, source) {
    try {
      const apiUser = await this.api.me(token);
      const user = mergeUsers(sanitizeUser(apiUser || {}), fallbackUser || userFromToken(token));
      this._persist(token, user, source);
      if (user.isBlocked) {
        return this._update({ status: STATUS.BLOCKED, user, tokenPresent: true, error: null });
      }
      return this._update({
        status: STATUS.CONNECTED,
        user,
        tokenPresent: true,
        error: null,
        lastSyncAt: this.now().toISOString(),
      });
    } catch (error) {
      const code = error && error.code;
      const status = error && error.status;

      if (code === 'network_error' || code === 'timeout') {
        const cached = fallbackUser ? sanitizeUser(fallbackUser) : userFromToken(token);
        return this._update({
          status: cached ? STATUS.CONNECTED : STATUS.ERROR,
          user: cached,
          tokenPresent: Boolean(token),
          error: {
            code: code || 'network_error',
            message: error.message,
            retryable: true,
          },
        });
      }

      if (status === 401 || code === 'unauthorized') {
        this._token = null;
        this.store.clear();
        return this._update({
          status: STATUS.DISCONNECTED,
          user: null,
          tokenPresent: false,
          error: { code: 'session_expired', message: 'Sua sessão do OCTOS expirou. Entre novamente.' },
        });
      }

      if (status === 403 || code === 'forbidden') {
        const blocked = mergeUsers(sanitizeUser(fallbackUser || {}), userFromToken(token));
        blocked.isBlocked = true;
        blocked.status = blocked.status === 'active' ? 'blocked' : blocked.status;
        this._persist(token, blocked, source);
        return this._update({ status: STATUS.BLOCKED, user: blocked, tokenPresent: true, error: null });
      }

      const cached = fallbackUser ? sanitizeUser(fallbackUser) : userFromToken(token);
      return this._update({
        status: cached ? STATUS.CONNECTED : STATUS.ERROR,
        user: cached,
        tokenPresent: Boolean(token),
        error: { code: code || 'profile_unavailable', message: error.message, retryable: true },
      });
    }
  }

  async signIn({ email, password }) {
    const normalizedEmail = String(email || '').trim().toLowerCase();
    if (!normalizedEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(normalizedEmail)) {
      throw new Error('Informe um e-mail válido.');
    }
    if (typeof password !== 'string' || password.length < 6) {
      throw new Error('A senha precisa ter pelo menos 6 caracteres.');
    }

    this._update({ status: STATUS.CONNECTING, error: null });
    try {
      const result = await this.api.login({ email: normalizedEmail, password });
      if (result.requiresOtp) {
        this._update({
          status: STATUS.OTP_REQUIRED,
          pendingEmail: normalizedEmail,
          error: { code: 'otp_required', message: 'Informe o código de verificação enviado pelo OCTOS.' },
        });
        return { requiresOtp: true, email: normalizedEmail };
      }
      const user = mergeUsers(sanitizeUser(result.rawUser || {}), userFromToken(result.token));
      this._persist(result.token, user, 'password');
      this._update({
        status: user.isBlocked ? STATUS.BLOCKED : STATUS.CONNECTED,
        user,
        tokenPresent: true,
        pendingEmail: null,
        error: null,
        lastSyncAt: this.now().toISOString(),
      });
      return { requiresOtp: false, state: this.state() };
    } catch (error) {
      this._update({
        status: STATUS.DISCONNECTED,
        user: null,
        tokenPresent: false,
        error: { code: error.code || 'login_failed', message: error.message, retryable: Boolean(error.retryable) },
      });
      throw error;
    }
  }

  async verifyOtp({ email, otp, challengeId }) {
    const target = String(email || this._state.pendingEmail || '').trim().toLowerCase();
    if (!target) throw new Error('E-mail não identificado para verificação.');
    if (!otp || String(otp).trim().length < 4) throw new Error('Informe o código de verificação.');
    this._update({ status: STATUS.CONNECTING, error: null });
    try {
      const result = await this.api.verifyOtp({ email: target, otp, challengeId });
      const user = mergeUsers(sanitizeUser(result.rawUser || {}), userFromToken(result.token));
      this._persist(result.token, user, 'otp');
      this._update({
        status: user.isBlocked ? STATUS.BLOCKED : STATUS.CONNECTED,
        user,
        tokenPresent: true,
        pendingEmail: null,
        error: null,
        lastSyncAt: this.now().toISOString(),
      });
      return this.state();
    } catch (error) {
      this._update({
        status: STATUS.OTP_REQUIRED,
        pendingEmail: target,
        error: { code: error.code || 'invalid_otp', message: error.message },
      });
      throw error;
    }
  }

  /** Adota o token obtido pelo próprio site oficial (Google, cadastro, sessão existente). */
  async adoptToken(token, { source = 'site' } = {}) {
    if (typeof token !== 'string' || token.length < 10) return this.state();
    if (token === this._token) return this.state();
    this._update({ status: STATUS.CONNECTING });
    return this._validate(token, null, source);
  }

  /** Sincroniza com a sessão real do site (chamado periodicamente e após navegação). */
  async syncFromStorage() {
    let token = null;
    try {
      token = await this.readStorageToken();
    } catch {
      return this.state();
    }
    if (!token) {
      if (this._token) {
        this._token = null;
        this.store.clear();
        return this._update({
          status: STATUS.DISCONNECTED,
          user: null,
          tokenPresent: false,
          pendingEmail: null,
          error: null,
        });
      }
      return this.state();
    }
    if (token === this._token) return this.state();
    return this.adoptToken(token, { source: 'site' });
  }

  /** Revalida o token atual (detecta revogação/bloqueio no servidor). */
  async refresh() {
    if (!this._token) return this.state();
    const user = this._state.user;
    return this._validate(this._token, user, this._state.user ? 'refresh' : 'stored');
  }

  async requestPasswordReset(email) {
    const normalized = String(email || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(normalized)) throw new Error('Informe um e-mail válido.');
    await this.api.requestPasswordReset(normalized);
    return true;
  }

  async signOut() {
    const token = this._token;
    try {
      if (token) await this.api.logout(token);
    } catch {
      /* logout local acontece mesmo se o servidor falhar */
    }
    this._token = null;
    this.store.clear();
    return this._update({
      status: STATUS.DISCONNECTED,
      user: null,
      tokenPresent: false,
      pendingEmail: null,
      error: null,
      lastSyncAt: null,
    });
  }
}

module.exports = { SessionManager, STATUS, TOKEN_STORAGE_KEYS };
