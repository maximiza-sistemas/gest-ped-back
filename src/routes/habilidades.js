/* ============================================================
   Habilidades — escrita no catálogo (apenas admin e secretaria,
   superusuários de rede). A leitura continua no GET /meta.
   ============================================================ */
export default async function habilidadesRoutes(fastify) {
  const p = fastify.prisma;

  const shape = h => ({ cod: h.cod, ...(h.rotulo ? { rotulo: h.rotulo } : {}), matriz: h.matrizId, comp: h.compId, desc: h.desc });

  // ---------- POST /habilidades ----------
  fastify.post('/habilidades', {
    preHandler: [fastify.authenticate, fastify.requirePerfil('secretaria')],
    schema: {
      body: {
        type: 'object',
        required: ['cod', 'matriz', 'comp', 'desc'],
        properties: {
          cod: { type: 'string', minLength: 2, maxLength: 40 },
          rotulo: { type: 'string', maxLength: 40 },
          matriz: { type: 'string' },
          comp: { type: 'string' },
          desc: { type: 'string', minLength: 5 },
        },
      },
    },
  }, async (request, reply) => {
    const { cod, rotulo, matriz, comp, desc } = request.body;
    const [m, c, existe] = await Promise.all([
      p.matriz.findUnique({ where: { id: matriz } }),
      p.componente.findUnique({ where: { id: comp } }),
      p.habilidade.findUnique({ where: { cod: cod.trim() } }),
    ]);
    if (!m) return reply.badRequest('Matriz de referência não existe.');
    if (!c) return reply.badRequest('Componente curricular não existe.');
    if (existe) return reply.conflict('Já existe uma habilidade com este código.');

    const h = await p.habilidade.create({
      data: { cod: cod.trim(), rotulo: (rotulo || '').trim() || null, matrizId: matriz, compId: comp, desc: desc.trim() },
    });
    reply.code(201);
    return shape(h);
  });

  // ---------- DELETE /habilidades/:cod ----------
  fastify.delete('/habilidades/:cod', {
    preHandler: [fastify.authenticate, fastify.requirePerfil('secretaria')],
  }, async (request, reply) => {
    const { cod } = request.params;
    const h = await p.habilidade.findUnique({ where: { cod } });
    if (!h) return reply.notFound('Habilidade não encontrada.');
    const [emPlanos, emTrabalhos, emAval] = await Promise.all([
      p.planejamentoHabilidade.count({ where: { habCod: cod } }),
      p.trabalhoHabilidade.count({ where: { habCod: cod } }),
      p.avaliacao.count({ where: { habCod: cod } }),
    ]);
    if (emPlanos || emTrabalhos || emAval) {
      return reply.badRequest('Habilidade em uso por planejamentos ou avaliações — não pode ser excluída.');
    }
    await p.habilidade.delete({ where: { cod } });
    return { ok: true };
  });
}
