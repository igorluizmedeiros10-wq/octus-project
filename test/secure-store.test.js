'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  SecureStore,
  createFallbackCrypto,
  assertNoSecrets,
  SecretsNotAllowedError,
} = require('../electron/lib/secure-store');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'octos-secure-'));
}

function buildStore() {
  const dir = tempDir();
  const keyPath = path.join(dir, 'session.key');
  const filePath = path.join(dir, 'session.bin');
  const store = new SecureStore({ filePath, cryptoProvider: createFallbackCrypto({ keyPath }) });
  return { dir, keyPath, filePath, store };
}

test('sessão é cifrada em disco e recuperada corretamente', () => {
  const { filePath, store } = buildStore();
  const token = 'token-oficial-octos-1234567890';

  assert.equal(store.write({ token, user: { email: 'ana@empresa.com' } }), true);

  const raw = fs.readFileSync(filePath, 'utf8');
  assert.equal(raw.includes(token), false, 'o token não pode aparecer em texto puro');
  assert.equal(raw.includes('ana@empresa.com'), false, 'dados do perfil também são cifrados');

  const restored = store.read();
  assert.equal(restored.token, token);
  assert.equal(restored.user.email, 'ana@empresa.com');
  assert.equal(store.backend, 'aes-256-gcm');
});

test('arquivo de sessão tem permissões restritas', () => {
  const { filePath, keyPath, store } = buildStore();
  store.write({ token: 'abc1234567890' });

  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(filePath).mode & 0o777, 0o600);
    assert.equal(fs.statSync(keyPath).mode & 0o777, 0o600);
  }
});

test('senhas nunca são gravadas', () => {
  const { filePath, store } = buildStore();
  assert.throws(
    () => store.write({ token: 'abc', password: 'segredo' }),
    SecretsNotAllowedError,
  );
  assert.equal(fs.existsSync(filePath), false);

  assert.throws(() => assertNoSecrets({ nested: { senha: 'x' } }), SecretsNotAllowedError);
  assert.throws(() => assertNoSecrets({ new_password: 'x' }), SecretsNotAllowedError);
  assert.doesNotThrow(() => assertNoSecrets({ token: 'abc', user: { email: 'a@b.com' } }));
});

test('clear remove a sessão e read devolve null', () => {
  const { filePath, store } = buildStore();
  store.write({ token: 'abc1234567890' });
  assert.equal(store.read().token, 'abc1234567890');

  store.clear();
  assert.equal(fs.existsSync(filePath), false);
  assert.equal(store.read(), null);
});

test('arquivo corrompido ou adulterado não é aceito', () => {
  const { filePath, store } = buildStore();
  store.write({ token: 'abc1234567890' });

  const payload = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  payload.data = Buffer.from('conteudo- adulterado').toString('base64');
  fs.writeFileSync(filePath, JSON.stringify(payload));

  assert.equal(store.read(), null);
});
