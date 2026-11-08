'use strict';

/**
 * Gerenciador de projetos: persistência real em disco, leitura, atualização,
 * remoção e exportação ZIP. Todos os caminhos são validados contra traversal.
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const { safeRelativePath, normalizeBlueprint } = require('./blueprints');
const { createZip } = require('./zip');

const ID_PATTERN = /^[a-z0-9][a-z0-9-]{5,63}$/;
const META_FILE = 'project.json';
const FILES_DIR = 'files';

class ProjectError extends Error {
  constructor(message, code = 'project_error') {
    super(message);
    this.name = 'ProjectError';
    this.code = code;
  }
}

function assertId(id) {
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) {
    throw new ProjectError('Identificador de projeto inválido.', 'invalid_id');
  }
  return id;
}

async function writeAtomic(target, content) {
  const temp = `${target}.${randomUUID()}.tmp`;
  await fsp.writeFile(temp, content, 'utf8');
  await fsp.rename(temp, target);
}

class ProjectStore {
  constructor({ rootDir } = {}) {
    if (!rootDir) throw new ProjectError('rootDir é obrigatório.', 'invalid_root');
    this.rootDir = path.resolve(rootDir);
  }

  projectDir(id) {
    return path.join(this.rootDir, assertId(id));
  }

  filesDir(id) {
    return path.join(this.projectDir(id), FILES_DIR);
  }

  async ensureRoot() {
    await fsp.mkdir(this.rootDir, { recursive: true });
  }

  static newId() {
    return `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
  }

  static summarize(meta) {
    return {
      id: meta.id,
      title: meta.title,
      name: meta.name,
      description: meta.description,
      language: meta.language,
      languageLabel: meta.languageLabel,
      kind: meta.kind,
      kindLabel: meta.kindLabel,
      accent: meta.accent,
      features: Array.isArray(meta.features) ? meta.features : [],
      source: meta.source || 'local',
      fileCount: Number(meta.fileCount) || 0,
      createdAt: meta.createdAt,
      updatedAt: meta.updatedAt,
      lastBuild: meta.lastBuild || null,
      lastRun: meta.lastRun || null,
    };
  }

  async list() {
    await this.ensureRoot();
    const entries = await fsp.readdir(this.rootDir, { withFileTypes: true });
    const projects = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !ID_PATTERN.test(entry.name)) continue;
      try {
        const raw = await fsp.readFile(path.join(this.rootDir, entry.name, META_FILE), 'utf8');
        const meta = JSON.parse(raw);
        if (meta && meta.id === entry.name) projects.push(ProjectStore.summarize(meta));
      } catch {
        // Diretório incompleto: ignorado na listagem.
      }
    }
    projects.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    return projects;
  }

  async exists(id) {
    try {
      await fsp.access(path.join(this.projectDir(id), META_FILE), fs.constants.R_OK);
      return true;
    } catch {
      return false;
    }
  }

  async readMeta(id) {
    const raw = await fsp.readFile(path.join(this.projectDir(id), META_FILE), 'utf8');
    return JSON.parse(raw);
  }

  async create({ blueprint, files, source = 'local', entry = null }) {
    const bp = normalizeBlueprint(blueprint);
    if (!Array.isArray(files) || !files.length) {
      throw new ProjectError('Nenhum arquivo para gravar.', 'empty_project');
    }
    await this.ensureRoot();
    const id = ProjectStore.newId();
    const dir = path.join(this.rootDir, id);
    await fsp.mkdir(path.join(dir, FILES_DIR), { recursive: true });

    const written = [];
    for (const file of files) {
      const relPath = safeRelativePath(file.path);
      if (!relPath) throw new ProjectError(`Caminho inválido: ${file.path}`, 'invalid_path');
      const target = path.join(dir, FILES_DIR, relPath);
      await fsp.mkdir(path.dirname(target), { recursive: true });
      await writeAtomic(target, String(file.content ?? ''));
      written.push({ path: relPath, bytes: Buffer.byteLength(String(file.content ?? ''), 'utf8') });
    }

    const now = new Date().toISOString();
    const meta = {
      id,
      title: bp.title,
      name: bp.name,
      description: bp.description,
      language: bp.language,
      languageLabel: bp.languageLabel,
      kind: bp.kind,
      kindLabel: bp.kindLabel,
      accent: bp.accent,
      features: bp.features,
      prompt: bp.prompt,
      window: bp.window,
      entry: entry || written[0].path,
      source,
      fileCount: written.length,
      createdAt: now,
      updatedAt: now,
      lastBuild: null,
      lastRun: null,
    };
    await writeAtomic(path.join(dir, META_FILE), JSON.stringify(meta, null, 2));
    return { meta: ProjectStore.summarize(meta), files: written };
  }

  async read(id) {
    const meta = await this.readMeta(id);
    const dir = this.filesDir(id);
    const files = [];

    const walk = async (current, prefix = '') => {
      const entries = await fsp.readdir(current, { withFileTypes: true });
      for (const entry of entries) {
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        const absolute = path.join(current, entry.name);
        if (entry.isDirectory()) {
          await walk(absolute, rel);
        } else if (entry.isFile()) {
          const buffer = await fsp.readFile(absolute);
          const isBinary = buffer.includes(0);
          files.push({
            path: rel,
            content: isBinary ? '' : buffer.toString('utf8'),
            bytes: buffer.length,
            binary: isBinary,
          });
        }
      }
    };

    await walk(dir);
    files.sort((a, b) => a.path.localeCompare(b.path));
    return { meta: ProjectStore.summarize(meta), raw: meta, files };
  }

  /** Atualiza um único arquivo de texto do projeto. */
  async writeFile(id, relPath, content) {
    const safe = safeRelativePath(relPath);
    if (!safe) throw new ProjectError('Caminho de arquivo inválido.', 'invalid_path');
    const target = path.join(this.filesDir(id), safe);
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await writeAtomic(target, String(content ?? ''));
    await this.touch(id);
    return { path: safe, bytes: Buffer.byteLength(String(content ?? ''), 'utf8') };
  }

  async removeFile(id, relPath) {
    const safe = safeRelativePath(relPath);
    if (!safe) throw new ProjectError('Caminho de arquivo inválido.', 'invalid_path');
    await fsp.rm(path.join(this.filesDir(id), safe), { force: true });
    await this.touch(id);
    return { removed: safe };
  }

  async touch(id, patch = {}) {
    const meta = await this.readMeta(id);
    const files = await this.readDirCount(id);
    const next = { ...meta, ...patch, fileCount: files, updatedAt: new Date().toISOString() };
    await writeAtomic(path.join(this.projectDir(id), META_FILE), JSON.stringify(next, null, 2));
    return ProjectStore.summarize(next);
  }

  async readDirCount(id) {
    const { files } = await this.read(id);
    return files.length;
  }

  async recordBuild(id, build) {
    const meta = await this.readMeta(id);
    meta.lastBuild = build;
    meta.updatedAt = new Date().toISOString();
    await writeAtomic(path.join(this.projectDir(id), META_FILE), JSON.stringify(meta, null, 2));
    return ProjectStore.summarize(meta);
  }

  async recordRun(id, run) {
    const meta = await this.readMeta(id);
    meta.lastRun = run;
    await writeAtomic(path.join(this.projectDir(id), META_FILE), JSON.stringify(meta, null, 2));
    return ProjectStore.summarize(meta);
  }

  async remove(id) {
    const dir = this.projectDir(id);
    await fsp.rm(dir, { recursive: true, force: true });
    return { removed: id };
  }

  /** Exporta o projeto inteiro como ZIP (inclui metadados do blueprint). */
  async exportZip(id) {
    const { raw, files } = await this.read(id);
    const entries = files.map((file) => ({ name: `${raw.name}/${file.path}`, content: file.content }));
    entries.push({
      name: `${raw.name}/executive-ai-studio.json`,
      content: JSON.stringify(
        {
          title: raw.title,
          language: raw.language,
          kind: raw.kind,
          features: raw.features,
          prompt: raw.prompt,
          entry: raw.entry,
          createdAt: raw.createdAt,
          updatedAt: raw.updatedAt,
          generator: 'Executive AI Studio',
        },
        null,
        2,
      ),
    });
    return { buffer: createZip(entries), filename: `${raw.name}.zip`, files: entries.length };
  }

  /** Exporta todos os arquivos para uma pasta escolhida pelo usuário. */
  async exportToDirectory(id, targetDir) {
    const { raw, files } = await this.read(id);
    const base = path.join(path.resolve(targetDir), raw.name);
    for (const file of files) {
      const target = path.join(base, file.path);
      await fsp.mkdir(path.dirname(target), { recursive: true });
      await fsp.writeFile(target, file.content, 'utf8');
    }
    return { directory: base, files: files.length };
  }
}

module.exports = { ProjectStore, ProjectError, ID_PATTERN };
