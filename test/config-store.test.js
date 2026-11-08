'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { ConfigStore, ConfigError, DEFAULT_CONFIG } = require('../electron/lib/config-store');

function buildStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'octos-config-'));
  return { dir, store: new ConfigStore({ filePath: path.join(dir, 'config.json') }) };
}

test('usa a URL oficial do OCTOS por padrão', () => {
  const { store } = buildStore();
  const config = store.read();
  assert.equal(config.octosUrl, 'https://octos-access-core.base44.app');
  assert.equal(config.appId, '6af08b29a691a162e5738c97');
  assert.equal(config.platformUrl, 'https://app.base44.com');
});

test('permite trocar a URL do OCTOS sem recompilar e persiste a escolha', () => {
  const { dir, store } = buildStore();
  store.save({ octosUrl: 'https://octos.minhaempresa.com/app/' });

  const config = store.read();
  assert.equal(config.octosUrl, 'https://octos.minhaempresa.com/app');
  assert.equal(config.origin, 'https://octos.minhaempresa.com');

  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
  assert.equal(onDisk.octosUrl, 'https://octos.minhaempresa.com/app');
  assert.ok(onDisk.updatedAt);
});

test('rejeita URL insegura ou inválida ao salvar', () => {
  const { store } = buildStore();
  assert.throws(() => store.save({ octosUrl: 'http://octos-access-core.base44.app' }), ConfigError);
  assert.throws(() => store.save({ octosUrl: 'javascript:alert(1)' }), ConfigError);
  assert.equal(store.read().octosUrl, DEFAULT_CONFIG.octosUrl);
});

test('rejeita app id inválido', () => {
  const { store } = buildStore();
  assert.throws(() => store.save({ appId: '../etc/passwd' }), ConfigError);
});

test('configuração corrompida volta ao padrão sem quebrar', () => {
  const { dir, store } = buildStore();
  fs.writeFileSync(path.join(dir, 'config.json'), '{ nao-e-json');
  assert.equal(store.read().octosUrl, DEFAULT_CONFIG.octosUrl);
});
