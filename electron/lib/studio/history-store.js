'use strict';

/**
 * Histórico persistente por projeto: conversas com a IA e registro de alterações.
 * Armazenamento em JSON no diretório de dados do usuário, com escrita atômica.
 */

const fsp = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const ID_PATTERN = /^[a-z0-9][a-z0-9-]{5,63}$/;
const MAX_MESSAGES = 400;
const MAX_CHANGES = 400;

function assertId(id) {
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) throw new Error('Identificador de projeto inválido.');
  return id;
}

function cleanText(value, max) {
  return String(value ?? '').replace(/\u0000/g, '').slice(0, max);
}

class HistoryStore {
  constructor({ rootDir } = {}) {
    if (!rootDir) throw new Error('rootDir é obrigatório.');
    this.rootDir = path.resolve(rootDir);
  }

  file(projectId) {
    return path.join(this.rootDir, `${assertId(projectId)}.json`);
  }

  async read(projectId) {
    try {
      const raw = await fsp.readFile(this.file(projectId), 'utf8');
      const data = JSON.parse(raw);
      return {
        projectId,
        messages: Array.isArray(data.messages) ? data.messages : [],
        changes: Array.isArray(data.changes) ? data.changes : [],
      };
    } catch {
      return { projectId, messages: [], changes: [] };
    }
  }

  async write(projectId, data) {
    await fsp.mkdir(this.rootDir, { recursive: true });
    const target = this.file(projectId);
    const temp = `${target}.${randomUUID()}.tmp`;
    await fsp.writeFile(temp, JSON.stringify(data, null, 2), 'utf8');
    await fsp.rename(temp, target);
  }

  async appendMessage(projectId, message) {
    const data = await this.read(projectId);
    const entry = {
      id: randomUUID(),
      role: message.role === 'user' ? 'user' : message.role === 'system' ? 'system' : 'assistant',
      content: cleanText(message.content, 20000),
      at: new Date().toISOString(),
      meta: message.meta && typeof message.meta === 'object' ? message.meta : null,
    };
    data.messages.push(entry);
    if (data.messages.length > MAX_MESSAGES) data.messages = data.messages.slice(-MAX_MESSAGES);
    await this.write(projectId, data);
    return entry;
  }

  async appendChange(projectId, change) {
    const data = await this.read(projectId);
    const entry = {
      id: randomUUID(),
      kind: cleanText(change.kind || 'alteracao', 40),
      detail: cleanText(change.detail, 400),
      files: Array.isArray(change.files) ? change.files.slice(0, 60).map((f) => cleanText(f, 200)) : [],
      at: new Date().toISOString(),
    };
    data.changes.push(entry);
    if (data.changes.length > MAX_CHANGES) data.changes = data.changes.slice(-MAX_CHANGES);
    await this.write(projectId, data);
    return entry;
  }

  async clear(projectId) {
    await this.write(projectId, { projectId: assertId(projectId), messages: [], changes: [] });
    return { cleared: projectId };
  }

  async remove(projectId) {
    await fsp.rm(this.file(projectId), { force: true });
    return { removed: projectId };
  }
}

module.exports = { HistoryStore };
