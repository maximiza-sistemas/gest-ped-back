/* ============================================================
   Indicadores reais por escola e por turma — fonte única do
   dashboard da rede (GET /rede), do detalhe da escola e dos
   relatórios CSV (GET /relatorios/*). Nada estimado:

   · professores = professores DISTINTOS com turma vinculada na
     plataforma (Professor.turmaIds ∩ turmas da escola);
   · avaliações = verificações contínuas (Avaliacao), atribuídas à
     turma ATUAL do aluno (a avaliação não guarda a turma);
   · % de atingimento = avaliações "Atingiu" / avaliações;
   · alunos que atingiram / não atingiram = pelo ÚLTIMO resultado
     registrado de cada aluno (verificação mais recente pela data;
     empate na mesma data → a registrada por último).
   Só entram escolas, turmas e alunos VISÍVEIS: os excluídos no SAG
   (excluidoNoSag — lib/ativos.js) e as avaliações dos seus alunos
   ficam fora de toda contagem. Na rede (GET /rede e CSV da rede)
   as avaliações são agregadas no banco (avaliacoesPorEscola).
   ============================================================ */
import { Prisma } from '@prisma/client';
import {
  soEscolasVisiveis, soTurmasVisiveis, soAvaliacoesVisiveis, alunosVisiveisDaTurma,
} from './ativos.js';

export const RESULTADO_ATINGIU = 2;

const pctDe = (parte, total) => (total ? Math.round((parte / total) * 100) : null);
const idsDe = s => { try { const v = JSON.parse(s || '[]'); return Array.isArray(v) ? v : []; } catch { return []; } };
const instante = d => new Date(d).getTime();

/** Seleção mínima de Avaliacao usada pelos indicadores. */
export const SELECT_AVALIACAO = {
  id: true, alunoId: true, data: true, resultado: true, aluno: { select: { turmaId: true } },
};

/** `a` foi registrada depois de `b`? (data; empate → id maior, cuid cresce no tempo) */
const maisRecente = (a, b) => {
  const ta = instante(a.data), tb = instante(b.data);
  return ta !== tb ? ta > tb : String(a.id) > String(b.id);
};

/**
 * Último resultado registrado de cada aluno.
 * @param {{id:string, alunoId:string, data:Date|string, resultado:number}[]} avs
 * @returns {Map<string, number>} alunoId → resultado (1 não atingiu | 2 atingiu)
 */
export function ultimoResultadoPorAluno(avs) {
  const ultima = new Map();
  for (const av of avs) {
    const atual = ultima.get(av.alunoId);
    if (!atual || maisRecente(av, atual)) ultima.set(av.alunoId, av);
  }
  return new Map([...ultima].map(([alunoId, av]) => [alunoId, av.resultado]));
}

/**
 * Resumo de um conjunto de avaliações.
 * alunosAtingiram + alunosNaoAtingiram = alunosAvaliados (regra do último resultado).
 */
export function resumoAvaliacoes(avs) {
  const atingiu = avs.filter(av => av.resultado === RESULTADO_ATINGIU).length;
  const ultimo = ultimoResultadoPorAluno(avs);
  const alunosAtingiram = [...ultimo.values()].filter(r => r === RESULTADO_ATINGIU).length;
  return {
    avaliacoes: avs.length,
    pctAtingiu: pctDe(atingiu, avs.length),
    alunosAvaliados: ultimo.size,
    alunosAtingiram,
    alunosNaoAtingiram: ultimo.size - alunosAtingiram,
  };
}

/** Agrupa itens por chave: Map<chave, item[]> novo (a entrada não é alterada). */
export function agruparPor(itens, chaveDe) {
  const grupos = new Map();
  for (const it of itens) {
    const k = chaveDe(it);
    const lista = grupos.get(k);
    if (lista) lista.push(it); // lista local, criada aqui — evita O(n²) de copiar a cada item
    else grupos.set(k, [it]);
  }
  return grupos;
}

