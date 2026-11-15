# A Ponte: um agente A2A com MCP por dentro

Hill Valley Tech: cinco salas de reuniao expostas como servidor MCP e um agente que as consome por dentro (host MCP) e se oferece por fora (servidor A2A). Dois processos Node.js (ESM, sem build), sem LLM.

- [servidor-mcp/](servidor-mcp): servidor MCP em Streamable HTTP (`:7301`, `/mcp`), `@modelcontextprotocol/server` 2.4.0, revisao `2026-07-28`
- [agente/](agente): agente A2A v1.0 JSON-RPC (`:7300`, `/a2a`), cliente MCP via `@modelcontextprotocol/client` 2.4.0
- `dados/`, `validador/` e `exemplos/` ficam como no starter

## Como rodar

Requisitos: Node.js 20 ou superior e Python 3.10 ou superior (so para o validador).

Terminal 1, servidor MCP (o stderr mostra cada request com metodo, id e `traceparent`):

```bash
cd servidor-mcp
npm ci
export REQUEST_STATE_SECRET=$(python3 -c "import secrets; print(secrets.token_hex(32))")
npm start
```

A chave de integridade do `requestState` vem de `REQUEST_STATE_SECRET` (minimo 32 bytes; o servidor nao sobe sem ela). Gere a sua com o comando acima. Para o `requestState` sobreviver a um restart, reinicie o servidor com a mesma chave exportada.

Terminal 2, agente:

```bash
cd agente
npm ci
npm start
```

Terminal 3, validador (com os dois processos recem-iniciados):

```bash
python3 validador/validar.py --agente http://localhost:7300 --mcp http://localhost:7301
```

Variaveis opcionais (os padroes sao os do enunciado): `MCP_PORT`, `MCP_HOST`, `REQUEST_STATE_TTL_SECONDS` (padrao 600) no servidor; `AGENT_PORT`, `AGENT_HOST`, `AGENT_PUBLIC_URL`, `MCP_URL` (padrao `http://127.0.0.1:7301/mcp`) no agente.

## Onde a ponte acontece

No agente. [`chamarFerramenta`](agente/src/mcp.mjs) chama `tools/call` com `inputRequired: { autoFulfill: false }` e sem handler de elicitation, entao o `input_required` chega cru. Em [`aplicarResultado`](agente/src/tarefas.mjs) ele vira `TASK_STATE_INPUT_REQUIRED`: a Task recebe a linha `alternativas: ...` (na ordem do `enum`) e o `requestState` e a chave de `inputRequests` ficam guardados em `entrada.pausa`, ligados aquela Task e fora da Task serializada. O caminho de volta e [`retomar`](agente/src/tarefas.mjs): o `SendMessage` com `taskId` e `escolha=<sala>` (ou `recusar`, que vira `action: decline` e termina em `TASK_STATE_CANCELED`) repete o `tools/call` com os mesmos argumentos, `inputResponses` com a mesma chave, o `requestState` ecoado sem ser aberto e um id de JSON-RPC novo (atribuido pelo cliente a cada request). Uma escolha fora do `enum` nao chama o servidor e repete a pausa. No servidor, o ponto equivalente e [`reservarSala`](servidor-mcp/src/servidor.mjs): ele devolve `inputRequired(...)` com o estado selado e, no retry, reconstroi o pedido a partir do estado verificado.

## Decisoes tecnicas

