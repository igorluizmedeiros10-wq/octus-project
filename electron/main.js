'use strict';

const path = require('node:path');
const {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
  safeStorage,
  shell,
} = require('electron');

const { ConfigStore, ConfigError } = require('./lib/config-store');
const { SecureStore, createElectronCrypto, createFallbackCrypto } = require('./lib/secure-store');
const { OctosApi, OctosError } = require('./lib/octos-api');
const { SessionManager, STATUS } = require('./lib/session-manager');
const { createMainWindow } = require('./windows/main-window');
const { OctosSiteView } = require('./windows/octos-site-view');
const { StudioService } = require('./lib/studio/service');
const { registerStudioIpc } = require('./studio-ipc');

const PARTITION = 'persist:octos';
const ALLOWED_ROUTES = new Set(['/', '/login', '/register', '/_authed', '/_authed/configuracoes']);
const SMOKE_TEST = process.argv.includes('--smoke-test');

// Isolamento opcional de dados (usado pelos testes automatizados).
if (process.env.OCTOS_USER_DATA_DIR) {
  app.setPath('userData', path.resolve(process.env.OCTOS_USER_DATA_DIR));
}
if (process.env.OCTOS_HEADLESS === '1') {
  app.disableHardwareAcceleration();
}

let mainWindow = null;
let siteView = null;
let configStore = null;
let secureStore = null;
let api = null;
let sessions = null;
let storagePollTimer = null;
let refreshTimer = null;
let studio = null;

/* ------------------------------------------------------------------ */
/* Utilidades                                                          */
/* ------------------------------------------------------------------ */

function errorPayload(error) {
  if (error instanceof OctosError) {
    return { code: error.code, message: error.message };
  }
  if (error instanceof ConfigError) {
    return { code: error.code, message: error.message };
  }
  console.error('[octos] erro inesperado:', error);
  return { code: 'unexpected_error', message: 'Não foi possível concluir a operação. Tente novamente.' };
}

async function guard(handler) {
  try {
    const data = await handler();
    return { ok: true, ...(data || {}) };
  } catch (error) {
    return { ok: false, error: errorPayload(error) };
  }
}

function requireString(value, field, max) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    throw new OctosError(`Informe um valor válido para ${field}.`, { code: 'invalid_input' });
  }
  return value.trim();
}

function publicSnapshot() {
  const config = configStore.read();
  return {
    state: sessions.state(),
    config: {
      octosUrl: config.octosUrl,
      appId: config.appId,
      platformUrl: config.platformUrl,
    },
    site: siteView ? siteView.info() : null,
    storage: secureStore ? secureStore.backend : null,
  };
}

function broadcastState() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('octos:state', publicSnapshot());
}

/* ------------------------------------------------------------------ */
/* Inicialização                                                       */
/* ------------------------------------------------------------------ */

function bootstrap() {
  const userData = app.getPath('userData');
  configStore = new ConfigStore({ filePath: path.join(userData, 'config.json') });

  const fallback = createFallbackCrypto({ keyPath: path.join(userData, 'session.key') });
  secureStore = new SecureStore({
    filePath: path.join(userData, 'session.bin'),
    cryptoProvider: createElectronCrypto(safeStorage, fallback),
  });

  // Chave da API de IA: guardada no mesmo cofre cifrado (DPAPI no Windows).
  const aiStore = new SecureStore({
    filePath: path.join(userData, 'ai-credentials.bin'),
    cryptoProvider: createElectronCrypto(safeStorage, createFallbackCrypto({ keyPath: path.join(userData, 'ai.key') })),
  });

  studio = new StudioService({
    projectsDir: path.join(userData, 'studio', 'projects'),
    historyDir: path.join(userData, 'studio', 'history'),
    aiStore,
  });

  const config = configStore.read();
  api = new OctosApi({ siteUrl: config.octosUrl, platformUrl: config.platformUrl, appId: config.appId });

  sessions = new SessionManager({
    api,
    store: secureStore,
    readStorageToken: () => (siteView ? siteView.readToken() : Promise.resolve(null)),
  });
  sessions.on('change', () => broadcastState());
}

