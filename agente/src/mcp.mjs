import { Client, isInputRequiredResult, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { randomBytes } from 'node:crypto';

const MCP_URL = process.env.MCP_URL ?? 'http://127.0.0.1:7301/mcp';
const PROTOCOLO_MCP = '2026-07-28';
const FERRAMENTA_DE_RESERVA = 'reservar_sala';
const URI_POLITICA = 'politica://uso';

let conexao;

// Um objeto cliente vivo entre chamadas e normal; o estado de protocolo
// (versao, capabilities, traceparent) viaja no _meta de cada request.
function cliente() {
  conexao ??= (async () => {
    // Sem handler de elicitation e sem auto-fulfil: o input_required chega cru
    // ao agente, que o transforma em pausa da Task em vez de responder sozinho.
    const c = new Client(
      { name: 'agente-central-de-salas', version: '1.0.0' },
      {
        capabilities: { elicitation: { form: {} } },
        versionNegotiation: { mode: { pin: PROTOCOLO_MCP } },
        inputRequired: { autoFulfill: false }
      }
    );
    await c.connect(new StreamableHTTPClientTransport(new URL(MCP_URL)));
    return c;
  })().catch(e => {
    conexao = undefined;
    throw e;
  });
  return conexao;
}

export function novoTraceparent(traceId = randomBytes(16).toString('hex')) {
  return `00-${traceId}-${randomBytes(8).toString('hex')}-01`;
}

export function traceIdDe(traceparent) {
  return /^[\da-f]{2}-([\da-f]{32})-[\da-f]{16}-[\da-f]{2}$/i.exec(traceparent ?? '')?.[1];
}

// Cada request MCP leva o mesmo trace-id da Task e um span-id novo.
const meta = traceId => ({ traceparent: novoTraceparent(traceId) });

const textoDe = resultado => (resultado.content ?? []).map(c => c.text ?? '').join(' ').trim();

/** tools/list antes de qualquer chamada: a ferramenta de reserva e descoberta em runtime. */
export async function descobrirFerramenta(traceId) {
  const c = await cliente();
  const { tools } = await c.request({ method: 'tools/list', params: { _meta: meta(traceId) } });
  const ferramenta = tools.find(t => t.name === FERRAMENTA_DE_RESERVA);
  if (!ferramenta) throw new Error(`O servidor MCP nao expoe a ferramenta ${FERRAMENTA_DE_RESERVA}`);
  return ferramenta.name;
}

/** Le o resource da politica e extrai a versao declarada na primeira linha. */
export async function lerVersaoDaPolitica(traceId) {
  const c = await cliente();
  const { contents } = await c.request({ method: 'resources/read', params: { uri: URI_POLITICA, _meta: meta(traceId) } });
  const primeiraLinha = (contents?.[0]?.text ?? '').split('\n', 1)[0];
  const versao = /^versao:\s*(\S+)/.exec(primeiraLinha)?.[1];
  if (!versao) throw new Error('A politica de uso nao declara a versao na primeira linha');
  return versao;
}

/**
 * tools/call sem auto-fulfil. Devolve um de:
 *  - { tipo: 'pausa', chave, alternativas, requestState }  (input_required cru)
 *  - { tipo: 'erro', mensagem }                             (isError: true)
 *  - { tipo: 'concluido', dados }                           (structuredContent)
 */
export async function chamarFerramenta({ nome, argumentos, traceId, inputResponses, requestState }) {
  const c = await cliente();
  const params = {
    name: nome,
    arguments: argumentos,
    ...(inputResponses && { inputResponses }),
    ...(requestState && { requestState }),
    _meta: meta(traceId)
  };
  const resposta = await c.request({ method: 'tools/call', params }, { allowInputRequired: true });

  if (isInputRequiredResult(resposta)) {
    const [chave, pedido] = Object.entries(resposta.inputRequests ?? {})[0] ?? [];
    const campo = pedido?.params?.requestedSchema?.properties?.sala;
    const alternativas = campo?.enum ?? (campo?.const !== undefined ? [campo.const] : []);
    return { tipo: 'pausa', chave, alternativas, requestState: resposta.requestState };
  }
  if (resposta.isError) return { tipo: 'erro', mensagem: textoDe(resposta) };
  return { tipo: 'concluido', dados: resposta.structuredContent ?? JSON.parse(textoDe(resposta)) };
}
