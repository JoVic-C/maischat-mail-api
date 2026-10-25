# PRD — Verificação de emails com a EmailListVerify

## Problema

Hoje o mailPulse só confere se o **domínio** do email recebe mensagens (registro MX,
com fallback para registro A), e só na importação em massa. Ficam de fora:

- Caixa postal inexistente em domínio válido (`joao.silvaa@empresa.com.br`): passa na
  checagem e vira hard bounce no envio, o que derruba a reputação do remetente.
- Contato cadastrado à mão, recebido por webhook de formulário ou importado antes da
  checagem existir: nunca é verificado.
- Domínio "estacionado" com registro A genérico: passa no fallback, mas não entrega.

Quem sofre: clientes que disparam para bases antigas ou compradas, e a plataforma, cujo
IP e domínio de envio são compartilhados.

## Escopo

**Dentro**
- Integração com a EmailListVerify (https://api.emaillistverify.com/api-doc), com os
  resultados traduzidos para quatro estados próprios, para o provedor poder ser trocado
  mexendo só no mapeamento.
- Verificação sob demanda de uma lista inteira ("Verificar emails" na tela da lista), pela
  API de lista assíncrona do provedor — vale também para listas recém-importadas.
- Verificação unitária no cadastro manual de contato e no envio do webhook de formulário.
- Resultado guardado no contato e respeitado no disparo de campanhas.
- Cota mensal de verificações por cliente; sem chave configurada, tudo fica desligado.

**Fora**
- Verificação a cada envio de campanha (custo alto e redundante com o cache).
- Verificação automática durante a validação da importação: a API unitária aceita 10
  por segundo, e uma base de 1M de linhas levaria mais de um dia. A lista importada é
  verificada depois, pela API de lista.
- Verificação própria por SMTP (RCPT TO) a partir dos nossos servidores: arrisca
  bloqueio do IP de envio.
- Cobrança/repasse do custo ao cliente.

## Requisitos funcionais

1. Cada contato passa a ter `verification`: `status` (`deliverable`, `undeliverable`,
   `risky`, `unknown`), `reason`, `checkedAt` e `provider`.
2. Na importação, as linhas `new` que passaram no DNS são enviadas ao provedor. O
   resultado `undeliverable` vira `invalid` com motivo legível ("Caixa postal não
   existe"); `risky` e `unknown` são importados e sinalizados.
3. Um email verificado há menos de `EMAIL_VERIFY_TTL_DAYS` (padrão 90) não é
   reenviado ao provedor: o resultado em cache é reaproveitado, inclusive entre listas.
4. "Verificar lista" roda como job em background (mesma fila e acompanhamento da
   importação), com progresso, cancelamento e resumo ao final.
5. Campanhas não disparam para contatos `undeliverable`, como já acontece com `bounced`.
   A tela de público mostra quantos foram excluídos por esse motivo.
6. A lista de contatos permite filtrar e exportar por situação da verificação.
7. Falha, timeout ou limite do provedor nunca bloqueiam a importação nem o cadastro:
   o contato entra como `unknown` e pode ser verificado depois.
8. Com a cota do cliente esgotada, a verificação é pulada (`unknown`) e o painel avisa.

## Requisitos não-funcionais

- **Segredos:** chave da API em variável de ambiente (`EMAIL_VERIFY_API_KEY`), nunca
  no código nem no banco; rotação sem deploy de código.
- **Custo:** só emails nunca verificados ou com cache vencido vão ao provedor; uso por
  cliente registrado para auditoria e cota.
- **Resiliência:** timeout por chamada, retentativa com backoff só em erro transitório,
  e respeito ao limite de requisições do provedor (fila com concorrência controlada).
- **Desempenho:** usar a API em lote do provedor, se houver; a importação de 1M de
  linhas não pode ficar presa a chamadas unitárias.
- **Isolamento:** todo processamento no escopo do cliente (`runWithTenant`); o cache é
  por cliente, para um cliente não inferir a base de outro.
- **LGPD:** o provedor passa a ser operador de dados pessoais (emails); exige contrato
  (DPA) e menção na política de privacidade.
- **Observabilidade:** erros do provedor no Sentry; contadores de chamadas, cache e
  resultados por status nos logs estruturados.

## Migração

Campo novo e opcional no `Contact` (`verification`), sem reescrever documentos
existentes: contato sem o campo é tratado como `unknown`. Índice em
`verification.status` para o filtro do disparo. Reversível: desligar a integração
mantém os dados e volta ao comportamento atual, exceto pelo bloqueio de `undeliverable`,
que pode ser desligado por variável.

## Critérios de aceite

- Importar um arquivo com uma caixa postal inexistente em domínio válido a classifica
  como recusada, com o motivo, e ela entra no relatório de recusados.
- Importar a mesma base duas vezes dentro do TTL não gera nenhuma chamada nova ao
  provedor.
- Com o provedor fora do ar, a importação conclui e os contatos ficam `unknown`.
- Uma campanha para uma lista com contatos `undeliverable` não os inclui no total nem
  na fila.
- Um cliente com a verificação desligada não gera nenhuma chamada ao provedor.

## Decisões

| Resultado da EmailListVerify | Estado | Efeito |
| --- | --- | --- |
| `ok` | `deliverable` | recebe campanhas |
| `email_disabled`, `dead_server`, `invalid_mx`, `invalid_syntax` | `undeliverable` | fora das campanhas; cadastro manual recusado |
| `spamtrap` | `undeliverable` | fora: entrega, mas derruba a reputação |
| `ok_for_all`, `disposable` | `risky` | recebe campanhas, sinalizado |
| `unknown`, `smtp_protocol`, `antispam_system` | `unknown` | recebe campanhas; não cobrado, volta para a cota |

- Cota única por cliente via `EMAIL_VERIFY_MONTHLY_LIMIT` (padrão 10.000; 0 = sem limite).
  Cota por cliente editável pelo superadmin fica para quando houver demanda.
- Só administradores iniciam a verificação de lista (gasta créditos); todos acompanham.
- Envio interrompido ao provedor não é repetido automaticamente, para não cobrar duas vezes.
- A lista é apagada do provedor depois que os resultados são gravados.
