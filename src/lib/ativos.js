/* ============================================================
   Registros VISÍVEIS do espelho do SAG — filtro único.

   Escola, Turma e Aluno com excluidoNoSag=true (deleted=true no
   SAG, do próprio registro ou do pai — lib/sagsync.js) continuam
   no banco para preservar o histórico (avaliações, eventos e
   timeline), mas ficam OCULTOS em toda a plataforma (decisão do
   usuário: "ocultar sem apagar"): listas, buscas, contagens,
   dashboards, Evolução, relatórios CSV, /meta, escopo de
   supervisor/gestor/professor (Professor.turmaIds que apontam
   para turma oculta são ignorados) e agregações de avaliações
   (avaliação de aluno oculto não conta). Detalhe de entidade
   oculta pedido por id → 404.

   Regra: TODA consulta de escola/turma/aluno/avaliação passa por
   um destes filtros. Visível = o próprio registro E os pais não
   excluídos (a sincronização já propaga a exclusão do pai, mas o
   filtro não depende disso).
   ============================================================ */

/** where de Escola visível. */
export const escolaVisivel = () => ({ excluidoNoSag: false });

/** where de Turma visível (a turma e a escola). */
export const turmaVisivel = () => ({ excluidoNoSag: false, escola: escolaVisivel() });

/** where de Aluno visível (o aluno, a turma e a escola). */
export const alunoVisivel = () => ({ excluidoNoSag: false, turma: turmaVisivel() });

/** where de Avaliacao contada: só de aluno visível. */
export const avaliacaoVisivel = () => ({ aluno: alunoVisivel() });

/**
 * Combina um where com o filtro de visibilidade (AND — não colide com
 * filtros já presentes nos mesmos campos, ex.: `turma: { escolaId }`).
 * @param {object|undefined|null} where
 * @param {object} visivel
 */
const comVisibilidade = (where, visivel) =>
  (where && Object.keys(where).length ? { AND: [where, visivel] } : visivel);

export const soEscolasVisiveis = where => comVisibilidade(where, escolaVisivel());
export const soTurmasVisiveis = where => comVisibilidade(where, turmaVisivel());
export const soAlunosVisiveis = where => comVisibilidade(where, alunoVisivel());
export const soAvaliacoesVisiveis = where => comVisibilidade(where, avaliacaoVisivel());

/**
 * Filtro de relação para include/_count dentro de uma turma JÁ visível:
 * `_count: { select: { alunos: alunosVisiveisDaTurma() } }` ou
 * `alunos: { ...alunosVisiveisDaTurma(), select, orderBy }`.
 */
export const alunosVisiveisDaTurma = () => ({ where: { excluidoNoSag: false } });

/** Idem para as turmas dentro de uma escola JÁ visível. */
export const turmasVisiveisDaEscola = () => ({ where: { excluidoNoSag: false } });

/**
 * Das turmas informadas, as visíveis (existentes e não ocultas), na ordem
 * recebida. Consulta só os ids informados.
 * @param {import('@prisma/client').PrismaClient} prisma
 * @param {string[]} ids
 * @returns {Promise<string[]>}
 */
export async function turmasVisiveisEntre(prisma, ids) {
  const unicos = [...new Set((ids || []).filter(Boolean))];
  if (!unicos.length) return [];
  const vivas = new Set((await prisma.turma.findMany({
    where: soTurmasVisiveis({ id: { in: unicos } }), select: { id: true },
  })).map(t => t.id));
  return unicos.filter(id => vivas.has(id));
}

/**
 * Ids das turmas OCULTAS (a turma ou a escola excluída no SAG) — para filtrar
 * tabelas sem relação com Turma (AcompanhamentoEvento, TimelineEvent) no
 * escopo de rede. São poucas (as excluídas na origem).
 * @returns {Promise<string[]>}
 */
export async function idsTurmasOcultas(prisma) {
  const ocultas = await prisma.turma.findMany({
    where: { OR: [{ excluidoNoSag: true }, { escola: { excluidoNoSag: true } }] },
    select: { id: true },
  });
  return ocultas.map(t => t.id);
}
