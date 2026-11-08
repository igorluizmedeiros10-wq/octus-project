'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { OctosApi, OctosError, extractToken } = require('../electron/lib/octos-api');

const SITE = 'https://octos-access-core.base44.app';
const APP_ID = '6af08b29a691a162e5738c97';

function mockFetch(responses) {
  const calls = [];
  const impl = async (url, options = {}) => {
    calls.push({ url, options });
    const next = responses.shift();
    if (!next) throw new Error(`Sem resposta simulada para ${url}`);
    const status = next.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => (typeof next.body === 'string' ? next.body : JSON.stringify(next.body ?? null)),
    };
  };
  impl.calls = calls;
  return impl;
}

function apiWith(responses) {
  const fetchImpl = mockFetch(responses);
  const api = new OctosApi({ siteUrl: SITE, platformUrl: SITE, appId: APP_ID, fetchImpl });
  return { api, fetchImpl };
}

test('login usa o endpoint oficial e devolve token e perfil', async () => {
  const { api, fetchImpl } = apiWith([
    {
      body: {
        access_token: 'token-oficial-123456',
        user: { id: 'u1', email: 'ana@empresa.com', full_name: 'Ana' },
      },
    },
  ]);

  const result = await api.login({ email: 'Ana@Empresa.com', password: 'senha-forte' });

  assert.equal(result.requiresOtp, false);
  assert.equal(result.token, 'token-oficial-123456');
  assert.equal(result.rawUser.email, 'ana@empresa.com');

  const [call] = fetchImpl.calls;
  assert.equal(call.url, `${SITE}/api/apps/auth/login`);
  assert.equal(call.options.method, 'POST');
  const body = JSON.parse(call.options.body);
  assert.equal(body.email, 'ana@empresa.com');
  assert.equal(body.app_id, APP_ID);
});

test('credenciais inválidas geram erro claro e não criam sessão', async () => {
  const { api } = apiWith([{ status: 401, body: { message: 'invalid credentials' } }]);

  await assert.rejects(
    () => api.login({ email: 'ana@empresa.com', password: 'errada' }),
    (error) => {
      assert.equal(error instanceof OctosError, true);
      assert.equal(error.code, 'invalid_credentials');
      return true;
    },
  );
});

test('conta bloqueada pelo OCTOS (403) é reconhecida', async () => {
  const { api } = apiWith([{ status: 403, body: { message: 'blocked' } }]);
  await assert.rejects(
    () => api.login({ email: 'ana@empresa.com', password: 'senha-forte' }),
    (error) => error.code === 'account_blocked',
  );
});

test('login com verificação em duas etapas informa OTP', async () => {
  const { api } = apiWith([{ body: { otp_required: true, challenge_id: 'ch_1' } }]);
  const result = await api.login({ email: 'ana@empresa.com', password: 'senha-forte' });
  assert.equal(result.requiresOtp, true);
  assert.equal(result.challengeId, 'ch_1');
});

test('verificação de OTP devolve a sessão oficial', async () => {
  const { api, fetchImpl } = apiWith([{ body: { access_token: 'token-otp-123456' } }]);
  const result = await api.verifyOtp({ email: 'ana@empresa.com', otp: '123456', challengeId: 'ch_1' });
  assert.equal(result.token, 'token-otp-123456');
  assert.equal(fetchImpl.calls[0].url, `${SITE}/api/apps/auth/verify-otp`);
});

test('cadastro usa o endpoint oficial e trata e-mail já cadastrado', async () => {
  const ok = apiWith([{ body: { access_token: 'token-novo-123456' } }]);
  const created = await ok.api.register({ email: 'novo@empresa.com', password: 'senha-forte', fullName: 'Novo' });
  assert.equal(created.token, 'token-novo-123456');
  assert.equal(ok.fetchImpl.calls[0].url, `${SITE}/api/apps/auth/register`);

  const conflict = apiWith([{ status: 409, body: { message: 'exists' } }]);
  await assert.rejects(
    () => conflict.api.register({ email: 'novo@empresa.com', password: 'senha-forte' }),
    (error) => error.code === 'email_taken',
  );
});

test('recuperação de senha usa os endpoints oficiais', async () => {
  const request = apiWith([{ body: { ok: true } }]);
  assert.equal(await request.api.requestPasswordReset('ana@empresa.com'), true);
  assert.equal(request.fetchImpl.calls[0].url, `${SITE}/api/apps/auth/reset-password-request`);

  const reset = apiWith([{ body: { ok: true } }]);
  assert.equal(await reset.api.resetPassword({ token: 'token-recuperacao', password: 'nova-senha-forte' }), true);
  assert.equal(reset.fetchImpl.calls[0].url, `${SITE}/api/apps/auth/reset-password`);
});

test('perfil oficial é lido com o token do usuário', async () => {
  const { api, fetchImpl } = apiWith([
    { body: { user: { id: 'u1', email: 'ana@empresa.com', full_name: 'Ana', role: 'admin' } } },
  ]);
  const user = await api.me('token-oficial-123456');

  assert.equal(user.email, 'ana@empresa.com');
  assert.equal(user.role, 'admin');
  assert.equal(fetchImpl.calls[0].url, `${SITE}/api/apps/${APP_ID}/entities/User/me`);
  assert.equal(fetchImpl.calls[0].options.headers.authorization, 'Bearer token-oficial-123456');
});

test('token expirado (401) encerra a sessão', async () => {
  const { api } = apiWith([{ status: 401, body: { message: 'expired' } }]);
  await assert.rejects(() => api.me('token-vencido'), (error) => error.code === 'unauthorized');
});

test('logout chama o endpoint oficial e tolera sessão já expirada', async () => {
  const { api, fetchImpl } = apiWith([{ body: { ok: true } }]);
  assert.equal(await api.logout('token-oficial-123456'), true);
  assert.equal(fetchImpl.calls[0].url, `${SITE}/api/apps/auth/logout`);

  const expired = apiWith([{ status: 401, body: {} }]);
  assert.equal(await expired.api.logout('token-vencido'), true);
});

test('falha de rede é reportada como erro recuperável', async () => {
  const api = new OctosApi({
    siteUrl: SITE,
    platformUrl: SITE,
    appId: APP_ID,
    fetchImpl: async () => {
      throw new TypeError('fetch failed');
    },
  });
  await assert.rejects(
    () => api.me('token'),
    (error) => error.code === 'network_error' && error.retryable === true,
  );
});

test('descobre o app-id oficial a partir do HTML do site', async () => {
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    text: async () => `<html><body><div id="root" data-app-id="${APP_ID}"></div></body></html>`,
  });
  const api = new OctosApi({ siteUrl: SITE, platformUrl: SITE, appId: '', fetchImpl });
  assert.equal(await api.resolveAppId(), APP_ID);
  assert.equal(api.appId, APP_ID);
});

test('extrai token em respostas aninhadas do SDK', () => {
  assert.equal(extractToken({ access_token: 'a' }), 'a');
  assert.equal(extractToken({ data: { token: 'b' } }), 'b');
  assert.equal(extractToken({ session: { access_token: 'c' } }), 'c');
  assert.equal(extractToken({}), '');
  assert.equal(extractToken(null), '');
});
