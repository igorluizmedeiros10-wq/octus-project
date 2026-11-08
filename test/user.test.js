'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { sanitizeUser, userFromToken, mergeUsers, decodeJwtPayload } = require('../electron/lib/user');

function fakeJwt(payload) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode(payload)}.assinatura`;
}

test('normaliza o perfil oficial sem expor campos sensíveis', () => {
  const user = sanitizeUser({
    id: 'u_1',
    email: 'Ana@Empresa.com',
    full_name: 'Ana Souza',
    avatar_url: 'https://media.base44.com/ana.png',
    role: 'admin',
    status: 'active',
    password: 'nao-deve-sair',
    access_token: 'nao-deve-sair',
  });

  assert.equal(user.email, 'ana@empresa.com');
  assert.equal(user.fullName, 'Ana Souza');
  assert.equal(user.avatarUrl, 'https://media.base44.com/ana.png');
  assert.equal(user.isAdmin, true);
  assert.equal(user.isBlocked, false);
  assert.deepEqual(Object.keys(user).sort(), [
    'avatarUrl',
    'createdAt',
    'email',
    'fullName',
    'id',
    'isAdmin',
    'isBlocked',
    'role',
    'status',
  ]);
});

test('reconhece contas bloqueadas ou suspensas definidas pelo OCTOS', () => {
  assert.equal(sanitizeUser({ status: 'blocked' }).isBlocked, true);
  assert.equal(sanitizeUser({ status: 'suspended' }).isBlocked, true);
  assert.equal(sanitizeUser({ disabled: true }).isBlocked, true);
  assert.equal(sanitizeUser({ is_blocked: true }).isBlocked, true);
  assert.equal(sanitizeUser({ role: 'blocked' }).isBlocked, true);
  assert.equal(sanitizeUser({ status: 'active' }).isBlocked, false);
});

test('extrai identidade do token oficial como fallback', () => {
  const token = fakeJwt({
    sub: 'u_9',
    email: 'bruno@empresa.com',
    name: 'Bruno Lima',
    picture: 'https://media.base44.com/bruno.png',
  });

  const payload = decodeJwtPayload(token);
  assert.equal(payload.sub, 'u_9');

  const user = userFromToken(token);
  assert.equal(user.id, 'u_9');
  assert.equal(user.email, 'bruno@empresa.com');
  assert.equal(user.fullName, 'Bruno Lima');
  assert.equal(user.avatarUrl, 'https://media.base44.com/bruno.png');
});

test('token inválido não quebra a identificação', () => {
  assert.equal(userFromToken('token-invalido'), null);
  assert.equal(decodeJwtPayload(''), null);
  assert.equal(decodeJwtPayload(null), null);
});

test('mergeUsers prioriza a API e completa com o token', () => {
  const apiUser = sanitizeUser({ id: 'u_1', email: 'ana@empresa.com', status: 'active' });
  const tokenUser = userFromToken(fakeJwt({ sub: 'u_1', name: 'Ana Souza', picture: 'https://x/y.png' }));

  const merged = mergeUsers(apiUser, tokenUser);
  assert.equal(merged.email, 'ana@empresa.com');
  assert.equal(merged.fullName, 'Ana Souza');
  assert.equal(merged.avatarUrl, 'https://x/y.png');
  assert.equal(merged.isBlocked, false);
});
