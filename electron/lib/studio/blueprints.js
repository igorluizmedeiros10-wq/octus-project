'use strict';

/**
 * Blueprints: descrição estruturada de um aplicativo a ser gerado.
 *
 * O mesmo formato é produzido por dois caminhos reais:
 *  - gerador local determinístico (sem chave de API), a partir do texto do usuário;
 *  - modelo de IA configurado pelo usuário (OpenAI-compatível), que devolve um manifesto de arquivos.
 *
 * Nada aqui simula resultado: o blueprint é sempre validado e normalizado antes de gerar arquivos.
 */

const LANGUAGES = Object.freeze(['cpp', 'csharp', 'python', 'javascript']);
const KINDS = Object.freeze(['notes', 'tasks', 'calculator']);

const LANGUAGE_LABELS = Object.freeze({
  cpp: 'C++ (Win32 API)',
  csharp: 'C# (WinForms)',
  python: 'Python (Tkinter)',
  javascript: 'JavaScript (Electron)',
});

const KIND_LABELS = Object.freeze({
  notes: 'Bloco de notas',
  tasks: 'Lista de tarefas',
  calculator: 'Calculadora',
});

const KIND_RULES = [
  { kind: 'calculator', words: ['calculadora', 'calculator', 'calcular', 'cálculo', 'calculo'] },
  { kind: 'tasks', words: ['tarefa', 'tarefas', 'todo', 'to-do', 'checklist', 'afazeres', 'pendências', 'pendencias'] },
  { kind: 'notes', words: ['nota', 'notas', 'anotação', 'anotações', 'anotacao', 'anotacoes', 'bloco de notas', 'diário', 'diario', 'notepad'] },
];

const LANGUAGE_RULES = [
  { language: 'cpp', words: ['c++', 'cpp', 'win32', 'mingw', 'msvc'] },
  { language: 'csharp', words: ['c#', 'csharp', 'c sharp', 'winforms', '.net', 'dotnet', 'wpf'] },
  { language: 'python', words: ['python', 'tkinter', 'pyinstaller', 'py'] },
  { language: 'javascript', words: ['javascript', 'js', 'electron', 'node', 'typescript'] },
];

const MAX = {
  name: 80,
  title: 120,
  description: 600,
  features: 10,
  feature: 160,
  filePath: 200,
  fileCount: 60,
  fileBytes: 400000,
  totalBytes: 2000000,
};

function cleanText(value, max) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function slugify(value, fallback = 'projeto') {
  const slug = String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return slug || fallback;
}

function detectLanguage(prompt) {
  const text = String(prompt || '').toLowerCase();
  let best = null;
  for (const rule of LANGUAGE_RULES) {
    const index = rule.words.reduce((found, word) => {
      const position = text.indexOf(word);
      return position === -1 || (found !== -1 && found <= position) ? found : position;
    }, -1);
    if (index === -1) continue;
    if (!best || index < best.index) best = { language: rule.language, index };
  }
  return best ? best.language : null;
}

function detectKind(prompt) {
  const text = String(prompt || '').toLowerCase();
  for (const rule of KIND_RULES) {
    if (rule.words.some((word) => text.includes(word))) return rule.kind;
  }
  return 'notes';
}

function titleFromPrompt(prompt) {
  const raw = cleanText(prompt, 160);
  if (!raw) return 'Novo aplicativo';
  const withoutCommand = raw
    .replace(/^(por favor,?\s*)?(crie|criar|cria|gere|gerar|faça|faca|construa|monte|quero|preciso de|desenvolva|make|create|build)\s+/i, '')
    .replace(/^(um|uma|o|a|an|a)\s+/i, '')
    .replace(/^(aplicativo|app|programa|software|projeto)\s+(de|para|do|da)?\s*/i, '');
  const firstClause = withoutCommand.split(/[.;\n]/)[0] || withoutCommand;
  const title = cleanText(firstClause, 70);
  if (!title) return 'Novo aplicativo';
  return title.charAt(0).toUpperCase() + title.slice(1);
}

function normalizeFeatures(input, fallbackKind) {
  const source = Array.isArray(input) ? input : [];
  const features = source
    .map((item) => cleanText(item, MAX.feature))
    .filter(Boolean)
    .slice(0, MAX.features);
  if (features.length) return features;
  const defaults = {
    notes: ['Criar, listar e remover notas', 'Persistir os dados em disco', 'Interface escura com detalhes em azul neon'],
    tasks: ['Adicionar e concluir tarefas', 'Persistir os dados em disco', 'Interface escura com detalhes em azul neon'],
    calculator: ['Avaliar expressões matemáticas', 'Histórico de cálculos na sessão', 'Interface escura com detalhes em azul neon'],
  };
  return (defaults[fallbackKind] || defaults.notes).slice();
}

