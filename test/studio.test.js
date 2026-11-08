'use strict';

/**
 * Testes do núcleo do Executive AI Studio.
 * Cobrem o caminho real usado pela interface: gerar projeto local nas quatro
 * linguagens, persistir, editar, exportar ZIP, histórico, verificação de
 * compilação Python e análise de executáveis reais.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { StudioService } = require('../electron/lib/studio/service');
const { ProjectStore } = require('../electron/lib/studio/project-store');
const { HistoryStore } = require('../electron/lib/studio/history-store');
const { analyzeBuffer, detectFormat } = require('../electron/lib/studio/exe-analyzer');
const { createZip, crc32 } = require('../electron/lib/studio/zip');
const { detectLanguage, detectKind, safeRelativePath, normalizeFileManifest } = require('../electron/lib/studio/blueprints');
const { detectToolchain } = require('../electron/lib/studio/build-runner');

function makeService() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-test-'));
  const service = new StudioService({
    projectsDir: path.join(root, 'projects'),
    historyDir: path.join(root, 'history'),
    aiStore: null,
  });
  return { service, root };
}

function findFile(files, suffix) {
  return (files || []).find((file) => String(file.path).toLowerCase().endsWith(suffix));
}

async function readContent(service, projectId, filePath) {
  const project = await service.readProject(projectId);
  const file = project.files.find((item) => item.path === filePath);
  assert.ok(file, `arquivo ${filePath} deve existir no projeto`);
  return file.content;
}

test('status reporta toolchain detectada e ausência de chave de IA', () => {
  const { service } = makeService();
  const status = service.status();
  assert.equal(status.ai.configured, false);
  assert.equal(status.ai.storageBackend, 'none');
  assert.equal(typeof status.toolchain.canBuild, 'object');
  assert.equal(typeof status.toolchain.tools.python.available, 'boolean');
  assert.ok(status.platform);
});

test('gerador local cria projeto Python com GUI e arquivos reais em disco', async () => {
  const { service } = makeService();
  const res = await service.generate({ prompt: 'Crie um bloco de notas em Python com interface gráfica', useAi: false });

  assert.match(res.source, /^local/);
  assert.equal(res.blueprint.language, 'python');
  assert.ok(res.files.length >= 2);

  const main = findFile(res.files, '.py');
  assert.ok(main, 'projeto Python precisa de um arquivo .py');

  const content = await readContent(service, res.project.id, main.path);
  assert.ok(content.includes('tkinter'), 'GUI Python deve usar tkinter');
  assert.ok(content.length > 500);

  const read = await service.readProject(res.project.id);
  assert.ok(read.meta.title);
  assert.ok(read.files.length >= 2);
});

test('gerador local respeita C++, C# e JavaScript com artefatos de build', async () => {
  const { service } = makeService();

  const cpp = await service.generate({ prompt: 'quero um app C++ Win32 para anotações', useAi: false });
  assert.equal(cpp.blueprint.language, 'cpp');
  const cppFile = findFile(cpp.files, '.cpp');
  assert.ok(cppFile, 'C++ deve gerar arquivo .cpp');
  const cppSource = await readContent(service, cpp.project.id, cppFile.path);
  assert.ok(cppSource.includes('CreateWindow'), 'C++ deve criar janela Win32');
  assert.ok(findFile(cpp.files, '.ps1'), 'C++ deve incluir script PowerShell de compilação');

  const csharp = await service.generate({ prompt: 'crie um aplicativo C# WinForms de tarefas', useAi: false });
  assert.equal(csharp.blueprint.language, 'csharp');
  const csFile = findFile(csharp.files, '.cs');
  assert.ok(csFile, 'C# deve gerar arquivo .cs');
  const csSource = await readContent(service, csharp.project.id, csFile.path);
  assert.ok(csSource.includes('Form'), 'C# deve gerar WinForms');
  assert.ok(findFile(csharp.files, '.csproj'), 'C# deve incluir projeto MSBuild');

  const js = await service.generate({ prompt: 'faça um app Electron em JavaScript de calculadora', useAi: false });
  assert.equal(js.blueprint.language, 'javascript');
  assert.ok(findFile(js.files, 'package.json'), 'JavaScript deve incluir package.json');
  assert.ok(findFile(js.files, 'main.js'), 'JavaScript deve incluir processo principal Electron');
});

test('linguagem explícita tem prioridade sobre o texto do pedido', async () => {
  const { service } = makeService();
  const res = await service.generate({ prompt: 'um aplicativo de notas', language: 'csharp', useAi: false });
  assert.equal(res.blueprint.language, 'csharp');
});

test('detecção de linguagem e tipo cobre os comandos esperados', () => {
  assert.equal(detectLanguage('preciso de um app em c++ com win32'), 'cpp');
  assert.equal(detectLanguage('app c# winforms'), 'csharp');
  assert.equal(detectLanguage('script python tkinter'), 'python');
  assert.equal(detectLanguage('app electron javascript'), 'javascript');
  assert.equal(detectKind('lista de tarefas'), 'tasks');
  assert.equal(detectKind('calculadora científica'), 'calculator');
  assert.equal(detectKind('bloco de notas'), 'notes');
});

test('edição de arquivo grava no disco e remove funciona', async () => {
  const { service } = makeService();
  const res = await service.generate({ prompt: 'notas em python', useAi: false });
  const target = res.files[0].path;

  await service.writeProjectFile(res.project.id, target, '# editado pelo teste\n');
  const after = await service.readProject(res.project.id);
  assert.equal(after.files.find((file) => file.path === target).content, '# editado pelo teste\n');

  await service.removeProjectFile(res.project.id, target);
  const removed = await service.readProject(res.project.id);
  assert.equal(removed.files.some((file) => file.path === target), false);
});

test('caminhos maliciosos são recusados pelo armazenamento', async () => {
  const { service } = makeService();
  const res = await service.generate({ prompt: 'notas em python', useAi: false });
  await assert.rejects(() => service.writeProjectFile(res.project.id, '../../fora.txt', 'x'), /inválido/i);
  await assert.rejects(() => service.readProject('../etc'), /inválido/i);
  assert.equal(safeRelativePath('/etc/passwd'), null);
  assert.equal(safeRelativePath('../x.txt'), null);
  assert.equal(safeRelativePath('src/main.py'), 'src/main.py');
});

test('manifesto de arquivos rejeita caminho absoluto e projeto vazio', () => {
  assert.throws(() => normalizeFileManifest([{ path: '/etc/passwd', content: 'x' }]), /inválido/i);
  assert.throws(() => normalizeFileManifest([]), /nenhum arquivo/i);
  const ok = normalizeFileManifest([{ path: 'a/b.txt', content: 'ok' }]);
  assert.deepEqual(ok, [{ path: 'a/b.txt', content: 'ok' }]);
});

test('exportação ZIP gera arquivo válido com o conteúdo do projeto', async () => {
  const { service } = makeService();
  const res = await service.generate({ prompt: 'tarefas em javascript', useAi: false });
  const exported = await service.exportProject(res.project.id);

  assert.ok(Buffer.isBuffer(exported.buffer), 'exportação deve devolver o conteúdo do ZIP');
  assert.match(exported.filename, /\.zip$/);
  assert.ok(exported.files >= 2);

  const buffer = exported.buffer;
  assert.equal(buffer[0], 0x50);
  assert.equal(buffer[1], 0x4b);
  assert.ok(buffer.length > 500);

  const read = await service.readProject(res.project.id);
  for (const file of read.files) {
    assert.ok(buffer.includes(Buffer.from(file.path)), `ZIP deve conter ${file.path}`);
  }
  assert.ok(buffer.includes(Buffer.from('executive-ai-studio.json')));
});

test('ZIP calcula CRC32 correto para entrada conhecida', () => {
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
  const zip = createZip([{ path: 'a.txt', data: 'conteudo' }]);
  assert.ok(zip.length > 40);
  assert.throws(() => createZip([{ path: '../fora.txt', data: 'x' }]), /inválido/i);
});

test('histórico registra geração e pode ser limpo', async () => {
  const { service } = makeService();
  const res = await service.generate({ prompt: 'calculadora em python', useAi: false });

  const history = await service.projectHistory(res.project.id);
  assert.ok(Array.isArray(history.messages));
  assert.ok(history.changes.length >= 1, 'geração deve registrar alteração');

  await service.clearHistory(res.project.id);
  const cleared = await service.projectHistory(res.project.id);
  assert.equal(cleared.changes.length, 0);
  assert.equal(cleared.messages.length, 0);
});

test('exclusão de projeto remove do gerenciador', async () => {
  const { service } = makeService();
  const res = await service.generate({ prompt: 'notas em python', useAi: false });
  await service.deleteProject(res.project.id);
  const list = await service.listProjects();
  assert.equal(list.some((project) => project.id === res.project.id), false);
});

test('verificação de compilação Python usa o interpretador real', async (t) => {
  const toolchain = detectToolchain();
  if (!toolchain.canBuild.python) {
    t.skip('Python não disponível neste ambiente');
    return;
  }
  const { service } = makeService();
  const res = await service.generate({ prompt: 'bloco de notas em python', useAi: false });
  const report = await service.verify(res.project.id);
  assert.equal(report.ok, true, `verificação falhou: ${JSON.stringify(report.steps)}`);
  assert.ok(report.steps.length >= 1);
});

test('analisador identifica binário real e calcula hashes', () => {
  // Usa o próprio executável do Node: ELF no Linux, PE no Windows.
  const binary = fs.readFileSync(process.execPath);
  const report = analyzeBuffer(binary, { filename: path.basename(process.execPath) });

  const expected = process.platform === 'win32' ? /PE/ : /ELF/;
  assert.match(String(report.format), expected);
  assert.equal(report.hashes.sha256.length, 64);
  assert.equal(report.hashes.md5.length, 32);
  assert.ok(report.libraries, 'relatório deve listar bibliotecas');
  assert.ok(Array.isArray(report.warnings));
  assert.ok(report.headers, 'relatório deve listar cabeçalhos');
});

test('analisador detecta PE do Windows sem executar o arquivo', () => {
  assert.equal(detectFormat(Buffer.from([0x4d, 0x5a, 0x90, 0x00])), 'PE (Windows)');
  assert.equal(detectFormat(Buffer.from([0x7f, 0x45, 0x4c, 0x46])), 'ELF (Linux/Unix)');
  assert.equal(detectFormat(Buffer.from('#!/bin/sh\n')), 'Script (shebang)');
});

test('análise recusa arquivo vazio ou pequeno demais', () => {
  assert.throws(() => analyzeBuffer(Buffer.from('abc')), /pequeno|vazio/i);
});

test('ProjectStore e HistoryStore funcionam isolados do Electron', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'store-test-'));
  const store = new ProjectStore({ rootDir: path.join(root, 'projects') });
  const history = new HistoryStore({ rootDir: path.join(root, 'history') });

  assert.equal(store.rootDir, path.join(root, 'projects'));
  assert.equal(history.rootDir, path.join(root, 'history'));
  await store.ensureRoot();
  assert.deepEqual(await store.list(), []);
});
