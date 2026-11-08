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
