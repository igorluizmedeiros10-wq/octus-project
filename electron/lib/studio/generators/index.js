'use strict';

/**
 * Monta o manifesto completo de arquivos de um projeto a partir do blueprint.
 * Cada linguagem recebe código real, script de compilação para .EXE e README.
 */

const { normalizeBlueprint, LANGUAGE_LABELS } = require('../blueprints');
const { cppSource } = require('./cpp');
const { csharpProject, csharpProgram, csharpMainForm } = require('./csharp');
const { pythonApp } = require('./python');
const { jsPackage, jsMain, jsPreload, jsIndex, jsRenderer, jsStyles } = require('./javascript');

function readme(bp, { build, output, extra }) {
  return `# ${bp.title}

${bp.description}

- Linguagem: **${bp.languageLabel}**
- Modelo: **${bp.kindLabel}**
- Gerado por: Executive AI Studio

## Recursos

${bp.features.map((feature) => `- ${feature}`).join('\n')}

## Estrutura

\`\`\`
${extra.files.join('\n')}
\`\`\`

## Como executar

${extra.run}

## Como gerar o .EXE

${build}

Saída esperada: \`${output}\`
`;
}

function cppFiles(bp) {
  const cppName = `${bp.name}.cpp`;
  const exeName = `${bp.name}.exe`;
  const buildPs1 = `# Compila ${bp.title} para Windows (.exe)
$ErrorActionPreference = 'Stop'
Set-Location -Path $PSScriptRoot

if (Get-Command cl.exe -ErrorAction SilentlyContinue) {
  Write-Host 'Compilando com MSVC...'
  cl /nologo /EHsc /std:c++17 /O2 /DUNICODE /D_UNICODE "${cppName}" ^
     /link /SUBSYSTEM:WINDOWS user32.lib gdi32.lib comctl32.lib shell32.lib /OUT:"${exeName}"
} elseif (Get-Command g++.exe -ErrorAction SilentlyContinue) {
  Write-Host 'Compilando com MinGW-w64...'
  g++ -std=c++17 -O2 -municode -mwindows -DUNICODE -D_UNICODE "${cppName}" -o "${exeName}" ^
      -luser32 -lgdi32 -lcomctl32 -lshell32 -static-libgcc -static-libstdc++
} else {
  throw 'Nenhum compilador C++ encontrado. Instale o Visual Studio Build Tools (MSVC) ou MinGW-w64.'
}

if (Test-Path "${exeName}") { Write-Host "OK: ${exeName} gerado." } else { throw 'A compilacao falhou.' }
`;
  const buildSh = `#!/usr/bin/env bash
# Compila ${bp.title} usando MinGW-w64 (cross-compile a partir de Linux/macOS).
set -euo pipefail
cd "$(dirname "$0")"
COMPILER="\${CXX_WINDOWS:-x86_64-w64-mingw32-g++}"
if ! command -v "$COMPILER" >/dev/null 2>&1; then
  echo "Compilador $COMPILER nao encontrado. Instale mingw-w64 ou compile no Windows com build.ps1." >&2
  exit 1
fi
"$COMPILER" -std=c++17 -O2 -municode -mwindows -DUNICODE -D_UNICODE "${cppName}" -o "${exeName}" \\
  -luser32 -lgdi32 -lcomctl32 -lshell32 -static-libgcc -static-libstdc++
echo "OK: ${exeName} gerado."
`;
  return [
    { path: cppName, content: cppSource(bp) },
    { path: 'build.ps1', content: buildPs1 },
    { path: 'build.sh', content: buildSh },
    {
      path: 'README.md',
      content: readme(bp, {
        build: '```powershell\npowershell -ExecutionPolicy Bypass -File build.ps1\n```\n\nOu, com MinGW-w64 em Linux/macOS: `./build.sh`',
        output: exeName,
        extra: {
          files: [cppName, 'build.ps1', 'build.sh', 'README.md'],
          run: `Execute \`${exeName}\` após compilar.`,
        },
      }),
    },
  ];
}

function csharpFiles(bp) {
  const csproj = `${bp.name}.csproj`;
  const buildPs1 = `# Publica ${bp.title} como executavel unico
$ErrorActionPreference = 'Stop'
Set-Location -Path $PSScriptRoot

if (-not (Get-Command dotnet -ErrorAction SilentlyContinue)) {
  throw 'O SDK do .NET nao foi encontrado. Instale o .NET 8 SDK (https://dot.net).'
}

dotnet publish "${csproj}" -c Release -r win-x64 --self-contained false ^
  -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true -o dist

if (Test-Path "dist/${bp.name}.exe") { Write-Host "OK: dist/${bp.name}.exe gerado." } else { throw 'A publicacao falhou.' }
`;
  return [
    { path: csproj, content: csharpProject(bp) },
    { path: 'Program.cs', content: csharpProgram(bp) },
    { path: 'MainForm.cs', content: csharpMainForm(bp) },
    { path: 'build.ps1', content: buildPs1 },
    {
      path: 'README.md',
      content: readme(bp, {
        build: '```powershell\npowershell -ExecutionPolicy Bypass -File build.ps1\n```',
        output: `dist/${bp.name}.exe`,
        extra: {
          files: [csproj, 'Program.cs', 'MainForm.cs', 'build.ps1', 'README.md'],
          run: 'Com o .NET 8 SDK instalado: `dotnet run`',
        },
      }),
    },
  ];
}

