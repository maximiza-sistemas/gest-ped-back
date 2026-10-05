/* ============================================================
   Escopo de acesso por perfil.

   - admin / secretaria: alcance de rede (sem restrição por escola).
   - supervisor (antigo "gestor de polo"): restrito às escolas a que
     está vinculado (Usuario.escolaIds, transportado no JWT). SOMENTE
     LEITURA — visualização e análise, sem intervenção direta (o plugin
     de auth barra qualquer escrita deste perfil).
   - gestor (gestor escolar): mesmo escopo por escolas do supervisor;
     a única escrita prevista é a validação do planejamento docente.
   - professor: escopo é por profId (tratado nas próprias rotas).
   ============================================================ */

/** Todos os perfis válidos de usuário (chave gravada em Usuario.perfil). */
export const PERFIS = ['secretaria', 'supervisor', 'gestor', 'professor', 'admin'];

/** Perfis escopados por escolas vinculadas (Usuario.escolaIds). */
export const PERFIS_ESCOLARES = ['supervisor', 'gestor'];

/** O perfil é escopado por escolas (supervisor ou gestor escolar)? */
export const perfilEscolar = perfil => PERFIS_ESCOLARES.includes(perfil);

/**
 * Lista de escolas a que um supervisor ou gestor escolar está restrito.
 * (O nome histórico foi mantido para não espalhar a mudança pelas rotas.)
 * @returns {string[] | null} array de escolaIds para supervisor/gestor;
 *   null quando o perfil tem alcance de rede ou não usa filtro por escola.
 */
export function gestorEscolas(user) {
  if (perfilEscolar(user?.perfil)) {
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
 * Turmas (com a escola) em que cada professor leciona — Professor.turmaIds.
 * @param {string[]} [profIds]  sem a lista, todos os professores
 * @returns {Promise<Map<string, {id:string, nome:string, ano:number, escolaId:string, escolaNome:string}[]>>}
 *   profId → turmas (só professores existentes entram no mapa)
 */
export async function turmasDosProfessores(prisma, profIds) {
  const profs = await prisma.professor.findMany({
    where: profIds ? { id: { in: profIds } } : undefined,
    select: { id: true, turmaIds: true },
  });
  const idsPorProf = profs.map(pr => {
    let ids = [];
    try { ids = JSON.parse(pr.turmaIds || '[]'); } catch { ids = []; }
    return [pr.id, Array.isArray(ids) ? ids : []];
  });
  const todas = [...new Set(idsPorProf.flatMap(([, ids]) => ids))];
  const turmas = todas.length
    ? await prisma.turma.findMany({
      where: { id: { in: todas } },
      select: { id: true, nome: true, ano: true, escolaId: true, escola: { select: { nome: true } } },
    })
    : [];
  const porId = new Map(turmas.map(t => [t.id, { id: t.id, nome: t.nome, ano: t.ano, escolaId: t.escolaId, escolaNome: t.escola.nome }]));
  return new Map(idsPorProf.map(([pid, ids]) => [pid, ids.map(i => porId.get(i)).filter(Boolean)]));
}

/** O professor leciona em alguma das escolas informadas? */
export const professorNasEscolas = (turmas, escolaIds) =>
  (turmas || []).some(t => (escolaIds || []).includes(t.escolaId));

/**
 * Dos professores informados, os que lecionam em alguma das escolas.
 * @param {string[]} profIds
 * @param {string[]} escolaIds
 * @returns {Promise<Set<string>>}
 */
export async function professoresNasEscolas(prisma, profIds, escolaIds) {
  const unicos = [...new Set((profIds || []).filter(Boolean))];
  if (!unicos.length || !escolaIds?.length) return new Set();
  const turmasPorProf = await turmasDosProfessores(prisma, unicos);
  return new Set([...turmasPorProf]
    .filter(([, turmas]) => professorNasEscolas(turmas, escolaIds))
    .map(([id]) => id));
}

/**
 * Filtro por professor do conteúdo de um planejamento (semanas e validações),
 * conforme o perfil:
 *   - professor: só os próprios registros;
 *   - supervisor / gestor escolar: só professores com turma nas escolas vinculadas;
 *   - secretaria / admin: tudo (rede).
 * @param {{perfil:string, profId?:string|null, escolaIds?:string[]}} user
 * @param {string[]} profIds  professores presentes no conteúdo a filtrar
 * @returns {Promise<(profId: string) => boolean>}
 */
export async function filtroProfessoresDoUsuario(prisma, user, profIds) {
  if (user?.perfil === 'professor') {
    const proprio = user.profId || null;
    return profId => proprio !== null && profId === proprio;
  }
  const escolas = gestorEscolas(user);
  if (!escolas) return () => true;
  const visiveis = await professoresNasEscolas(prisma, profIds, escolas);
  return profId => visiveis.has(profId);
}

/**
 * Aluno visível ao usuário? supervisor/gestor escolar: turma numa das escolas
 * vinculadas; professor: turma em que leciona; secretaria/admin: rede toda.
 * @param {{turmaId:string, turma:{escolaId:string}}} aluno
 * @returns {Promise<{ok:true} | {ok:false, mensagem:string}>}
 */
export async function alunoNoEscopo(prisma, user, aluno) {
  const escolas = gestorEscolas(user);
  if (escolas && !escolas.includes(aluno.turma.escolaId)) {
    return { ok: false, mensagem: 'Aluno fora do seu grupo de escolas.' };
  }
  if (user?.perfil === 'professor') {
    const ctx = await contextoProfessor(prisma, user.profId);
    if (!ctx.turmaIds.includes(aluno.turmaId)) {
      return { ok: false, mensagem: 'Aluno fora das turmas em que você leciona.' };
    }
  }
  return { ok: true };
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
