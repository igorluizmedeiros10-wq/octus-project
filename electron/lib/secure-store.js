'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

/**
 * Armazenamento da sessão em disco, sempre cifrado.
 *
 * - Em produção no Windows usa safeStorage (DPAPI, vinculado ao usuário do Windows).
 * - Fallback (ex.: Linux sem keyring) usa AES-256-GCM com chave local 0600.
 * - Senhas nunca são gravadas: qualquer payload com campo de senha é rejeitado.
 */

const FORBIDDEN_KEYS = ['password', 'senha', 'passphrase', 'new_password', 'newPassword'];
const SESSION_FILE_VERSION = 1;

function assertNoSecrets(payload, source = 'session') {
  if (!payload || typeof payload !== 'object') return;
  for (const key of Object.keys(payload)) {
    if (FORBIDDEN_KEYS.includes(key)) {
      throw new Error(`Campo sensível "${key}" não pode ser persistido (${source}).`);
    }
    const value = payload[key];
    if (value && typeof value === 'object') assertNoSecrets(value, source);
  }
}

function writePrivateFile(fsImpl, filePath, data) {
  fsImpl.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  fsImpl.writeFileSync(tmp, data, { mode: 0o600 });
  fsImpl.renameSync(tmp, filePath);
  try {
    fsImpl.chmodSync(filePath, 0o600);
  } catch {
    /* Windows não aplica POSIX; DPAPI já protege o conteúdo. */
  }
}

class SecureStore {
  /**
   * @param {{filePath: string, cryptoProvider: {name: string, encrypt: Function, decrypt: Function}, fsImpl?: typeof fs}} options
   */
  constructor({ filePath, cryptoProvider, fsImpl = fs }) {
    if (!filePath) throw new Error('filePath é obrigatório.');
    if (!cryptoProvider) throw new Error('cryptoProvider é obrigatório.');
    this.filePath = filePath;
    this.crypto = cryptoProvider;
    this.fs = fsImpl;
  }

  get backend() {
    return this.crypto.name;
  }

  read() {
    let raw;
    try {
      raw = JSON.parse(this.fs.readFileSync(this.filePath, 'utf8'));
    } catch {
      return null;
    }
    if (!raw || raw.version !== SESSION_FILE_VERSION || typeof raw.payload !== 'string') return null;
    try {
      const decrypted = this.crypto.decrypt(Buffer.from(raw.payload, 'base64'));
      const session = JSON.parse(decrypted);
      if (!session || typeof session.token !== 'string' || !session.token) return null;
      return session;
    } catch {
      return null;
    }
  }

  write(session) {
    if (!session || typeof session.token !== 'string' || !session.token) {
      throw new Error('Sessão inválida: token ausente.');
    }
    assertNoSecrets(session);
    const payload = JSON.stringify({ ...session, savedAt: session.savedAt || new Date().toISOString() });
    const encrypted = this.crypto.encrypt(payload);
    writePrivateFile(
      this.fs,
      this.filePath,
      JSON.stringify(
        {
          version: SESSION_FILE_VERSION,
          backend: this.crypto.name,
          payload: Buffer.from(encrypted).toString('base64'),
        },
        null,
        2,
      ),
    );
    return true;
  }

  clear() {
    try {
      this.fs.rmSync(this.filePath, { force: true });
      return true;
    } catch {
      return false;
    }
  }
}

/** Provedor de criptografia baseado em Electron safeStorage (DPAPI no Windows). */
function createElectronCrypto(safeStorage, fallback) {
  const available = (() => {
    try {
      return Boolean(safeStorage && safeStorage.isEncryptionAvailable());
    } catch {
      return false;
    }
  })();

  if (!available) return fallback;

  return {
    name: 'electron-safeStorage',
    encrypt(value) {
      return safeStorage.encryptString(value);
    },
    decrypt(buffer) {
      return safeStorage.decryptString(Buffer.from(buffer));
    },
  };
}

/** Fallback AES-256-GCM com chave local protegida por permissões 0600. */
function createFallbackCrypto({ keyPath, fsImpl = fs }) {
  const loadKey = () => {
    try {
      const existing = fsImpl.readFileSync(keyPath);
      if (existing.length === 32) return existing;
    } catch {
      /* gera nova chave abaixo */
    }
    const key = crypto.randomBytes(32);
    writePrivateFile(fsImpl, keyPath, key);
    return key;
  };

  return {
    name: 'aes-256-gcm',
    encrypt(value) {
      const key = loadKey();
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
      const encrypted = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), encrypted]);
    },
    decrypt(buffer) {
      const key = loadKey();
      const data = Buffer.from(buffer);
      const iv = data.subarray(0, 12);
      const tag = data.subarray(12, 28);
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString('utf8');
    },
  };
}

module.exports = { SecureStore, createElectronCrypto, createFallbackCrypto, assertNoSecrets };
