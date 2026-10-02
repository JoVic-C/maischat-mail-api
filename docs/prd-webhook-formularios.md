# PRD — Webhook de formulário

## Problema

Clientes do mMail captam pessoas por formulários espalhados em ferramentas diferentes: site
próprio, WordPress/Elementor, RD Station, Typeform, Google Forms via Zapier/Make. Hoje não há
como o mMail responder a quem preencheu. O cliente quer que, ao enviar o formulário, a pessoa
receba na hora um email do próprio cliente.

## Escopo

**Dentro**

- Vários webhooks por cliente, um por formulário, cada um com URL própria.
- Cada webhook aponta para um template do mMail e, opcionalmente, para um servidor SMTP.
- Aceita qualquer formato de envio: JSON, `application/x-www-form-urlencoded` (inclusive
  campos aninhados, como os do Elementor), `multipart/form-data` e texto com JSON.
- Encontra o email e o nome sozinho; o painel permite fixar o campo quando houver ambiguidade.
- Todos os campos recebidos viram variáveis do template (`{{telefone}}`, `{{empresa}}`...).
- Histórico das submissões recentes, com o motivo de cada recusa ou falha.
- Formulário HTML puro, sem JavaScript: pode redirecionar para uma página de obrigado.

**Fora**

- Criar ou atualizar contatos e listas.
- Sequências de emails (automação com atrasos).
- Arquivos enviados no formulário.

## Requisitos funcionais

1. O admin do cliente cria, edita, pausa, exclui e gera nova URL para um webhook.
2. A URL pública recebe `POST`; `GET` responde que o webhook existe (algumas ferramentas testam assim).
3. Recebimento válido responde em menos de 1 s: o email vai para uma fila, não sai na requisição.
4. Sem email válido, a submissão é recusada e registrada no histórico com o motivo.
5. O envio usa o SMTP do webhook, senão o padrão do cliente, senão o da plataforma, com as
   mesmas regras de cota e de domínio de envio das campanhas.
6. Endereço com bounce registrado não recebe.

## Requisitos não funcionais

- **Segurança:** a URL é o segredo (token longo, guardado cifrado e buscado por hash). Não há
  como mandar conteúdo pelo formulário: o texto é sempre o do template, com os valores escapados.
- **Abuso:** limite por IP, teto de envios por hora por webhook (configurável), o mesmo email
  não recebe de novo no mesmo webhook por 10 minutos, e campo honeypot descarta robôs sem avisar.
- **Isolamento:** tudo escopado por cliente, como o resto do sistema.
- **Retenção:** histórico de submissões mantido por 90 dias.

## Critérios de aceite

- Um formulário do Elementor, um HTML puro e um `fetch` com JSON disparam o email do template
  com os campos preenchidos.
- URL errada ou webhook pausado não envia nada e não revela se o webhook existe.
- Passado o teto por hora, novos envios são recusados com 429 e aparecem no histórico.
- Cliente A não vê nem altera webhooks do cliente B.
