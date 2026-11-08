'use strict';

/**
 * Orquestrador do Executive AI Studio: une geração (IA ou local), projetos,
 * histórico, verificação, compilação, execução e análise de executáveis.
 */

const fs = require('node:fs');
const path = require('node:path');

const { ProjectStore } = require('./project-store');
const { HistoryStore } = require('./history-store');
const { generateProjectFiles } = require('./generators');
const { buildLocalBlueprint, normalizeBlueprint, normalizeFileManifest, describeBlueprint } = require('./blueprints');
const { AiClient, AiError } = require('./ai-client');
const { detectToolchain, verifyProject, buildProject, runProject } = require('./build-runner');
const { analyzeBuffer } = require('./exe-analyzer');

const DEFAULT_AI = Object.freeze({ baseUrl: 'https://api.openai.com/v1', model: 'gpt-4.1-mini' });
const MAX_ANALYSIS_BYTES = 128 * 1024 * 1024;

class StudioError extends Error {
  constructor(message, code = 'studio_error') {
    super(message);
    this.name = 'StudioError';
    this.code = code;
  }
}

function normalizeBaseUrl(value) {
  const candidate = String(value || '').trim() || DEFAULT_AI.baseUrl;
  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new StudioError('URL da API de IA inválida.', 'invalid_base_url');
  }
  if (parsed.protocol !== 'https:' && parsed.hostname !== 'localhost' && parsed.hostname !== '127.0.0.1') {
    throw new StudioError('Use HTTPS para a API de IA (exceto em localhost).', 'insecure_base_url');
  }
  return candidate.replace(/\/+$/, '');
}

class StudioService {
  constructor({ projectsDir, historyDir, aiStore }) {
    if (!projectsDir || !historyDir) throw new StudioError('Diretórios de dados são obrigatórios.', 'invalid_dirs');
    this.projects = new ProjectStore({ rootDir: projectsDir });
    this.history = new HistoryStore({ rootDir: historyDir });
    this.aiStore = aiStore || null;
    this.running = new Map();
  }

  /* ------------------------------------------------------------ settings -- */

  aiSettings() {
    let stored = null;
    try {
      stored = this.aiStore ? this.aiStore.read() : null;
    } catch {
      stored = null;
    }
    const apiKey = stored && typeof stored.token === 'string' ? stored.token : '';
    return {
      configured: Boolean(apiKey),
      baseUrl: (stored && stored.baseUrl) || DEFAULT_AI.baseUrl,
      model: (stored && stored.model) || DEFAULT_AI.model,
      storageBackend: this.aiStore ? this.aiStore.backend : 'none',
    };
  }

  saveAiSettings({ apiKey, baseUrl, model } = {}) {
    if (!this.aiStore) throw new StudioError('Armazenamento seguro indisponível.', 'no_secure_store');
    const current = this.aiSettings();
    const key = typeof apiKey === 'string' && apiKey.trim() ? apiKey.trim() : current.configured ? this.aiStore.read().token : '';
    if (!key) throw new StudioError('Informe a chave da API de IA.', 'missing_key');
    const normalizedBase = normalizeBaseUrl(baseUrl ?? current.baseUrl);
    const normalizedModel = String(model || current.model).trim().slice(0, 120) || DEFAULT_AI.model;
    this.aiStore.write({ token: key, baseUrl: normalizedBase, model: normalizedModel });
    return this.aiSettings();
  }

  clearAiKey() {
    if (this.aiStore) this.aiStore.clear();
    return this.aiSettings();
  }

  client() {
    const settings = this.aiSettings();
    return new AiClient({ apiKey: settings.configured ? this.aiStore.read().token : '', baseUrl: settings.baseUrl, model: settings.model });
  }

  status() {
    const toolchain = detectToolchain();
    return {
      ai: this.aiSettings(),
      toolchain,
      platform: process.platform,
      canBuildHere: toolchain.canBuild,
    };
  }

  /* ------------------------------------------------------------ projects -- */

  listProjects() {
    return this.projects.list();
  }

  async readProject(id) {
    const project = await this.projects.read(id);
    const history = await this.history.read(id);
    return { ...project, history };
  }

  async deleteProject(id) {
    await this.history.remove(id);
    return this.projects.remove(id);
  }

