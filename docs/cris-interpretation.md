# Interpretacao do Cris

## Funcionamento

Antes de preencher as etapas ASK_*, RECOMMEND_PLAN, CHOOSE_PLAN,
CONFIRM_DATA e CORRECTION, o motor solicita uma classificacao estruturada.
A resposta distingue dado da etapa, pergunta, objecao, espera, recusa,
correcao e ambiguidade. O valor precisa constar literalmente na mensagem
atual e ainda passa pelos validadores locais existentes.

Perguntas nao mudam o cadastro. Mensagens com dado e pergunta aproveitam
o dado e respondem a duvida. Falhas de interpretacao mantem a etapa e
solicitam esclarecimento. Os textos existentes de avancos bem-sucedidos
permanecem no motor do fluxo.

O contexto inclui os dados confirmados, ate dez mensagens recentes ja
carregadas do banco e ate doze observacoes anteriores do cliente (limitadas
a 800 caracteres cada). Observacoes nao substituem dados cadastrais.
Pedidos explicitos de espera ou recusa pausam os lembretes; a proxima
mensagem permite retomar a mesma etapa.

## Modelos

OPENAI_INTERPRETATION_MODEL e opcional; seu padrao e gpt-5.4-mini.
O modelo das respostas comerciais continua vindo da configuracao existente
do CRM / OPENAI_MODEL. Nao foram alteradas configuracoes do banco ou Vercel.
Cada mensagem nas etapas cobertas acrescenta uma chamada de interpretacao,
com timeout de 15 segundos e sem repeticoes automaticas.

## Verificacao

Teste de integracao do motor com IA simulada, sem banco ou WhatsApp:

```sh
npx tsx --test scripts/cris-interpretation.test.mjs
```

Comparacao opcional pela API, com frases ficticias e consumo de tokens:

```sh
npx tsx scripts/evaluate-cris-interpretation.mjs gpt-4o-mini gpt-5.4-mini
```

Em 09/09/2026, apos refinar as instrucoes, gpt-5.4-mini passou nos 12
exemplos da rodada. gpt-4o-mini acertou os quatro primeiros e retornou
um resultado nao aproveitavel no quinto, interrompendo a rodada. A amostra
e pequena e nao garante a qualidade em todas as conversas de producao.

Backup anterior aos ajustes desta tarefa:
/tmp/cris-before-interpretation-20260909.tar.gz

A validacao utilizou frases ficticias e nao enviou mensagens para clientes.
