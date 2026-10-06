/* ============================================================
   Acompanhamento real de cada habilidade de um planejamento —
   o status é DERIVADO da verificação contínua (nada marcado à
   mão; TrabalhoHabilidade.status/proxima deixaram de ser lidos):

   · trabalhada — existe ao menos um evento de acompanhamento
     COMPLETO da habilidade (todos os alunos atuais da turma
     analisados) numa turma do recorte;
   · andamento  — há avaliações, mas nenhum evento completo;
   · pendente   — nenhuma avaliação.

   Recorte por (planejamento, habilidade): o evento é a unidade e
   pertence ao planejamento em que foi registrado
   (AcompanhamentoEvento.planejamentoId) e à sua turma; avaliações
   legadas sem evento contam pelo próprio planejamentoId e pela
   turma atual do aluno. As turmas do recorte vêm do perfil
   (turmasDoUsuario): professor = as suas; supervisor/gestor
   escolar = as das escolas vinculadas; secretaria/admin = rede.

   Números por (planejamento, habilidade):
     avaliacoes  = verificações realizadas: eventos com ao menos
                   uma avaliação + datas distintas de avaliações
                   legadas (sem evento);
     eventos / eventosCompletos;
     avaliados / atingiram = último resultado de cada aluno
                   (mesma regra de lib/indicadores.js);
     ultima      = data da avaliação mais recente (dd/mm/aaaa).
   ============================================================ */
import { fmtBR } from './datas.js';
import { ultimoResultadoPorAluno, RESULTADO_ATINGIU } from './indicadores.js';
import { idsTurmasOcultas, soAlunosVisiveis, soAvaliacoesVisiveis } from './ativos.js';

export const STATUS_TRABALHO = Object.freeze({
  PENDENTE: 'pendente', ANDAMENTO: 'andamento', TRABALHADA: 'trabalhada',
});

/** Acompanhamento de uma habilidade ainda sem nenhuma verificação. */
export const TRABALHO_VAZIO = Object.freeze({
  status: STATUS_TRABALHO.PENDENTE,
  avaliacoes: 0, eventos: 0, eventosCompletos: 0, avaliados: 0, atingiram: 0, ultima: null,
});

/** Chave do mapa de acompanhamento. */
export const chaveTrabalho = (planejamentoId, habCod) => `${planejamentoId}::${habCod}`;

/**
 * Evento completo: a turma tem alunos e TODOS os alunos atuais dela foram
 * analisados no evento (alunos que saíram da turma não contam).
 * @param {string[]} alunosDaTurma   ids dos alunos atuais da turma
 * @param {Iterable<string>} analisados  ids dos alunos com avaliação no evento
 */
export function eventoCompleto(alunosDaTurma, analisados) {
  const set = analisados instanceof Set ? analisados : new Set(analisados);
  return alunosDaTurma.length > 0 && alunosDaTurma.every(id => set.has(id));
}

/** Status derivado dos números de uma habilidade. */
export function statusTrabalho({ avaliacoes = 0, eventosCompletos = 0 } = {}) {
  if (eventosCompletos > 0) return STATUS_TRABALHO.TRABALHADA;
  if (avaliacoes > 0) return STATUS_TRABALHO.ANDAMENTO;
  return STATUS_TRABALHO.PENDENTE;
}

const novoAcumulador = () => ({ avs: [], eventos: 0, eventosCompletos: 0, datasLegadas: new Set() });

const acumuladorDe = (mapa, chave) => {
  if (!mapa.has(chave)) mapa.set(chave, novoAcumulador());
  return mapa.get(chave);
};

/** Números finais de um acumulador (objeto novo). */
function fecharAcumulador(acc) {
  const ultimo = ultimoResultadoPorAluno(acc.avs);
  const maisRecente = acc.avs.reduce((max, av) => (!max || new Date(av.data) > new Date(max) ? av.data : max), null);
  const avaliacoes = acc.eventos + acc.datasLegadas.size;
  return {
    status: statusTrabalho({ avaliacoes, eventosCompletos: acc.eventosCompletos }),
    avaliacoes,
    eventos: acc.eventos,
    eventosCompletos: acc.eventosCompletos,
    avaliados: ultimo.size,
    atingiram: [...ultimo.values()].filter(r => r === RESULTADO_ATINGIU).length,
    ultima: maisRecente ? fmtBR(maisRecente) : null,
  };
}

/**
 * Monta o acompanhamento por (planejamento, habilidade) — função pura.
 * @param {{
 *   eventos: {id:string, turmaId:string, habCod:string, planejamentoId:string|null}[],
 *   avaliacoes: {id:string, alunoId:string, habCod:string, planejamentoId:string|null,
 *                eventoId:string|null, data:Date|string, resultado:number}[],
 *   alunosPorTurma: Map<string, string[]>,
 * }} dados  avaliacoes = as dos eventos informados + as legadas (sem evento) do recorte
 * @returns {Map<string, typeof TRABALHO_VAZIO>} chaveTrabalho(plano, hab) → acompanhamento
 */
