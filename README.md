# Executive AI Studio — Integração oficial com OCTOS

Aplicativo desktop para **Windows 11** que abre o site OCTOS (Base44) em uma janela integrada e usa
**exclusivamente a autenticação oficial do OCTOS**. Não existe segundo cadastro, login local ou
"modo demonstração": toda credencial é validada pela API oficial do site configurado.

Site padrão: <https://octos-access-core.base44.app>

---

## 1. O que o aplicativo faz

| Requisito | Como foi implementado |
| --- | --- |
| Conexão direta com o site | Janela integrada (`WebContentsView`) carregando a URL oficial do OCTOS |
| URL configurável sem recompilar | `config.json` em `%APPDATA%/Executive AI Studio OCTOS/config.json`, editável na tela de configurações |
| Detecção de conectado/desconectado | Leitura do token oficial do site + validação em `/api/apps/{appId}/entities/User/me` |
| Sincronização com o site | Eventos de navegação, carregamento e polling periódico da sessão do site |
| Login com Google | OAuth oficial executado na janela integrada (domínio Google) e sessão adotada pelo app |
| Login com e-mail e senha | `POST /api/apps/auth/login` (endpoint oficial Base44) |
| Cadastro | `POST /api/apps/auth/register` ou tela oficial `/register` dentro do app |
| Recuperação de senha | `POST /api/apps/auth/reset-password-request` e `/reset-password` |
| Logout | `POST /api/apps/auth/logout` + limpeza da sessão local e do site |
| Manutenção de sessão | Token cifrado em disco e revalidado na abertura |
| Identificação do usuário | Nome, e-mail, foto e papel vindos do perfil oficial |
| Bloqueios e permissões | Status `blocked/suspended/disabled` e respostas 401/403 do OCTOS encerram o acesso |
| Segurança | HTTPS obrigatório, `safeStorage` (DPAPI no Windows), sem senhas em disco, `contextIsolation` + sandbox |

---

## 2. Arquitetura

```
electron/
  main.js                     processo principal: janela, IPC, sessão, configuração
  preload.js                  ponte mínima e validada (nenhum token exposto ao renderer)
  lib/
    octos-api.js              cliente dos endpoints oficiais de auth/perfil
    session-manager.js        ciclo de vida da sessão (login, OTP, sync, bloqueio, logout)
    secure-store.js           token cifrado (safeStorage/DPAPI ou AES-256-GCM)
    config-store.js           URL do OCTOS persistida, sem recompilar
    url-policy.js             HTTPS obrigatório e navegação restrita
    user.js                   normalização do perfil e detecção de bloqueio
  windows/
    main-window.js            janela principal segura
    octos-site-view.js        janela integrada do site + captura do token oficial
src/
  index.html, styles.css, renderer.js    interface (login, perfil, configuração)
test/                         testes automatizados (node:test)
```

### Endpoints oficiais usados

Confirmados no SDK oficial `@base44/sdk@0.8.59`:

```
POST /api/apps/auth/login
POST /api/apps/auth/register
POST /api/apps/auth/reset-password-request
POST /api/apps/auth/reset-password
POST /api/apps/auth/verify-otp
POST /api/apps/auth/resend-otp
POST /api/apps/auth/logout
GET  /api/apps/{appId}/entities/User/me
```

App ID do OCTOS: `6af08b29a691a162e5738c97`.

---

## 3. Como executar

```bash
npm install
npm start
```

No Windows, o instalador é gerado com:

```bash
npm run dist:win
```

O resultado fica em `release/` (`Executive AI Studio OCTOS-1.0.0-setup.exe`).
A compilação do instalador NSIS precisa ser feita em Windows ou em CI Windows — o ambiente de
desenvolvimento deste repositório não compila binários nativos.

---

## 4. Segurança aplicada

- **HTTPS obrigatório** para a URL do OCTOS (HTTP só é aceito em `localhost`, para desenvolvimento).
- **Nenhuma senha é gravada**: o armazenamento rejeita qualquer payload com `password`/`senha`.
- **Token cifrado**: `safeStorage` (DPAPI, vinculado ao usuário do Windows) com fallback AES-256-GCM
  e chave local com permissão `0600`.
- **Renderer isolado**: `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`,
  CSP sem `unsafe-inline` e sem conexões de rede (`connect-src 'none'`).
