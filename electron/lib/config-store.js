'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { validateOctosUrl } = require('./url-policy');

/**
 * Configuração persistida em userData/config.json.
 * Permite trocar a URL do OCTOS sem recompilar o aplicativo.
 */

const DEFAULT_CONFIG = Object.freeze({
  octosUrl: 'https://octos-access-core.base44.app',
  appId: '6af08b29a691a162e5738c97',
  platformUrl: 'https://app.base44.com',
});

class ConfigError extends Error {
  constructor(message, code = 'invalid_config') {
    super(message);
    this.name = 'ConfigError';
    this.code = code;
  }
}

class ConfigStore {
  constructor({ filePath, fsImpl = fs }) {
    if (!filePath) throw new ConfigError('filePath é obrigatório.');
    this.filePath = filePath;
    this.fs = fsImpl;
  }

  read() {
    let stored = {};
    try {
      stored = JSON.parse(this.fs.readFileSync(this.filePath, 'utf8')) || {};
    } catch {
      stored = {};
    }
    if (!stored || typeof stored !== 'object') stored = {};

    const candidate = typeof stored.octosUrl === 'string' ? stored.octosUrl : DEFAULT_CONFIG.octosUrl;
    const validation = validateOctosUrl(candidate);
    const fallback = validateOctosUrl(DEFAULT_CONFIG.octosUrl);

    return {
      octosUrl: validation.ok ? validation.url : fallback.url,
      origin: validation.ok ? validation.origin : fallback.origin,
      appId: typeof stored.appId === 'string' && /^[a-zA-Z0-9]+$/.test(stored.appId) ? stored.appId : DEFAULT_CONFIG.appId,
      platformUrl:
        typeof stored.platformUrl === 'string' && validateOctosUrl(stored.platformUrl).ok
          ? validateOctosUrl(stored.platformUrl).url
          : DEFAULT_CONFIG.platformUrl,
      updatedAt: typeof stored.updatedAt === 'string' ? stored.updatedAt : null,
    };
  }

  save(patch = {}) {
    const current = this.read();
    const next = {
      octosUrl: current.octosUrl,
      appId: current.appId,
      platformUrl: current.platformUrl,
    };

    if (patch.octosUrl !== undefined) {
      const validation = validateOctosUrl(patch.octosUrl);
      if (!validation.ok) throw new ConfigError(validation.error, 'invalid_url');
      next.octosUrl = validation.url;
    }

    if (patch.platformUrl !== undefined) {
      const validation = validateOctosUrl(patch.platformUrl);
      if (!validation.ok) throw new ConfigError('URL da plataforma Base44 inválida.', 'invalid_url');
      next.platformUrl = validation.url;
    }

    if (patch.appId !== undefined) {
      const appId = String(patch.appId || '').trim();
      if (appId && !/^[a-zA-Z0-9]{6,64}$/.test(appId)) {
        throw new ConfigError('App ID do Base44 inválido.', 'invalid_app_id');
      }
      next.appId = appId || current.appId;
    }

    this.fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const payload = JSON.stringify({ ...next, updatedAt: new Date().toISOString() }, null, 2);
    const tmp = `${this.filePath}.tmp`;
    this.fs.writeFileSync(tmp, payload, { mode: 0o600 });
    this.fs.renameSync(tmp, this.filePath);
    return this.read();
  }
}

module.exports = { ConfigStore, ConfigError, DEFAULT_CONFIG };