function pythonFiles(bp) {
  const buildPs1 = `# Gera ${bp.title}.exe com PyInstaller
$ErrorActionPreference = 'Stop'
Set-Location -Path $PSScriptRoot

$python = if (Get-Command python -ErrorAction SilentlyContinue) { 'python' } elseif (Get-Command py -ErrorAction SilentlyContinue) { 'py' } else { throw 'Python nao encontrado.' }

& $python -m pip install --upgrade pip pyinstaller
& $python -m PyInstaller --noconfirm --onefile --windowed --name "${bp.name}" app.py

if (Test-Path "dist/${bp.name}.exe") { Write-Host "OK: dist/${bp.name}.exe gerado." } else { throw 'A geracao do executavel falhou.' }
`;
  const buildSh = `#!/usr/bin/env bash
# Gera o executavel com PyInstaller (o binario produzido roda na plataforma atual).
set -euo pipefail
cd "$(dirname "$0")"
python3 -m pip install --upgrade pip pyinstaller
python3 -m PyInstaller --noconfirm --onefile --windowed --name "${bp.name}" app.py
echo "OK: dist/${bp.name} gerado."
`;
  return [
    { path: 'app.py', content: pythonApp(bp) },
    { path: 'requirements.txt', content: '# Tkinter faz parte da biblioteca padrao do Python.\n# PyInstaller e instalado automaticamente pelos scripts de build.\n' },
    { path: 'build.ps1', content: buildPs1 },
    { path: 'build.sh', content: buildSh },
    {
      path: 'README.md',
      content: readme(bp, {
        build: '```powershell\npowershell -ExecutionPolicy Bypass -File build.ps1\n```',
        output: `dist/${bp.name}.exe`,
        extra: {
          files: ['app.py', 'requirements.txt', 'build.ps1', 'build.sh', 'README.md'],
          run: '`python app.py`',
        },
      }),
    },
  ];
}

function javascriptFiles(bp) {
  const buildPs1 = `# Gera o instalador Windows com electron-builder
$ErrorActionPreference = 'Stop'
Set-Location -Path $PSScriptRoot

if (-not (Get-Command npm -ErrorAction SilentlyContinue)) { throw 'Node.js/npm nao encontrado.' }
npm install
npm run dist:win

Write-Host 'OK: instalador gerado em release/'
`;
  return [
    { path: 'package.json', content: jsPackage(bp) },
    { path: 'main.js', content: jsMain(bp) },
    { path: 'preload.js', content: jsPreload(bp) },
    { path: 'index.html', content: jsIndex(bp) },
    { path: 'renderer.js', content: jsRenderer(bp) },
    { path: 'styles.css', content: jsStyles(bp) },
    { path: 'build.ps1', content: buildPs1 },
    {
      path: 'README.md',
      content: readme(bp, {
        build: '```powershell\nnpm install\nnpm run dist:win\n```',
        output: 'release/*-setup.exe',
        extra: {
          files: ['package.json', 'main.js', 'preload.js', 'index.html', 'renderer.js', 'styles.css', 'build.ps1', 'README.md'],
          run: '`npm install` e depois `npm start`',
        },
      }),
    },
  ];
}

const BUILDERS = {
  cpp: cppFiles,
  csharp: csharpFiles,
  python: pythonFiles,
  javascript: javascriptFiles,
};

const ENTRY_POINTS = {
  cpp: (bp) => `${bp.name}.cpp`,
  csharp: () => 'Program.cs',
  python: () => 'app.py',
  javascript: () => 'main.js',
};

/** Gera todos os arquivos do projeto para o blueprint informado. */
function generateProjectFiles(input) {
  const bp = normalizeBlueprint(input);
  const builder = BUILDERS[bp.language];
  if (!builder) throw new Error(`Linguagem não suportada: ${bp.language}`);
  const files = builder(bp);
  return { blueprint: bp, files, entry: ENTRY_POINTS[bp.language](bp) };
}

module.exports = {
  generateProjectFiles,
  ENTRY_POINTS,
  SUPPORTED_LANGUAGES: Object.keys(BUILDERS),
  LANGUAGE_LABELS,
};