- **Navegação restrita**: apenas o domínio do OCTOS, Base44 e Google; links externos abrem no
  navegador padrão.
- **Sessão de terceiros nunca é aceita**: o token é sempre validado no servidor oficial antes de
  liberar o perfil; 401 encerra a sessão e 403 marca a conta como bloqueada.
- **Permissões**: papéis e status vêm do OCTOS; o app apenas os exibe e respeita.

---

## 5. Testes

```bash
npm test          # testes de URL, perfil, armazenamento, configuração, API e sessão
npm run smoke     # inicialização real do Electron (xvfb no Linux) com o site oficial
```

Os testes cobrem:

- política de URL (HTTPS, domínios permitidos, bloqueio de terceiros);
- normalização de perfil, foto, papel e bloqueios;
- cifragem do token, ausência de senha em disco, detecção de adulteração;
- configuração de URL persistida e validação de entradas;
- cliente oficial de auth (login, cadastro, OTP, recuperação, logout) com respostas simuladas;
- gerenciador de sessão (restauração, adoção do token do site, expiração, bloqueio, logout).

> Os testes usam respostas HTTP simuladas para os endpoints oficiais: eles validam o
> comportamento do cliente, não substituem um teste com uma conta real no OCTOS.

---

## 6. Executive AI Studio (gerador de aplicativos)

Além da conexão com o OCTOS, o app inclui o **Executive AI Studio**: chat de IA que gera
projetos completos de aplicativos para PC.

| Requisito | Como foi implementado |
| --- | --- |
| Chat integrado com IA | `electron/lib/studio/ai-client.js` — API compatível com OpenAI, com streaming (SSE) e cancelamento |
| Campo de comando | Área de mensagem central; a linguagem é detectada do texto ou escolhida nos chips |
| C++, C#, Python, JavaScript | Geradores reais em `electron/lib/studio/generators/` (Win32/GDI, WinForms, Tkinter, Electron) |
| Interfaces gráficas Windows | Cada projeto sai com janela nativa, tema escuro e detalhes em azul neon |
| Visualizar e testar | `build-runner.js` compila e executa o projeto; o console exibe a saída real do processo |
| Exportar e gerar `.EXE` | ZIP do projeto (`exportProject`) + scripts de build (`build.ps1`/`build.bat`, `dotnet publish`, `pyinstaller`, `electron-builder`) |
| Gerenciador de projetos | `project-store.js` — criar, abrir, editar arquivos, excluir, revelar no Explorer |
| Histórico de conversas e alterações | `history-store.js` — mensagens e log de alterações por projeto, com limpeza |
| Análise de executáveis | `exe-analyzer.js` — PE/ELF: arquitetura, subsistema, seções, imports, DLLs, entropia, SHA-256/MD5, sem executar o arquivo |

### Chave de IA (opcional)

O Studio funciona sem chave: nesse caso usa o **gerador local determinístico**, que produz
projetos reais e compiláveis a partir da descrição. Para usar um modelo de IA, informe em
**Configurações → IA** a chave, o endpoint (padrão `https://api.openai.com/v1`) e o modelo.
A chave é guardada cifrada via `safeStorage` e nunca é enviada ao renderer.

### Análise de executáveis

A aba **Análise** aceita apenas arquivos que o usuário escolhe no disco. O arquivo é lido em
memória e interpretado — nunca executado. São exibidos formato, arquitetura, timestamp,
subsistema, seções com entropia, bibliotecas importadas, símbolos exportados e hashes.

---

## 7. Gerar o instalador `.EXE` (Windows 11)

O empacotamento usa `electron-builder` com alvo **NSIS** (instalador com escolha de diretório,
sem exigir administrador).

```bash
npm install
npm run dist:win
```

Resultado em `release/`:

```
release/Executive AI Studio OCTOS-1.0.0-setup.exe   # instalador
release/win-unpacked/                               # versão portátil
```

Configuração em `package.json → build`: `appId com.executiveaistudio.octos`, `target nsis`,
`artifactName ${productName}-${version}-setup.${ext}`.

> O instalador precisa ser gerado em uma máquina Windows (ou runner Windows), pois
> `electron-builder` usa as ferramentas de assinatura/empacotamento do sistema. Neste
> ambiente Linux o código é testado (`npm test`), mas o `.exe` final não é produzido aqui.

