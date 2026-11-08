'use strict';

/**
 * Executor real de verificação, compilação e execução dos projetos gerados.
 * Detecta toolchains de verdade no PATH do sistema e informa honestamente
 * quando um compilador não está disponível na plataforma atual.
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');

const isWindows = process.platform === 'win32';

/** Procura um executável no PATH (equivalente a `which`/`where`, sem shell). */
function findExecutable(name) {
  const extensions = isWindows ? String(process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';') : [''];
  const separator = isWindows ? ';' : ':';
  const directories = String(process.env.PATH || '').split(separator);
  for (const directory of directories) {
    if (!directory) continue;
    for (const extension of extensions) {
      const candidate = path.join(directory, `${name}${extension}`);
      try {
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch {
        /* continua */
      }
    }
  }
  return null;
}

const TOOLCHAIN = {
  cpp: { candidates: ['cl.exe', 'cl', 'x86_64-w64-mingw32-g++', 'g++'], label: 'Compilador C++ (MSVC ou MinGW-w64)' },
  csharp: { candidates: ['dotnet'], label: 'SDK .NET' },
  python: { candidates: ['python', 'python3', 'py'], label: 'Python 3' },
  javascript: { candidates: ['node'], label: 'Node.js' },
  npm: { candidates: ['npm'], label: 'npm' },
  powershell: { candidates: ['powershell', 'pwsh'], label: 'PowerShell' },
  bash: { candidates: ['bash'], label: 'Bash' },
};

/** Detecta as ferramentas disponíveis, com caminho real de cada uma. */
function detectToolchain() {
  const result = {};
  for (const [key, definition] of Object.entries(TOOLCHAIN)) {
    const found = definition.candidates.map((name) => findExecutable(name)).find(Boolean) || null;
    result[key] = { available: Boolean(found), path: found, label: definition.label };
  }
  return {
    platform: process.platform,
    tools: result,
    canBuild: {
      cpp: result.cpp.available && (isWindows || /mingw/.test(result.cpp.path || '')),
      csharp: result.csharp.available,
      python: result.python.available,
      javascript: result.javascript.available && result.npm.available,
    },
  };
}

function runCommand(command, args, { cwd, timeoutMs = 300000, onOutput } = {}) {
  return new Promise((resolve) => {
    let output = '';
    let settled = false;
    const child = spawn(command, args, { cwd, windowsHide: true, env: process.env });
    const push = (chunk) => {
      const text = chunk.toString();
      output += text;
      if (output.length > 200000) output = output.slice(-200000);
      if (onOutput) onOutput(text);
    };
    const timer = setTimeout(() => {
      if (!settled) {
        child.kill();
        settled = true;
        resolve({ ok: false, code: null, output: `${output}\n[tempo limite excedido: ${timeoutMs} ms]`, timedOut: true });
      }
    }, timeoutMs);

    child.stdout.on('data', push);
    child.stderr.on('data', push);
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, code: null, output: `${output}\n${error.message}` });
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: code === 0, code, output });
    });
  });
}

/** Verifica a sintaxe/compilação do projeto sem executá-lo. */
async function verifyProject(projectDir, meta, { onOutput } = {}) {
  const tools = detectToolchain();
  const steps = [];
  const language = meta.language;

  if (language === 'python') {
    if (!tools.tools.python.available) {
      steps.push({ name: 'Python', ok: false, output: 'Python 3 não encontrado no PATH.' });
    } else {
      const files = fs.readdirSync(projectDir).filter((f) => f.endsWith('.py'));
      for (const file of files) {
        const result = await runCommand(tools.tools.python.path, ['-m', 'py_compile', file], {
          cwd: projectDir,
          timeoutMs: 60000,
          onOutput,
        });
        steps.push({ name: `py_compile ${file}`, ok: result.ok, output: result.output.trim().slice(0, 4000) });
      }
    }
  } else if (language === 'javascript') {
    if (!tools.tools.javascript.available) {
      steps.push({ name: 'Node.js', ok: false, output: 'Node.js não encontrado no PATH.' });
    } else {
      const files = fs.readdirSync(projectDir).filter((f) => f.endsWith('.js'));
      for (const file of files) {
        const result = await runCommand(tools.tools.javascript.path, ['--check', file], {
          cwd: projectDir,
          timeoutMs: 60000,
          onOutput,
        });
        steps.push({ name: `node --check ${file}`, ok: result.ok, output: result.output.trim().slice(0, 4000) });
      }
    }
  } else if (language === 'csharp') {
    if (!tools.tools.csharp.available) {
      steps.push({ name: '.NET SDK', ok: false, output: 'SDK .NET não encontrado. Instale o .NET 8 SDK para compilar.' });
    } else {
      const project = fs.readdirSync(projectDir).find((f) => f.endsWith('.csproj'));
      if (!project) {
        steps.push({ name: 'Projeto C#', ok: false, output: 'Arquivo .csproj não encontrado.' });
      } else {
        const result = await runCommand(tools.tools.csharp.path, ['build', project, '--nologo', '-v', 'quiet'], {
          cwd: projectDir,
          timeoutMs: 300000,
          onOutput,
        });
        steps.push({ name: `dotnet build ${project}`, ok: result.ok, output: result.output.trim().slice(0, 6000) });
      }
    }
  } else if (language === 'cpp') {
    const compiler = tools.tools.cpp.path;
    const canCompileWindows = compiler && (isWindows || /mingw/.test(compiler));
    if (!canCompileWindows) {
      steps.push({
        name: 'Compilador C++ para Windows',
        ok: false,
        output:
          'Nenhum compilador capaz de gerar binários Windows nesta máquina. Instale o Visual Studio Build Tools (MSVC) ou MinGW-w64 e use o script build.ps1.',
      });
    } else {
      const source = fs.readdirSync(projectDir).find((f) => f.endsWith('.cpp'));
      const args = /cl(\.exe)?$/i.test(compiler)
        ? ['/nologo', '/EHsc', '/std:c++17', '/DUNICODE', '/D_UNICODE', '/c', source, `/Fo${path.join(projectDir, 'verify.obj')}`]
        : ['-std=c++17', '-municode', '-DUNICODE', '-D_UNICODE', '-fsyntax-only', source];
      const result = await runCommand(compiler, args, { cwd: projectDir, timeoutMs: 180000, onOutput });
      steps.push({ name: `verificação ${path.basename(compiler)}`, ok: result.ok, output: result.output.trim().slice(0, 6000) });
    }
  } else {
    steps.push({ name: 'Linguagem', ok: false, output: `Linguagem não suportada: ${language}` });
  }

  const ok = steps.length > 0 && steps.every((step) => step.ok);
  return { ok, language, steps, toolchain: tools };
}

