/* ============================================================
   GET /timeline — eventos filtrados, mais recentes primeiro.
   Shape espelha DATA.TIMELINE: { data, tipo, hab, texto }.
   Eventos de turmas INEXISTENTES (turma fictícia do protótipo, ou
   turma que sumiu do SAG) ou OCULTAS (excluídas no SAG —
   lib/ativos.js) nunca aparecem; evento sem turma só aparece sem
   filtro de turma e fora dos escopos escolar e de professor.
   Escopo (mesma regra de /alunos e /dashboard/evolucao):
     · professor: só as turmas em que leciona; ?turma de outra turma
       ou ?prof de outro professor → 403;
     · supervisor/gestor escolar: só as turmas das escolas vinculadas;
       ?turma fora delas (ou inexistente) → [] (nunca o escopo todo);
     · admin/secretaria: rede toda; ?turma inexistente/oculta → [].
   ============================================================ */
import { fmtBR } from '../lib/datas.js';
import { gestorEscolas, contextoProfessor } from '../lib/escopo.js';
import { soTurmasVisiveis, turmasVisiveisEntre } from '../lib/ativos.js';

/**
 * Turmas existentes e visíveis entre as referenciadas pela timeline —
 * consulta só os ids usados nos eventos (não a rede inteira).
 * @returns {Promise<string[]>}
 */
export async function turmasValidasDaTimeline(prisma) {
  const usadas = await prisma.timelineEvent.findMany({
    where: { turmaId: { not: null } },
    distinct: ['turmaId'],
    select: { turmaId: true },
  });
  return turmasVisiveisEntre(prisma, usadas.map(e => e.turmaId));
}

/**
 * Recorte de turmas pedido × escopo do usuário.
 * @returns {Promise<{ turmaIn?: string[], proibido?: string }>}
 *   turmaIn undefined = sem recorte de turma (rede)
 */
async function recorteDeTurmas(prisma, user, { turma, prof }) {
  if (user.perfil === 'professor') {
    if (prof && prof !== user.profId) return { proibido: 'Você só acompanha os registros das suas turmas.' };
    const { turmaIds } = await contextoProfessor(prisma, user.profId);
    if (turma && !turmaIds.includes(turma)) return { proibido: 'Turma fora das turmas em que você leciona.' };
    return { turmaIn: turma ? [turma] : turmaIds };
  }
  const escopo = gestorEscolas(user);
  if (escopo) {
    const turmas = await prisma.turma.findMany({ where: soTurmasVisiveis({ escolaId: { in: escopo } }), select: { id: true } });
    const ids = turmas.map(t => t.id);
    // ?turma fora do escopo (ou inexistente): vazio — nunca cai no escopo inteiro
    return { turmaIn: turma ? ids.filter(id => id === turma) : ids };
  }
  return { turmaIn: turma ? [turma] : undefined };
}

export default async function timelineRoutes(fastify) {
  const p = fastify.prisma;

  fastify.get('/timeline', {
    preHandler: [fastify.authenticate],
    schema: {
      querystring: {
        type: 'object',
        properties: {
          limit: { type: 'integer', default: 30 },
          prof: { type: 'string' },
          turma: { type: 'string' },
          // sem 'leitura': o nível de leitura foi retirado da plataforma
          tipo: { type: 'string', enum: ['avaliacao', 'atividade'] },
        },
      },
    },
  }, async (request, reply) => {
    const { limit, prof, turma, tipo } = request.query;

    const { turmaIn, proibido } = await recorteDeTurmas(p, request.user, { turma, prof });
    if (proibido) return reply.forbidden(proibido);

    // só turmas que existem e estão visíveis; sem recorte de turma, eventos sem turma continuam
    const validas = new Set(await turmasValidasDaTimeline(p));
    const filtroTurma = turmaIn
      ? { turmaId: { in: turmaIn.filter(id => validas.has(id)) } }
      : { OR: [{ turmaId: null }, { turmaId: { in: [...validas] } }] };

    const rows = await p.timelineEvent.findMany({
      where: {
        ...(prof ? { profId: prof } : {}),
        ...filtroTurma,
        ...(tipo ? { tipo } : {}),
      },
      orderBy: { data: 'desc' },
      take: limit,
    });
    return rows.map(e => ({
      data: fmtBR(e.data), tipo: e.tipo, hab: e.habCod, texto: e.texto,
      prof: e.profId, turma: e.turmaId,
    }));
  });
}