  async writeProjectFile(id, filePath, content) {
    const result = await this.projects.writeFile(id, filePath, content);
    await this.history.appendChange(id, { kind: 'edicao', detail: `Arquivo editado: ${result.path}`, files: [result.path] });
    return result;
  }

  async removeProjectFile(id, filePath) {
    const result = await this.projects.removeFile(id, filePath);
    await this.history.appendChange(id, { kind: 'remocao', detail: `Arquivo removido: ${filePath}`, files: [filePath] });
    return result;
  }

  async exportProject(id) {
    return this.projects.exportZip(id);
  }

  async exportProjectTo(id, targetDir) {
    if (!targetDir) throw new StudioError('Escolha uma pasta de destino.', 'missing_target');
    return this.projects.exportToDirectory(id, targetDir);
  }

  /* ---------------------------------------------------------- generation -- */

  /**
   * Gera um projeto completo.
   * useAi=false (ou sem chave) usa o gerador local determinístico — sempre real.
   */
  async generate({ prompt, language, useAi = true, projectId = null, onDelta = null } = {}) {
    const text = String(prompt || '').trim();
    if (!text) throw new StudioError('Descreva o aplicativo que deseja criar.', 'empty_prompt');
    if (text.length > 4000) throw new StudioError('Descrição muito longa (máximo 4000 caracteres).', 'prompt_too_long');

    const settings = this.aiSettings();
    const wantsAi = Boolean(useAi) && settings.configured;
    let blueprint;
    let files;
    let source;
    let notes = '';

    if (wantsAi) {
      try {
        const client = this.client();
        const history = projectId ? (await this.history.read(projectId)).messages : [];
        const result = await client.generateProject({ prompt: text, language, history });
        blueprint = result.blueprint;
        files = result.files;
        source = 'ai';
        notes = `Projeto gerado por IA (${settings.model}).`;
      } catch (error) {
        if (!(error instanceof AiError)) throw error;
        blueprint = buildLocalBlueprint({ prompt: text, language });
        const generated = generateProjectFiles(blueprint);
        files = generated.files;
        source = 'local-fallback';
        notes = `A IA falhou (${error.message}). Projeto gerado pelo motor local do Studio.`;
      }
    } else {
      blueprint = buildLocalBlueprint({ prompt: text, language });
      const generated = generateProjectFiles(blueprint);
      files = generated.files;
      source = settings.configured ? 'local' : 'local-no-key';
      notes = settings.configured
        ? 'Projeto gerado pelo motor local determinístico (modo local ativado).'
        : 'Projeto gerado pelo motor local. Configure uma chave de IA em Configurações para geração por modelo.';
    }

    const validated = normalizeFileManifest(files);
    const entry = validated.find((file) => /\.(cpp|cs|py|js)$/.test(file.path))?.path || validated[0].path;

    let project;
    if (projectId) {
      await this.projects.read(projectId);
      for (const file of validated) await this.projects.writeFile(projectId, file.path, file.content);
      project = await this.projects.touch(projectId, {
        title: blueprint.title,
        description: blueprint.description,
        features: blueprint.features,
        source,
        entry,
      });
      await this.history.appendChange(projectId, {
        kind: 'regeneracao',
        detail: notes,
        files: validated.map((file) => file.path),
      });
    } else {
      const created = await this.projects.create({ blueprint, files: validated, source, entry });
      project = created.meta;
      await this.history.appendMessage(project.id, {
        role: 'assistant',
        content: `Projeto **${blueprint.title}** criado em ${blueprint.languageLabel}.\n\n${describeBlueprint(blueprint)}\n\n${notes}`,
        meta: { kind: 'generation', source },
      });
      await this.history.appendChange(project.id, {
        kind: 'criacao',
        detail: `Projeto criado com ${validated.length} arquivos (${blueprint.languageLabel}). ${notes}`,
        files: validated.map((file) => file.path),
      });
    }

    await this.history.appendMessage(project.id, { role: 'user', content: text, meta: { kind: 'prompt' } });

    return { project, blueprint, files: validated.map((file) => ({ path: file.path, bytes: Buffer.byteLength(file.content, 'utf8') })), source, notes };
  }

  /* ------------------------------------------------------ chat with AI ---- */

  async chat({ messages = [], onDelta = null, signal = null } = {}) {
    const settings = this.aiSettings();
    if (!settings.configured) {
      throw new StudioError('Configure uma chave de IA em Configurações para conversar com o modelo.', 'not_configured');
    }
    const client = this.client();
    return client.chat({ messages, onDelta, signal });
  }

