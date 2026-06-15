/* ============================================================
   Escolas — shape espelha network.js escolasFull()/escola(id).
   ?detalhe=alunos inclui o roster completo (drill-down admin).
   ============================================================ */
import { shapeEscola } from '../lib/agregacoes.js';

export default async function escolasRoutes(fastify) {
  const p = fastify.prisma;

  // ---------- GET /escolas ---------- (rede inteira: admin/secretaria)
  fastify.get('/escolas', {
    preHandler: [fastify.authenticate, fastify.requirePerfil()],
    schema: {
      querystring: { type: 'object', properties: { detalhe: { type: 'string' } } },
    },
  }, async request => {
    const incluirAlunos = request.query.detalhe === 'alunos';
    const escolas = await p.escola.findMany({
      include: { turmas: { include: { alunos: true }, orderBy: [{ ano: 'asc' }, { nome: 'asc' }] } },
      orderBy: { id: 'asc' },
    });
    return escolas.map(e => shapeEscola(e, e.turmas, { incluirAlunos }));
  });

  // ---------- GET /escolas/:id ---------- (detalhe da rede: admin/secretaria)
  fastify.get('/escolas/:id', { preHandler: [fastify.authenticate, fastify.requirePerfil()] }, async (request, reply) => {
    const e = await p.escola.findUnique({
      where: { id: request.params.id },
      include: { turmas: { include: { alunos: { orderBy: { numero: 'asc' } } }, orderBy: [{ ano: 'asc' }, { nome: 'asc' }] } },
    });
    if (!e) return reply.notFound('Escola não encontrada.');
    return shapeEscola(e, e.turmas, { incluirAlunos: true });
  });
}
