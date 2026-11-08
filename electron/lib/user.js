'use strict';

/**
 * Normaliza os dados do usuário devolvidos pelo OCTOS/Base44.
 * Nenhum campo sensível (senha, token, metadados internos) sai deste módulo.
 */

const BLOCKED_STATUS = new Set(['blocked', 'suspended', 'disabled', 'inactive', 'banned', 'bloqueado']);
const ADMIN_ROLES = new Set(['admin', 'owner', 'administrator']);

function pickString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function decodeJwtPayload(token) {
  try {
    const parts = String(token || '').split('.');
    if (parts.length < 2) return null;
    const normalized = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), '=');
    const payload = JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
    return payload && typeof payload === 'object' ? payload : null;
  } catch {
    return null;
  }
}

/**
 * @param {Record<string, unknown>} [raw]
 * @returns {{id:string,email:string,fullName:string,avatarUrl:string,role:string,status:string,isBlocked:boolean,isAdmin:boolean,createdAt:string}}
 */
function sanitizeUser(raw = {}) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const status = pickString(source.status, source.account_status).toLowerCase();
  const role = pickString(source.role, 'user').toLowerCase();
  const isBlocked =
    source.disabled === true ||
    source.blocked === true ||
    source.is_blocked === true ||
    source.suspended === true ||
    BLOCKED_STATUS.has(status) ||
    role === 'blocked';

  return {
    id: pickString(source.id, source._id, source.user_id, source.userId),
    email: pickString(source.email).toLowerCase(),
    fullName:
      pickString(source.full_name, source.fullName, source.name, source.display_name, source.displayName) ||
      pickString(source.email),
    avatarUrl: pickString(
      source.avatar_url,
      source.avatarUrl,
      source.picture,
      source.photo_url,
      source.image,
      source.profile_image,
    ),
    role,
    status: status || (isBlocked ? 'blocked' : 'active'),
    isBlocked,
    isAdmin: ADMIN_ROLES.has(role),
    createdAt: pickString(source.created_date, source.createdAt),
  };
}

/** Extrai identidade do JWT oficial (usado como fallback quando /me não responde). */
function userFromToken(token) {
  const payload = decodeJwtPayload(token);
  if (!payload) return null;
  return sanitizeUser({
    id: payload.sub || payload.user_id || payload.uid,
    email: payload.email,
    full_name: payload.name || payload.full_name,
    avatar_url: payload.picture || payload.avatar_url,
    role: payload.role,
  });
}

/**
 * Combina o perfil vindo da API com o perfil derivado do token.
 * A API tem prioridade; o token preenche apenas campos vazios.
 */
function mergeUsers(apiUser, tokenUser) {
  const primary = sanitizeUser(apiUser || {});
  const secondary = tokenUser ? sanitizeUser(tokenUser) : null;
  if (!secondary) return primary;
  const merged = {
    ...primary,
    id: primary.id || secondary.id,
    email: primary.email || secondary.email,
    fullName: primary.fullName || secondary.fullName,
    avatarUrl: primary.avatarUrl || secondary.avatarUrl,
    role: primary.role && primary.role !== 'user' ? primary.role : secondary.role,
    status: primary.status || secondary.status,
    isBlocked: primary.isBlocked || secondary.isBlocked,
  };
  merged.isAdmin = ADMIN_ROLES.has(merged.role);
  return merged;
}

module.exports = { sanitizeUser, userFromToken, mergeUsers, decodeJwtPayload };