/**
 * Professores distintos com turma vinculada, por escola.
 * @param {{id:string, turmaIds:string}[]} professores  Professor.turmaIds em JSON
 * @param {Map<string,string>} turmaEscola  turmaId → escolaId (turmas existentes)
 * @returns {{ porEscola: Map<string, Set<string>>, total: number, daEscola: (id:string) => number }}
 */
export function professoresPorEscola(professores, turmaEscola) {
  const porEscola = new Map();
  const todos = new Set();
  for (const pr of professores) {
    for (const turmaId of idsDe(pr.turmaIds)) {
      const escolaId = turmaEscola.get(turmaId);
      if (!escolaId) continue; // turma inexistente (removida no SAG) não conta
      todos.add(pr.id);
      if (!porEscola.has(escolaId)) porEscola.set(escolaId, new Set());
      porEscola.get(escolaId).add(pr.id);
    }
  }
  return { porEscola, total: todos.size, daEscola: id => (porEscola.get(id) || new Set()).size };
}

/** Contagem real de professores por escola, lendo do banco. */
export async function contarProfessoresPorEscola(prisma, turmas /* [{id, escolaId}] */) {
  const professores = await prisma.professor.findMany({ select: { id: true, turmaIds: true } });
  return professoresPorEscola(professores, new Map(turmas.map(t => [t.id, t.escolaId])));
}

// ordem estável: nome e, entre homônimas (ex.: "TRANSFERIDOS"), o id
const ordemNome = (a, b) => a.nome.localeCompare(b.nome, 'pt-BR') || a.id.localeCompare(b.id);

/**
 * Avaliações agregadas NO BANCO por escola (só alunos/turmas/escolas visíveis):
 * nº de avaliações, nº com "Atingiu" e alunos avaliados distintos. Evita
 * carregar todas as linhas de Avaliacao a cada GET /rede (achado F5).
 * Cada aluno pertence a uma turma → a uma escola: a soma dos alunos
 * avaliados por escola é o total distinto da rede.
 * @param {import('@prisma/client').PrismaClient} prisma
 * @param {string[]|null} escolaIds  null = rede toda
 * @returns {Promise<Map<string, {avaliacoes:number, atingiu:number, alunosAvaliados:number}>>}
 */
export async function avaliacoesPorEscola(prisma, escolaIds = null) {
  if (escolaIds && !escolaIds.length) return new Map();
  const filtroEscola = escolaIds ? Prisma.sql`AND t."escolaId" IN (${Prisma.join(escolaIds)})` : Prisma.empty;
  const linhas = await prisma.$queryRaw`
    SELECT t."escolaId" AS "escolaId",
           COUNT(*)::int AS "avaliacoes",
           COUNT(*) FILTER (WHERE a."resultado" = ${RESULTADO_ATINGIU})::int AS "atingiu",
           COUNT(DISTINCT a."alunoId")::int AS "alunosAvaliados"
      FROM "Avaliacao" a
      JOIN "Aluno" al ON al."id" = a."alunoId"
      JOIN "Turma" t ON t."id" = al."turmaId"
      JOIN "Escola" e ON e."id" = t."escolaId"
     WHERE al."excluidoNoSag" = false AND t."excluidoNoSag" = false AND e."excluidoNoSag" = false
       ${filtroEscola}
     GROUP BY t."escolaId"`;
  return new Map(linhas.map(l => [l.escolaId, {
    avaliacoes: Number(l.avaliacoes), atingiu: Number(l.atingiu), alunosAvaliados: Number(l.alunosAvaliados),
  }]));
}

const SEM_AVALIACAO = Object.freeze({ avaliacoes: 0, atingiu: 0, alunosAvaliados: 0 });

/**
 * Indicadores por escola da rede (ou das escolas informadas). Só escolas,
 * turmas e alunos VISÍVEIS (excluídos no SAG ficam fora — lib/ativos.js).
 * @param {import('@prisma/client').PrismaClient} prisma
 * @param {{ escolaIds?: string[]|null }} [opts]
 */
