/* ============================================================
   Dashboards — agregados prontos por perfil.
   ============================================================ */
import { fmtBR } from '../lib/datas.js';
import { distFromAlunos, progressoPlano } from '../lib/agregacoes.js';
import { gestorEscolas } from '../lib/escopo.js';

export default async function dashboardRoutes(fastify) {
  const p = fastify.prisma;

  // ---------- GET /dashboard/gestor?periodo=&escola= ----------
  fastify.get('/dashboard/gestor', {
    preHandler: [fastify.authenticate, fastify.requirePerfil('gestor')],
    schema: {
      querystring: {
        type: 'object',
        properties: { periodo: { type: 'string' }, escola: { type: 'string' } },
      },
    },
  }, async request => {
    const { periodo } = request.query;
    // gestor: restrito ao grupo (default = 1ª escola do grupo); demais: escola pedida ou e1
    const escopo = gestorEscolas(request.user);
    let escola = request.query.escola;
    if (escopo) escola = (escola && escopo.includes(escola)) ? escola : (escopo[0] || '__none__');
    else escola = escola || 'e1';

    const [planos, turmas, timeline] = await Promise.all([
      p.planejamento.findMany({
        where: { ...(periodo ? { periodoId: periodo } : {}), turma: { escolaId: escola } },
        include: { habilidades: true, trabalhos: { select: { status: true } } },
      }),
      p.turma.findMany({
        where: { escolaId: escola },
        include: { alunos: { select: { nivelLeitura: true } } },
        orderBy: [{ ano: 'asc' }, { nome: 'asc' }],
      }),
      p.timelineEvent.findMany({ orderBy: { data: 'desc' }, take: 8 }),
    ]);

    const totAvaliacoes = await p.avaliacao.count({
      where: { aluno: { turma: { escolaId: escola } } },
    });

    const habilidadesDirecionadas = new Set(planos.flatMap(pl => pl.habilidades.map(h => h.habCod))).size;

    return {
      stats: {
        alunos: turmas.reduce((s, t) => s + t.alunos.length, 0),
        turmas: turmas.length,
        planejamentosAtivos: planos.filter(pl => pl.status === 'ativo').length,
        habilidadesDirecionadas,
        avaliacoes: totAvaliacoes,
      },
      distPorTurma: turmas.map(t => ({
        id: t.id, nome: t.nome, ano: t.ano, totAlunos: t.alunos.length,
        dist: distFromAlunos(t.alunos),
      })),
      planejamentos: planos.map(pl => ({
        id: pl.id, titulo: pl.titulo, comp: pl.compId, turma: pl.turmaId, prof: pl.profId,
        status: pl.status, progresso: progressoPlano(pl.trabalhos),
      })),
      timeline: timeline.map(e => ({ data: fmtBR(e.data), tipo: e.tipo, hab: e.habCod, texto: e.texto })),
    };
  });

  // ---------- GET /dashboard/professor ----------
  fastify.get('/dashboard/professor', {
    preHandler: [fastify.authenticate, fastify.requirePerfil('professor')],
  }, async (request, reply) => {
    const profId = request.user.profId;
    if (!profId) return reply.badRequest('Usuário não está vinculado a um professor.');

    const planos = await p.planejamento.findMany({
      where: { profId, status: 'ativo' },
      include: { habilidades: true, trabalhos: true, turma: { include: { alunos: { select: { nivelLeitura: true } } } } },
      orderBy: { criadoEm: 'asc' },
    });

    return {
      planejamentos: planos.map(pl => ({
        id: pl.id, titulo: pl.titulo, comp: pl.compId, turma: pl.turmaId, periodo: pl.periodoId,
        progresso: progressoPlano(pl.trabalhos),
        distTurma: distFromAlunos(pl.turma.alunos),
        totAlunos: pl.turma.alunos.length,
        proximas: pl.trabalhos.filter(t => t.proxima).map(t => ({ hab: t.habCod, proxima: t.proxima })),
      })),
    };
  });
}
