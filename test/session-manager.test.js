'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { SessionManager, STATUS } = require('../electron/lib/session-manager');
const { OctosError } = require('../electron/lib/octos-api');

function fakeStore(initial = null) {
  const store = {
    saved: initial,
    cleared: 0,
    read() {
      return store.saved;
    },
    write(payload) {
      store.saved = payload;
      return true;
    },
    clear() {
      store.saved = null;
      store.cleared += 1;
      return true;
    },
  };
  return store;
}

function fakeApi(overrides = {}) {
  const calls = [];
  const api = {
    async login(args) {
      calls.push(['login', args]);
      return { requiresOtp: false, token: 'token-oficial-1234567890', rawUser: { id: 'u1', email: args.email, full_name: 'Ana' } };
    },
    async me(token) {
      calls.push(['me', token]);
      return { id: 'u1', email: 'ana@empresa.com', full_name: 'Ana Souza', role: 'user', status: 'active' };
    },
    async logout(token) {
      calls.push(['logout', token]);
      return true;
    },
    async register(args) {
      calls.push(['register', args]);
      return { token: 'token-novo-1234567890', rawUser: { id: 'u2', email: args.email } };
    },
    async requestPasswordReset(email) {
      calls.push(['reset-request', email]);
      return true;
    },
    async resetPassword(args) {
      calls.push(['reset', args]);
      return true;
    },
    ...overrides,
  };
  api.calls = calls;
  return api;
}

function build({ api = fakeApi(), store = fakeStore(), readStorageToken = async () => null } = {}) {
  return { api, store, manager: new SessionManager({ api, store, readStorageToken }) };
}

test('login por e-mail e senha conecta e persiste a sessão cifrada', async () => {
  const { manager, store, api } = build();

  const result = await manager.signIn({ email: 'Ana@Empresa.com', password: 'senha-forte' });

  assert.equal(result.requiresOtp, false);
  assert.equal(manager.state().status, STATUS.CONNECTED);
  assert.equal(manager.state().user.email, 'ana@empresa.com');
  assert.equal(manager.currentToken(), 'token-oficial-1234567890');
  assert.equal(store.saved.token, 'token-oficial-1234567890');
  assert.equal(api.calls[0][1].email, 'ana@empresa.com');
});

test('login valida e-mail e senha antes de chamar o OCTOS', async () => {
  const { manager, api } = build();
  await assert.rejects(() => manager.signIn({ email: 'invalido', password: 'senha-forte' }), (error) => error.code === 'invalid_input');
  await assert.rejects(() => manager.signIn({ email: 'ana@empresa.com', password: '123' }), (error) => error.code === 'invalid_input');
  assert.equal(api.calls.length, 0);
});

test('conta bloqueada no OCTOS não recebe acesso', async () => {
  const api = fakeApi({
    async login() {
      return {
        requiresOtp: false,
        token: 'token-oficial-1234567890',
        rawUser: { id: 'u1', email: 'ana@empresa.com', status: 'blocked' },
      };
    },
    async me() {
      return { id: 'u1', email: 'ana@empresa.com', status: 'blocked' };
    },
  });
  const { manager } = build({ api });

  await manager.signIn({ email: 'ana@empresa.com', password: 'senha-forte' });
  assert.equal(manager.state().status, STATUS.BLOCKED);
  assert.equal(manager.state().user.isBlocked, true);
});

test('sessão salva é restaurada e revalidada no servidor', async () => {
  const store = fakeStore({ token: 'token-salvo-1234567890', user: { email: 'ana@empresa.com' }, source: 'password' });
  const { manager } = build({ store });

  const state = await manager.restore();

  assert.equal(state.status, STATUS.CONNECTED);
  assert.equal(state.user.email, 'ana@empresa.com');
  assert.equal(state.tokenPresent, true);
  assert.equal(manager.currentToken(), 'token-salvo-1234567890');
});

test('token expirado ao restaurar desconecta e limpa o disco', async () => {
  const store = fakeStore({ token: 'token-vencido-1234567890', user: { email: 'ana@empresa.com' } });
  const api = fakeApi({
    async me() {
      throw new OctosError('Sua sessão do OCTOS expirou.', { code: 'unauthorized', status: 401 });
    },
  });
  const { manager } = build({ api, store });

  const state = await manager.restore();

  assert.equal(state.status, STATUS.DISCONNECTED);
  assert.equal(state.user, null);
  assert.equal(manager.currentToken(), null);
  assert.ok(store.cleared >= 1);
});

