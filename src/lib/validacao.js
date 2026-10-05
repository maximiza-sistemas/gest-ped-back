/* ============================================================
   Validação do planejamento docente — regras puras (sem banco).

   Unidade validada: as semanas (PlanejamentoSemana) de UM professor
   em UM planejamento → uma linha PlanejamentoValidacao
   (planejamentoId + profId).

   Fluxo:
     rascunho ──(professor envia)──▶ enviado ──(gestor escolar)──▶ validado
                                        │                           │
                                        └──────▶ recusado ◀─────────┘
     recusado = reaberto automaticamente para edição; o professor
     ajusta as semanas e reenvia (recusado → enviado).
   Sem linha gravada equivale a 'rascunho'.
   ============================================================ */
import { fmtBR } from './datas.js';

export const STATUS_VALIDACAO = Object.freeze(['rascunho', 'enviado', 'validado', 'recusado']);

/** Tamanho do motivo da devolução (após trim). */
export const MOTIVO_MIN = 5;
export const MOTIVO_MAX = 2000;

const AGUARDE_GESTOR = 'Planejamento enviado para validação — aguarde a análise do gestor escolar.';
const JA_VALIDADO = 'Planejamento já validado pelo gestor escolar.';
const NAO_ENVIADO = 'O professor ainda não enviou este planejamento para validação.';
const AGUARDE_REENVIO = 'Planejamento devolvido para ajustes — aguarde o reenvio do professor.';

// ação → { status de origem aceitos, status de destino, recusa por status atual }
const TRANSICOES = Object.freeze({
  enviar: {
    origens: ['rascunho', 'recusado'],
    destino: 'enviado',
    recusas: { enviado: AGUARDE_GESTOR, validado: JA_VALIDADO },
  },
  validar: {
    origens: ['enviado'],
    destino: 'validado',
    recusas: { rascunho: NAO_ENVIADO, validado: 'Este planejamento já foi validado.', recusado: AGUARDE_REENVIO },
  },
  recusar: {
    origens: ['enviado', 'validado'],
    destino: 'recusado',
    recusas: { rascunho: NAO_ENVIADO, recusado: AGUARDE_REENVIO },
  },
});

/** Registro do histórico gravado por ação. */
export const ACAO_HISTORICO = Object.freeze({ enviar: 'enviado', validar: 'validado', recusar: 'recusado' });

/**
 * A ação é permitida a partir do status atual?
 * @param {'enviar'|'validar'|'recusar'} acao
 * @param {string|null|undefined} statusAtual  null/undefined = sem linha (rascunho)
 * @returns {{ ok: true, destino: string } | { ok: false, mensagem: string }}
 */
export function transicao(acao, statusAtual) {
  const regra = TRANSICOES[acao];
  if (!regra) throw new Error(`Ação de validação desconhecida: ${acao}`);
  const atual = statusAtual || 'rascunho';
  if (regra.origens.includes(atual)) return { ok: true, destino: regra.destino };
  return { ok: false, mensagem: regra.recusas[atual] || 'Ação não permitida no status atual do planejamento.' };
}

/**
 * As semanas do professor estão travadas para edição?
 * @returns {string|null} mensagem de bloqueio (409) ou null quando pode editar
 */
export function bloqueioEdicao(status) {
  if (status === 'enviado') return AGUARDE_GESTOR;
  if (status === 'validado') return JA_VALIDADO;
  return null;
}

/**
 * Motivo da devolução: obrigatório, com trim, entre MOTIVO_MIN e MOTIVO_MAX caracteres.
 * @returns {{ ok: true, valor: string } | { ok: false, mensagem: string }}
 */
export function normalizarMotivo(motivo) {
  const valor = typeof motivo === 'string' ? motivo.trim() : '';
  if (valor.length < MOTIVO_MIN) {
    return { ok: false, mensagem: `Informe o motivo da devolução (mínimo de ${MOTIVO_MIN} caracteres) — o professor verá esse texto para ajustar o planejamento.` };
  }
  if (valor.length > MOTIVO_MAX) {
    return { ok: false, mensagem: `O motivo da devolução deve ter no máximo ${MOTIVO_MAX} caracteres.` };
  }
  return { ok: true, valor };
}

/** Histórico gravado (JSON) → array; tolera conteúdo inválido. */
export function lerHistorico(json) {
  try {
    const h = JSON.parse(json || '[]');
    return Array.isArray(h) ? h : [];
  } catch {
    return [];
  }
}

/**
 * Novo JSON do histórico com a entrada acrescentada no fim (não altera o original).
 * @param {string} historicoJSON
 * @param {{ acao: string, porId: string, porNome: string, em: string, motivo?: string }} entrada
 */
export function acrescentarHistorico(historicoJSON, entrada) {
  return JSON.stringify([...lerHistorico(historicoJSON), entrada]);
}

/**
 * Formato público de uma validação.
 * @param {object|null} v  linha PlanejamentoValidacao (ou null = rascunho sem linha)
 * @param {Map<string,string>} nomes  usuarioId → nome (decisor)
 */
export function shapeValidacao(v, nomes = new Map()) {
  return {
    planejamentoId: v?.planejamentoId ?? null,
    profId: v?.profId ?? null,
    status: v?.status || 'rascunho',
    motivo: v?.motivo || '',
    enviadoEm: v?.enviadoEm ? fmtBR(v.enviadoEm) : null,
    decididoEm: v?.decididoEm ? fmtBR(v.decididoEm) : null,
    decididoPorNome: v?.decididoPorId ? (nomes.get(v.decididoPorId) || null) : null,
    historico: lerHistorico(v?.historico).map(h => ({
      acao: h.acao, porNome: h.porNome || null, em: h.em ? fmtBR(h.em) : null,
      ...(h.motivo ? { motivo: h.motivo } : {}),
    })),
  };
}

// ordem de exibição: pendentes primeiro, depois devolvidos, validados e rascunhos
const PRIORIDADE = { enviado: 0, recusado: 1, validado: 2, rascunho: 3 };
const ultimaData = v => +(v.decididoEm || v.enviadoEm || v.atualizadoEm || 0);

/**
 * Ordena linhas de validação (sem alterar o array recebido): por status
 * (pendentes primeiro) e, dentro do status, pendentes do mais antigo para
 * o mais novo (fila) e os demais da decisão mais recente para a mais antiga.
 */
export function ordenarValidacoes(linhas) {
  return [...linhas].sort((a, b) => {
    const pa = PRIORIDADE[a.status || 'rascunho'] ?? 9;
    const pb = PRIORIDADE[b.status || 'rascunho'] ?? 9;
    if (pa !== pb) return pa - pb;
    if (a.status === 'enviado') return ultimaData(a) - ultimaData(b);
    return ultimaData(b) - ultimaData(a);
  });
}
