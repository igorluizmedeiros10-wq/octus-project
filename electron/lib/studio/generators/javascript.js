'use strict';

/**
 * Gerador JavaScript (Electron) — aplicativo desktop real com interface escura,
 * persistência em disco no processo principal e IPC seguro via preload.
 */

function jsPackage(bp) {
  return JSON.stringify(
    {
      name: bp.name,
      version: '1.0.0',
      private: true,
      description: bp.description,
      main: 'main.js',
      scripts: {
        start: 'electron .',
        'dist:win': 'electron-builder --win nsis',
      },
      devDependencies: {
        electron: '^45.2.3',
        'electron-builder': '^26.18.0',
      },
      build: {
        appId: `com.executiveaistudio.${bp.name.replace(/[^a-z0-9]/g, '')}`,
        productName: bp.title,
        directories: { output: 'release' },
        files: ['main.js', 'preload.js', 'index.html', 'renderer.js', 'styles.css'],
        win: { target: ['nsis'], artifactName: '${productName}-${version}-setup.${ext}' },
        nsis: { oneClick: false, allowToChangeInstallationDirectory: true },
      },
    },
    null,
    2,
  );
}

function jsMain(bp) {
  const isCalculator = bp.kind === 'calculator';
  return `// ${bp.title} — processo principal (gerado pelo Executive AI Studio)
'use strict';

const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const IS_CALCULATOR = ${isCalculator ? 'true' : 'false'};

function dataFile() {
  const directory = path.join(app.getPath('userData'), 'Executive AI Studio', '${bp.name}');
  fs.mkdirSync(directory, { recursive: true });
  return path.join(directory, 'data.json');
}

function readItems() {
  try {
    const raw = fs.readFileSync(dataFile(), 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function writeItems(items) {
  const safe = Array.isArray(items) ? items.map(String).slice(0, 5000) : [];
  fs.writeFileSync(dataFile(), JSON.stringify(safe, null, 2), 'utf8');
  return safe;
}

function createWindow() {
  const window = new BrowserWindow({
    width: ${bp.window.width},
    height: ${bp.window.height},
    minWidth: 760,
    minHeight: 520,
    backgroundColor: '#101113',
    title: ${JSON.stringify(bp.title)},
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  window.loadFile(path.join(__dirname, 'index.html'));
  return window;
}

ipcMain.handle('items:read', () => readItems());
ipcMain.handle('items:write', (_event, items) => writeItems(items));

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
`;
}

function jsPreload() {
  return `'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('studio', {
  readItems: () => ipcRenderer.invoke('items:read'),
  writeItems: (items) => ipcRenderer.invoke('items:write', Array.isArray(items) ? items : []),
});
`;
}

function jsIndex(bp) {
  const isCalculator = bp.kind === 'calculator';
  const placeholder = isCalculator ? 'Expressao (ex.: (2+3)*4)' : bp.kind === 'tasks' ? 'Nova tarefa' : 'Nova nota';
  const addLabel = isCalculator ? 'Calcular' : 'Adicionar';
  return `<!doctype html>
<html lang="pt-BR">
  <head>
    <meta charset="utf-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'self'; style-src 'self'; script-src 'self'" />
    <title>${bp.title}</title>
    <link rel="stylesheet" href="styles.css" />
  </head>
  <body>
    <header>
      <h1>${bp.title}</h1>
      <p class="subtitle">${bp.kindLabel} • ${bp.languageLabel}</p>
    </header>

    <section class="controls">
      <input id="entry" type="text" placeholder="${placeholder}" autocomplete="off" spellcheck="false" />
      <button id="add" class="primary">${addLabel}</button>
      <button id="remove">Remover</button>
      <button id="clear">Limpar</button>
    </section>

    <main>
      <ul id="list" aria-live="polite"></ul>
    </main>

    <footer id="status">0 itens</footer>

    <script src="renderer.js"></script>
  </body>
</html>
`;
}

