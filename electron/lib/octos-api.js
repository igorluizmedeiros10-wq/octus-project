'use strict';

const { validateOctosUrl } = require('./url-policy');

/**
 * Cliente dos endpoints oficiais de autenticação do OCTOS (plataforma Base44).
 * Endpoints confirmados no SDK oficial @base44/sdk 0.8.59:
 *   POST /api/apps/auth/login
 *   POST /api/apps/auth/register
 *   POST /api/apps/auth/reset-password-request
 *   POST /api/apps/auth/reset-password
 *   POST /api/apps/auth/verify-otp
 *   POST /api/apps/auth/resend-otp
 *   POST /api/apps/auth/logout
 *   GET  /api/apps/{appId}/entities/User/me
 */

const DEFAULT_PLATFORM_URL = 'https://app.base44.com';

class OctosError extends Error {
  constructor(message, { code = 'octos_error', status = 0, retryable = false } = {}) {
    super(message);
    this.name = 'OctosError';
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}

function messageFromResponse(response, fallback) {
  const data = response && response.data;
  if (data && typeof data === 'object') {
    for (const key of ['message', 'error_description', 'detail', 'error']) {
      const value = data[key];
      if (typeof value === 'string' && value.trim()) return value.trim();
    }
  }
  return fallback;
}

function extractToken(data) {
  if (!data || typeof data !== 'object') return '';
  const direct = [data.access_token, data.token, data.id_token, data.accessToken];
  for (const value of direct) if (typeof value === 'string' && value) return value;
  if (data.data && typeof data.data === 'object') return extractToken(data.data);
  if (data.session && typeof data.session === 'object') return extractToken(data.session);
  return '';
}

function extractUser(data) {
  if (!data || typeof data !== 'object') return null;
  if (data.user && typeof data.user === 'object') return data.user;
  if (data.data && typeof data.data === 'object') return extractUser(data.data);
  return null;
}

function requiresOtp(data) {
  if (!data || typeof data !== 'object') return false;
  const flag = data.otp_required ?? data.requires_otp ?? data.mfa_required ?? data.requires_verification;
  if (flag === true) return true;
  return data.status === 'otp_required' || data.status === 'mfa_required';
}

class OctosApi {
  /**
   * @param {{siteUrl: string, platformUrl?: string, appId?: string, fetchImpl?: Function, timeoutMs?: number}} options
   */
  constructor({ siteUrl, platformUrl = DEFAULT_PLATFORM_URL, appId = '', fetchImpl, timeoutMs = 15000 }) {
    const site = validateOctosUrl(siteUrl);
    if (!site.ok) throw new OctosError(site.error, { code: 'invalid_url' });
    const platform = validateOctosUrl(platformUrl);
    this.siteOrigin = site.origin;
    this.siteUrl = site.url;
    this.platformOrigin = platform.ok ? platform.origin : DEFAULT_PLATFORM_URL;
    this.appId = appId || '';
    this.fetchImpl = fetchImpl || globalThis.fetch;
    this.timeoutMs = timeoutMs;
  }

  get bases() {
    return [...new Set([this.platformOrigin, this.siteOrigin])];
  }

  setAppId(appId) {
    if (typeof appId === 'string' && appId) this.appId = appId;
  }

