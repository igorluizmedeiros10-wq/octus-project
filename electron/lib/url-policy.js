'use strict';

/**
 * Política de URLs do aplicativo.
 *
 * Regras:
 *  - A URL do OCTOS precisa ser HTTPS (HTTP apenas para localhost em desenvolvimento).
 *  - A janela integrada só navega no próprio site do OCTOS ou em domínios oficiais
 *    de autenticação (Base44 / Google). Qualquer outro destino abre no navegador padrão.
 */

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const TRUSTED_AUTH_DOMAINS = ['base44.com', 'base44.app', 'google.com', 'gstatic.com'];

function parseUrl(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 2048) return null;
  try {
    return new URL(trimmed);
  } catch {
    return null;
  }
}

function hostMatches(hostname, domain) {
  const host = String(hostname || '').toLowerCase();
  return host === domain || host.endsWith(`.${domain}`);
}

function isSecureProtocol(url) {
  if (!url) return false;
  if (url.protocol === 'https:') return true;
  return url.protocol === 'http:' && LOCAL_HOSTS.has(url.hostname.toLowerCase());
}

/**
 * Valida e normaliza a URL do site OCTOS.
 * @returns {{ok: true, url: string, origin: string, hostname: string} | {ok: false, error: string}}
 */
function validateOctosUrl(value) {
  const url = parseUrl(value);
  if (!url) {
    return { ok: false, error: 'Informe uma URL válida (ex.: https://octos-access-core.base44.app).' };
  }
  if (!isSecureProtocol(url)) {
    return { ok: false, error: 'A URL do OCTOS precisa usar HTTPS (HTTP é aceito apenas para localhost).' };
  }
  if (url.username || url.password) {
    return { ok: false, error: 'A URL não pode conter usuário ou senha embutidos.' };
  }
  if (!url.hostname) {
    return { ok: false, error: 'A URL precisa conter um domínio.' };
  }
  const pathname = url.pathname.replace(/\/+$/, '');
  return {
    ok: true,
    url: `${url.protocol}//${url.host}${pathname}`,
    origin: `${url.protocol}//${url.host}`,
    hostname: url.hostname.toLowerCase(),
  };
}

function isSameOrigin(target, origin) {
  const url = parseUrl(target);
  if (!url || !origin) return false;
  const parsedOrigin = parseUrl(origin);
  if (!parsedOrigin) return false;
  return parsedOrigin.origin === url.origin;
}

function isTrustedAuthUrl(target) {
  const url = parseUrl(target);
  if (!url) return false;
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;
  return TRUSTED_AUTH_DOMAINS.some((domain) => hostMatches(url.hostname, domain));
}

/** Navegação de nível superior permitida dentro da janela integrada. */
function isAllowedTopLevelNavigation(target, siteOrigin) {
  return isSameOrigin(target, siteOrigin) || isTrustedAuthUrl(target);
}

/** Popups permitidos (OAuth do Google, fluxo de autenticação do Base44). */
function isAllowedPopup(target, siteOrigin) {
  return isSameOrigin(target, siteOrigin) || isTrustedAuthUrl(target);
}

function isExternalScheme(target) {
  const url = parseUrl(target);
  return Boolean(url) && ['mailto:', 'tel:'].includes(url.protocol);
}

module.exports = {
  validateOctosUrl,
  isSameOrigin,
  isTrustedAuthUrl,
  isAllowedTopLevelNavigation,
  isAllowedPopup,
  isExternalScheme,
  hostMatches,
  parseUrl,
};
