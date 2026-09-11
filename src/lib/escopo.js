/* ============================================================
   Escopo de acesso por perfil.

   - admin / secretaria: alcance de rede (sem restrição por escola).
   - gestor: restrito ao seu grupo de escolas (Usuario.escolaIds,
     transportado no JWT).
   - professor: escopo é por profId (tratado nas próprias rotas).
   ============================================================ */

/**
 * Lista de escolas a que um gestor está restrito.
 * @returns {string[] | null} array de escolaIds para gestor;
 *   null quando o perfil tem alcance de rede ou não usa filtro por escola.
 */
export function gestorEscolas(user) {
  if (user?.perfil === 'gestor') {
    return Array.isArray(user.escolaIds) ? user.escolaIds : [];
  }
  return null;
}

/** Ids dos grupos a que pertencem as escolas informadas (Set). */
export async function gruposDasEscolas(prisma, escolaIds) {
  if (!escolaIds || escolaIds.length === 0) return new Set();
  const escolas = await prisma.escola.findMany({
    where: { id: { in: escolaIds } }, select: { grupoId: true },
  });
  return new Set(escolas.map(e => e.grupoId).filter(Boolean));
}

/**
 * Planejamento visível no escopo: direcionado à rede toda (sem grupos)
 * ou a pelo menos um grupo do escopo.
 * @param {string} gruposJSON  Planejamento.grupos (JSON: ["g1","g2"])
 * @param {Set<string>} gruposEscopo
 */
export function planoNoEscopo(gruposJSON, gruposEscopo) {
  let grupos = [];
  try { grupos = JSON.parse(gruposJSON || '[]'); } catch { grupos = []; }
  if (!Array.isArray(grupos) || grupos.length === 0) return true;
  return grupos.some(g => gruposEscopo.has(g));
}

/**
 * Anos direcionados casam com as turmas? vazio = todas as séries;
 * ano 0 (turma de habilidades / multisseriada) recebe qualquer direcionamento.
 * @param {string} anosJSON  Planejamento.anos (JSON: [1,2])
 * @param {Set<number>} anosTurmas
 */
export function planoCasaAnos(anosJSON, anosTurmas) {
  let anos = [];
  try { anos = JSON.parse(anosJSON || '[]'); } catch { anos = []; }
  if (!Array.isArray(anos) || anos.length === 0) return true;
  if (anosTurmas.has(0)) return true;
  return anos.some(a => anosTurmas.has(a));
}

/** Contexto das turmas em que um professor leciona: grupos das escolas, anos e componente. */
export async function contextoProfessor(prisma, profId) {
  const prof = profId
    ? await prisma.professor.findUnique({ where: { id: profId }, select: { compId: true, turmaIds: true } })
    : null;
  let turmaIds = [];
  try { turmaIds = JSON.parse(prof?.turmaIds || '[]'); } catch { turmaIds = []; }
  const turmas = turmaIds.length
    ? await prisma.turma.findMany({ where: { id: { in: turmaIds } }, select: { id: true, ano: true, escola: { select: { grupoId: true } } } })
    : [];
  return {
    compId: prof?.compId || null,
    turmaIds: turmas.map(t => t.id),
    grupos: new Set(turmas.map(t => t.escola.grupoId).filter(Boolean)),
    anos: new Set(turmas.map(t => t.ano)),
    temTurmas: turmas.length > 0,
  };
}

/**
 * Plano direcionado ao professor: casa grupo E ano de alguma turma dele e tem
 * pelo menos uma habilidade do seu componente. Sem turmas vinculadas, só o
 * componente filtra (mesma regra de planosDirecionados() no painel).
 * @param {{grupos:string, anos:string, habilidades:{habCod:string}[]}} pl
 * @param {Awaited<ReturnType<typeof contextoProfessor>>} ctx
 * @param {Map<string,string>} compDaHab  habCod → compId
 */
export function planoDirecionadoAoProfessor(pl, ctx, compDaHab) {
  const casaGrupo = !ctx.temTurmas || planoNoEscopo(pl.grupos, ctx.grupos);
  const casaAno = !ctx.temTurmas || planoCasaAnos(pl.anos, ctx.anos);
  const casaComp = !ctx.compId || (pl.habilidades || []).some(h => compDaHab.get(h.habCod) === ctx.compId);
  return casaGrupo && casaAno && casaComp;
}
