/* ============================================================
   GET /timeline — eventos filtrados, mais recentes primeiro.
   Shape espelha DATA.TIMELINE: { data, tipo, hab, texto }.
   ============================================================ */
import { fmtBR } from '../lib/datas.js';
import { gestorEscolas } from '../lib/escopo.js';

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
          tipo: { type: 'string', enum: ['avaliacao', 'atividade', 'leitura'] },
        },
      },
    },
  }, async request => {
    const { limit, prof, turma, tipo } = request.query;

    // gestor: restringe os eventos às turmas do seu grupo de escolas
    const escopo = gestorEscolas(request.user);
    let turmaIn;
    if (escopo) {
      const turmas = await p.turma.findMany({ where: { escolaId: { in: escopo } }, select: { id: true } });
      const ids = turmas.map(t => t.id);
      turmaIn = turma && ids.includes(turma) ? [turma] : ids;
    } else if (turma) {
      turmaIn = [turma];
    }

    const rows = await p.timelineEvent.findMany({
      where: {
        ...(prof ? { profId: prof } : {}),
        ...(turmaIn ? { turmaId: { in: turmaIn } } : {}),
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