export async function indicadoresEscolas(prisma, { escolaIds = null } = {}) {
  const whereTurma = soTurmasVisiveis(escolaIds ? { escolaId: { in: escolaIds } } : {});
  const [escolas, turmas, professores, avsPorEscola] = await Promise.all([
    prisma.escola.findMany({
      where: soEscolasVisiveis(escolaIds ? { id: { in: escolaIds } } : {}),
      select: {
        id: true, nome: true, sigla: true, cor: true, regiao: true, bairro: true, diretor: true, grupoId: true,
        grupo: { select: { id: true, nome: true, cor: true } },
      },
    }),
    prisma.turma.findMany({ where: whereTurma, select: { id: true, escolaId: true, _count: { select: { alunos: alunosVisiveisDaTurma() } } } }),
    prisma.professor.findMany({ select: { id: true, turmaIds: true } }),
    avaliacoesPorEscola(prisma, escolaIds),
  ]);

  const turmaEscola = new Map(turmas.map(t => [t.id, t.escolaId]));
  const profs = professoresPorEscola(professores, turmaEscola);
  const turmasPorEscola = agruparPor(turmas, t => t.escolaId);

  const linhas = escolas.map(e => {
    const ts = turmasPorEscola.get(e.id) || [];
    const av = avsPorEscola.get(e.id) || SEM_AVALIACAO;
    return {
      id: e.id, nome: e.nome, sigla: e.sigla, cor: e.cor,
      regiao: e.regiao || '', grupoId: e.grupoId || null, grupo: e.grupo || null,
      bairro: e.bairro || '', diretor: e.diretor || '',
      totTurmas: ts.length,
      totAlunos: ts.reduce((s, t) => s + t._count.alunos, 0),
      professores: profs.daEscola(e.id),
      avaliacoes: av.avaliacoes, alunosAvaliados: av.alunosAvaliados, pctAtingiu: pctDe(av.atingiu, av.avaliacoes),
    };
  }).sort(ordemNome);

  const geral = [...avsPorEscola.values()].reduce((s, av) => ({
    avaliacoes: s.avaliacoes + av.avaliacoes, atingiu: s.atingiu + av.atingiu, alunosAvaliados: s.alunosAvaliados + av.alunosAvaliados,
  }), { ...SEM_AVALIACAO });
  return {
    escolas: linhas,
    totais: {
      escolas: linhas.length,
      turmas: turmas.length,
      alunos: linhas.reduce((s, e) => s + e.totAlunos, 0),
      professores: profs.total,
      avaliacoes: geral.avaliacoes,
      alunosAvaliados: geral.alunosAvaliados,
      pctAtingiu: pctDe(geral.atingiu, geral.avaliacoes),
    },
  };
}

/**
 * Indicadores por turma de uma escola (relatório da escola) — só turmas,
 * alunos e avaliações visíveis.
 * @returns {Promise<{ turmas: object[], totais: object }>}
 */
export async function indicadoresTurmasEscola(prisma, escolaId) {
  const [turmas, avs] = await Promise.all([
    prisma.turma.findMany({
      where: soTurmasVisiveis({ escolaId }),
      select: { id: true, nome: true, ano: true, turno: true, _count: { select: { alunos: alunosVisiveisDaTurma() } } },
      orderBy: [{ ano: 'asc' }, { nome: 'asc' }],
    }),
    prisma.avaliacao.findMany({ where: soAvaliacoesVisiveis({ aluno: { turma: { escolaId } } }), select: SELECT_AVALIACAO }),
  ]);
  const avsPorTurma = agruparPor(avs, av => av.aluno.turmaId);
  const linhas = turmas.map(t => {
    const resumo = resumoAvaliacoes(avsPorTurma.get(t.id) || []);
    const alunos = t._count.alunos;
    return { id: t.id, nome: t.nome, ano: t.ano, turno: t.turno, alunos, ...resumo, pctAplicado: pctDe(resumo.alunosAvaliados, alunos) };
  });
  const alunos = linhas.reduce((s, t) => s + t.alunos, 0);
  const geral = resumoAvaliacoes(avs);
  return {
    turmas: linhas,
    totais: { turmas: linhas.length, alunos, ...geral, pctAplicado: pctDe(geral.alunosAvaliados, alunos) },
  };
}
