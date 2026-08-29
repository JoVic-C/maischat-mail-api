# MailPulse — Backend

API REST da plataforma de email marketing MailPulse (Mais Chat Tecnologia).

**Stack:** Node.js 22 · Express 4 · TypeScript (strict) · MongoDB (Mongoose) · Redis + BullMQ · Nodemailer · Handlebars.

## Estrutura

```
src/
├── config/        # db, redis, sentry, seed do superadmin
├── controllers/   # camada HTTP (req/res) — um por módulo
├── services/      # regra de negócio — um por módulo
├── models/        # schemas Mongoose
├── routes/        # rotas + validação (express-validator)
├── queue/         # BullMQ: fila de envio, scheduler, cota de SMTP
├── middleware/    # auth, errorHandler, validate, rateLimit, upload
├── errors/        # AppError e subclasses (BadRequest, NotFound, ...)
├── scripts/       # tarefas operacionais (rotação de chave, migração multi-tenant)
├── utils/         # csv, excel, logger, cripto de campo, assinatura de tracking
└── server.ts      # bootstrap Express
```

Fluxo de uma requisição: **route → validate → controller → service → model**.

## Rodando

```bash
docker compose up -d mongo redis    # sobe as dependências
cp .env.example .env                # preencha JWT_SECRET e ENCRYPTION_KEY
npm install
npm run seed:admin                  # cria o SUPERADMIN da plataforma (imprime a senha)
npm run dev                         # http://localhost:3000
```

Health check: `GET /api/health`

> `JWT_SECRET`, `ENCRYPTION_KEY` e `MONGO_URI` são obrigatórias — a API encerra no boot se faltarem.

## Scripts