- **Integridade do `requestState`**: `createRequestStateCodec` do SDK (HMAC-SHA256, `v1.<payload>.<mac>`), com a chave de `REQUEST_STATE_SECRET`. O `verify` esta ligado em `ServerOptions.requestState.verify`, entao qualquer estado adulterado, expirado ou malformado e recusado com `-32602` antes do handler rodar. O estado e assinado, nao cifrado: o conteudo e legivel, mas nao adulteravel.
- **Estado autocontido**: o pedido original (sala, intervalo, responsavel) viaja selado no `requestState`. O servidor nao guarda nada entre o `input_required` e o retry, por isso um retry funciona depois de reiniciar o processo (com a mesma chave). No retry, os `arguments` reenviados sao ignorados em favor do pedido selado, e a sala escolhida precisa estar entre as alternativas recalculadas.
- **Validade**: 10 minutos (`REQUEST_STATE_TTL_SECONDS=600`, dentro da faixa de 5 a 30 minutos).
- **Capability de elicitation**: o handler devolve `input_required` e o proprio SDK compara `inputRequests` com `io.modelcontextprotocol/clientCapabilities` do request, respondendo `-32021` com `data.requiredCapabilities` e HTTP 400 quando falta a elicitation em form mode.
- **Estado das Tasks**: em memoria, em um `Map` por Task no processo do agente ([tarefas.mjs](agente/src/tarefas.mjs)). Cada Task tem o proprio `requestState`, `traceId` e pedido, entao duas pausas simultaneas nao se misturam. Nao ha persistencia: reiniciar o agente perde as Tasks.
- **Reservas**: em memoria no servidor MCP, iniciadas de `dados/reservas.json`.
- **Sem sessao**: o agente conecta com `versionNegotiation: { mode: { pin: '2026-07-28' } }` e todo request leva `protocolVersion`, `clientInfo`, `clientCapabilities` (`{"elicitation":{"form":{}}}`) e `traceparent` no `_meta`, alem dos headers `MCP-Protocol-Version`, `Mcp-Method` e `Mcp-Name`, todos montados pelo SDK. Cada Task roda `tools/list`, le `politica://uso` (versao da primeira linha) e so entao chama a tool.
- **Trace**: o trace-id do header `traceparent` do cliente A2A e reaproveitado em todos os requests MCP da Task (span-id novo a cada request) e aparece no stderr do servidor MCP.
- **Dominio no servidor**: conflito, politica e alternativas ficam em [dominio.mjs](servidor-mcp/src/dominio.mjs). O agente so traduz protocolo.

## Saida do validador

Ultima execucao, com os dois processos recem-iniciados:

```
trace-id desta execucao: 38e58495ed9f18699946e6d123204ba9
procure esse valor no stderr do servidor MCP para conferir a propagacao do traceparent.

PASS 01 tools/list traz as tres tools
PASS 02 toda tool tem inputSchema de objeto
PASS 03 listar_salas devolve structuredContent e o mesmo JSON em texto
PASS 04 _meta sem protocolVersion devolve -32602 e HTTP 400
PASS 05 _meta sem clientCapabilities devolve -32602 e HTTP 400
PASS 06 tool inexistente e recusada, por -32602 ou por isError
PASS 07 resources/read de politica://uso devolve a politica
PASS 08 resources/read de URI inexistente devolve -32602
PASS 09 sala inexistente devolve isError com a mensagem exata
PASS 10 fora da janela devolve isError com a mensagem exata
PASS 11 duracao acima de 2h devolve isError com a mensagem exata
PASS 12 intervalo invertido devolve isError com a mensagem exata
PASS 13 conflito devolve input_required com inputRequests e requestState
PASS 14 a elicitation e form mode e oferece as alternativas na ordem certa
PASS 15 conflito sem a capability elicitation devolve -32021 e HTTP 400
PASS 16 retry com inputResponses e requestState conclui a reserva
PASS 17 requestState adulterado e rejeitado com -32602
PASS 18 argumentos adulterados no retry nao tomam efeito
PASS 19 recusa conclui sem reservar e sem isError
PASS 20 conflito sem alternativa possivel devolve isError com a mensagem exata

PASS 21 agent card responde 200 no well-known com JSON
PASS 22 o card declara a interface JSON-RPC com url e versao 1.0
PASS 23 o card declara a skill reservar-sala
PASS 24 SendMessage com sala livre conclui a Task
PASS 25 o artifact chama reserva e traz a versao da politica
PASS 26 GetTask devolve id, contextId e estado corrente
PASS 27 SendMessage com sala ocupada pausa a Task
PASS 28 a Task pausada lista as alternativas na ordem certa
PASS 29 escolha fora do enum mantem a Task pausada
PASS 30 a continuacao conclui a Task na sala escolhida
PASS 31 SendMessage em Task terminal e recusado
PASS 32 a recusa termina a Task em CANCELED
PASS 33 duas Tasks pausadas ao mesmo tempo concluem cada uma com a sua reserva
PASS 34 nenhuma resposta A2A carrega o requestState
PASS 35 sala inexistente termina a Task em FAILED com a mensagem da tool
PASS 36 o agente e deterministico: o mesmo pedido produz a mesma pausa

resumo: 36 passaram, 0 falharam, de 36 verificacoes
```
