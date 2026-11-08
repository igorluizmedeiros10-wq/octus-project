'use strict';

/**
 * IPC do Executive AI Studio.
 * Todo canal valida entrada, usa apenas caminhos escolhidos pelo usuário via diálogo
 * e devolve erros estruturados ({ok:false, error:{code,message}}).
 */

const fs = require('node:fs/promises');
const path = require('node:path');
const { dialog, shell } = require('electron');

const { StudioError } = require('./lib/studio/service');

const MAX_PROMPT = 4000;
const MAX_ID = 64;
const MAX_PATH = 400;
const MAX_CONTENT = 2 * 1024 * 1024;
const MAX_MESSAGES = 60;
const MAX_MESSAGE_CHARS = 8000;

function text(value, max) {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

function projectId(value) {
  const id = text(value, MAX_ID).trim();
  if (!/^[a-z0-9][a-z0-9-]{5,63}$/.test(id)) throw new StudioError('Projeto inválido.', 'invalid_project');
  return id;
}

function registerStudioIpc({ ipcMain, service, getWindow }) {
  const fail = (error) => {
    if (error instanceof StudioError) return { ok: false, error: { code: error.code, message: error.message } };
    if (error && (error.name === 'AiError' || error.name === 'AnalysisError' || error.name === 'ProjectError')) {
      return { ok: false, error: { code: error.code || 'studio_error', message: error.message } };
    }
    console.error('[studio] erro inesperado:', error);
    return { ok: false, error: { code: 'unexpected_error', message: 'Não foi possível concluir a operação. Tente novamente.' } };
  };

  const handle = (channel, fn) =>
    ipcMain.handle(channel, async (event, payload) => {
      try {
        const data = await fn(payload || {}, event);
        return { ok: true, ...(data || {}) };
      } catch (error) {
        return fail(error);
      }
    });

  const emit = (channel, data) => {
    const win = getWindow();
    if (win && !win.isDestroyed()) win.webContents.send(channel, data);
  };

  /* ------------------------------------------------------------ status --- */

  handle('studio:status', () => ({ status: service.status() }));

  handle('studio:settings-save', (payload) => {
    const settings = service.saveAiSettings({
      apiKey: text(payload.apiKey, 400),
      baseUrl: text(payload.baseUrl, 300),
      model: text(payload.model, 120),
    });
    return { ai: settings };
  });

  handle('studio:settings-clear', () => ({ ai: service.clearAiKey() }));

  /* ---------------------------------------------------------- projects --- */

  handle('studio:projects-list', () => ({ projects: service.listProjects() }));

  handle('studio:project-read', (payload) => service.readProject(projectId(payload.id)));

  handle('studio:project-delete', async (payload) => ({ deleted: await service.deleteProject(projectId(payload.id)) }));

  handle('studio:project-file-write', async (payload) =>
    service.writeProjectFile(projectId(payload.id), text(payload.path, MAX_PATH), text(payload.content, MAX_CONTENT))
  );

  handle('studio:project-file-remove', async (payload) =>
    service.removeProjectFile(projectId(payload.id), text(payload.path, MAX_PATH))
  );

  handle('studio:project-export', async (payload) => {
    const id = projectId(payload.id);
    const bundle = await service.exportProject(id);
    const win = getWindow();
    const result = await dialog.showSaveDialog(win, {
      title: 'Exportar projeto',
      defaultPath: bundle.filename,
      filters: [{ name: 'Pacote ZIP', extensions: ['zip'] }],
    });
    if (result.canceled || !result.filePath) return { saved: false };
    await fs.writeFile(result.filePath, bundle.buffer);
    return { saved: true, path: result.filePath };
  });

  handle('studio:project-export-folder', async (payload) => {
    const win = getWindow();
    const result = await dialog.showOpenDialog(win, {
      title: 'Escolher pasta para exportar o projeto',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (result.canceled || !result.filePaths.length) return { saved: false };
    const written = await service.exportProjectTo(projectId(payload.id), result.filePaths[0]);
    return { saved: true, path: result.filePaths[0], files: written.files, dir: written.dir };
  });

  handle('studio:project-reveal', async (payload) => {
    const id = projectId(payload.id);
    const dir = service.projects.filesDir(id);
    await shell.openPath(dir);
    return { opened: dir };
  });

  /* -------------------------------------------------------- generation --- */

  handle('studio:generate', async (payload) => {
    const prompt = text(payload.prompt, MAX_PROMPT).trim();
    if (!prompt) throw new StudioError('Descreva o aplicativo que deseja criar.', 'empty_prompt');
    const result = await service.generate({
      prompt,
      language: text(payload.language, 20) || undefined,
      useAi: payload.useAi !== false,
      projectId: payload.projectId ? projectId(payload.projectId) : null,
    });
    emit('studio:projects-changed', {});
    return result;
  });

  /* -------------------------------------------------------------- chat --- */

  handle('studio:chat', async (payload) => {
    const messages = Array.isArray(payload.messages) ? payload.messages.slice(-MAX_MESSAGES) : [];
    const normalized = messages
      .filter((message) => message && typeof message.content === 'string' && message.content.trim())
      .map((message) => ({
        role: message.role === 'assistant' ? 'assistant' : 'user',
        content: message.content.slice(0, MAX_MESSAGE_CHARS),
      }));
    if (!normalized.length) throw new StudioError('Escreva uma mensagem.', 'empty_message');
    const reply = await service.chat({
      messages: normalized,
      onDelta: (chunk) => emit('studio:delta', { chunk }),
    });
    return { reply };
  });

  /* ------------------------------------------------------- build / run --- */

  handle('studio:verify', async (payload) => {
    const result = await service.verify(projectId(payload.id));
    emit('studio:projects-changed', {});
    return { verification: result };
  });

  handle('studio:build', async (payload) => {
    const id = projectId(payload.id);
    emit('studio:output', { id, channel: 'build', chunk: `> Compilando ${id}\n` });
    const result = await service.build(id, {
      onOutput: (chunk) => emit('studio:output', { id, channel: 'build', chunk: String(chunk) }),
    });
    emit('studio:projects-changed', {});
    return { build: result };
  });

  handle('studio:run', async (payload) => {
    const id = projectId(payload.id);
    const result = await service.run(id, {
      onOutput: (chunk) => emit('studio:output', { id, channel: 'run', chunk: String(chunk) }),
    });
    emit('studio:projects-changed', {});
    return { run: result };
  });

  handle('studio:stop', (payload) => ({ stop: service.stopRun(projectId(payload.id)) }));

  /* ---------------------------------------------------------- analysis --- */

  handle('studio:analyze-file', async () => {
    const win = getWindow();
    const result = await dialog.showOpenDialog(win, {
      title: 'Escolher executável ou binário para analisar',
      properties: ['openFile'],
      filters: [
        { name: 'Executáveis e bibliotecas', extensions: ['exe', 'dll', 'sys', 'bin', 'so', 'elf', 'msi', 'node'] },
        { name: 'Todos os arquivos', extensions: ['*'] },
      ],
    });
    if (result.canceled || !result.filePaths.length) return { canceled: true };
    const report = await service.analyzeFile(result.filePaths[0]);
    return { report };
  });

  handle('studio:analyze-project-artifact', async (payload) => {
    const report = await service.analyzeProjectArtifact(projectId(payload.id), text(payload.path, MAX_PATH));
    return { report };
  });

  /* ----------------------------------------------------------- history --- */

  handle('studio:history', async (payload) => ({ history: await service.projectHistory(projectId(payload.id)) }));

  handle('studio:history-clear', async (payload) => ({ history: await service.clearHistory(projectId(payload.id)) }));

  handle('studio:open-external', async (payload) => {
    const target = text(payload.url, 2048);
    if (!/^https:\/\//i.test(target)) throw new StudioError('Apenas endereços HTTPS podem ser abertos.', 'invalid_url');
    await shell.openExternal(target);
    return { opened: true };
  });
}

module.exports = { registerStudioIpc };