  /* ------------------------------------------------------ build / run ----- */

  async verify(id) {
    const { meta } = await this.projects.read(id);
    const dir = path.join(this.projects.filesDir(id));
    const result = await verifyProject(dir, meta);
    await this.history.appendChange(id, {
      kind: 'verificacao',
      detail: result.ok ? 'Verificação concluída com sucesso.' : `Verificação com falhas: ${result.steps.filter((s) => !s.ok).map((s) => s.name).join(', ')}`,
      files: [],
    });
    return result;
  }

  async build(id, { onOutput } = {}) {
    const { meta } = await this.projects.read(id);
    const dir = this.projects.filesDir(id);
    const result = await buildProject(dir, meta, { onOutput });
    const summary = {
      ok: result.ok,
      at: new Date().toISOString(),
      artifacts: result.artifacts || [],
      message: result.ok ? `Compilação concluída (${(result.artifacts || []).length} artefato(s)).` : 'A compilação não foi concluída.',
    };
    await this.projects.recordBuild(id, summary);
    await this.history.appendChange(id, { kind: 'build', detail: summary.message, files: (result.artifacts || []).map((a) => a.path) });
    return { ...result, summary };
  }

  async run(id, { onOutput } = {}) {
    const { meta } = await this.projects.read(id);
    const dir = this.projects.filesDir(id);
    const previous = this.running.get(id);
    if (previous) {
      try {
        previous.kill();
      } catch {
        /* já encerrado */
      }
      this.running.delete(id);
    }
    const result = runProject(dir, meta, { onOutput });
    if (!result.ok) return result;
    this.running.set(id, result.child);
    result.child.on('exit', (code) => {
      this.running.delete(id);
      if (onOutput) onOutput(`\n[processo encerrado com código ${code}]`);
    });
    await this.projects.recordRun(id, { at: new Date().toISOString(), command: result.command, pid: result.pid });
    await this.history.appendChange(id, { kind: 'execucao', detail: `Aplicativo iniciado (${result.command}).`, files: [] });
    return { ok: true, pid: result.pid, command: result.command };
  }

  stopRun(id) {
    const child = this.running.get(id);
    if (!child) return { stopped: false };
    try {
      child.kill();
    } catch {
      /* já encerrado */
    }
    this.running.delete(id);
    return { stopped: true };
  }

  stopAll() {
    for (const child of this.running.values()) {
      try {
        child.kill();
      } catch {
        /* ignora */
      }
    }
    this.running.clear();
  }

  /* ---------------------------------------------------------- analysis --- */

  async analyzeFile(filePath) {
    if (typeof filePath !== 'string' || !filePath.trim()) {
      throw new StudioError('Nenhum arquivo informado.', 'missing_file');
    }
    const resolved = path.resolve(filePath);
    let stat;
    try {
      stat = fs.statSync(resolved);
    } catch {
      throw new StudioError('Arquivo não encontrado.', 'not_found');
    }
    if (!stat.isFile()) throw new StudioError('O caminho informado não é um arquivo.', 'not_a_file');
    if (stat.size === 0) throw new StudioError('O arquivo está vazio.', 'empty_file');
    if (stat.size > MAX_ANALYSIS_BYTES) throw new StudioError('Arquivo muito grande para análise (limite de 128 MB).', 'too_large');
    const buffer = fs.readFileSync(resolved);
    const report = analyzeBuffer(buffer, { filename: path.basename(resolved) });
    return { ...report, path: resolved, analyzedAt: new Date().toISOString() };
  }

  /** Analisa um artefato já compilado dentro de um projeto. */
  async analyzeProjectArtifact(id, relPath) {
    const dir = this.projects.filesDir(id);
    const safe = String(relPath || '').replace(/\\/g, '/');
    if (safe.split('/').includes('..') || safe.startsWith('/')) {
      throw new StudioError('Caminho inválido.', 'invalid_path');
    }
    return this.analyzeFile(path.join(dir, safe));
  }

  /* ----------------------------------------------------------- history --- */

  async projectHistory(id) {
    return this.history.read(id);
  }

  async clearHistory(id) {
    return this.history.clear(id);
  }

  async appendNote(id, content) {
    return this.history.appendMessage(id, { role: 'user', content });
  }
}

module.exports = { StudioService, StudioError, DEFAULT_AI };
