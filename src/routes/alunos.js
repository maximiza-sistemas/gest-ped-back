/* ============================================================
   Alunos — listagem com filtros e ficha completa.
   Shape de /alunos/:id/full espelha DATA.alunoFull() + histNivel.
   ============================================================ */
import { fmtBR } from '../lib/datas.js';
import { gestorEscolas } from '../lib/escopo.js';

export default async function alunosRoutes(fastify) {
  const p = fastify.prisma;

  // ---------- GET /alunos?escola=&nivel=&busca=&limit= ----------
  fastify.get('/alunos', {
    preHandler: [fastify.authenticate],
    schema: {
      querystring: {
        type: 'object',
        properties: {
          escola: { type: 'string' }, turma: { type: 'string' },
          nivel: { type: 'integer' }, busca: { type: 'string' },
          limit: { type: 'integer', default: 50 }, offset: { type: 'integer', default: 0 },
        },
      },
    },
  }, async request => {
    const { escola, turma, nivel, busca, limit, offset } = request.query;
    const escopo = gestorEscolas(request.user); // null p/ não-gestor
    let escolaIn;
    if (escopo) escolaIn = escola && escopo.includes(escola) ? [escola] : escopo;
    else if (escola) escolaIn = [escola];

    const where = {
      ...(turma ? { turmaId: turma } : {}),
      ...(escolaIn ? { turma: { escolaId: { in: escolaIn } } } : {}),
      ...(nivel ? { nivelLeitura: nivel } : {}),
      ...(busca ? { nome: { contains: busca } } : {}),
    };
    const [total, rows] = await Promise.all([
      p.aluno.count({ where }),
      p.aluno.findMany({
        where,
        include: { turma: { include: { escola: true } }, leituras: { orderBy: { data: 'desc' }, take: 1 } },
        orderBy: [{ turmaId: 'asc' }, { numero: 'asc' }],
        take: limit, skip: offset,
      }),
    ]);
    return {
      total,
      alunos: rows.map(a => ({
        id: a.id, nome: a.nome, numero: a.numero, iniciais: a.iniciais,
        nivelLeitura: a.nivelLeitura, ano: a.turma.ano, turma: a.turmaId,
        turmaNome: a.turma.nome, turno: a.turma.turno,
        escola: a.turma.escolaId, escolaNome: a.turma.escola.nome, escolaCor: a.turma.escola.cor,
        ultimaAplicacao: a.leituras[0] ? fmtBR(a.leituras[0].data) : null,
      })),
    };
  });

  // ---------- GET /alunos/:id/full ----------
  fastify.get('/alunos/:id/full', { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const a = await p.aluno.findUnique({
      where: { id: request.params.id },
      include: {
        turma: { include: { escola: true } },
        leituras: { orderBy: { data: 'asc' } },
      },
    });
    if (!a) return reply.notFound('Aluno não encontrado.');

    const escopo = gestorEscolas(request.user);
    if (escopo && !escopo.includes(a.turma.escolaId)) {
      return reply.forbidden('Aluno fora do seu grupo de escolas.');
    }
    return {
      id: a.id, nome: a.nome, numero: a.numero, iniciais: a.iniciais,
      nivelLeitura: a.nivelLeitura, ano: a.turma.ano, turma: a.turmaId,
      escola: a.turma.escolaId, escolaNome: a.turma.escola.nome,
      turmaNome: a.turma.nome, turno: a.turma.turno,
      histNivel: a.leituras.map(l => ({ data: fmtBR(l.data), nivel: l.nivel })),
    };
  });
}