function handleSiteEvent(type, payload) {
  if (type === 'loaded' || type === 'title') {
    // O site oficial pode concluir o login Google dentro da janela integrada.
    sessions.syncFromStorage().catch(() => {});
  }
  if (type === 'failed') broadcastState();
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('octos:site-event', { type, payload });
  }
}

function createWindow() {
  mainWindow = createMainWindow({
    preloadPath: path.join(__dirname, 'preload.js'),
    indexPath: path.join(__dirname, '..', 'src', 'index.html'),
    show: !SMOKE_TEST,
  });

  const config = configStore.read();
  siteView = new OctosSiteView({
    window: mainWindow,
    partition: PARTITION,
    siteOrigin: config.origin,
    onEvent: handleSiteEvent,
  });
  siteView.load(config.octosUrl);

  mainWindow.on('closed', () => {
    mainWindow = null;
    if (siteView) siteView.destroy();
    siteView = null;
  });
}

function startSyncLoops() {
  storagePollTimer = setInterval(() => {
    sessions.syncFromStorage().catch(() => {});
  }, 3000);
  refreshTimer = setInterval(() => {
    sessions.refresh().catch(() => {});
  }, 60000);
}

/* ------------------------------------------------------------------ */
/* IPC                                                                 */
/* ------------------------------------------------------------------ */