test('token revogado com 403 marca a conta como bloqueada', async () => {
  const store = fakeStore({ token: 'token-bloqueado-1234567890', user: { email: 'ana@empresa.com' } });
  const api = fakeApi({
    async me() {
      throw new OctosError('O OCTOS não autoriza esta conta.', { code: 'forbidden', status: 403 });
    },
  });
  const { manager } = build({ api, store });

  const state = await manager.restore();
  assert.equal(state.status, STATUS.BLOCKED);
  assert.equal(state.user.isBlocked, true);
});

test('falha de rede mantém o perfil em cache sem inventar login', async () => {
  const store = fakeStore({ token: 'token-salvo-1234567890', user: { email: 'ana@empresa.com', full_name: 'Ana' } });
  const api = fakeApi({
    async me() {
      throw new OctosError('Sem conexão.', { code: 'network_error', retryable: true });
    },
  });
  const { manager } = build({ api, store });

  const state = await manager.restore();
  assert.equal(state.status, STATUS.CONNECTED);
  assert.equal(state.user.email, 'ana@empresa.com');
  assert.equal(state.error.retryable, true);
});

test('sincronização adota o token criado pelo próprio site (Google/cadastro)', async () => {
  const readStorageToken = async () => 'token-do-site-1234567890';
  const { manager, store } = build({ readStorageToken });

  const state = await manager.syncFromStorage();

  assert.equal(state.status, STATUS.CONNECTED);
  assert.equal(manager.currentToken(), 'token-do-site-1234567890');
  assert.equal(store.saved.token, 'token-do-site-1234567890');
});

test('logout no site reflete desconexão no aplicativo', async () => {
  const store = fakeStore({ token: 'token-salvo-1234567890', user: { email: 'ana@empresa.com' } });
  const { manager, api } = build({ store });
  await manager.restore();

  const state = await manager.syncFromStorage();

  assert.equal(state.status, STATUS.DISCONNECTED);
  assert.equal(state.user, null);
  assert.equal(store.saved, null);
});

test('logout encerra a sessão no servidor e localmente', async () => {
  const store = fakeStore();
  const { manager, api } = build({ store });
  await manager.signIn({ email: 'ana@empresa.com', password: 'senha-forte' });

  const state = await manager.signOut();

  assert.equal(state.status, STATUS.DISCONNECTED);
  assert.equal(state.user, null);
  assert.equal(manager.currentToken(), null);
  assert.equal(store.saved, null);
  assert.ok(api.calls.some(([name]) => name === 'logout'));
});

test('cadastro cria conta apenas no OCTOS e adota a sessão', async () => {
  const { manager, api } = build();
  const result = await manager.register({ email: 'novo@empresa.com', password: 'senha-forte', fullName: 'Novo' });

  assert.equal(result.requiresVerification, false);
  assert.equal(manager.state().status, STATUS.CONNECTED);
  assert.ok(api.calls.some(([name]) => name === 'register'));
});

test('recuperação de senha e redefinição usam a API oficial', async () => {
  const { manager, api } = build();
  assert.equal(await manager.requestPasswordReset('ana@empresa.com'), true);
  assert.equal(await manager.resetPassword({ token: 'token-recuperacao-123', password: 'nova-senha-forte' }), true);
  assert.deepEqual(api.calls.map(([name]) => name), ['reset-request', 'reset']);
});

test('verificação de OTP conclui o login', async () => {
  const api = fakeApi({
    async login() {
      return { requiresOtp: true, email: 'ana@empresa.com', challengeId: 'ch_1' };
    },
    async verifyOtp() {
      return { token: 'token-otp-1234567890', rawUser: { id: 'u1', email: 'ana@empresa.com' } };
    },
  });
  const { manager } = build({ api });

  const first = await manager.signIn({ email: 'ana@empresa.com', password: 'senha-forte' });
  assert.equal(first.requiresOtp, true);
  assert.equal(manager.state().status, STATUS.OTP_REQUIRED);

  const state = await manager.verifyOtp({ email: 'ana@empresa.com', otp: '123456', challengeId: 'ch_1' });
  assert.equal(state.status, STATUS.CONNECTED);
  assert.equal(manager.currentToken(), 'token-otp-1234567890');
});
