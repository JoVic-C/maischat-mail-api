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

## Testes

```bash
npm test                 # unidade — regra pura, sem banco nem rede
npm run test:integration # integração — sobe a API (supertest) contra Mongo e Redis
```

Os de **unidade** rodam em qualquer lugar. Cobrem o parser de CSV, a leitura de
células do Excel, o contexto de cliente (o substituto do Row Level Security) e a
criptografia de campo — inclusive a janela de rotação de chave.

Os de **integração** exigem os serviços no ar (`docker compose up -d mongo redis`) e
usam um banco próprio, `MONGO_URI_TEST` (padrão `mailpulse_test`), que é limpo entre
os testes. Cobrem o isolamento entre clientes pela API real, a portaria (login, token,
papéis) e o relatório de envios.

O `src/app.ts` existe para isso: importá-lo NÃO abre porta, não conecta em banco e não
sobe worker, então o supertest levanta a API sem efeito colateral. O `server.ts` ficou
só com o bootstrap.

No CI, a integração roda com Mongo e Redis como containers de serviço — sem mock, para
não esconder justamente a falha de isolamento que a suíte existe para pegar.

## Módulos da API

| Rota | Acesso | Descrição |
| --- | --- | --- |
| `/api/auth` | público / logado | login, `/me`, `logout-all`, troca de senha |
| `/api/dashboard` | logado | métricas (`/stats`) e relatório de envios da conta (`/sends`) |
| `/api/lists`, `/api/contacts`, `/api/templates`, `/api/segments` | logado | CRUD dos módulos; contatos também exportam CSV |
| `/api/campaigns` | logado | CRUD, disparo, pausa/retomada, agendamento, teste, logs, relatório CSV |
| `/api/upload` | logado | imagens e anexos |
| `/api/smtp`, `/api/users`, `/api/bounces` | **admin** | credenciais SMTP, usuários, marcação manual de bounce |
| `/api/tenants` | **superadmin** | clientes da plataforma (criar, ativar/desativar, excluir) |
| `/api/tracking` | público (assinado) | pixel de abertura, clique, descadastro |
| `/api/webhooks/xmailer` | Bearer próprio | retorno de entrega/bounce do xMailer |

### Importação de contatos em massa

A planilha (**.csv** ou **.xlsx**) sobe como arquivo e é processada por um worker
(fila `contact-import`, separada da de envio). A requisição de upload só devolve o id do job — nenhuma rota
carrega linhas de contato no corpo, em nenhum sentido. É o que permite listas de até
~1 milhão de contatos (~100 MB) sem estourar memória nem o limite de corpo do proxy.

| Rota | Descrição |
| --- | --- |
| `POST /api/contacts/import` | multipart (`file`, .csv ou .xlsx); cria o job e enfileira a validação |
| `GET /api/contacts/import/open` | importações ainda abertas (retomar após F5) |
| `GET /api/contacts/import/:id` | progresso agregado (a tela consulta em intervalo curto) |
| `POST /api/contacts/import/:id/confirm` | grava no banco o que foi validado |
| `POST /api/contacts/import/:id/cancel` | interrompe o job |
| `GET /api/contacts/import/:id/invalid` | relatório dos recusados (xlsx, ou CSV acima de 20 mil) |

Fases: `uploaded → validating → validated →` (confirmação) `→ importing → done`.

### Campanha para várias listas

Uma campanha aceita N listas (`listIds`). O disparo usa `lists: { $in: listIds }`, então
quem está em duas listas **recebe uma vez só** — é o mesmo documento de contato. Os
destinatários são percorridos por cursor, em lotes, sem carregar a base em memória.

O conteúdo do email é congelado no `snapshot` da campanha no momento do disparo, e o
job da fila leva só o que varia por destinatário. Antes o HTML ia dentro de CADA job:
medido, 28,6 KB por job contra 0,72 KB agora — para 6 milhões de destinatários isso é a
diferença entre ~160 GB e ~4 GB de Redis.

