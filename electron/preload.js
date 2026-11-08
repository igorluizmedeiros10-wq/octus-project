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

/* ---------------------------------------------------------------------- */
/* Executive AI Studio                                                    */
/* ---------------------------------------------------------------------- */

const MAX_PROMPT = 4000;
const MAX_ID = 64;
const MAX_REL_PATH = 400;
const MAX_CONTENT = 2 * 1024 * 1024;

function subscribe(channel, callback) {
  if (typeof callback !== 'function') return () => {};
  const handler = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

contextBridge.exposeInMainWorld('studio', {
  status: () => ipcRenderer.invoke('studio:status'),

  saveSettings: (payload) =>
    ipcRenderer.invoke('studio:settings-save', {
      apiKey: asString(payload && payload.apiKey, 400),
      baseUrl: asString(payload && payload.baseUrl, 300),
      model: asString(payload && payload.model, 120),
    }),
  clearSettings: () => ipcRenderer.invoke('studio:settings-clear'),

  listProjects: () => ipcRenderer.invoke('studio:projects-list'),
  readProject: (id) => ipcRenderer.invoke('studio:project-read', { id: asString(id, MAX_ID) }),
  deleteProject: (id) => ipcRenderer.invoke('studio:project-delete', { id: asString(id, MAX_ID) }),
  writeProjectFile: (payload) =>
    ipcRenderer.invoke('studio:project-file-write', {
      id: asString(payload && payload.id, MAX_ID),
      path: asString(payload && payload.path, MAX_REL_PATH),
      content: asString(payload && payload.content, MAX_CONTENT),
    }),
  removeProjectFile: (payload) =>
    ipcRenderer.invoke('studio:project-file-remove', {
      id: asString(payload && payload.id, MAX_ID),
      path: asString(payload && payload.path, MAX_REL_PATH),
    }),
  exportProject: (id) => ipcRenderer.invoke('studio:project-export', { id: asString(id, MAX_ID) }),
  exportProjectFolder: (id) => ipcRenderer.invoke('studio:project-export-folder', { id: asString(id, MAX_ID) }),
  revealProject: (id) => ipcRenderer.invoke('studio:project-reveal', { id: asString(id, MAX_ID) }),

  generate: (payload) =>
    ipcRenderer.invoke('studio:generate', {
      prompt: asString(payload && payload.prompt, MAX_PROMPT),
      language: asString(payload && payload.language, 20),
      useAi: !(payload && payload.useAi === false),
      projectId: payload && payload.projectId ? asString(payload.projectId, MAX_ID) : null,
    }),

  chat: (messages) =>
    ipcRenderer.invoke('studio:chat', {
      messages: Array.isArray(messages)
        ? messages.slice(-60).map((message) => ({
            role: message && message.role === 'assistant' ? 'assistant' : 'user',
            content: asString(message && message.content, 8000),
          }))
        : [],
    }),
  onDelta: (callback) => subscribe('studio:delta', callback),
  onOutput: (callback) => subscribe('studio:output', callback),
  onProjectsChanged: (callback) => subscribe('studio:projects-changed', callback),

  verify: (id) => ipcRenderer.invoke('studio:verify', { id: asString(id, MAX_ID) }),
  build: (id) => ipcRenderer.invoke('studio:build', { id: asString(id, MAX_ID) }),
  run: (id) => ipcRenderer.invoke('studio:run', { id: asString(id, MAX_ID) }),
  stop: (id) => ipcRenderer.invoke('studio:stop', { id: asString(id, MAX_ID) }),

  analyzeFile: () => ipcRenderer.invoke('studio:analyze-file'),
  analyzeProjectArtifact: (payload) =>
    ipcRenderer.invoke('studio:analyze-project-artifact', {
      id: asString(payload && payload.id, MAX_ID),
      path: asString(payload && payload.path, MAX_REL_PATH),
    }),

  history: (id) => ipcRenderer.invoke('studio:history', { id: asString(id, MAX_ID) }),
  clearHistory: (id) => ipcRenderer.invoke('studio:history-clear', { id: asString(id, MAX_ID) }),
  openExternal: (url) => ipcRenderer.invoke('studio:open-external', { url: asString(url, MAX_URL) }),
});