  async _fetchJson(base, path, { method = 'GET', body, token, headers = {} } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(`${base}${path}`, {
        method,
        headers: {
          accept: 'application/json',
          ...(body ? { 'content-type': 'application/json' } : {}),
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...headers,
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
        redirect: 'follow',
      });
      const text = await response.text();
      let data = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        data = { raw: String(text).slice(0, 500) };
      }
      return { ok: response.ok, status: response.status, data };
    } catch (error) {
      if (error && error.name === 'AbortError') {
        throw new OctosError('O OCTOS demorou para responder. Tente novamente.', {
          code: 'timeout',
          retryable: true,
        });
      }
      throw new OctosError('Não foi possível falar com o OCTOS. Verifique sua conexão e a URL configurada.', {
        code: 'network_error',
        retryable: true,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  /** Tenta a plataforma Base44 e, se o caminho não existir lá, o próprio domínio do site. */
  async request(path, options = {}) {
    let lastResponse = null;
    let lastError = null;
    for (const base of this.bases) {
      try {
        const response = await this._fetchJson(base, path, options);
        if (response.status !== 404) return response;
        lastResponse = response;
      } catch (error) {
        lastError = error;
        if (error.code === 'timeout') throw error;
      }
    }
    if (lastResponse) return lastResponse;
    throw lastError || new OctosError('Falha de comunicação com o OCTOS.', { code: 'network_error', retryable: true });
  }

  async login({ email, password }) {
    const payload = { email: String(email || '').trim().toLowerCase(), password: String(password || ''), app_id: this.appId };
    const response = await this.request('/api/apps/auth/login', { method: 'POST', body: payload });

    if (response.status === 400 || response.status === 401) {
      throw new OctosError('E-mail ou senha incorretos.', { code: 'invalid_credentials', status: response.status });
    }
    if (response.status === 403) {
      throw new OctosError('O OCTOS bloqueou o acesso desta conta.', { code: 'account_blocked', status: response.status });
    }
    if (response.status === 429) {
      throw new OctosError('Muitas tentativas. Aguarde alguns instantes e tente novamente.', {
        code: 'rate_limited',
        status: response.status,
        retryable: true,
      });
    }
    if (!response.ok) {
      throw new OctosError(messageFromResponse(response, 'Não foi possível entrar no OCTOS.'), {
        code: 'login_failed',
        status: response.status,
      });
    }

    const token = extractToken(response.data);
    if (!token) {
      if (requiresOtp(response.data)) {
        return { requiresOtp: true, email: payload.email, challengeId: response.data.challenge_id || null };
      }
      throw new OctosError('O OCTOS não retornou uma sessão válida.', { code: 'no_token', status: response.status });
    }
    return { requiresOtp: false, token, rawUser: extractUser(response.data) };
  }

  async verifyOtp({ email, otp, challengeId }) {
    const payload = {
      email: String(email || '').trim().toLowerCase(),
      otp: String(otp || '').trim(),
      code: String(otp || '').trim(),
      app_id: this.appId,
      ...(challengeId ? { challenge_id: challengeId } : {}),
    };
    const response = await this.request('/api/apps/auth/verify-otp', { method: 'POST', body: payload });
    if (!response.ok) {
      throw new OctosError(messageFromResponse(response, 'Código de verificação inválido.'), {
        code: 'invalid_otp',
        status: response.status,
      });
    }
    const token = extractToken(response.data);
    if (!token) throw new OctosError('O OCTOS não retornou uma sessão válida.', { code: 'no_token' });
    return { token, rawUser: extractUser(response.data) };
  }

  async register({ email, password, fullName }) {
    const payload = {
      email: String(email || '').trim().toLowerCase(),
      password: String(password || ''),
      full_name: String(fullName || '').trim(),
      app_id: this.appId,
    };
    const response = await this.request('/api/apps/auth/register', { method: 'POST', body: payload });
    if (response.status === 409) {
      throw new OctosError('Já existe uma conta OCTOS com este e-mail.', { code: 'email_taken', status: 409 });
    }
    if (!response.ok) {
      throw new OctosError(messageFromResponse(response, 'Não foi possível criar a conta no OCTOS.'), {
        code: 'register_failed',
        status: response.status,
      });
    }
    const token = extractToken(response.data);
    return { token: token || null, rawUser: extractUser(response.data) };
  }

  async requestPasswordReset(email) {
    const payload = { email: String(email || '').trim().toLowerCase(), app_id: this.appId };
    const response = await this.request('/api/apps/auth/reset-password-request', { method: 'POST', body: payload });
    if (!response.ok) {
      throw new OctosError(messageFromResponse(response, 'Não foi possível solicitar a recuperação de senha.'), {
        code: 'reset_request_failed',
        status: response.status,
      });
    }
    return true;
  }

  async resetPassword({ token, password }) {
    const payload = { token: String(token || '').trim(), new_password: String(password || ''), app_id: this.appId };
    const response = await this.request('/api/apps/auth/reset-password', { method: 'POST', body: payload });
    if (!response.ok) {
      throw new OctosError(messageFromResponse(response, 'Não foi possível redefinir a senha.'), {
        code: 'reset_failed',
        status: response.status,
      });
    }
    return true;
  }

  async logout(token) {
    if (!token) return true;
    try {
      const response = await this.request('/api/apps/auth/logout', { method: 'POST', body: {}, token });
      return response.ok || response.status === 401;
    } catch {
      return false;
    }
  }

  /** Perfil oficial do usuário autenticado. */
  async me(token) {
    if (!token) throw new OctosError('Sessão ausente.', { code: 'unauthorized', status: 401 });
    const paths = [];
    if (this.appId) paths.push(`/api/apps/${this.appId}/entities/User/me`);
    if (this.appId) paths.push(`/api/apps/${this.appId}/auth/me`);

    let lastStatus = 0;
    for (const path of paths) {
      const response = await this.request(path, { token });
      if (response.ok) {
        const data = response.data;
        if (data && typeof data === 'object') {
          const user = data.user && typeof data.user === 'object' ? data.user : data.data && typeof data.data === 'object' ? data.data : data;
          if (user && typeof user === 'object' && Object.keys(user).length) return user;
        }
        continue;
      }
      lastStatus = response.status;
      if (response.status === 401) {
        throw new OctosError('Sua sessão do OCTOS expirou.', { code: 'unauthorized', status: 401 });
      }
      if (response.status === 403) {
        throw new OctosError('O OCTOS não autoriza esta conta.', { code: 'forbidden', status: 403 });
      }
    }
    throw new OctosError('Não foi possível carregar o perfil no OCTOS.', {
      code: lastStatus === 401 ? 'unauthorized' : 'profile_unavailable',
      status: lastStatus || 0,
    });
  }

  /** Descobre o app-id Base44 a partir do HTML do site (data-app-id). */
  async resolveAppId() {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(this.siteUrl || this.siteOrigin, {
        headers: { accept: 'text/html' },
        signal: controller.signal,
      });
      const html = await response.text();
      const match = html.match(/data-app-id="([a-zA-Z0-9]{6,64})"/);
      if (match) {
        this.appId = match[1];
        return match[1];
      }
      return null;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}

module.exports = { OctosApi, OctosError, DEFAULT_PLATFORM_URL, extractToken };