/** Compila o projeto executando o script de build gerado. */
async function buildProject(projectDir, meta, { onOutput } = {}) {
  const tools = detectToolchain();
  const scriptPs1 = path.join(projectDir, 'build.ps1');
  const scriptSh = path.join(projectDir, 'build.sh');
  const hasPs1 = fs.existsSync(scriptPs1);
  const hasSh = fs.existsSync(scriptSh);

  let command;
  let args;

  if (isWindows && hasPs1 && tools.tools.powershell.available) {
    command = tools.tools.powershell.path;
    args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPs1];
  } else if (!isWindows && hasSh && tools.tools.bash.available) {
    command = tools.tools.bash.path;
    args = [scriptSh];
  } else if (hasPs1) {
    return {
      ok: false,
      output:
        'Este projeto precisa ser compilado no Windows (script build.ps1). Copie a pasta exportada para o Windows 11 e execute: powershell -ExecutionPolicy Bypass -File build.ps1',
      artifacts: [],
    };
  } else {
    return { ok: false, output: 'Nenhum script de build encontrado no projeto.', artifacts: [] };
  }

  const result = await runCommand(command, args, { cwd: projectDir, timeoutMs: 600000, onOutput });
  const artifacts = listArtifacts(projectDir);
  return { ok: result.ok, code: result.code, output: result.output, artifacts, command: `${path.basename(command)} ${args.join(' ')}` };
}

/** Lista executáveis e instaladores produzidos. */
function listArtifacts(projectDir) {
  const found = [];
  const walk = (dir, depth = 0) => {
    if (depth > 3) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, depth + 1);
      else if (/\.(exe|msi|appimage|dmg)$/i.test(entry.name)) {
        found.push({ path: path.relative(projectDir, full), bytes: fs.statSync(full).size });
      }
    }
  };
  walk(projectDir);
  return found;
}

/** Inicia o aplicativo gerado (processo real). */
function runProject(projectDir, meta, { onOutput } = {}) {
  const tools = detectToolchain();
  const artifacts = listArtifacts(projectDir);
  const language = meta.language;

  if (artifacts.length && (language === 'cpp' || language === 'csharp')) {
    const artifact = path.join(projectDir, artifacts[0].path);
    const child = spawn(artifact, [], { cwd: projectDir, windowsHide: false });
    child.stdout?.on('data', (chunk) => onOutput && onOutput(chunk.toString()));
    child.stderr?.on('data', (chunk) => onOutput && onOutput(chunk.toString()));
    return { ok: true, pid: child.pid, command: artifact, child };
  }

  if (language === 'python' && tools.tools.python.available) {
    const child = spawn(tools.tools.python.path, ['app.py'], { cwd: projectDir, windowsHide: false });
    child.stdout?.on('data', (chunk) => onOutput && onOutput(chunk.toString()));
    child.stderr?.on('data', (chunk) => onOutput && onOutput(chunk.toString()));
    return { ok: true, pid: child.pid, command: `${path.basename(tools.tools.python.path)} app.py`, child };
  }

  if (language === 'javascript' && tools.tools.npm.available) {
    const child = spawn(tools.tools.npm.path, ['start'], { cwd: projectDir, shell: isWindows, windowsHide: false });
    child.stdout?.on('data', (chunk) => onOutput && onOutput(chunk.toString()));
    child.stderr?.on('data', (chunk) => onOutput && onOutput(chunk.toString()));
    return { ok: true, pid: child.pid, command: 'npm start', child };
  }

  return {
    ok: false,
    error: `Não foi possível executar: toolchain de ${language} ausente ou projeto ainda não compilado.`,
  };
}

module.exports = { detectToolchain, verifyProject, buildProject, runProject, listArtifacts, findExecutable, runCommand };
