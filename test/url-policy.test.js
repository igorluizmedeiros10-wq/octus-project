'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  validateOctosUrl,
  isAllowedTopLevelNavigation,
  isAllowedPopup,
  isSameOrigin,
  isTrustedAuthUrl,
} = require('../electron/lib/url-policy');

const OCTOS = 'https://octos-access-core.base44.app';

test('aceita a URL oficial do OCTOS em HTTPS', () => {
  const result = validateOctosUrl(`${OCTOS}/`);
  assert.equal(result.ok, true);
  assert.equal(result.url, OCTOS);
  assert.equal(result.origin, OCTOS);
});

test('rejeita HTTP fora de localhost', () => {
  const result = validateOctosUrl('http://octos-access-core.base44.app');
  assert.equal(result.ok, false);
  assert.match(result.error, /HTTPS/i);
});

test('aceita HTTP apenas em localhost para desenvolvimento', () => {
  assert.equal(validateOctosUrl('http://localhost:3000').ok, true);
  assert.equal(validateOctosUrl('http://127.0.0.1:5173').ok, true);
});

test('rejeita URL com credenciais embutidas e entradas inválidas', () => {
  assert.equal(validateOctosUrl('https://user:pass@octos-access-core.base44.app').ok, false);
  assert.equal(validateOctosUrl('nao-e-url').ok, false);
  assert.equal(validateOctosUrl('javascript:alert(1)').ok, false);
  assert.equal(validateOctosUrl('').ok, false);
});

test('permite navegação no próprio OCTOS e nos provedores oficiais de login', () => {
  assert.equal(isAllowedTopLevelNavigation(`${OCTOS}/_authed`, OCTOS), true);
  assert.equal(isAllowedTopLevelNavigation('https://accounts.google.com/o/oauth2/v2/auth', OCTOS), true);
  assert.equal(isAllowedTopLevelNavigation('https://app.base44.com/login', OCTOS), true);
  assert.equal(isAllowedPopup('https://accounts.google.com/signin', OCTOS), true);
});

test('bloqueia navegação para domínios de terceiros', () => {
  assert.equal(isAllowedTopLevelNavigation('https://evil.example.com/phishing', OCTOS), false);
  assert.equal(isAllowedPopup('https://evil.example.com', OCTOS), false);
  assert.equal(isTrustedAuthUrl('https://evil.example.com'), false);
  assert.equal(isSameOrigin('https://evil.example.com', OCTOS), false);
});
