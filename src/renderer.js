'use strict';

/**
 * Renderer do Executive AI Studio.
 * Toda ação da interface chama um canal IPC real — nenhum botão é decorativo.
 */

(() => {
  const studio = window.studio;
  const octos = window.octos;

  const state = {
    view: 'chat',
    projects: [],
    activeId: null,
    project: null,
    selectedFile: null,
    chatLog: [],
    busy: false,
    status: null,
    octosState: null,
    octosTimer: null,
  };

  const $ = (id) => document.getElementById(id);

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function toast(message, kind = 'info') {
    const stack = $('toast-stack');
    if (!stack) return;
    const node = el('div', `toast${kind === 'error' ? ' is-error' : kind === 'ok' ? ' is-ok' : ''}`, message);
    stack.appendChild(node);
    setTimeout(() => {
      node.style.opacity = '0';
      setTimeout(() => node.remove(), 240);
    }, kind === 'error' ? 6500 : 3600);
  }

  async function call(promise) {
    let res;
    try {
      res = await promise;
    } catch (error) {
      throw new Error(error && error.message ? error.message : 'Falha de comunicação com o processo principal.');
    }
    if (!res || res.ok !== true) {
      const message = res && res.error && res.error.message ? res.error.message : 'Operação não concluída.';
      const failure = new Error(message);
      failure.code = res && res.error ? res.error.code : 'unknown';
      throw failure;
    }
    return res;
  }

  function fmtDate(value) {
    if (!value) return '—';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    return date.toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
  }

  function fmtBytes(bytes) {
    const value = Number(bytes) || 0;
    if (value < 1024) return `${value} B`;
    if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
    return `${(value / (1024 * 1024)).toFixed(2)} MB`;
  }

  /* ------------------------------------------------------------- views --- */

  function syncOctosSite() {
    if (!octos) return;
    const active = state.view === 'octos';
    if (!active) {
      octos.setViewVisible(false);
      return;
    }
    const holder = $('octos-site');
    if (!holder) return;
    const rect = holder.getBoundingClientRect();
    octos.setViewBounds({ x: Math.round(rect.left), y: Math.round(rect.top), width: Math.round(rect.width), height: Math.round(rect.height) });
    octos.setViewVisible(true);
  }

  function setView(view) {
    state.view = view;
    document.querySelectorAll('.nav-item').forEach((button) => {
      button.classList.toggle('is-active', button.dataset.view === view);
    });
    document.querySelectorAll('[data-view-panel]').forEach((panel) => {
      panel.classList.toggle('is-active', panel.dataset.viewPanel === view);
    });
    if (view === 'projects') refreshProjects();
    if (view === 'settings') loadSettings();
    if (view === 'octos') loadOctosState();
    syncOctosSite();
  }

  document.querySelectorAll('.nav-item').forEach((button) => {
    button.addEventListener('click', () => setView(button.dataset.view));
  });

  window.addEventListener('resize', () => {
    if (state.view === 'octos') syncOctosSite();
  });

  /* -------------------------------------------------------------- chat --- */

  const messagesBox = $('messages');

  function scrollMessages() {
    messagesBox.scrollTop = messagesBox.scrollHeight;
  }

  function addMessage(role, text, { typing = false } = {}) {
    const wrapper = el('div', `message message-${role}`);
    const body = el('div', 'message-body');
    const label = role === 'user' ? 'Você' : role === 'error' ? 'Erro' : 'Executive AI Studio';
    body.appendChild(el('strong', null, label));
    const paragraph = el('p', typing ? 'typing' : null, text);
    body.appendChild(paragraph);
    wrapper.appendChild(body);
    messagesBox.appendChild(wrapper);
    scrollMessages();
    return paragraph;
  }

  function streamInto(node) {
    return (payload) => {
      const chunk = typeof payload === 'string' ? payload : (payload && (payload.delta || payload.text || payload.chunk)) || '';
      if (!chunk) return;
      node.dataset.text = (node.dataset.text || '') + chunk;
      node.textContent = node.dataset.text;
      scrollMessages();
    };
  }

  function setBusy(busy) {
    state.busy = busy;
    const button = $('send');
    button.disabled = busy;
    $('send-label').textContent = busy ? 'Processando…' : $('mode').value === 'chat' ? 'Enviar' : 'Gerar projeto';
  }

  $('mode').addEventListener('change', () => setBusy(state.busy));

  $('composer').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (state.busy) return;
    const prompt = $('prompt').value.trim();
    if (!prompt) {
      toast('Escreva o que você quer criar.', 'error');
      return;
    }

    const mode = $('mode').value;
    const language = $('language').value;
    const useAi = $('use-ai').checked;

    addMessage('user', prompt);
    $('prompt').value = '';
    setBusy(true);
    const target = addMessage('assistant', '', { typing: true });

    try {
      if (mode === 'chat') {
        state.chatLog.push({ role: 'user', content: prompt });
        const res = await call(studio.chat(state.chatLog));
        const reply = typeof res.reply === 'string' && res.reply ? res.reply : target.dataset.text || 'Sem resposta do modelo.';
        target.textContent = reply;
        target.classList.remove('typing');
        state.chatLog.push({ role: 'assistant', content: reply });
      } else {
        const res = await call(studio.generate({ prompt, language, useAi }));
        target.classList.remove('typing');
        target.textContent = '';
        const blueprint = res.blueprint || {};
        target.appendChild(document.createTextNode(`${blueprint.title || res.project.title} — projeto ${blueprint.languageLabel || ''} gerado com ${(res.files || []).length} arquivo(s).`));
        if (res.source === 'local') {
          target.appendChild(document.createTextNode(' Motor local (nenhuma chave de IA configurada).'));
        }
        const openButton = el('button', 'btn btn-mini', 'Abrir no gerenciador');
        openButton.type = 'button';
        openButton.addEventListener('click', () => {
          setView('projects');
          openProject(res.project.id);
        });
        target.parentElement.appendChild(openButton);
        toast('Projeto gerado e salvo.', 'ok');
        await refreshProjects();
        state.activeId = res.project.id;
        renderPanel();
      }
    } catch (error) {
      target.classList.remove('typing');
      target.textContent = error.message;
      target.parentElement.parentElement.className = 'message message-error';
      toast(error.message, 'error');
    } finally {
      setBusy(false);
      scrollMessages();
    }
  });

  /* ---------------------------------------------------------- projects --- */

  async function refreshProjects() {
    try {
      const res = await call(studio.listProjects());
      state.projects = Array.isArray(res.projects) ? res.projects : [];
      renderPanel();
      renderGrid();
    } catch (error) {
      toast(error.message, 'error');
    }
  }

  function renderPanel() {
    const list = $('project-list');
    list.textContent = '';
    $('project-count').textContent = String(state.projects.length);
    if (!state.projects.length) {
      list.appendChild(el('p', 'empty-hint', 'Nenhum projeto ainda.'));
      return;
    }
    for (const project of state.projects) {
      const item = el('button', `panel-item${project.id === state.activeId ? ' is-active' : ''}`);
      item.type = 'button';
      item.appendChild(el('strong', null, project.title || project.id));
      item.appendChild(el('small', null, `${project.languageLabel || project.language || '—'} · ${fmtDate(project.updatedAt)}`));
      item.addEventListener('click', () => {
        setView('projects');
        openProject(project.id);
      });
      list.appendChild(item);
    }
  }

  function renderGrid() {
    const grid = $('projects-grid');
    grid.textContent = '';
    $('projects-empty').classList.toggle('is-hidden', state.projects.length > 0);
    for (const project of state.projects) {
      const card = el('button', `project-card${project.id === state.activeId ? ' is-active' : ''}`);
      card.type = 'button';
      card.appendChild(el('strong', null, project.title || project.id));
      card.appendChild(el('small', null, `${project.languageLabel || project.language || '—'} · ${project.fileCount || 0} arquivo(s)`));
      card.addEventListener('click', () => openProject(project.id));
      grid.appendChild(card);
    }
  }

  function appendConsole(text) {
    const box = $('console');
    if (!box) return;
    box.textContent += text;
    box.scrollTop = box.scrollHeight;
  }

  async function openProject(id) {
    try {
      const res = await call(studio.readProject(id));
      state.project = res;
      state.activeId = id;
      state.selectedFile = null;
      $('detail-placeholder').classList.add('is-hidden');
      $('detail-content').classList.remove('is-hidden');
      renderDetail();
      renderPanel();
      renderGrid();
      const entry = (res.meta && res.meta.entry) || (res.files && res.files[0] && res.files[0].path);
      if (entry) selectFile(entry);
      renderHistory(res.history);
    } catch (error) {
      toast(error.message, 'error');
    }
  }

  function renderDetail() {
    const { meta, raw, files } = state.project;
    $('detail-title').textContent = (meta && meta.title) || 'Projeto';
    const info = [
      (raw && raw.languageLabel) || (meta && meta.languageLabel) || '',
      (raw && raw.kindLabel) || '',
      `${(files || []).length} arquivo(s)`,
      `atualizado ${fmtDate(meta && meta.updatedAt)}`,
      meta && meta.lastBuild && meta.lastBuild.at ? `build ${meta.lastBuild.ok ? 'ok' : 'com falha'} em ${fmtDate(meta.lastBuild.at)}` : 'sem build',
    ].filter(Boolean);
    $('detail-meta').textContent = info.join(' · ');

    const features = $('detail-features');
    features.textContent = '';
    const list = (raw && raw.features) || [];
    for (const feature of list) features.appendChild(el('span', null, feature));

    const tree = $('file-tree');
    tree.textContent = '';
    for (const file of files || []) {
      const button = el('button', `file-item${file.path === state.selectedFile ? ' is-active' : ''}`, file.path);
      button.type = 'button';
      button.addEventListener('click', () => selectFile(file.path));
      tree.appendChild(button);
    }
  }

  function selectFile(filePath) {
    state.selectedFile = filePath;
    const file = (state.project.files || []).find((item) => item.path === filePath);
    $('editor-path').textContent = filePath;
    const view = $('code-view');
    view.value = file ? file.content : '';
    view.readOnly = Boolean(file && file.binary);
    view.placeholder = file && file.binary ? 'Arquivo binário — não editável.' : '';
    document.querySelectorAll('.file-item').forEach((button) => {
      button.classList.toggle('is-active', button.textContent === filePath);
    });
  }

  function renderHistory(history) {
    const box = $('history-list');
    box.textContent = '';
    const changes = (history && history.changes) || [];
    const messages = (history && history.messages) || [];
    const entries = [
      ...changes.map((change) => ({ kind: change.kind, detail: change.detail, at: change.at })),
      ...messages.map((message) => ({ kind: message.role === 'user' ? 'você' : 'ia', detail: message.content, at: message.at })),
    ].sort((a, b) => String(b.at || '').localeCompare(String(a.at || ''))).slice(0, 60);

    if (!entries.length) {
      box.appendChild(el('p', 'empty-hint', 'Sem histórico para este projeto.'));
      return;
    }
    for (const entry of entries) {
      const item = el('div', 'history-item');
      item.appendChild(el('strong', null, entry.kind || 'evento'));
      item.appendChild(document.createTextNode(` ${entry.detail || ''}`));
      item.appendChild(el('time', null, fmtDate(entry.at)));
      box.appendChild(item);
    }
  }

  $('save-file').addEventListener('click', async () => {
    if (!state.project || !state.selectedFile) {
      toast('Selecione um arquivo.', 'error');
      return;
    }
    try {
      await call(studio.writeProjectFile({ id: state.activeId, path: state.selectedFile, content: $('code-view').value }));
      toast('Arquivo salvo.', 'ok');
      await openProject(state.activeId);
    } catch (error) {
      toast(error.message, 'error');
    }
  });

  $('remove-file').addEventListener('click', async () => {
    if (!state.project || !state.selectedFile) {
      toast('Selecione um arquivo.', 'error');
      return;
    }
    try {
      await call(studio.removeProjectFile({ id: state.activeId, path: state.selectedFile }));
      toast('Arquivo removido.', 'ok');
      await openProject(state.activeId);
    } catch (error) {
      toast(error.message, 'error');
    }
  });

  $('delete-project').addEventListener('click', async () => {
    if (!state.activeId) return;
    try {
      await call(studio.deleteProject(state.activeId));
      state.activeId = null;
      state.project = null;
      $('detail-content').classList.add('is-hidden');
      $('detail-placeholder').classList.remove('is-hidden');
      toast('Projeto excluído.', 'ok');
      await refreshProjects();
    } catch (error) {
      toast(error.message, 'error');
    }
  });

  $('refresh-projects').addEventListener('click', refreshProjects);

  $('clear-history').addEventListener('click', async () => {
    if (!state.activeId) return;
    try {
      const res = await call(studio.clearHistory(state.activeId));
      renderHistory(res.history);
      toast('Histórico limpo.', 'ok');
    } catch (error) {
      toast(error.message, 'error');
    }
  });

  document.querySelectorAll('[data-action]').forEach((button) => {
    button.addEventListener('click', async () => {
      if (!state.activeId) {
        toast('Selecione um projeto.', 'error');
        return;
      }
      const action = button.dataset.action;
      button.disabled = true;
      try {
        if (action === 'verify') {
          appendConsole('\n$ verificação\n');
          const res = await call(studio.verify(state.activeId));
          for (const step of res.steps || []) appendConsole(`${step.ok ? '✔' : '✘'} ${step.name}${step.detail ? ` — ${step.detail}` : ''}\n`);
          appendConsole(res.ok ? 'Verificação concluída com sucesso.\n' : 'Verificação encontrou problemas.\n');
          toast(res.ok ? 'Verificação concluída.' : 'Verificação com falhas.', res.ok ? 'ok' : 'error');
          await openProject(state.activeId);
        } else if (action === 'build') {
          appendConsole('\n$ compilação\n');
          const res = await call(studio.build(state.activeId));
          if (res.output) appendConsole(res.output);
          for (const artifact of res.artifacts || []) appendConsole(`artefato: ${artifact.path || artifact}\n`);
          appendConsole(res.ok ? 'Compilação concluída.\n' : 'Compilação não concluída.\n');
          toast(res.summary ? res.summary.message : res.ok ? 'Compilado.' : 'Falha na compilação.', res.ok ? 'ok' : 'error');
          await openProject(state.activeId);
        } else if (action === 'run') {
          const res = await call(studio.run(state.activeId));
          appendConsole(`\n$ ${res.command} (pid ${res.pid})\n`);
          toast('Aplicativo iniciado.', 'ok');
        } else if (action === 'stop') {
          const res = await call(studio.stop(state.activeId));
          appendConsole(res.stop && res.stop.stopped ? '\n[processo encerrado]\n' : '\n[nenhum processo em execução]\n');
        } else if (action === 'export-zip') {
          const res = await call(studio.exportProject(state.activeId));
          toast(`ZIP salvo em ${res.path || res.saved || 'disco'}.`, 'ok');
          appendConsole(`\nexportado: ${res.path || res.saved || ''}\n`);
        } else if (action === 'export-folder') {
          const res = await call(studio.exportProjectFolder(state.activeId));
          toast(`Projeto exportado para ${res.directory || res.path || 'disco'}.`, 'ok');
        } else if (action === 'reveal') {
          await call(studio.revealProject(state.activeId));
        } else if (action === 'analyze') {
          const artifacts = (state.project.meta && state.project.meta.lastBuild && state.project.meta.lastBuild.artifacts) || [];
          const first = artifacts[0];
          const relPath = first && (first.path || first);
          if (!relPath) {
            toast('Compile o projeto primeiro para gerar um executável.', 'error');
            return;
          }
          const report = await call(studio.analyzeProjectArtifact({ id: state.activeId, path: relPath }));
          renderReport(report);
          setView('analysis');
        }
      } catch (error) {
        toast(error.message, 'error');
        appendConsole(`\n[erro] ${error.message}\n`);
      } finally {
        button.disabled = false;
      }
    });
  });

  $('open-projects-view').addEventListener('click', () => setView('projects'));

  /* ---------------------------------------------------------- analysis --- */

  function renderReport(report) {
    const holder = $('analysis-result');
    holder.textContent = '';
    const wrap = el('div', 'report');

    const info = el('div', 'report-card');
    info.appendChild(el('h3', null, 'Identificação'));
    const infoList = el('dl', 'kv');
    const format = report.format && typeof report.format === 'object' ? report.format : { tipo: report.format || 'desconhecido' };
    const pairs = [
      ['arquivo', report.path || report.file || '—'],
      ['tamanho', fmtBytes(report.size || report.bytes)],
      ['analisado', fmtDate(report.analyzedAt)],
      ...Object.entries(format).slice(0, 8),
    ];
    for (const [key, value] of pairs) {
      infoList.appendChild(el('dt', null, String(key)));
      infoList.appendChild(el('dd', null, String(value)));
    }
    info.appendChild(infoList);

    const hashCard = el('div', 'report-card');
    hashCard.appendChild(el('h3', null, 'Hashes'));
    const hashList = el('dl', 'kv');
    for (const [key, value] of Object.entries(report.hashes || {})) {
      hashList.appendChild(el('dt', null, key.toUpperCase()));
      hashList.appendChild(el('dd', null, String(value)));
    }
    hashCard.appendChild(hashList);

    wrap.appendChild(info);
    wrap.appendChild(hashCard);

    const headers = report.headers || {};
    const headerKeys = Object.keys(headers);
    if (headerKeys.length) {
      const card = el('div', 'report-card');
      card.appendChild(el('h3', null, 'Cabeçalhos e seções'));
      const list = el('dl', 'kv');
      for (const key of headerKeys.slice(0, 40)) {
        const value = headers[key];
        list.appendChild(el('dt', null, key));
        list.appendChild(el('dd', null, typeof value === 'object' ? JSON.stringify(value) : String(value)));
      }
      card.appendChild(list);
      wrap.appendChild(card);
    }

    const libraries = report.libraries || {};
    const libraryEntries = Array.isArray(libraries)
      ? [['bibliotecas', libraries]]
      : Object.entries(libraries).filter(([, value]) => (Array.isArray(value) ? value.length : value));
    if (libraryEntries.length) {
      const card = el('div', 'report-card');
      card.appendChild(el('h3', null, 'Bibliotecas'));
      for (const [group, value] of libraryEntries) {
        card.appendChild(el('div', 'kv', String(group)));
        const table = el('table', 'report-table');
        const rows = Array.isArray(value) ? value : [value];
        for (const row of rows.slice(0, 80)) {
          const tr = el('tr');
          if (typeof row === 'object' && row !== null) {
            for (const cell of Object.values(row)) tr.appendChild(el('td', null, String(cell)));
          } else {
            tr.appendChild(el('td', null, String(row)));
          }
          table.appendChild(tr);
        }
        card.appendChild(table);
      }
      wrap.appendChild(card);
    }

    const warnings = report.warnings || [];
    if (warnings.length) {
      const card = el('div', 'report-card');
      card.appendChild(el('h3', null, 'Alertas técnicos'));
      const list = el('ul', 'warning-list');
      for (const warning of warnings) list.appendChild(el('li', null, String(warning)));
      card.appendChild(list);
      wrap.appendChild(card);
    }

    const strings = report.strings || [];
    if (strings.length) {
      const card = el('div', 'report-card');
      card.appendChild(el('h3', null, 'Strings'));
      card.appendChild(el('div', 'strings-box', strings.slice(0, 200).join('\n')));
      wrap.appendChild(card);
    }

    holder.appendChild(wrap);
  }

  $('pick-binary').addEventListener('click', async () => {
    try {
      const report = await call(studio.analyzeFile());
      if (report.cancelled) return;
      renderReport(report);
    } catch (error) {
      toast(error.message, 'error');
    }
  });

  /* ------------------------------------------------------------ octos ---- */

  function renderOctosState(payload) {
    const snapshot = payload && payload.state ? payload.state : payload || {};
    state.octosState = snapshot;
    const connected = Boolean(snapshot.connected || snapshot.signedIn || (snapshot.user && snapshot.user.email));
    const badge = $('octos-badge');
    badge.textContent = connected ? 'conectado' : 'desconectado';
    badge.classList.toggle('badge-ghost', !connected);
    $('octos-form').classList.toggle('is-hidden', connected);
    $('octos-user').classList.toggle('is-hidden', !connected);

    const user = snapshot.user || {};
    if (connected) {
      $('octos-name').textContent = user.name || user.fullName || 'Conta OCTOS';
      $('octos-email').textContent = user.email || '';
      const avatar = $('octos-avatar');
      avatar.textContent = '';
      if (user.avatarUrl) {
        const image = el('img');
        image.src = user.avatarUrl;
        image.alt = '';
        avatar.appendChild(image);
      } else {
        avatar.textContent = String(user.name || user.email || '?').trim().charAt(0).toUpperCase();
      }
    }
    if (snapshot.message) setOctosMessage(snapshot.message, snapshot.status === 'error' ? 'error' : 'ok');
  }

  function setOctosMessage(message, kind = 'info') {
    const node = $('octos-message');
    node.textContent = message || '';
    node.className = `form-message${kind === 'error' ? ' is-error' : kind === 'ok' ? ' is-ok' : ''}`;
  }

  async function loadOctosState() {
    if (!octos) return;
    try {
      const res = await octos.getState();
      if (res && res.ok === false) {
        setOctosMessage(res.error && res.error.message ? res.error.message : 'Falha ao consultar a conta.', 'error');
        return;
      }
      renderOctosState(res);
    } catch (error) {
      setOctosMessage(error.message, 'error');
    }
  }

  $('octos-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const email = $('octos-email-input').value.trim();
    const password = $('octos-password-input').value;
    if (!email || !password) {
      setOctosMessage('Informe e-mail e senha.', 'error');
      return;
    }
    setOctosMessage('Entrando…');
    try {
      const res = await octos.signIn({ email, password });
      if (res && res.ok === false) {
        setOctosMessage(res.error && res.error.message ? res.error.message : 'Não foi possível entrar.', 'error');
        return;
      }
      $('octos-password-input').value = '';
      renderOctosState(res);
      setOctosMessage('Conectado ao OCTOS.', 'ok');
      toast('Sessão OCTOS iniciada.', 'ok');
    } catch (error) {
      setOctosMessage(error.message, 'error');
    }
  });

  $('octos-signout').addEventListener('click', async () => {
    try {
      const res = await octos.signOut();
      renderOctosState(res);
      setOctosMessage('Sessão encerrada.');
    } catch (error) {
      setOctosMessage(error.message, 'error');
    }
  });

  $('octos-google').addEventListener('click', async () => {
    try {
      await octos.openRoute('login');
      setOctosMessage('Escolha "Continuar com Google" na página oficial do OCTOS.', 'ok');
    } catch (error) {
      setOctosMessage(error.message, 'error');
    }
  });

  $('octos-register').addEventListener('click', async () => {
    try {
      await octos.openRoute('register');
      setOctosMessage('Cadastro aberto na página oficial do OCTOS.', 'ok');
    } catch (error) {
      setOctosMessage(error.message, 'error');
    }
  });

  $('octos-forgot').addEventListener('click', async () => {
    try {
      await octos.openRoute('reset');
      setOctosMessage('Recuperação de senha aberta na página oficial do OCTOS.', 'ok');
    } catch (error) {
      setOctosMessage(error.message, 'error');
    }
  });

  /* --------------------------------------------------------- settings ---- */

  function renderToolchain(toolchain) {
    const holder = $('toolchain-list');
    holder.textContent = '';
    const tools = (toolchain && toolchain.tools) || {};
    const canBuild = (toolchain && toolchain.canBuild) || {};
    for (const [key, info] of Object.entries(tools)) {
      const row = el('div', 'toolchain-row');
      row.appendChild(el('span', null, info.label || key));
      const value = el('span', info.available ? 'ok-text' : 'bad-text', info.available ? `disponível${canBuild[key] === false ? ' (sem build .EXE aqui)' : ''}` : 'ausente');
      row.appendChild(value);
      holder.appendChild(row);
    }
  }

  async function loadSettings() {
    try {
      const res = await call(studio.status());
      state.status = res.status || {};
      const ai = state.status.ai || {};
      $('ai-base').value = ai.baseUrl || '';
      $('ai-model').value = ai.model || '';
      $('ai-key').value = '';
      $('ai-key').placeholder = ai.configured ? 'chave salva — preencha para substituir' : 'sk-…';
      $('ai-storage').textContent = ai.configured
        ? `Chave cifrada em ${ai.storageBackend === 'none' ? 'armazenamento indisponível' : ai.storageBackend}.`
        : 'Nenhuma chave configurada — o Studio usa o motor local determinístico.';
      $('ai-status').textContent = ai.configured ? `IA · ${ai.model}` : 'Motor local';
      $('ai-dot').className = ai.configured ? 'dot' : 'dot dot-warn';
      $('engine-badge').textContent = ai.configured ? ai.model : 'motor local';
      renderToolchain(state.status.toolchain);
      $('platform-badge').textContent = state.status.platform === 'win32' ? 'windows' : state.status.platform || 'desconhecido';

      const toolchain = state.status.toolchain || {};
      const anyTool = Object.values(toolchain.tools || {}).some((tool) => tool.available);
      $('toolchain-status').textContent = anyTool ? 'toolchain detectada' : 'sem compiladores';
      $('toolchain-dot').className = `dot ${anyTool ? '' : 'dot-warn'}`;

      if (octos) {
        const octosState = await octos.getState();
        const url = (octosState && octosState.state && octosState.state.octosUrl) || (octosState && octosState.octosUrl);
        if (url) $('octos-url').value = url;
      }
    } catch (error) {
      toast(error.message, 'error');
    }
  }

  $('ai-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const message = $('ai-message');
    try {
      const res = await call(
        studio.saveSettings({ apiKey: $('ai-key').value.trim(), baseUrl: $('ai-base').value.trim(), model: $('ai-model').value.trim() })
      );
      message.textContent = res.ai && res.ai.configured ? 'Chave salva com segurança.' : 'Configuração salva.';
      message.className = 'form-message is-ok';
      await loadSettings();
      toast('Configuração de IA salva.', 'ok');
    } catch (error) {
      message.textContent = error.message;
      message.className = 'form-message is-error';
    }
  });

  $('ai-clear').addEventListener('click', async () => {
    try {
      await call(studio.clearSettings());
      $('ai-message').textContent = 'Chave removida. O Studio voltou ao motor local.';
      $('ai-message').className = 'form-message is-ok';
      await loadSettings();
    } catch (error) {
      $('ai-message').textContent = error.message;
      $('ai-message').className = 'form-message is-error';
    }
  });

  $('octos-url-save').addEventListener('click', async () => {
    const node = $('octos-url-message');
    try {
      const res = await octos.saveConfig({ octosUrl: $('octos-url').value.trim() });
      if (res && res.ok === false) throw new Error(res.error && res.error.message ? res.error.message : 'URL inválida.');
      node.textContent = 'URL do OCTOS atualizada.';
      node.className = 'form-message is-ok';
      loadOctosState();
    } catch (error) {
      node.textContent = error.message;
      node.className = 'form-message is-error';
    }
  });

  /* ------------------------------------------------------ subscriptions -- */

  if (studio) {
    studio.onProjectsChanged(() => refreshProjects());
    studio.onOutput((payload) => {
      const text = typeof payload === 'string' ? payload : (payload && (payload.text || payload.chunk || payload.output)) || '';
      if (!text) return;
      const id = payload && payload.id;
      if (!id || id === state.activeId) appendConsole(text);
    });
  }

  if (octos) {
    octos.onState((payload) => renderOctosState(payload));
  }

  /* --------------------------------------------------------------- boot -- */

  refreshProjects();
  loadSettings();
  loadOctosState();
  syncOctosSite();
})();
