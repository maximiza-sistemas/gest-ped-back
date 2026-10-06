/* ============================================================
   Dashboards — agregados prontos por perfil.
   Sem nível de leitura (retirado da plataforma): as turmas trazem
   só a contagem de alunos. O progresso dos planejamentos é
   derivado da verificação contínua (lib/acompanhamento.js) nas
   turmas do recorte — não há status nem próxima atividade manuais.
   Só escolas/turmas/alunos VISÍVEIS (excluídos no SAG ficam fora —
   lib/ativos.js), inclusive nas contagens de alunos e avaliações.
   ============================================================ */
import { fmtBR } from '../lib/datas.js';
import { progressoPlano } from '../lib/agregacoes.js';
import { gestorEscolas, turmasDoUsuario } from '../lib/escopo.js';
import { carregarAcompanhamento, trabalhoDoPlano } from '../lib/acompanhamento.js';
import { soEscolasVisiveis, soTurmasVisiveis, soAvaliacoesVisiveis, alunosVisiveisDaTurma } from '../lib/ativos.js';

// progresso derivado de cada plano nas turmas informadas
const progressoDerivado = async (prisma, planos, turmaIds) => {
  const acompanhamento = await carregarAcompanhamento(prisma, { planejamentoIds: planos.map(pl => pl.id), turmaIds });
  return new Map(planos.map(pl => [pl.id, progressoPlano(Object.values(trabalhoDoPlano(pl, acompanhamento)))]));
};

export default async function dashboardRoutes(fastify) {
  const p = fastify.prisma;

  // ---------- GET /dashboard/gestor?periodo=&escola= ---------- (legado; leitura)
  // supervisor e gestor escolar: restritos às escolas vinculadas
  fastify.get('/dashboard/gestor', {
    preHandler: [fastify.authenticate, fastify.requirePerfil('supervisor', 'gestor')],
    schema: {
      querystring: {
        type: 'object',
        properties: { periodo: { type: 'string' }, escola: { type: 'string' } },
      },
    },
  }, async request => {
    const { periodo } = request.query;
    // supervisor/gestor: restrito às suas escolas (default = a 1ª); demais: escola pedida ou e1
    const escopo = gestorEscolas(request.user);
    let escola = request.query.escola;
    if (escopo) escola = (escola && escopo.includes(escola)) ? escola : (escopo[0] || '__none__');
    else escola = escola || (await p.escola.findFirst({ where: soEscolasVisiveis(), orderBy: { id: 'asc' } }))?.id || '__none__';

    const [planos, turmas] = await Promise.all([
      p.planejamento.findMany({
        where: { ...(periodo ? { periodoId: periodo } : {}), turma: { escolaId: escola } },
        include: { habilidades: true },
      }),
      p.turma.findMany({
        where: soTurmasVisiveis({ escolaId: escola }),
        include: { _count: { select: { alunos: alunosVisiveisDaTurma() } } },
        orderBy: [{ ano: 'asc' }, { nome: 'asc' }],
      }),
    ]);
    // timeline só das turmas (existentes) da escola — nada de turma fictícia ou de outra escola
    const timeline = await p.timelineEvent.findMany({
      where: { turmaId: { in: turmas.map(t => t.id) } },
      orderBy: { data: 'desc' },
      take: 8,
    });

    const totAvaliacoes = await p.avaliacao.count({
      where: soAvaliacoesVisiveis({ aluno: { turma: { escolaId: escola } } }),
    });

    const habilidadesDirecionadas = new Set(planos.flatMap(pl => pl.habilidades.map(h => h.habCod))).size;
    const progresso = await progressoDerivado(p, planos, turmas.map(t => t.id));

    return {
      stats: {
        alunos: turmas.reduce((s, t) => s + t._count.alunos, 0),
        turmas: turmas.length,
        planejamentosAtivos: planos.filter(pl => pl.status === 'ativo').length,
        habilidadesDirecionadas,
        avaliacoes: totAvaliacoes,
      },
      turmas: turmas.map(t => ({ id: t.id, nome: t.nome, ano: t.ano, totAlunos: t._count.alunos })),
      planejamentos: planos.map(pl => ({
        id: pl.id, titulo: pl.titulo, comp: pl.compId, turma: pl.turmaId, prof: pl.profId,
        status: pl.status, progresso: progresso.get(pl.id),
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
      include: { habilidades: true, turma: { include: { _count: { select: { alunos: alunosVisiveisDaTurma() } } } } },
      orderBy: { criadoEm: 'asc' },
    });
    const progresso = await progressoDerivado(p, planos, await turmasDoUsuario(p, request.user));

    return {
      planejamentos: planos.map(pl => ({
        id: pl.id, titulo: pl.titulo, comp: pl.compId, turma: pl.turmaId, periodo: pl.periodoId,
        progresso: progresso.get(pl.id),
        // turma legada do plano excluída no SAG: oculta (sem alunos)
        totAlunos: pl.turma && !pl.turma.excluidoNoSag ? pl.turma._count.alunos : 0,
      })),
    };
  });
}