function registerIpc() {
  ipcMain.handle('octos:get-state', () => guard(async () => publicSnapshot()));

  ipcMain.handle('octos:diagnostics', () =>
    guard(async () => {
      const config = configStore.read();
      const state = sessions.state();
      return {
        diagnostics: {
          configuredUrl: config.octosUrl,
          appId: config.appId,
          platformUrl: config.platformUrl,
          partition: PARTITION,
          storage: secureStore.backend,
          connected: state.status === STATUS.CONNECTED,
          status: state.status,
          userEmail: state.user ? state.user.email : null,
          site: siteView ? siteView.info() : null,
          renderer: mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents.getURL() : null,
          electron: process.versions.electron,
          chrome: process.versions.chrome,
        },
      };
    })
  );

  ipcMain.handle('octos:sign-in', (_event, payload) =>
    guard(async () => {
      const email = requireString(payload && payload.email, 'e-mail', 320);
      const password = requireString(payload && payload.password, 'senha', 256);
      const result = await sessions.signIn({ email, password });
      const token = sessions.currentToken();
      if (!result.requiresOtp && token && siteView) await siteView.injectToken(token);
      return publicSnapshot();
    })
  );

  ipcMain.handle('octos:verify-otp', (_event, payload) =>
    guard(async () => {
      const email = requireString(payload && payload.email, 'e-mail', 320);
      const otp = requireString(payload && payload.otp, 'código', 12);
      await sessions.verifyOtp({ email, otp, challengeId: payload.challengeId });
      const token = sessions.currentToken();
      if (token && siteView) await siteView.injectToken(token);
      return publicSnapshot();
    })
  );

  ipcMain.handle('octos:register', (_event, payload) =>
    guard(async () => {
      const email = requireString(payload && payload.email, 'e-mail', 320);
      const password = requireString(payload && payload.password, 'senha', 256);
      const fullName = typeof payload.fullName === 'string' ? payload.fullName.trim().slice(0, 120) : '';
      const result = await sessions.register({ email, password, fullName });
      if (result.token && siteView) await siteView.injectToken(result.token);
      return { ...publicSnapshot(), registration: { requiresVerification: Boolean(result.requiresVerification) } };
    })
  );

  ipcMain.handle('octos:request-password-reset', (_event, payload) =>
    guard(async () => {
      const email = requireString(payload && payload.email, 'e-mail', 320);
      await sessions.requestPasswordReset(email);
      return { message: 'Se existir uma conta com este e-mail, o OCTOS enviará o link de recuperação.' };
    })
  );

  ipcMain.handle('octos:reset-password', (_event, payload) =>
    guard(async () => {
      const token = requireString(payload && payload.token, 'token', 512);
      const password = requireString(payload && payload.password, 'senha', 256);
      await sessions.resetPassword({ token, password });
      return { message: 'Senha atualizada no OCTOS. Entre novamente com a nova senha.' };
    })
  );

  ipcMain.handle('octos:sign-out', () =>
    guard(async () => {
      await sessions.signOut();
      if (siteView) await siteView.clearSessionData();
      return publicSnapshot();
    })
  );

  ipcMain.handle('octos:refresh', () =>
    guard(async () => {
      await sessions.refresh();
      return publicSnapshot();
    })
  );

  ipcMain.handle('octos:save-config', (_event, payload) =>
    guard(async () => {
      const previous = configStore.read();
      const next = configStore.save({ octosUrl: payload && payload.octosUrl });
      if (next.origin !== previous.origin) {
        await sessions.signOut();
        if (siteView) await siteView.clearSessionData();
      }
      api = new OctosApi({ siteUrl: next.octosUrl, platformUrl: next.platformUrl, appId: next.appId });
      sessions.api = api;
      const resolvedAppId = await api.resolveAppId();
      if (resolvedAppId && resolvedAppId !== next.appId) {
        configStore.save({ appId: resolvedAppId });
      }
      if (siteView) {
        siteView.setSiteOrigin(next.origin);
        await siteView.load(next.octosUrl);
      }
      return publicSnapshot();
    })
  );

  ipcMain.handle('octos:open-route', (_event, payload) =>
    guard(async () => {
      const route = typeof payload === 'string' ? payload : '';
      if (!ALLOWED_ROUTES.has(route)) {
        throw new OctosError('Rota do OCTOS não permitida.', { code: 'invalid_route' });
      }
      const config = configStore.read();
      const target = route === '/' ? config.octosUrl : `${config.octosUrl}${route}`;
      if (siteView) {
        siteView.setVisible(true);
        await siteView.load(target);
      }
      return { url: target, ...publicSnapshot() };
    })
  );

  ipcMain.handle('octos:open-external', (_event, payload) =>
    guard(async () => {
      const target = typeof payload === 'string' ? payload : '';
      if (!/^https:\/\//i.test(target)) {
        throw new OctosError('Apenas endereços HTTPS podem ser abertos.', { code: 'invalid_url' });
      }
      await shell.openExternal(target);
      return { opened: true };
    })
  );

  ipcMain.on('octos:view-bounds', (_event, rect) => {
    if (siteView) siteView.setBounds(rect || {});
  });

  ipcMain.on('octos:view-visible', (_event, visible) => {
    if (siteView) siteView.setVisible(Boolean(visible));
  });

  registerStudioIpc({ ipcMain, service: studio, getWindow: () => mainWindow });
}

/* ------------------------------------------------------------------ */
/* Ciclo de vida                                                       */
/* ------------------------------------------------------------------ */

const hasLock = app.requestSingleInstanceLock();
if (!hasLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    Menu.setApplicationMenu(null);
    bootstrap();
    registerIpc();
    createWindow();
    startSyncLoops();

    await sessions.restore();
    broadcastState();

    if (SMOKE_TEST) {
      setTimeout(() => {
        const report = {
          smoke: true,
          appReady: app.isReady() && Boolean(mainWindow && !mainWindow.isDestroyed()),
          ...publicSnapshot(),
        };
        process.stdout.write(`${JSON.stringify(report)}\n`);
        app.quit();
      }, Number(process.env.OCTOS_SMOKE_MS || 9000));
    }
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', () => {
    if (storagePollTimer) clearInterval(storagePollTimer);
    if (refreshTimer) clearInterval(refreshTimer);
    if (studio) studio.stopAll();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}