O snapshot também garante que editar o template no meio de um envio não altere os
emails daquela campanha. Antes essa garantia vinha, sem querer, da cópia por job.

### Exportação de contatos

`GET /api/contacts/export` devolve um CSV com os contatos, aceitando os **mesmos
filtros da listagem** (`search`, `listId`, `status`, `delivery`). Um endpoint só serve
às duas entradas do painel: o botão da tela de Contatos (exporta o que está filtrado) e
o botão de cada linha em Listas (exporta aquela lista).

Colunas: email, nome, empresa, telefone (decifrado), situação, criado em — mais uma
coluna por campo extra que veio do CSV importado. É o que permite **reimportar** o
arquivo sem perder dado.

Duas sutilezas que o teste de ida e volta revelou:

- as colunas informativas (`situacao`, `criado em`) são IGNORADAS na importação; sem
  isso elas viravam campos extras do contato e a exportação seguinte duplicaria colunas;
- o filtro por lista converte o id para ObjectId antes da consulta. O `find()` converte
  sozinho pelo schema, mas o `aggregate()` que descobre as colunas extras **não** — com
  string, o arquivo saía sem as colunas de metadata, em silêncio.

Assim como o relatório, é escrito em streaming a partir de um cursor: o pico de memória
não depende do tamanho da lista.

### Relatório de envios da conta (dashboard)

`GET /api/dashboard/sends` responde os envios da conta inteira — todas as campanhas —
recortados por período, para o gráfico do painel.

| Parâmetro | Padrão | Observação |
| --- | --- | --- |
| `de`, `ate` | últimos 30 dias | ISO 8601; `de` maior que `ate` é recusado com 400 |
| `agrupamento` | `day` | `day`, `week` (começa na segunda) ou `month` |

A resposta traz os **totais** do período, as **taxas** (abertura e clique sobre os
enviados, não sobre o total de registros) e a **série** de baldes.

Dois cuidados que os testes de integração fixam:

- os baldes são cortados no fuso **America/Sao_Paulo**. Um envio das 21h já é o dia
  seguinte em UTC: cortando em UTC, o número na tela não bateria com o dia do operador;
- a janela é recusada com 400 quando renderia mais de 400 baldes. Cinco anos por dia
  dariam quase 2 mil barras — ilegível na tela e caro de montar.

Baldes sem nenhum envio não voltam do banco; **o painel os reinsere** antes de desenhar.
Sem isso, janeiro e setembro sairiam como barras vizinhas e os sete meses parados entre
elas sumiriam do gráfico.

A consulta é uma agregação com `$dateTrunc` apoiada no índice composto
`{ tenantId, createdAt }` do `SendLog`. Sem o composto, o Mongo usaria o índice de
`createdAt` e depois descartaria os documentos dos outros clientes — varrendo, numa
instalação compartilhada, a janela inteira de todo mundo para responder a de um só.

### Relatório de uma campanha

`GET /api/campaigns/:id/report` devolve uma planilha **.xlsx** com uma linha por
destinatário (situação, data de envio, aberturas, cliques e o erro quando houve).
Aceita `?status=` para filtrar e `?format=csv` para forçar o outro formato.

As datas vão como **data de verdade**, não como texto — é o que permite ordenar e
filtrar por período dentro do Excel. O cabeçalho fica congelado e em negrito.

Acima de ~1 milhão de linhas o formato .xlsx não comporta a planilha (limite do
próprio Excel), e o servidor **cai para CSV sozinho**. Quem decide o formato é o
servidor: o painel lê o nome do arquivo do cabeçalho `Content-Disposition`.

O arquivo é escrito na resposta enquanto é lido do banco, a partir de um cursor: uma
campanha grande tem um registro POR DESTINATÁRIO, e montar o arquivo inteiro em
memória repetiria o erro que a importação já teve. O pico de memória não depende do
tamanho da campanha.


Formatos: **.csv** (delimitador `;` ou `,`, detectado pela primeira linha) e **.xlsx**
(só a primeira aba; células de hyperlink, texto formatado e fórmula são resolvidas para
o texto que aparece na tela). O **.xls** antigo não é lido — a mensagem de erro pede
para salvar como .xlsx ou CSV.