### Toolchains para compilar os projetos gerados

| Linguagem | Necessário para gerar o `.EXE` |
| --- | --- |
| C++ | Visual Studio Build Tools (MSVC) ou MinGW-w64 |
| C# | .NET SDK 8+ (`dotnet publish -r win-x64`) |
| Python | Python 3.10+ e `pip install pyinstaller` |
| JavaScript | Node.js 20+ e `npm install` no projeto gerado |

O Studio detecta o que está instalado e informa na interface o que falta antes de compilar.

---

## 8. Limites conhecidos

- O login com Google depende de o OCTOS/Base44 permitir o popup OAuth dentro da janela
  integrada; se o provedor exigir uma janela externa, o app abre o navegador padrão.
- A geração por IA exige uma chave válida do provedor escolhido; sem ela o Studio usa o
  gerador local, que é determinístico e não inventa funcionalidades não pedidas.
- A análise de executáveis é estática (cabeçalhos, seções, imports): não faz descompilação
  nem engenharia reversa de código protegido.

---

## 9. Baixar o instalador `.exe` pronto

O instalador é gerado automaticamente em um runner **Windows** pelo GitHub Actions
(`.github/workflows/build-windows.yml`), pois o empacotamento NSIS precisa de Windows.

**Download direto (recomendado):**

<https://github.com/igorluizmedeiros10-wq/octus-project/releases/tag/v1.0.0>

| Arquivo | Tamanho | Link direto |
| --- | --- | --- |
| `Executive.AI.Studio.OCTOS-1.0.0-setup.exe` | 115,7 MB | <https://github.com/igorluizmedeiros10-wq/octus-project/releases/download/v1.0.0/Executive.AI.Studio.OCTOS-1.0.0-setup.exe> |
| `Executive-AI-Studio-OCTOS-portable.zip` | 154,9 MB | <https://github.com/igorluizmedeiros10-wq/octus-project/releases/download/v1.0.0/Executive-AI-Studio-OCTOS-portable.zip> |
| `Executive-AI-Studio-OCTOS-source.zip` | arquivos do app | <https://github.com/igorluizmedeiros10-wq/octus-project/releases/download/v1.0.0/Executive-AI-Studio-OCTOS-source.zip> |

O `source.zip` contém os arquivos do aplicativo (código-fonte completo: `electron/`,
`src/`, `assets/`, `test/`, `package.json`, `package-lock.json`, README e o workflow),
sem `node_modules` e sem artefatos de build — útil para abrir no seu ambiente,
conferir o código e rodar `npm install && npm start`.

Baixe o `setup.exe` e execute. O instalador não exige administrador e permite escolher a
pasta de instalação (cria atalhos na área de trabalho e no menu Iniciar).

**Alternativa — artefato do workflow:**

<https://github.com/igorluizmedeiros10-wq/octus-project/actions/workflows/build-windows.yml>

Cada execução publica o pacote `executive-ai-studio-windows` com:

| Arquivo | Uso |
| --- | --- |
| `Executive AI Studio OCTOS-1.0.0-setup.exe` | Instalador NSIS para Windows 11 |
| `Executive-AI-Studio-OCTOS-portable.zip` | Versão portátil (descompactar e rodar o `.exe` interno) |
| `Executive-AI-Studio-OCTOS-source.zip` | Arquivos do aplicativo (código-fonte completo) |

O build roda automaticamente a cada push no branch `appjet`, ao enviar uma tag `v*`
(ex.: `git tag v1.0.0 && git push origin v1.0.0`) ou manualmente em
**Actions → Build Windows EXE → Run workflow**. Antes de empacotar, ele executa
`npm test`, então um release só é publicado se os testes passarem.

> Se o botão *Run workflow* não aparecer, habilite em
> **Settings → Actions → General → Allow all actions**.

### Build local (na sua máquina Windows)

```powershell
npm install
npm run dist:win
# resultado: release\Executive AI Studio OCTOS-1.0.0-setup.exe
```

> O `.exe` não é assinado digitalmente. Na primeira execução o Windows SmartScreen pode
> exibir "Windows protegeu o seu PC": clique em **Mais informações → Executar assim mesmo**.
> Para remover o aviso é necessário um certificado de assinatura de código (Code Signing).