| Comando | O que faz |
| --- | --- |
| `npm run dev` | API em modo watch |
| `npm run build` / `start` | compila para `dist/` / roda o compilado |
| `npm run verify` | **lint + tipos + build** (o que o CI roda) |
| `npm run lint` / `lint:fix` | Biome (lint + formatação) |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run seed:admin` | cria o superadmin da plataforma (desenvolvimento) |
| `npm run rotate:encryption` | reescreve os campos cifrados com a `ENCRYPTION_KEY` atual |
| `*:prod` | mesma tarefa rodando o JS compilado — é a forma de usar dentro do container |
| `npm run migrate:multi-tenant` | move a base pré-existente para um cliente padrão |
| `npm run audit:ci` | falha em vulnerabilidade alta/crítica |

## Módulos da API

| Rota | Acesso | Descrição |
| --- | --- | --- |
| `/api/auth` | público / logado | login, `/me`, `logout-all`, troca de senha |
| `/api/dashboard` | logado | métricas e gráfico de atividade |
| `/api/lists`, `/api/contacts`, `/api/templates`, `/api/segments` | logado | CRUD dos módulos |
| `/api/campaigns` | logado | CRUD, disparo, pausa/retomada, agendamento, teste, logs |
| `/api/upload` | logado | imagens e anexos |
| `/api/smtp`, `/api/users`, `/api/bounces` | **admin** | credenciais SMTP, usuários, marcação manual de bounce |
| `/api/tenants` | **superadmin** | clientes da plataforma (criar, ativar/desativar, excluir) |
| `/api/tracking` | público (assinado) | pixel de abertura, clique, descadastro |
| `/api/webhooks/xmailer` | Bearer próprio | retorno de entrega/bounce do xMailer |

### Multi-tenancy

A instalação é **compartilhada entre vários clientes** (tenants). Cada contato, lista,
template, campanha, segmento, envio e servidor SMTP pertence a um cliente.

Papéis:

| Papel | Alcance |
| --- | --- |
| `superadmin` | a plataforma: cria e gerencia clientes. Não pertence a nenhum. |
| `admin` | um cliente: usuários, SMTP e bounces daquele cliente. |
| `user` | um cliente: contatos, listas, templates e campanhas. |

O isolamento **não** depende de o service lembrar de filtrar. Como o Mongo não tem Row
Level Security, o equivalente aqui é o par:

- `config/tenantContext` — AsyncLocalStorage com o cliente da requisição/job;
- `models/plugins/tenantScope` — plugin que injeta `tenantId` em toda query, escrita
  e agregação dos modelos de domínio.

Sem contexto ativo, a query é **recusada** em vez de rodar sem filtro. Fluxos que
legitimamente não têm cliente na entrada (tracking público, webhook do xMailer,
scripts) rodam em modo `system`, declarado explicitamente.

O superadmin opera dentro de um cliente informando o header `X-Tenant-Id`.

> ⚠️ Ao usar `runWithTenant`, o `await` precisa estar **dentro** do callback: uma Query
> do Mongoose só executa quando aguardada, e fora do escopo o contexto já não existe.

**Primeiro acesso:** `npm run seed:admin` cria o superadmin da plataforma; os clientes
(e o admin de cada um) nascem em `POST /api/tenants`.

**Base já existente:** `npm run migrate:multi-tenant` move tudo para um cliente padrão
e troca o índice único de `contacts.email` pelo composto `{tenantId, email}`.

### Segurança

- **JWT com revogação por versão** (`tokenVersion`): logout-all e troca de senha invalidam
  imediatamente todos os tokens já emitidos.
- **Campos sensíveis cifrados** em repouso (AES-256-GCM): telefone do contato e senha SMTP.
  A rotação de chave é feita com `ENCRYPTION_KEY_PREVIOUS` + `npm run rotate:encryption`.
- **Links de tracking assinados** (HMAC): clique e descadastro só valem com assinatura válida —
  fecha open-redirect e impede descadastrar terceiros conhecendo apenas os ids.
- **Rate limit no Redis**, compartilhado entre instâncias; limiter estrito no login.
- **CORS** restrito à lista do ambiente + subdomínios `maischat.*` em HTTPS.

### Envio de campanhas

O disparo percorre os destinatários **por cursor, em lotes** (`CAMPAIGN_BATCH_SIZE`), criando os
`SendLog` e enfileirando os jobs por lote — uma lista grande não é carregada em memória.

No worker, cada job respeita, nesta ordem: campanha excluída (descarta), campanha pausada
(adia, com teto de `CAMPAIGN_MAX_PAUSE_WAIT_MS`), **cota do servidor SMTP**
(`dailyLimit`/`hourlyLimit`, contada no Redis) e só então envia. Erros permanentes (5xx) viram
bounce sem retry; erros de autenticação SMTP são registrados como falha do remetente, sem
bouncar o contato. Acima de `CAMPAIGN_MAX_ERRORS` a campanha é auto-pausada.

## Deploy no EasyPanel

O EasyPanel já cuida de domínio, TLS e roteamento, então a stack de lá é diferente da
local: **nenhuma porta é publicada** e as variáveis vêm do painel, não de arquivo. Use
o `docker-compose.easypanel.yml`.

1. **Serviço do tipo Compose** apontando para este repositório e para
   `docker-compose.easypanel.yml`. O contexto do frontend é `../frontend`, então o
   serviço precisa enxergar as duas pastas — aponte a raiz do projeto, não só o backend.
2. **Variáveis** na aba Environment. Obrigatórias (a stack nem sobe sem elas):
   `JWT_SECRET`, `ENCRYPTION_KEY`, `PUBLIC_API_URL`, `FRONTEND_URL`.
   As duas últimas são o **domínio real** — com localhost, todo email sai com tracking
   e descadastro quebrados, e isso não se corrige depois de enviado.
   As demais estão em `.env.example`.
3. **Domínio** apontando para o serviço `frontend`, porta **80**. O backend não recebe
   domínio: o nginx do frontend faz proxy de `/api` e `/uploads` pela rede interna.
4. **Primeiro acesso**: rode o seed pelo terminal do EasyPanel, no serviço `backend`:

   ```bash
   npm run seed:admin:prod
   ```

`MONGO_URI` e `REDIS_URL` já vêm definidos no compose apontando para os serviços da
própria stack — não os sobrescreva com endereços externos sem necessidade.

## Primeiro acesso em produção

Os scripts operacionais usam `ts-node`, que **não existe na imagem** (`npm ci --omit=dev`)
e nem o `src/` é copiado para ela. Dentro do container use sempre a variante `:prod`,
que roda o JavaScript já compilado:

```bash
docker compose exec backend npm run seed:admin:prod
```

Ele lê `ADMIN_EMAIL` e `ADMIN_PASSWORD` do ambiente. Sem a senha, sorteia uma forte e a
imprime **uma única vez** — anote na hora. É idempotente: se a conta já existir, não faz nada.

Esse superadmin administra a plataforma e não pertence a cliente nenhum. Entre com ele,
crie o primeiro cliente em **Clientes → + Novo cliente** (o admin daquele cliente nasce
junto) e o resto do time entra por convite.

As outras tarefas seguem a mesma regra:

```bash
docker compose exec backend npm run migrate:multi-tenant:prod   # base vinda de antes do multi-cliente
docker compose exec backend npm run rotate:encryption:prod      # após trocar a ENCRYPTION_KEY
```

## Testar envio sem mandar email de verdade

Há um sink SMTP local no compose, atrás de um profile:

```bash
docker compose --profile smtp up -d mailpit
```

Cadastre-o como servidor SMTP do cliente (host `mailpit`, porta 1025, sem autenticação) e
dispare a campanha normalmente. Nada sai da máquina; o que "chegou" aparece em
http://localhost:8025.

**Nunca aponte um teste para um SMTP real.** Mensagens para endereços fabricados geram
bounce em massa e queimam a reputação do domínio — dano que não se desfaz.

## Fluxo de trabalho

1. Abrir uma **Issue** com label `fix`, `improvement` ou `feature`.
2. Branch a partir de `main` — nunca commitar direto na `main`.
3. Commits no padrão **Conventional Commits** (validado por commitlint no hook `commit-msg`).
4. `npm run verify` antes de abrir o PR; o hook `pre-commit` já roda lint + tipos.
5. PR preenchendo o template (Issue, o que mudou, validação, riscos, próximos passos).
6. Merge só com o CI verde.
