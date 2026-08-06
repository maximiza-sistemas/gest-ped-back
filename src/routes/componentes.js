/* ============================================================
   Componentes curriculares — cadastro (apenas admin e secretaria,
   superusuários de rede). Usados no cadastro de habilidades, nos
   professores e nos planejamentos. Leitura via GET /meta.
   ============================================================ */
export default async function componentesRoutes(fastify) {
  const p = fastify.prisma;
  const gerente = [fastify.authenticate, fastify.requirePerfil('secretaria')]; // admin também passa (superusuário)

  // ---------- POST /componentes ----------
  fastify.post('/componentes', {
    preHandler: gerente,
    schema: {
      body: {
        type: 'object',
        required: ['id', 'nome'],
        properties: {
          id: { type: 'string', pattern: '^[a-z0-9-]{2,20}$' },
          nome: { type: 'string', minLength: 2, maxLength: 60 },
        },
      },
    },
  }, async (request, reply) => {
    const { id, nome } = request.body;
    if (await p.componente.findUnique({ where: { id } })) {
      return reply.conflict('Já existe um componente curricular com este código.');
    }
    const c = await p.componente.create({ data: { id, nome: nome.trim() } });
    reply.code(201);
    return c;
  });

  // ---------- PATCH /componentes/:id ----------
  fastify.patch('/componentes/:id', {
    preHandler: gerente,
    schema: {
      body: {
        type: 'object',
        required: ['nome'],
        properties: { nome: { type: 'string', minLength: 2, maxLength: 60 } },
      },
    },
  }, async (request, reply) => {
    const existe = await p.componente.findUnique({ where: { id: request.params.id } });
    if (!existe) return reply.notFound('Componente curricular não encontrado.');
    return p.componente.update({ where: { id: existe.id }, data: { nome: request.body.nome.trim() } });
  });

  // ---------- DELETE /componentes/:id ----------
  fastify.delete('/componentes/:id', { preHandler: gerente }, async (request, reply) => {
    const { id } = request.params;
    const existe = await p.componente.findUnique({ where: { id } });
    if (!existe) return reply.notFound('Componente curricular não encontrado.');
    const [habs, profs, planos] = await Promise.all([
      p.habilidade.count({ where: { compId: id } }),
      p.professor.count({ where: { compId: id } }),
      p.planejamento.count({ where: { compId: id } }),
    ]);
    if (habs || profs || planos) {
      return reply.badRequest('Componente em uso por habilidades, professores ou planejamentos — não pode ser excluído.');
    }
    await p.componente.delete({ where: { id } });
    return { ok: true };
  });
}
