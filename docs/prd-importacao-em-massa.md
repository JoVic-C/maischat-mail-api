# PRD — Importação de contatos em massa

## Problema

A importação de contatos hoje trafega o CSV inteiro como string dentro de um JSON,
e devolve as linhas validadas do navegador para o servidor num segundo POST. Isso
impõe um teto duro: um arquivo de 2,6 MB já é recusado com **413** pelo nginx, e
mesmo elevando o limite o desenho quebra por memória (arquivo inteiro em string no
browser e no Node), por volume de eventos (um evento SSE por linha) e por duração
(tudo dentro de uma requisição HTTP, sem sobreviver a um F5).

Quem sofre: operadores que sobem listas de clientes reais — hoje já passam de
2 MB, e o produto precisa suportar listas de até ~1 milhão de contatos.

## Escopo

**Dentro**
- Envio do CSV como arquivo (multipart, gravado em disco em streaming).
- Validação e importação como job em background (BullMQ), com estado no Mongo.
- Progresso agregado consultável, que sobrevive a recarga de página e queda de rede.
- Etapa de conferência preservada: validar → conferir → confirmar.
- Download dos contatos recusados a partir do resultado guardado no servidor.
- Expiração e limpeza dos arquivos temporários.

**Fora**
- Deduplicação entre listas diferentes ou merge inteligente de campos.
- Importação a partir de fontes externas (Google Contacts, API de terceiros).
- Reprocessamento parcial de um job já concluído.

## Requisitos funcionais

1. O usuário envia um arquivo CSV (ou cola o conteúdo, que é enviado como arquivo).
2. O servidor responde imediatamente com um identificador de job; nada é validado
   dentro da requisição.
3. Um worker valida o arquivo linha a linha, classificando cada uma como
   `new`, `add-to-list`, `in-list`, `already` ou `invalid` — mesmas regras de hoje.
4. O front acompanha o progresso por contadores agregados e uma amostra das
   primeiras linhas, não por evento-por-linha.
5. Ao terminar a validação, o usuário confere os números e confirma.
6. A confirmação importa a partir do resultado já gravado no servidor — o
   navegador nunca carrega nem reenvia as linhas.
7. Trocar a lista de destino invalida a validação (a classificação depende dela) e
   exige revalidar.
8. Os recusados podem ser baixados a partir do job.

## Requisitos não-funcionais

- **Escala alvo:** 1.000.000 de contatos / arquivo de até 100 MB.
- **Memória:** o arquivo nunca é carregado inteiro, nem no servidor nem no cliente.
- **Isolamento:** todo o processamento roda no escopo do cliente (`runWithTenant`);
  os arquivos temporários ficam FORA de `uploads/`, que é servido sem autenticação.
- **Resiliência:** o progresso vive no Mongo; recarregar a página não perde o job.
- **Retenção:** arquivos e jobs são apagados 48h após a conclusão.
- **Não degradar o envio:** a fila de importação é separada da fila de emails.

## Critérios de aceite

- Um CSV de 100 MB / ~1M linhas é validado e importado sem estourar memória e sem
  413 em nenhuma etapa.
- Recarregar a página no meio da validação e voltar à tela mostra o job em andamento.
- Confirmar importa exatamente as linhas classificadas como `new` e `add-to-list`.
- Nenhuma requisição da nova rota carrega linhas de contato no corpo, em nenhum sentido.
- Um usuário do cliente A não consegue ler nem confirmar um job do cliente B.
