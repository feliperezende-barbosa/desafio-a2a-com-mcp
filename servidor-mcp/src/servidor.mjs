import {
  acceptedContent,
  createMcpHandler,
  createRequestStateCodec,
  inputRequired,
  inputResponse,
  McpServer,
  ProtocolError,
  ProtocolErrorCode
} from '@modelcontextprotocol/server';
import { createServer } from 'node:http';
import * as z from 'zod/v4';
import {
  alternativas,
  buscarSala,
  conflitos,
  criarReserva,
  ERROS,
  ErroDeNegocio,
  politicaTexto,
  politicaVersao,
  salas,
  validarPedido
} from './dominio.mjs';

const PORTA = Number(process.env.MCP_PORT ?? 7301);
const HOST = process.env.MCP_HOST ?? '127.0.0.1';
const TTL_REQUEST_STATE_SEGUNDOS = Number(process.env.REQUEST_STATE_TTL_SECONDS ?? 600);
const CHAVE_DE_ESCOLHA = 'escolha_de_sala';

const segredo = process.env.REQUEST_STATE_SECRET;
if (!segredo || Buffer.byteLength(segredo, 'utf8') < 32) {
  console.error(
    'REQUEST_STATE_SECRET ausente ou curta demais (minimo 32 bytes). Gere uma com:\n' +
      '  export REQUEST_STATE_SECRET=$(python3 -c "import secrets; print(secrets.token_hex(32))")'
  );
  process.exit(1);
}

// Assina (HMAC-SHA256) e carrega a expiracao. Todo o pedido original viaja
// dentro do estado: o servidor nao guarda nada entre o input_required e o retry.
const codec = createRequestStateCodec({ key: segredo, ttlSeconds: TTL_REQUEST_STATE_SEGUNDOS });

const ReservaOut = z.object({
  reserva: z.string().nullable(),
  reservado: z.boolean(),
  sala: z.string().nullable(),
  inicio: z.string().nullable(),
  fim: z.string().nullable(),
  responsavel: z.string().nullable(),
  politica: z.string().nullable(),
  motivo: z.string().nullable()
});

const SalaOut = z.object({ id: z.string(), nome: z.string(), capacidade: z.number().int(), recursos: z.array(z.string()) });
const ListaDeSalas = z.object({ salas: z.array(SalaOut) });
const ConflitoOut = z.object({ id: z.string(), inicio: z.string(), fim: z.string(), responsavel: z.string() });
const Disponibilidade = z.object({ sala: z.string(), livre: z.boolean(), conflitos: z.array(ConflitoOut) });

const Intervalo = {
  sala: z.string().describe('Id da sala, como em listar_salas'),
  inicio: z.string().describe('Inicio em ISO 8601 com fuso'),
  fim: z.string().describe('Fim em ISO 8601 com fuso')
};

const resultado = estruturado => ({
  content: [{ type: 'text', text: JSON.stringify(estruturado, null, 2) }],
  structuredContent: estruturado
});

const erroDeExecucao = mensagem => ({ isError: true, content: [{ type: 'text', text: mensagem }] });

const semReserva = motivo => ({
  reserva: null,
  reservado: false,
  sala: null,
  inicio: null,
  fim: null,
  responsavel: null,
  politica: null,
  motivo
});

function pedirEscolha(ctx, pedido, intervalo) {
  const opcoes = alternativas(pedido.sala, intervalo.ini, intervalo.fi);
  if (opcoes.length === 0) return erroDeExecucao(ERROS.semAlternativas);

  // Sem a capability de elicitation em form mode, o SDK recusa o input_required
  // com -32021 (HTTP 400) ao validar o resultado do handler.
  return codec
    .mint({ ferramenta: 'reservar_sala', pedido, chave: CHAVE_DE_ESCOLHA }, ctx)
    .then(requestState =>
      inputRequired({
        inputRequests: {
          [CHAVE_DE_ESCOLHA]: inputRequired.elicit({
            message: 'A sala pedida esta ocupada nesse intervalo. Escolha uma alternativa.',
            requestedSchema: {
              type: 'object',
              properties: { sala: { type: 'string', title: 'Sala', description: 'Sala alternativa escolhida', enum: opcoes } },
              required: ['sala']
            }
          })
        },
        requestState
      })
    );
}

function concluirReserva(pedido) {
  const reserva = criarReserva(pedido);
  return resultado({
    reserva: reserva.id,
    reservado: true,
    sala: reserva.sala,
    inicio: reserva.inicio,
    fim: reserva.fim,
    responsavel: reserva.responsavel,
    politica: politicaVersao,
    motivo: null
  });
}

