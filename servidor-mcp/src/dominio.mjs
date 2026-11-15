import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const raizDados = process.env.DADOS_DIR ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../dados');

export const salas = JSON.parse(readFileSync(path.join(raizDados, 'salas.json'), 'utf8'));
export const politicaTexto = readFileSync(path.join(raizDados, 'politica-de-uso.md'), 'utf8');
export const politicaVersao = /^versao:\s*(\S+)/m.exec(politicaTexto)?.[1] ?? 'desconhecida';

// Reservas em memoria: valem para todos os requests do processo.
const reservas = JSON.parse(readFileSync(path.join(raizDados, 'reservas.json'), 'utf8'));
let proximoNumero = reservas.length + 1;

const MS_HORA = 3_600_000;
const OFFSET_SAO_PAULO_MS = -3 * MS_HORA;
const JANELA_INICIO_MIN = 8 * 60;
const JANELA_FIM_MIN = 20 * 60;
const DURACAO_MAXIMA_MS = 2 * MS_HORA;
const MAX_ALTERNATIVAS = 3;

export const ERROS = {
  salaInexistente: id => `Sala inexistente: ${id}`,
  foraDaJanela: 'Fora da janela de uso: a politica permite reservas entre 08:00 e 20:00',
  duracao: 'Duracao acima do limite: a politica permite no maximo 2 horas',
  intervalo: 'Intervalo invalido: fim deve ser posterior a inicio',
  dataInvalida: 'Intervalo invalido: inicio e fim devem estar em ISO 8601 com fuso',
  semAlternativas: 'Sem alternativas disponiveis no intervalo'
};

export class ErroDeNegocio extends Error {}

const minutosNoDia = ms => {
  const local = new Date(ms + OFFSET_SAO_PAULO_MS);
  return { dia: local.toISOString().slice(0, 10), minutos: local.getUTCHours() * 60 + local.getUTCMinutes() };
};

export function buscarSala(id) {
  const sala = salas.find(s => s.id === id);
  if (!sala) throw new ErroDeNegocio(ERROS.salaInexistente(id));
  return sala;
}

const temFuso = valor => /(Z|[+-]\d{2}:?\d{2})$/i.test(valor);

// Valida sala e politica; devolve o intervalo em milissegundos.
export function validarPedido({ sala, inicio, fim }) {
  buscarSala(sala);
  const ini = temFuso(String(inicio)) ? Date.parse(inicio) : NaN;
  const fi = temFuso(String(fim)) ? Date.parse(fim) : NaN;
  if (Number.isNaN(ini) || Number.isNaN(fi)) throw new ErroDeNegocio(ERROS.dataInvalida);
  if (fi <= ini) throw new ErroDeNegocio(ERROS.intervalo);

  const a = minutosNoDia(ini);
  const b = minutosNoDia(fi);
  const dentro = a.minutos >= JANELA_INICIO_MIN && a.minutos <= JANELA_FIM_MIN && b.minutos >= JANELA_INICIO_MIN && b.minutos <= JANELA_FIM_MIN;
  if (!dentro || a.dia !== b.dia) throw new ErroDeNegocio(ERROS.foraDaJanela);
  if (fi - ini > DURACAO_MAXIMA_MS) throw new ErroDeNegocio(ERROS.duracao);
  return { ini, fi };
}

export function conflitos(salaId, ini, fi) {
  return reservas.filter(r => r.sala === salaId && Date.parse(r.inicio) < fi && ini < Date.parse(r.fim));
}

// Salas livres no intervalo com capacidade >= a da sala pedida: no maximo tres,
// por capacidade crescente e, em empate, por id.
export function alternativas(salaId, ini, fi) {
  const pedida = buscarSala(salaId);
  return salas
    .filter(s => s.id !== salaId && s.capacidade >= pedida.capacidade && conflitos(s.id, ini, fi).length === 0)
    .sort((x, y) => x.capacidade - y.capacidade || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0))
    .slice(0, MAX_ALTERNATIVAS)
    .map(s => s.id);
}

export function criarReserva({ sala, inicio, fim, responsavel }) {
  const reserva = { id: `res-${String(proximoNumero++).padStart(4, '0')}`, sala, inicio, fim, responsavel };
  reservas.push(reserva);
  return reserva;
}
