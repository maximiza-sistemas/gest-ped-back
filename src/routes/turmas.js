/* ============================================================
   Turmas — listagem e detalhe completo.
   Shape de /turmas/:id/full espelha DATA.turmaFull().
   ============================================================ */
import { distFromAlunos } from '../lib/agregacoes.js';
import { fmtBR } from '../lib/datas.js';
import { gestorEscolas } from '../lib/escopo.js';

export default async function turmasRoutes(fastify) {
  const p = fastify.prisma;

  // ---------- GET /turmas?escola=&ano= ----------
  fastify.get('/turmas', {
    preHandler: [fastify.authenticate],
    schema: {
      querystring: {
        type: 'object',
        properties: { escola: { type: 'string' }, ano: { type: 'integer' } },
      },
    },
  }, async request => {
    const { escola, ano } = request.query;
    const escopo = gestorEscolas(request.user); // null p/ não-gestor
    // gestor: intersecta o filtro pedido com seu grupo; não-gestor: filtro livre
    let escolaFilter;
    if (escopo) escolaFilter = escola && escopo.includes(escola) ? [escola] : escopo;
    else if (escola) escolaFilter = [escola];

    const turmas = await p.turma.findMany({
      where: { ...(escolaFilter ? { escolaId: { in: escolaFilter } } : {}), ...(ano ? { ano } : {}) },
      include: { escola: true, alunos: { select: { nivelLeitura: true } } },
      orderBy: [{ escolaId: 'asc' }, { ano: 'asc' }, { nome: 'asc' }],
    });
    return turmas.map(t => ({
      id: t.id, escola: t.escolaId, escolaNome: t.escola.nome, escolaSigla: t.escola.sigla,
      escolaCor: t.escola.cor, ano: t.ano, nome: t.nome, turno: t.turno,
      totAlunos: t.alunos.length, dist: distFromAlunos(t.alunos),
    }));
  });

  // ---------- GET /turmas/:id/full ----------
  fastify.get('/turmas/:id/full', { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const t = await p.turma.findUnique({
      where: { id: request.params.id },
      include: {
        escola: true,
        alunos: { orderBy: { numero: 'asc' }, include: { leituras: { orderBy: { data: 'asc' } } } },
      },
    });
    if (!t) return reply.notFound('Turma não encontrada.');

    const escopo = gestorEscolas(request.user);
    if (escopo && !escopo.includes(t.escolaId)) {
      return reply.forbidden('Turma fora do seu grupo de escolas.');
    }
    return {
      id: t.id, escola: t.escolaId, ano: t.ano, nome: t.nome, turno: t.turno,
      escolaNome: t.escola.nome, escolaCor: t.escola.cor,
      alunos: t.alunos.map(a => ({
        id: a.id, nome: a.nome, numero: a.numero, iniciais: a.iniciais,
        nivelLeitura: a.nivelLeitura, ano: t.ano, turma: t.id,
        histNivel: a.leituras.map(l => ({ data: fmtBR(l.data), nivel: l.nivel })),
      })),
      dist: distFromAlunos(t.alunos),
      totAlunos: t.alunos.length,
    };
  });
}