/**
 * Valida e normaliza um blueprint vindo da interface ou da IA.
 * Nunca lança por campos opcionais ausentes: aplica padrões seguros.
 */
function normalizeBlueprint(input = {}) {
  const prompt = cleanText(input.prompt, 4000);
  const language = LANGUAGES.includes(input.language) ? input.language : detectLanguage(prompt) || 'python';
  const kind = KINDS.includes(input.kind) ? input.kind : detectKind(prompt);
  const title = cleanText(input.title, MAX.title) || titleFromPrompt(prompt);
  const name = slugify(input.name || title);
  const width = Math.min(2400, Math.max(640, Number(input.width) || 1080));
  const height = Math.min(1600, Math.max(420, Number(input.height) || 720));
  const accent = /^#[0-9a-f]{6}$/i.test(String(input.accent || '')) ? String(input.accent).toLowerCase() : '#2f9bff';

  return {
    version: 1,
    name,
    title,
    description: cleanText(input.description, MAX.description) || `${KIND_LABELS[kind]} gerado a partir da descrição do usuário.`,
    language,
    languageLabel: LANGUAGE_LABELS[language],
    kind,
    kindLabel: KIND_LABELS[kind],
    features: normalizeFeatures(input.features, kind),
    window: { width, height },
    accent,
    prompt,
  };
}

/** Blueprint determinístico gerado a partir do texto do usuário (modo local). */
function buildLocalBlueprint({ prompt, language, title } = {}) {
  const text = cleanText(prompt, 4000);
  return normalizeBlueprint({
    prompt: text,
    language: language || detectLanguage(text) || 'python',
    kind: detectKind(text),
    title: title || titleFromPrompt(text),
    description: text
      ? `Aplicativo Windows gerado a partir do pedido: "${text.slice(0, 220)}".`
      : 'Aplicativo Windows gerado com o modelo padrão do Executive AI Studio.',
  });
}

function describeBlueprint(blueprint) {
  const bp = normalizeBlueprint(blueprint);
  const lines = [
    `${bp.title} — ${bp.languageLabel}`,
    `Modelo: ${bp.kindLabel}`,
    `Janela: ${bp.window.width}x${bp.window.height} • Cor de destaque: ${bp.accent}`,
    '',
    'Recursos que serão gerados:',
    ...bp.features.map((feature) => `• ${feature}`),
  ];
  return lines.join('\n');
}

function safeRelativePath(value) {
  if (typeof value !== 'string') return null;
  const candidate = value.replace(/\\/g, '/').trim();
  if (!candidate || candidate.length > MAX.filePath) return null;
  if (/^[a-zA-Z]:/.test(candidate)) return null;
  if (candidate.startsWith('/') || candidate.startsWith('~')) return null;
  if (candidate.split('/').some((part) => part === '' || part === '.' || part === '..')) return null;
  if (/[\u0000-\u001f]/.test(candidate)) return null;
  return candidate;
}

/**
 * Valida o manifesto de arquivos devolvido pela IA.
 * Só aceita caminhos relativos seguros e arquivos de texto de tamanho limitado.
 */
function normalizeFileManifest(files) {
  if (!Array.isArray(files) || !files.length) {
    throw new Error('O modelo não devolveu nenhum arquivo para o projeto.');
  }
  if (files.length > MAX.fileCount) {
    throw new Error(`O projeto excede o limite de ${MAX.fileCount} arquivos.`);
  }
  const seen = new Set();
  const normalized = [];
  let total = 0;

  for (const entry of files) {
    if (!entry || typeof entry !== 'object') continue;
    const filePath = safeRelativePath(entry.path);
    if (!filePath) throw new Error(`Caminho de arquivo inválido no projeto gerado: ${String(entry.path).slice(0, 80)}`);
    if (seen.has(filePath)) continue;
    const content = typeof entry.content === 'string' ? entry.content : '';
    const bytes = Buffer.byteLength(content, 'utf8');
    if (bytes > MAX.fileBytes) throw new Error(`Arquivo grande demais: ${filePath}`);
    total += bytes;
    if (total > MAX.totalBytes) throw new Error('O projeto gerado excede o tamanho máximo permitido.');
    seen.add(filePath);
    normalized.push({ path: filePath, content });
  }

  if (!normalized.length) throw new Error('O modelo não devolveu nenhum arquivo válido.');
  return normalized;
}

module.exports = {
  LANGUAGES,
  KINDS,
  LANGUAGE_LABELS,
  KIND_LABELS,
  MAX,
  slugify,
  cleanText,
  detectLanguage,
  detectKind,
  titleFromPrompt,
  normalizeBlueprint,
  buildLocalBlueprint,
  describeBlueprint,
  normalizeFileManifest,
  safeRelativePath,
};
