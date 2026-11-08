'use strict';

const { WebContentsView, session, shell } = require('electron');
const { isAllowedTopLevelNavigation, isAllowedPopup } = require('../lib/url-policy');

const TOKEN_KEYS = ['base44_access_token', 'base44_token', 'access_token'];

/**
 * User agent compatível com Chrome para que o OAuth oficial do Google
 * funcione dentro da janela integrada (o Google recusa UA de Electron).
 */
function buildChromeUserAgent() {
  const chrome = process.versions.chrome || '124.0.0.0';
  return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chrome} Safari/537.36`;
}

function normalizeBounds(rect) {
  const clamp = (value) => Math.max(0, Math.round(Number(value) || 0));
  return {
    x: clamp(rect && rect.x),
    y: clamp(rect && rect.y),
    width: clamp(rect && rect.width),
    height: clamp(rect && rect.height),
  };
}

/**
 * Visão integrada que carrega o site oficial OCTOS dentro da janela do aplicativo.
 * Toda autenticação (Google, e-mail/senha, cadastro, recuperação) acontece no site oficial.
 */
class OctosSiteView {
  constructor({ window, partition, siteOrigin, onEvent = () => {} }) {
    this.window = window;
    this.partition = partition;
    this.siteOrigin = siteOrigin;
    this.onEvent = onEvent;
    this.view = null;
    this.visible = true;
    this.bounds = { x: 0, y: 0, width: 0, height: 0 };
    this.loading = false;
    this.lastError = null;
  }

  ensure() {
    if (this.view) return this.view;

    const siteSession = session.fromPartition(this.partition);
    siteSession.setUserAgent(buildChromeUserAgent());
    siteSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    siteSession.setPermissionCheckHandler(() => false);

    this.view = new WebContentsView({
      webPreferences: {
        partition: this.partition,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webviewTag: false,
        spellcheck: false,
        backgroundThrottling: false,
      },
    });

    this.window.contentView.addChildView(this.view);
    this._applyBounds();

    const contents = this.view.webContents;

    contents.setWindowOpenHandler(({ url }) => {
      if (isAllowedPopup(url, this.siteOrigin)) {
        return {
          action: 'allow',
          overrideBrowserWindowOptions: {
            width: 540,
            height: 740,
            parent: this.window,
            autoHideMenuBar: true,
            backgroundColor: '#0b1220',
            webPreferences: {
              partition: this.partition,
              contextIsolation: true,
              nodeIntegration: false,
              sandbox: true,
              webviewTag: false,
            },
          },
        };
      }
      this._openExternal(url);
      return { action: 'deny' };
    });

    const guardNavigation = (event, url) => {
      if (isAllowedTopLevelNavigation(url, this.siteOrigin)) return;
      event.preventDefault();
      this._openExternal(url);
    };

    contents.on('will-navigate', guardNavigation);
    contents.on('will-redirect', guardNavigation);
    contents.on('did-start-loading', () => {
      this.loading = true;
      this.onEvent('loading', this.info());
    });
    contents.on('did-stop-loading', () => {
      this.loading = false;
      this.onEvent('loaded', this.info());
    });
    contents.on('did-finish-load', () => {
      this.loading = false;
      this.lastError = null;
      this.onEvent('loaded', this.info());
    });
    contents.on('page-title-updated', (_event, title) => this.onEvent('title', { title }));
    contents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (!isMainFrame) return;
      if (errorCode === -3) return; // navegação cancelada
      this.loading = false;
      this.lastError = { code: errorCode, message: errorDescription, url: validatedURL };
      this.onEvent('failed', this.lastError);
    });
    contents.on('render-process-gone', () => {
      this.onEvent('crashed', { message: 'A janela integrada do OCTOS foi encerrada inesperadamente.' });
    });

    return this.view;
  }

  setSiteOrigin(origin) {
    if (typeof origin === 'string' && origin) this.siteOrigin = origin;
  }

  async load(url) {
    this.ensure();
    try {
      await this.view.webContents.loadURL(url);
      return true;
    } catch (error) {
      this.lastError = { code: 'load_failed', message: error.message, url };
      this.onEvent('failed', this.lastError);
      return false;
    }
  }

  reload() {
    if (this.view) this.view.webContents.reload();
  }

  setBounds(rect) {
    this.bounds = normalizeBounds(rect);
    this._applyBounds();
  }

  setVisible(visible) {
    this.visible = Boolean(visible);
    if (this.view && typeof this.view.setVisible === 'function') {
      this.view.setVisible(this.visible);
    }
    this._applyBounds();
  }

  _applyBounds() {
    if (!this.view) return;
    const target = this.visible ? this.bounds : { x: 0, y: 0, width: 0, height: 0 };
    this.view.setBounds(target);
  }

  _openExternal(url) {
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) {
      shell.openExternal(url);
    }
  }

  /** Lê o token oficial gravado pelo próprio site OCTOS no armazenamento da sessão. */
  async readToken() {
    if (!this.view || this.view.webContents.isDestroyed()) return null;
    const script = `(() => {
      const keys = ${JSON.stringify(TOKEN_KEYS)};
      for (const key of keys) {
        try {
          const value = window.localStorage.getItem(key);
          if (value) return value;
        } catch (error) { /* acesso bloqueado durante navegação */ }
      }
      return null;
    })()`;
    try {
      const token = await this.view.webContents.executeJavaScript(script, true);
      return typeof token === 'string' && token.length > 10 ? token : null;
    } catch {
      return null;
    }
  }

  /** Injeta a sessão obtida pela API oficial para que o site abra já autenticado. */
  async injectToken(token) {
    if (!this.view || this.view.webContents.isDestroyed() || !token) return false;
    const script = `(() => {
      try {
        window.localStorage.setItem('base44_access_token', ${JSON.stringify(token)});
        return true;
      } catch (error) { return false; }
    })()`;
    try {
      const applied = await this.view.webContents.executeJavaScript(script, true);
      if (applied) this.reload();
      return Boolean(applied);
    } catch {
      return false;
    }
  }

  async clearSessionData() {
    try {
      const siteSession = session.fromPartition(this.partition);
      await siteSession.clearStorageData({
        storages: ['cookies', 'localstorage', 'indexdb', 'serviceworkers', 'cachestorage'],
      });
      await siteSession.clearAuthCache();
      return true;
    } catch {
      return false;
    }
  }

  info() {
    if (!this.view || this.view.webContents.isDestroyed()) {
      return {
        url: null,
        title: null,
        loading: this.loading,
        loaded: false,
        visible: this.visible,
        bounds: { ...this.bounds },
      };
    }
    const url = this.view.webContents.getURL();
    return {
      url,
      title: this.view.webContents.getTitle(),
      loading: this.loading,
      loaded: Boolean(url) && !this.loading && !this.lastError,
      visible: this.visible,
      bounds: { ...this.bounds },
      error: this.lastError,
    };
  }

  destroy() {
    if (!this.view) return;
    try {
      this.window.contentView.removeChildView(this.view);
    } catch {
      /* janela já destruída */
    }
    try {
      this.view.webContents.close();
    } catch {
      /* já fechado */
    }
    this.view = null;
  }
}

module.exports = { OctosSiteView, buildChromeUserAgent, TOKEN_KEYS };
