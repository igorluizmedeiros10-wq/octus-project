'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/**
 * Ponte segura entre a interface e o processo principal.
 * Nenhum token, cookie ou senha é exposto ao renderer.
 */

const MAX_EMAIL = 320;
const MAX_PASSWORD = 256;
const MAX_NAME = 120;
const MAX_URL = 2048;
const MAX_ROUTE = 64;

function asString(value, max) {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

function sanitizeRect(rect) {
  const source = rect && typeof rect === 'object' ? rect : {};
  const number = (value) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed) : 0;
  };
  return { x: number(source.x), y: number(source.y), width: number(source.width), height: number(source.height) };
}

contextBridge.exposeInMainWorld('octos', {
  getState: () => ipcRenderer.invoke('octos:get-state'),
  onState: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('octos:state', handler);
    return () => ipcRenderer.removeListener('octos:state', handler);
  },
  signIn: (credentials) =>
    ipcRenderer.invoke('octos:sign-in', {
      email: asString(credentials && credentials.email, MAX_EMAIL),
      password: asString(credentials && credentials.password, MAX_PASSWORD),
    }),
  verifyOtp: (payload) =>
    ipcRenderer.invoke('octos:verify-otp', {
      email: asString(payload && payload.email, MAX_EMAIL),
      otp: asString(payload && payload.otp, 12),
      challengeId: asString(payload && payload.challengeId, 128),
    }),
  register: (payload) =>
    ipcRenderer.invoke('octos:register', {
      email: asString(payload && payload.email, MAX_EMAIL),
      password: asString(payload && payload.password, MAX_PASSWORD),
      fullName: asString(payload && payload.fullName, MAX_NAME),
    }),
  requestPasswordReset: (email) =>
    ipcRenderer.invoke('octos:request-password-reset', { email: asString(email, MAX_EMAIL) }),
  resetPassword: (payload) =>
    ipcRenderer.invoke('octos:reset-password', {
      token: asString(payload && payload.token, 512),
      password: asString(payload && payload.password, MAX_PASSWORD),
    }),
  signOut: () => ipcRenderer.invoke('octos:sign-out'),
  refresh: () => ipcRenderer.invoke('octos:refresh'),
  saveConfig: (payload) => ipcRenderer.invoke('octos:save-config', { octosUrl: asString(payload && payload.octosUrl, MAX_URL) }),
  openRoute: (route) => ipcRenderer.invoke('octos:open-route', asString(route, MAX_ROUTE)),
  openExternal: (url) => ipcRenderer.invoke('octos:open-external', asString(url, MAX_URL)),
  diagnostics: () => ipcRenderer.invoke('octos:diagnostics'),
  setViewBounds: (rect) => ipcRenderer.send('octos:view-bounds', sanitizeRect(rect)),
  setViewVisible: (visible) => ipcRenderer.send('octos:view-visible', Boolean(visible)),
});
