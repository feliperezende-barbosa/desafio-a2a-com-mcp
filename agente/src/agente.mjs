import { createServer } from 'node:http';
import { enviarMensagem, ErroRpc, ERRO_PARAMETROS, obterTask } from './tarefas.mjs';

const PORTA = Number(process.env.AGENT_PORT ?? 7300);
const HOST = process.env.AGENT_HOST ?? '127.0.0.1';
const MAX_CORPO_BYTES = 1_000_000;

const ERRO_JSON = -32700;
const ERRO_REQUISICAO = -32600;
const ERRO_METODO = -32601;
const ERRO_INTERNO = -32603;

function cartao(req) {
  const base = process.env.AGENT_PUBLIC_URL ?? `http://${req.headers.host ?? `${HOST}:${PORTA}`}`;
  return {
    name: 'Central de Salas',
    description: 'Reserva salas de reuniao da Hill Valley Tech.',
    provider: { organization: 'Hill Valley Tech', url: 'https://hillvalley.example' },
    version: '1.0.0',
    supportedInterfaces: [{ url: `${base}/a2a`, protocolBinding: 'JSONRPC', protocolVersion: '1.0' }],
    capabilities: { streaming: false, pushNotifications: false, extendedAgentCard: false },
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
    skills: [
      {
        id: 'reservar-sala',
        name: 'Reservar sala',
        description: 'Reserva uma sala em um intervalo. Se houver conflito, pergunta qual alternativa usar.',
        tags: ['salas', 'agenda'],
        inputModes: ['text/plain'],
        outputModes: ['text/plain'],
        examples: ['reservar sala=sala-garagem inicio=2026-11-03T14:00:00-03:00 fim=2026-11-03T15:00:00-03:00 responsavel=Marty']
      }
    ]
  };
}

const rpcErro = (id, code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

async function tratarRpc(corpo, traceparent) {
  if (!corpo || typeof corpo !== 'object' || corpo.jsonrpc !== '2.0' || typeof corpo.method !== 'string') {
    return rpcErro(corpo?.id, ERRO_REQUISICAO, 'Requisicao JSON-RPC invalida');
  }
  try {
    let result;
    if (corpo.method === 'SendMessage') result = await enviarMensagem(corpo.params, traceparent);
    else if (corpo.method === 'GetTask') result = obterTask(corpo.params);
    else return rpcErro(corpo.id, ERRO_METODO, `Metodo nao suportado: ${corpo.method}`);
    return { jsonrpc: '2.0', id: corpo.id, result };
  } catch (e) {
    if (e instanceof ErroRpc) return rpcErro(corpo.id, e.codigo, e.message);
    console.error('[agente] erro interno:', e);
    return rpcErro(corpo.id, ERRO_INTERNO, 'Erro interno');
  }
}

async function lerCorpo(req) {
  const partes = [];
  let total = 0;
  for await (const parte of req) {
    total += parte.length;
    if (total > MAX_CORPO_BYTES) throw new ErroRpc(ERRO_PARAMETROS, 'Corpo grande demais');
    partes.push(parte);
  }
  return Buffer.concat(partes).toString('utf8');
}

const responder = (res, status, corpo) => {
  res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(corpo));
};

const servidor = createServer(async (req, res) => {
  const caminho = new URL(req.url, 'http://localhost').pathname;
  try {
    if (req.method === 'GET' && caminho === '/.well-known/agent-card.json') return responder(res, 200, cartao(req));
    if (req.method === 'POST' && caminho === '/a2a') {
      let corpo;
      try {
        corpo = JSON.parse(await lerCorpo(req));
      } catch (e) {
        return responder(res, 200, rpcErro(null, e instanceof ErroRpc ? e.codigo : ERRO_JSON, e instanceof ErroRpc ? e.message : 'JSON invalido'));
      }
      return responder(res, 200, await tratarRpc(corpo, req.headers.traceparent));
    }
    responder(res, 404, { error: 'nao encontrado' });
  } catch (e) {
    console.error('[agente] erro interno:', e);
    if (!res.headersSent) responder(res, 500, rpcErro(null, ERRO_INTERNO, 'Erro interno'));
  }
});

servidor.listen(PORTA, HOST, () => {
  console.error(`[agente] A2A em http://${HOST}:${PORTA}/a2a (card em /.well-known/agent-card.json)`);
});
