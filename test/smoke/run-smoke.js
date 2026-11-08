'use strict';

/**
 * Smoke test real do Electron: inicia o aplicativo com --smoke-test,
 * carrega o site oficial do OCTOS na janela integrada e imprime o estado
 * observado em JSON. No Linux usa xvfb-run quando não há display.
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const electronBinary = require('electron');
const root = path.join(__dirname, '..', '..');
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'octos-smoke-'));
const useXvfb = process.platform === 'linux' && !process.env.DISPLAY;
const display = useXvfb ? ':99' : process.env.DISPLAY;

const args = [root, '--smoke-test', '--no-sandbox'];

let xvfb = null;
if (useXvfb) {
  xvfb = spawn('Xvfb', [display, '-screen', '0', '1440x900x24', '-nolisten', 'tcp'], {
    stdio: 'ignore',
  });
}

const child = spawn(electronBinary, args, {
  cwd: root,
  env: {
    ...process.env,
    DISPLAY: display,
    OCTOS_USER_DATA_DIR: userDataDir,
    OCTOS_HEADLESS: '1',
    OCTOS_SMOKE_MS: process.env.OCTOS_SMOKE_MS || '20000',
    ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let stdout = '';
let stderr = '';
child.stdout.on('data', (chunk) => {
  stdout += chunk.toString();
});
child.stderr.on('data', (chunk) => {
  stderr += chunk.toString();
});

const timeout = setTimeout(() => {
  child.kill('SIGKILL');
}, 120000);

child.on('exit', (code) => {
  clearTimeout(timeout);
  const line = stdout
    .split('\n')
    .reverse()
    .find((entry) => entry.trim().startsWith('{') && entry.includes('"smoke":true'));

  if (!line) {
    console.error('SMOKE_FAIL: o aplicativo não reportou estado.');
    console.error(stdout.slice(-2000));
    console.error(stderr.slice(-2000));
    process.exit(1);
  }

  const report = JSON.parse(line);
  const failures = [];

  if (!report.appReady) failures.push('janela principal não ficou pronta');
  if (!report.config || !String(report.config.octosUrl).startsWith('https://')) {
    failures.push('URL oficial do OCTOS não configurada em HTTPS');
  }
  if (!report.site || report.site.loaded !== true) failures.push('janela integrada não carregou o site');
  if (!report.state || report.state.status !== 'disconnected') {
    failures.push(`estado inicial inesperado: ${report.state && report.state.status}`);
  }
  if (report.state && report.state.user !== null) failures.push('sessão deveria iniciar sem usuário');

  console.log(JSON.stringify(report, null, 2));
  if (failures.length) {
    console.error(`SMOKE_FAIL: ${failures.join('; ')}`);
    process.exit(1);
  }
  console.log('SMOKE_OK');
  process.exit(0);
});

child.on('error', (error) => {
  clearTimeout(timeout);
  console.error(`SMOKE_FAIL: não foi possível iniciar o Electron (${error.message}).`);
  process.exit(1);
});