async function reservarSala(argumentos, ctx) {
  // O que vem em `arguments` no retry nao e confiavel: o pedido selado no
  // requestState (ja verificado pelo SDK) prevalece sobre ele.
  const estado = ctx.mcpReq.requestState();
  if (estado && estado.ferramenta !== 'reservar_sala') {
    throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'requestState nao pertence a esta ferramenta');
  }
  const pedido = estado ? estado.pedido : argumentos;

  try {
    const intervalo = validarPedido(pedido);

    if (estado) {
      const resposta = inputResponse(ctx.mcpReq.inputResponses, estado.chave);
      if (resposta.kind === 'elicit' && resposta.action !== 'accept') return resultado(semReserva('recusado'));
      if (resposta.kind === 'elicit') {
        const escolhida = acceptedContent(ctx.mcpReq.inputResponses, estado.chave, z.object({ sala: z.string() }))?.sala;
        const valida = escolhida && alternativas(pedido.sala, intervalo.ini, intervalo.fi).includes(escolhida);
        if (valida) return concluirReserva({ ...pedido, sala: escolhida });
      }
      return await pedirEscolha(ctx, pedido, intervalo);
    }

    if (conflitos(pedido.sala, intervalo.ini, intervalo.fi).length === 0) return concluirReserva(pedido);
    return await pedirEscolha(ctx, pedido, intervalo);
  } catch (e) {
    if (e instanceof ErroDeNegocio) return erroDeExecucao(e.message);
    throw e;
  }
}

function construirServidor() {
  const server = new McpServer(
    { name: 'central-de-salas', version: '1.0.0' },
    { capabilities: { tools: {}, resources: {} }, requestState: { verify: codec.verify } }
  );

  server.registerTool(
    'listar_salas',
    {
      description: 'Lista todas as salas com capacidade e recursos.',
      inputSchema: z.object({}),
      outputSchema: ListaDeSalas
    },
    async () => resultado({ salas })
  );

  server.registerTool(
    'consultar_disponibilidade',
    {
      description: 'Diz se uma sala esta livre no intervalo, e quais reservas conflitam.',
      inputSchema: z.object(Intervalo),
      outputSchema: Disponibilidade
    },
    async pedido => {
      try {
        const { ini, fi } = validarPedido(pedido);
        buscarSala(pedido.sala);
        const encontrados = conflitos(pedido.sala, ini, fi).map(({ id, inicio, fim, responsavel }) => ({ id, inicio, fim, responsavel }));
        return resultado({ sala: pedido.sala, livre: encontrados.length === 0, conflitos: encontrados });
      } catch (e) {
        if (e instanceof ErroDeNegocio) return erroDeExecucao(e.message);
        throw e;
      }
    }
  );

  server.registerTool(
    'reservar_sala',
    {
      description: 'Reserva uma sala. Se o intervalo estiver ocupado, pergunta qual alternativa usar.',
      inputSchema: z.object({ ...Intervalo, responsavel: z.string().describe('Nome de quem reserva') }),
      outputSchema: ReservaOut
    },
    reservarSala
  );

  server.registerResource(
    'politica-de-uso',
    'politica://uso',
    { title: 'Politica de uso das salas', description: 'Regras de uso e versao vigente.', mimeType: 'text/markdown' },
    async uri => ({ contents: [{ uri: uri.href, mimeType: 'text/markdown', text: politicaTexto }] })
  );

  return server;
}

const handler = createMcpHandler(construirServidor);

// stderr: metodo, id e traceparent de cada request recebido.
function registrar(corpo, cabecalhos) {
  const mensagens = Array.isArray(corpo) ? corpo : [corpo];
  for (const m of mensagens) {
    if (!m || typeof m !== 'object') continue;
    const traceparent = m.params?._meta?.traceparent ?? '-';
    const retry = m.params?.requestState ? ' retry=sim' : '';
    const nome = cabecalhos['mcp-name'] ? ` mcp-name=${cabecalhos['mcp-name']}` : '';
    console.error(`[mcp] metodo=${m.method ?? '-'} id=${JSON.stringify(m.id ?? null)} traceparent=${traceparent}${nome}${retry}`);
  }
}

async function lerCorpo(req) {
  const partes = [];
  for await (const parte of req) partes.push(parte);
  return Buffer.concat(partes);
}

const http = createServer(async (req, res) => {
  try {
    const corpo = req.method === 'POST' ? await lerCorpo(req) : undefined;
    if (corpo?.length) {
      try {
        registrar(JSON.parse(corpo.toString('utf8')), req.headers);
      } catch {
        console.error('[mcp] corpo recebido nao e JSON valido');
      }
    }

    const cabecalhos = new Headers();
    for (const [nome, valor] of Object.entries(req.headers)) {
      if (valor !== undefined) cabecalhos.set(nome, Array.isArray(valor) ? valor.join(', ') : valor);
    }
    const request = new Request(`http://${req.headers.host ?? `${HOST}:${PORTA}`}${req.url}`, {
      method: req.method,
      headers: cabecalhos,
      body: corpo?.length ? corpo : undefined
    });

    if (new URL(request.url).pathname !== '/mcp') {
      res.writeHead(404).end();
      return;
    }

    const resposta = await handler.fetch(request);
    res.writeHead(resposta.status, Object.fromEntries(resposta.headers));
    if (resposta.body) {
      for await (const pedaco of resposta.body) res.write(pedaco);
    }
    res.end();
  } catch (e) {
    console.error('[mcp] erro interno:', e);
    if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32603, message: 'Erro interno' } }));
  }
});

http.listen(PORTA, HOST, () => {
  console.error(`[mcp] central-de-salas ouvindo em http://${HOST}:${PORTA}/mcp`);
});
