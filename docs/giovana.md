# Giovana

Giovana utiliza o mesmo motor de fluxo do Cris, com cadastro de agente, instancia,
conversas e catalogo separados. Nenhuma migracao do banco e necessaria.

## Catalogo

| Plano | Valor |
| --- | --- |
| 350Mb | R$ 89,90 |
| Oferta Especial 600Mb (recomendado) | R$ 69,90 |
| 500Mega+60Gb (Celular) | R$ 129,90 |
| 1Gb+60Gb (Celular) | R$ 179,90 |

Os planos do Cris permanecem vinculados exclusivamente ao seu agente. A Giovana
usa apenas seus quatro planos e nao utiliza o catalogo global como alternativa.

## Cadastro e publicacao

O script `scripts/setup-giovana.mjs` copia o fluxo, regras e ajustes do Cris,
personaliza o nome e cria quatro planos independentes em uma transacao. Exige
`DATABASE_URL`, `GIOVANA_ZAPI_INSTANCE_ID`, `GIOVANA_ZAPI_TOKEN`,
`GIOVANA_ZAPI_CLIENT_TOKEN` e `GIOVANA_ZAPI_WHATSAPP_NUMBER` no ambiente.
Execute com `npx tsx --env-file=.env scripts/setup-giovana.mjs`.
Ele recusa sobrescrever um agente Giovana ja existente e verifica que o Cris
permaneceu identico. As credenciais ficam no cadastro do agente no banco;
nao substitua as variaveis ZAPI_* do Cris na Vercel.

Apos publicar o codigo, configure o webhook de recebimento da instancia Giovana:

`https://www.alffafibra.com.br/api/webhooks/zapi/giovana`

O endpoint exige que `instanceId` do payload corresponda a instancia cadastrada.
Se o cadastro estiver ausente/inativo retorna 503; outra instancia retorna 403.
O webhook do Cris continua em `/api/webhooks/zapi`.

Os lembretes e as respostas manuais usam a instancia do agente da conversa.
Falhas em uma instancia valida nao provocam envio pela conta padrao do Cris.

Leads da Giovana usam `source=chatbot:giovana`. Os antigos `source=chatbot`
continuam identificados como Cris. O mesmo telefone pode ter leads separados.
A origem aparece na lista, quadro, ficha, pesquisa e exportacao de leads.

## Verificacao local

`npx tsx --test scripts/giovana.test.mjs scripts/cris-objections.test.mjs scripts/cris-interpretation.test.mjs`

`npm run build`

Os testes usam servicos simulados e nao enviam mensagens a clientes.
