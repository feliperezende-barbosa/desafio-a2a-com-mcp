import { randomBytes } from 'node:crypto';
import { chamarFerramenta, descobrirFerramenta, lerVersaoDaPolitica, novoTraceparent, traceIdDe } from './mcp.mjs';

export const ESTADOS_TERMINAIS = new Set(['TASK_STATE_COMPLETED', 'TASK_STATE_CANCELED', 'TASK_STATE_FAILED']);

// Codigos de erro de A2A v1.0 (JSON-RPC).
export const ERRO_TASK_NAO_ENCONTRADA = -32001;
export const ERRO_OPERACAO_NAO_SUPORTADA = -32004;
export const ERRO_PARAMETROS = -32602;

export class ErroRpc extends Error {
  constructor(codigo, mensagem) {
    super(mensagem);
    this.codigo = codigo;
  }
}

const id = prefixo => `${prefixo}-${randomBytes(6).toString('hex')}`;

// Estado das Tasks, em memoria, por Task. O requestState de cada pausa fica em
// `pausa`, fora da Task serializada: ele nunca sai pelo A2A.
const tarefas = new Map();

const PEDIDO = /^reservar\s+sala=(\S+)\s+inicio=(\S+)\s+fim=(\S+)\s+responsavel=(.+?)\s*$/s;
const ESCOLHA = /^escolha=(\S+)\s*$/;

const textoDa = mensagem => (mensagem?.parts ?? []).map(p => p.text ?? '').join('').trim();

function mensagemDoAgente(tarefa, texto) {
  return { messageId: id('msg'), role: 'ROLE_AGENT', parts: [{ text: texto }], taskId: tarefa.id, contextId: tarefa.contextId };
}

function definirEstado(entrada, estado, texto) {
  const { tarefa } = entrada;
  const mensagem = texto === undefined ? undefined : mensagemDoAgente(tarefa, texto);
  tarefa.status = { state: estado, ...(mensagem && { message: mensagem }), timestamp: new Date().toISOString() };
  if (mensagem) tarefa.history.push(mensagem);
}

const paraCliente = ({ tarefa }) => structuredClone(tarefa);

function linhaDeAlternativas(alternativas) {
  return `alternativas: ${alternativas.join(', ')}`;
}

function concluirComReserva(entrada, dados) {
  const reserva = {
    reserva: dados.reserva,
    sala: dados.sala,
    inicio: dados.inicio,
    fim: dados.fim,
    responsavel: dados.responsavel,
    politica: entrada.politica
  };
  entrada.tarefa.artifacts.push({ artifactId: id('art'), name: 'reserva', parts: [{ text: JSON.stringify(reserva) }] });
  definirEstado(entrada, 'TASK_STATE_COMPLETED', `Reserva ${dados.reserva} confirmada na ${dados.sala}.`);
}

// A ponte (MCP -> A2A): o que o servidor MCP devolveu vira estado da Task.
//  - input_required -> TASK_STATE_INPUT_REQUIRED, com o requestState guardado na Task
//  - isError        -> TASK_STATE_FAILED, com a mensagem exata da tool
//  - recusa         -> TASK_STATE_CANCELED
//  - reserva criada -> TASK_STATE_COMPLETED, com o artifact
function aplicarResultado(entrada, resultado) {
  if (resultado.tipo === 'pausa') {
    if (!resultado.chave || !resultado.requestState || resultado.alternativas.length === 0) {
      entrada.pausa = undefined;
      definirEstado(entrada, 'TASK_STATE_FAILED', 'O servidor MCP pediu informacao em um formato que o agente nao sabe repassar.');
      return;
    }
    entrada.pausa = { chave: resultado.chave, requestState: resultado.requestState, alternativas: resultado.alternativas };
    definirEstado(entrada, 'TASK_STATE_INPUT_REQUIRED', linhaDeAlternativas(resultado.alternativas));
    return;
  }

  entrada.pausa = undefined;
  if (resultado.tipo === 'erro') {
    definirEstado(entrada, 'TASK_STATE_FAILED', resultado.mensagem);
  } else if (resultado.dados.reservado) {
    concluirComReserva(entrada, resultado.dados);
  } else {
    definirEstado(entrada, 'TASK_STATE_CANCELED', `Reserva nao realizada: ${resultado.dados.motivo ?? 'recusado'}.`);
  }
}

function falhaDeComunicacao(entrada, erro) {
  console.error(`[agente] task=${entrada.tarefa.id} falha ao falar com o servidor MCP:`, erro.message);
  entrada.pausa = undefined;
  definirEstado(entrada, 'TASK_STATE_FAILED', `Falha ao falar com o servidor MCP: ${erro.message}`);
}