A extensão do arquivo é preservada no disco de propósito: é por ela que o worker
escolhe entre o leitor de CSV e o de planilha.

Para as listas maiores, prefira CSV: o .xlsx guarda os textos numa tabela
compartilhada que precisa caber em memória para as células serem resolvidas.


A validação percorre o arquivo em lotes e grava o veredito de cada linha em NDJSON
ao lado do CSV; a confirmação lê esse arquivo. O estado fica no modelo `ImportJob`,
não em memória — por isso o job sobrevive a fechar o modal, recarregar a página ou
cair a rede.

Os arquivos vão para `IMPORT_DIR` (padrão `data/imports`), **fora de `uploads/`**, que
é servido como estático sem autenticação. Um job e seus arquivos são apagados 48h
depois de criados, por um job horário na própria fila.

O teto prático é o conjunto de emails já vistos, usado para detectar repetidos dentro
do arquivo: ~100 MB de heap por 1 milhão de linhas. Daí a concorrência baixa do worker
(`IMPORT_WORKER_CONCURRENCY`, padrão 2).

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

1. **Crie os dois serviços gerenciados**: um **MongoDB** e um **Redis**. Ambos são
   obrigatórios — sem Redis nenhuma campanha é enviada, porque a fila inteira (BullMQ),
   as cotas de envio e o rate limit vivem nele.
2. **Serviço do tipo Compose** apontando para este repositório e para
   `docker-compose.easypanel.yml`. O contexto do frontend é `../frontend`, então o
   serviço precisa enxergar as duas pastas — aponte a raiz do projeto, não só o backend.
3. **Variáveis** na aba Environment. Obrigatórias (a stack nem sobe sem elas):
   `MONGO_URI`, `REDIS_URL`, `JWT_SECRET`, `ENCRYPTION_KEY`, `PUBLIC_API_URL`, `FRONTEND_URL`.

   Copie as URLs internas dos serviços gerenciados. No Mongo, ajuste dois detalhes que
   o painel não inclui: o **nome do banco** e o `authSource` — o usuário é criado no
   banco `admin`, e sem isso a autenticação falha:

   ```
   mongodb://usuario:senha@outros_mongomail:27017/mmail?authSource=admin&tls=false
   ```

   `PUBLIC_API_URL` e `FRONTEND_URL` são o **domínio real** — com localhost, todo email
   sai com tracking e descadastro quebrados, e isso não se corrige depois de enviado.
   As demais variáveis estão em `.env.example`.
4. **Domínio** apontando para o serviço `frontend`, porta **80**. O backend não recebe
   domínio: o nginx do frontend faz proxy de `/api` e `/uploads` pela rede interna.
5. **Primeiro acesso**: rode o seed pelo terminal do EasyPanel, no serviço `backend`:

   ```bash
   npm run seed:admin:prod
   ```

A stack do EasyPanel **não sobe banco nenhum** — usa os serviços gerenciados. Se preferir
subir Mongo e Redis dentro da própria stack, use o `docker-compose.yml` local como base.

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

Ao criar um cliente, o administrador dele recebe um **email de boas-vindas** com um link
para definir a senha. **O superadmin não define senha de ninguém**: o painel nem pede uma,
e o admin escolhe a sua pelo link — assim a senha não trafega por outro canal nem fica
conhecida por quem criou a conta.

O link é de convite (validade de `INVITE_TTL_HOURS`, padrão 72h). A API ainda aceita um
`adminPassword` opcional, para provisionamento automatizado; nesse caso o link enviado é
de redefinição, com a validade curta de `PASSWORD_RESET_TTL_MINUTES`. Quem entrega é o
SMTP da plataforma (`XMAILER_SMTP_*`) — o cliente acabou de nascer e ainda não tem
servidor próprio.

O envio é **best-effort**: se o email não sai, o cliente continua criado e o painel mostra
o link para o superadmin repassar por outro canal.

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
