'use strict';

/**
 * Cliente de IA compatível com a API OpenAI (chat/completions).
 * Funciona com OpenAI, Groq, DeepSeek, Together, Ollama e gateways compatíveis.
 * Streaming real por SSE; sem chave configurada, o app usa o gerador local determinístico.
 */

const { normalizeBlueprint, normalizeFileManifest, LANGUAGES } = require('./blueprints');

class AiError extends Error {
  constructor(message, code = 'ai_error', status = 0) {
    super(message);
    this.name = 'AiError';
    this.code = code;
    this.status = status;
  }
}

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_MODEL = 'gpt-4.1-mini';

function trimBaseUrl(value) {
  const candidate = String(value || '').trim() || DEFAULT_BASE_URL;
  return candidate.replace(/\/+$/, '');
}

/** Extrai o primeiro objeto JSON completo de um texto (tolera cercas markdown). */
function extractJson(text) {
  const source = String(text || '');
  const start = source.indexOf('{');
  if (start === -1) throw new AiError('A resposta do modelo não contém JSON.', 'invalid_response');
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < source.length; i += 1) {
    const char = source[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        const slice = source.slice(start, i + 1);
        try {
          return JSON.parse(slice);
        } catch (error) {
          throw new AiError(`JSON inválido devolvido pelo modelo: ${error.message}`, 'invalid_response');
        }
      }
    }
  }
  throw new AiError('A resposta do modelo está incompleta (JSON não terminado).', 'invalid_response');
}

function systemPrompt(language) {
  const langHint = LANGUAGES.includes(language) ? language : 'a mais adequada ao pedido';
  return [
    'Você é o motor de geração do Executive AI Studio.',
    'Responda SOMENTE com um objeto JSON válido, sem markdown, sem comentários e sem texto fora do JSON.',
    'Formato exato:',
    '{"blueprint":{"title":"...","description":"...","language":"cpp|csharp|python|javascript","kind":"notes|tasks|calculator","features":["..."],"accent":"#2f9bff"},"files":[{"path":"arquivo.ext","content":"conteúdo completo"}]}',
    `Linguagem preferida quando o pedido não especificar: ${langHint}.`,
    'Regras obrigatórias:',
    '- Gere um projeto COMPLETO e compilável/executável, sem trechos omitidos ou "..." no código.',
    '- Inclua interface gráfica real: Win32 API para C++, WinForms (.NET 8) para C#, Tkinter para Python, Electron para JavaScript.',
    '- Inclua sempre um script de compilação para .EXE (build.ps1) e um README.md curto.',
    '- Persistência de dados em disco quando o app fizer sentido (notas, tarefas).',
    '- Nunca use eval() nem comandos destrutivos. Nunca inclua credenciais.',
    '- Caminhos relativos, sem "..", sem barra inicial, no máximo 20 arquivos.',
  ].join('\n');
}

class AiClient {
  constructor({ apiKey, baseUrl, model, fetchImpl, timeoutMs = 180000 } = {}) {
    this.apiKey = typeof apiKey === 'string' ? apiKey.trim() : '';
    this.baseUrl = trimBaseUrl(baseUrl);
    this.model = String(model || '').trim() || DEFAULT_MODEL;
    this.fetchImpl = fetchImpl || globalThis.fetch;
    this.timeoutMs = timeoutMs;
  }

  get configured() {
    return Boolean(this.apiKey);
  }

  describe() {
    return { configured: this.configured, baseUrl: this.baseUrl, model: this.model };
  }

  headers() {
    if (!this.apiKey) throw new AiError('Nenhuma chave de IA configurada.', 'not_configured');
    return {
      'content-type': 'application/json',
      authorization: `Bearer ${this.apiKey}`,
    };
  }

  async request(pathname, body, { signal } = {}) {
    if (typeof this.fetchImpl !== 'function') {
      throw new AiError('Este ambiente não possui fetch disponível.', 'unsupported');
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const onAbort = () => controller.abort();
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    try {
      const response = await this.fetchImpl(`${this.baseUrl}${pathname}`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!response.ok) {
        const text = await response.text().catch(() => '');
        let message = text.slice(0, 400) || `HTTP ${response.status}`;
        try {
          const parsed = JSON.parse(text);
          message = parsed?.error?.message || parsed?.message || message;
        } catch {
          /* texto puro */
        }
        const code = response.status === 401 ? 'invalid_key' : response.status === 429 ? 'rate_limited' : 'http_error';
        throw new AiError(message, code, response.status);
      }
      return response;
    } catch (error) {
      if (error instanceof AiError) throw error;
      if (error.name === 'AbortError') throw new AiError('A requisição de IA excedeu o tempo limite.', 'timeout');
      throw new AiError(`Falha de rede ao chamar a IA: ${error.message}`, 'network');
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    }
  }

  /** Chat com streaming SSE real. onDelta recebe cada fragmento de texto. */
  async streamChat({ messages, onDelta, signal, temperature = 0.4 } = {}) {
    const response = await this.request(
      '/chat/completions',
      { model: this.model, messages, stream: true, temperature },
      { signal },
    );
    if (!response.body || typeof response.body.getReader !== 'function') {
      const payload = await response.json();
      const text = payload?.choices?.[0]?.message?.content || '';
      if (text && onDelta) onDelta(text);
      return text;
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let full = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const data = trimmed.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        let parsed;
        try {
          parsed = JSON.parse(data);
        } catch {
          continue;
        }
        const delta = parsed?.choices?.[0]?.delta?.content || '';
        if (delta) {
          full += delta;
          if (onDelta) onDelta(delta);
        }
      }
    }
    return full;
  }

  /** Gera um projeto completo: blueprint validado + arquivos validados. */
  async generateProject({ prompt, language, history = [] } = {}) {
    const text = String(prompt || '').trim();
    if (!text) throw new AiError('Descreva o aplicativo que deseja criar.', 'empty_prompt');
    const messages = [
      { role: 'system', content: systemPrompt(language) },
      ...history
        .filter((m) => m && (m.role === 'user' || m.role === 'assistant'))
        .slice(-6)
        .map((m) => ({ role: m.role, content: String(m.content || '').slice(0, 4000) })),
      { role: 'user', content: text },
    ];
    const raw = await this.streamChat({ messages, temperature: 0.3 });
    const parsed = extractJson(raw);
    const blueprint = normalizeBlueprint({
      ...(parsed.blueprint || {}),
      prompt: text,
      language: LANGUAGES.includes(parsed?.blueprint?.language) ? parsed.blueprint.language : language,
    });
    const files = normalizeFileManifest(parsed.files);
    return { blueprint, files, source: 'ai', raw };
  }

  /** Diálogo de apoio no chat (sem gerar projeto). */
  async chat({ messages, onDelta, signal } = {}) {
    const prepared = [
      {
        role: 'system',
        content:
          'Você é o assistente do Executive AI Studio, especialista em desenvolvimento de aplicativos desktop para Windows (C++, C#, Python, JavaScript/Electron). Responda em português, de forma técnica e objetiva.',
      },
      ...messages.map((m) => ({ role: m.role, content: String(m.content || '').slice(0, 6000) })),
    ];
    return this.streamChat({ messages: prepared, onDelta, signal });
  }
}

module.exports = { AiClient, AiError, extractJson, DEFAULT_BASE_URL, DEFAULT_MODEL };