function jsRenderer(bp) {
  const isCalculator = bp.kind === 'calculator';
  return `// ${bp.title} — interface (gerado pelo Executive AI Studio)
'use strict';

const IS_CALCULATOR = ${isCalculator ? 'true' : 'false'};
const entry = document.getElementById('entry');
const list = document.getElementById('list');
const status = document.getElementById('status');
let items = [];

// Avaliador aritmetico (sem eval).
function evaluate(expression) {
  let position = 0;
  const text = String(expression).replace(/\\s+/g, '');

  function parseExpression() {
    let value = parseTerm();
    while (position < text.length) {
      const op = text[position];
      if (op !== '+' && op !== '-') break;
      position += 1;
      const right = parseTerm();
      value = op === '+' ? value + right : value - right;
    }
    return value;
  }

  function parseTerm() {
    let value = parseFactor();
    while (position < text.length) {
      const op = text[position];
      if (op !== '*' && op !== '/' && op !== '%') break;
      position += 1;
      const right = parseFactor();
      if ((op === '/' || op === '%') && right === 0) throw new Error('Divisao por zero.');
      value = op === '*' ? value * right : op === '/' ? value / right : value % right;
    }
    return value;
  }

  function parseFactor() {
    if (text[position] === '-') {
      position += 1;
      return -parseFactor();
    }
    if (text[position] === '(') {
      position += 1;
      const inner = parseExpression();
      if (text[position] !== ')') throw new Error('Parenteses invalidos.');
      position += 1;
      return inner;
    }
    const start = position;
    while (position < text.length && /[0-9.]/.test(text[position])) position += 1;
    if (start === position) throw new Error('Numero esperado.');
    const value = Number(text.slice(start, position));
    if (!Number.isFinite(value)) throw new Error('Numero invalido.');
    return value;
  }

  const result = parseExpression();
  if (position !== text.length) throw new Error('Expressao invalida.');
  return result;
}

function render() {
  list.textContent = '';
  items.forEach((item, index) => {
    const row = document.createElement('li');
    row.textContent = item;
    row.title = 'Clique para remover';
    row.addEventListener('click', () => {
      items.splice(index, 1);
      persist();
    });
    list.appendChild(row);
  });
  status.textContent = items.length + (items.length === 1 ? ' item' : ' itens');
}

async function persist() {
  items = await window.studio.writeItems(items);
  render();
}

function submit() {
  const value = entry.value.trim();
  if (!value) return;
  if (IS_CALCULATOR) {
    try {
      const result = evaluate(value);
      items.push(value + ' = ' + Number(result.toPrecision(12)));
    } catch (error) {
      status.textContent = 'Expressao invalida: ' + error.message;
      return;
    }
  } else {
    items.push(value);
  }
  entry.value = '';
  persist();
}

document.getElementById('add').addEventListener('click', submit);
document.getElementById('remove').addEventListener('click', () => {
  items.pop();
  persist();
});
document.getElementById('clear').addEventListener('click', () => {
  items = [];
  persist();
});
entry.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') submit();
});

window.studio.readItems().then((stored) => {
  items = stored;
  render();
  entry.focus();
});
`;
}

function jsStyles(bp) {
  return `:root {
  --background: #101113;
  --panel: #191b1f;
  --border: #2a2d33;
  --text: #e6eaf0;
  --muted: #969ca6;
  --accent: ${bp.accent};
}

* { box-sizing: border-box; }

body {
  margin: 0;
  min-height: 100vh;
  display: flex;
  flex-direction: column;
  background: radial-gradient(1200px 600px at 20% -10%, rgba(47, 155, 255, 0.12), transparent 60%), var(--background);
  color: var(--text);
  font-family: "Segoe UI", system-ui, sans-serif;
}

header { padding: 26px 28px 6px; }

h1 {
  margin: 0;
  font-size: 24px;
  letter-spacing: 0.2px;
}

.subtitle {
  margin: 4px 0 0;
  color: var(--accent);
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: 1.4px;
}

.controls {
  display: flex;
  gap: 10px;
  padding: 16px 28px 10px;
}

input {
  flex: 1;
  padding: 11px 14px;
  border-radius: 10px;
  border: 1px solid var(--border);
  background: var(--panel);
  color: var(--text);
  font-size: 14px;
  outline: none;
  transition: border-color 0.18s ease, box-shadow 0.18s ease;
}

input:focus {
  border-color: var(--accent);
  box-shadow: 0 0 0 3px rgba(47, 155, 255, 0.18);
}

button {
  padding: 11px 16px;
  border-radius: 10px;
  border: 1px solid var(--border);
  background: var(--panel);
  color: var(--text);
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  transition: transform 0.15s ease, border-color 0.18s ease, background 0.18s ease;
}

button:hover { border-color: var(--accent); transform: translateY(-1px); }
button:active { transform: translateY(0); }

button.primary {
  border-color: var(--accent);
  color: #04121f;
  background: linear-gradient(180deg, #56b1ff, var(--accent));
}

main { flex: 1; padding: 8px 28px 0; overflow: auto; }

ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }

li {
  padding: 12px 14px;
  border-radius: 10px;
  border: 1px solid var(--border);
  background: var(--panel);
  font-size: 14px;
  cursor: pointer;
  transition: border-color 0.18s ease, transform 0.15s ease;
}

li:hover { border-color: var(--accent); transform: translateX(2px); }

footer {
  padding: 12px 28px 18px;
  color: var(--muted);
  font-size: 12px;
}
`;
}

module.exports = { jsPackage, jsMain, jsPreload, jsIndex, jsRenderer, jsStyles };