async function iniciar(entrada, texto) {
  const pedido = PEDIDO.exec(texto);
  if (!pedido) {
    definirEstado(entrada, 'TASK_STATE_FAILED', 'Pedido invalido. Use: reservar sala=<id> inicio=<iso8601> fim=<iso8601> responsavel=<nome>');
    return;
  }
  const [, sala, inicio, fim, responsavel] = pedido;
  const argumentos = { sala, inicio, fim, responsavel };
  try {
    const nome = await descobrirFerramenta(entrada.traceId);
    entrada.politica = await lerVersaoDaPolitica(entrada.traceId);
    entrada.pedido = { nome, argumentos };
    aplicarResultado(entrada, await chamarFerramenta({ nome, argumentos, traceId: entrada.traceId }));
  } catch (e) {
    falhaDeComunicacao(entrada, e);
  }
}

// A ponte (A2A -> MCP): a resposta do cliente vira um novo tools/call com os
// mesmos argumentos, o requestState ecoado sem abrir e um id de request novo.
async function retomar(entrada, texto) {
  const { pausa, pedido } = entrada;
  const escolha = ESCOLHA.exec(texto)?.[1];
  const recusou = escolha === 'recusar';

  if (!escolha || (!recusou && !pausa.alternativas.includes(escolha))) {
    definirEstado(entrada, 'TASK_STATE_INPUT_REQUIRED', linhaDeAlternativas(pausa.alternativas));
    return;
  }

  definirEstado(entrada, 'TASK_STATE_WORKING');
  const resposta = recusou ? { action: 'decline' } : { action: 'accept', content: { sala: escolha } };
  try {
    aplicarResultado(
      entrada,
      await chamarFerramenta({
        nome: pedido.nome,
        argumentos: pedido.argumentos,
        traceId: entrada.traceId,
        inputResponses: { [pausa.chave]: resposta },
        requestState: pausa.requestState
      })
    );
  } catch (e) {
    falhaDeComunicacao(entrada, e);
  }
}

export async function enviarMensagem(params, traceparent) {
  const mensagem = params?.message;
  if (!mensagem || !Array.isArray(mensagem.parts)) throw new ErroRpc(ERRO_PARAMETROS, 'message com parts e obrigatoria');
  const texto = textoDa(mensagem);
  const traceIdRecebido = traceIdDe(traceparent);

  let entrada;
  if (mensagem.taskId) {
    entrada = tarefas.get(mensagem.taskId);
    if (!entrada) throw new ErroRpc(ERRO_TASK_NAO_ENCONTRADA, `Task nao encontrada: ${mensagem.taskId}`);
    const estado = entrada.tarefa.status.state;
    if (ESTADOS_TERMINAIS.has(estado)) {
      throw new ErroRpc(ERRO_OPERACAO_NAO_SUPORTADA, `A Task ${entrada.tarefa.id} esta em estado terminal (${estado}) e nao aceita novas mensagens`);
    }
    if (estado !== 'TASK_STATE_INPUT_REQUIRED') {
      throw new ErroRpc(ERRO_OPERACAO_NAO_SUPORTADA, `A Task ${entrada.tarefa.id} esta em ${estado} e nao aguarda mensagem`);
    }
    if (traceIdRecebido) entrada.traceId = traceIdRecebido;
    entrada.tarefa.history.push(structuredClone(mensagem));
    await retomar(entrada, texto);
  } else {
    const tarefa = {
      id: id('task'),
      contextId: mensagem.contextId ?? id('ctx'),
      status: { state: 'TASK_STATE_SUBMITTED', timestamp: new Date().toISOString() },
      history: [structuredClone(mensagem)],
      artifacts: []
    };
    entrada = { tarefa, traceId: traceIdRecebido ?? traceIdDe(novoTraceparent()), pausa: undefined };
    tarefas.set(tarefa.id, entrada);
    definirEstado(entrada, 'TASK_STATE_WORKING');
    await iniciar(entrada, texto);
  }

  console.error(`[agente] task=${entrada.tarefa.id} estado=${entrada.tarefa.status.state} trace-id=${entrada.traceId}`);
  return { task: paraCliente(entrada) };
}

export function obterTask(params) {
  const entrada = tarefas.get(params?.id);
  if (!entrada) throw new ErroRpc(ERRO_TASK_NAO_ENCONTRADA, `Task nao encontrada: ${params?.id}`);
  return { task: paraCliente(entrada) };
}
