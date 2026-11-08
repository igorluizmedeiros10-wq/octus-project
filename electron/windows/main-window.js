'use strict';

const { BrowserWindow, app, shell } = require('electron');

/**
 * Janela principal do aplicativo.
 * Segurança: contexto isolado, sandbox, sem integração Node no renderer.
 */
function createMainWindow({ preloadPath, indexPath, show = true }) {
  const window = new BrowserWindow({
    width: 1360,
    height: 880,
    minWidth: 1024,
    minHeight: 680,
    show: false,
    backgroundColor: '#070b12',
    title: 'Executive AI Studio — OCTOS',
    autoHideMenuBar: true,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
      spellcheck: false,
      devTools: !app.isPackaged,
    },
  });

  window.loadFile(indexPath);

  window.once('ready-to-show', () => {
    if (show) window.show();
  });

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  window.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file://')) {
      event.preventDefault();
      if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    }
  });

  return window;
}

module.exports = { createMainWindow };