export function montarAcompanhamento({ eventos, avaliacoes, alunosPorTurma }) {
  const eventoPorId = new Map(eventos.map(e => [e.id, e]));
  const avsPorEvento = new Map();
  const acc = new Map();

  for (const av of avaliacoes) {
    const ev = av.eventoId ? eventoPorId.get(av.eventoId) : null;
    if (av.eventoId && !ev) continue; // avaliação de evento fora do recorte
    const planoId = (ev && ev.planejamentoId) || av.planejamentoId;
    const a = acumuladorDe(acc, chaveTrabalho(planoId, ev ? ev.habCod : av.habCod));
    a.avs.push(av);
    if (ev) {
      if (!avsPorEvento.has(ev.id)) avsPorEvento.set(ev.id, { planoId, alunos: new Set() });
      avsPorEvento.get(ev.id).alunos.add(av.alunoId);
    } else {
      a.datasLegadas.add(new Date(av.data).getTime());
    }
  }

  // eventos sem nenhuma avaliação não são verificação realizada
  for (const [eventoId, { planoId, alunos }] of avsPorEvento) {
    const ev = eventoPorId.get(eventoId);
    const a = acumuladorDe(acc, chaveTrabalho(planoId, ev.habCod));
    a.eventos += 1;
    if (eventoCompleto(alunosPorTurma.get(ev.turmaId) || [], alunos)) a.eventosCompletos += 1;
  }

  return new Map([...acc].map(([chave, a]) => [chave, fecharAcumulador(a)]));
}

const SELECT_AVALIACAO = {
  id: true, alunoId: true, habCod: true, planejamentoId: true, eventoId: true, data: true, resultado: true,
};

/**
 * Lê do banco e monta o acompanhamento dos planejamentos nas turmas do recorte.
 * @param {import('@prisma/client').PrismaClient} prisma
 * @param {{ planejamentoIds: string[], turmaIds?: string[]|null }} opts
 *   turmaIds null = rede toda; [] = nenhuma turma (tudo pendente)
 * @returns {Promise<Map<string, typeof TRABALHO_VAZIO>>}
 */
export async function carregarAcompanhamento(prisma, { planejamentoIds, turmaIds = null }) {
  if (!planejamentoIds?.length || (turmaIds && !turmaIds.length)) return new Map();
  // turmas/alunos excluídos no SAG ficam fora (lib/ativos.js): o recorte por turma
  // já vem só com turmas visíveis; na rede, os eventos de turmas ocultas saem aqui
  const daTurma = turmaIds
    ? { turmaId: { in: turmaIds } }
    : { turmaId: { notIn: await idsTurmasOcultas(prisma) } };
  const filtroEvento = { planejamentoId: { in: planejamentoIds }, ...daTurma };

  const [eventos, avsDeEventos, avsLegadas] = await Promise.all([
    prisma.acompanhamentoEvento.findMany({
      where: filtroEvento, select: { id: true, turmaId: true, habCod: true, planejamentoId: true },
    }),
    prisma.avaliacao.findMany({ where: soAvaliacoesVisiveis({ evento: { is: filtroEvento } }), select: SELECT_AVALIACAO }),
    prisma.avaliacao.findMany({
      where: soAvaliacoesVisiveis({
        eventoId: null, planejamentoId: { in: planejamentoIds },
        ...(turmaIds ? { aluno: { turmaId: { in: turmaIds } } } : {}),
      }),
      select: SELECT_AVALIACAO,
    }),
  ]);

  // "todos os alunos atuais da turma" = os visíveis (aluno excluído no SAG não conta)
  const turmasComEvento = [...new Set(eventos.map(e => e.turmaId))];
  const alunos = turmasComEvento.length
    ? await prisma.aluno.findMany({ where: soAlunosVisiveis({ turmaId: { in: turmasComEvento } }), select: { id: true, turmaId: true } })
    : [];
  const alunosPorTurma = new Map();
  for (const al of alunos) {
    if (!alunosPorTurma.has(al.turmaId)) alunosPorTurma.set(al.turmaId, []);
    alunosPorTurma.get(al.turmaId).push(al.id);
  }

  return montarAcompanhamento({ eventos, avaliacoes: [...avsDeEventos, ...avsLegadas], alunosPorTurma });
}

/**
 * Acompanhamento de cada habilidade de um planejamento: { [habCod]: {...} }.
 * Habilidade sem verificação no recorte → TRABALHO_VAZIO (pendente).
 * @param {{ id:string, habilidades:{habCod:string}[] }} plano
 * @param {Map<string, typeof TRABALHO_VAZIO>} acompanhamento
 */
export function trabalhoDoPlano(plano, acompanhamento) {
  return Object.fromEntries(plano.habilidades.map(h =>
    [h.habCod, { ...(acompanhamento.get(chaveTrabalho(plano.id, h.habCod)) || TRABALHO_VAZIO) }]));
}
