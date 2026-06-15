/* ============================================================
   Grupos de escolas (polos) — camada organizacional gerida por
   admin/secretaria. Independente do escopo do gestor.

   Todas as rotas exigem perfil de rede (admin/secretaria) via
   requirePerfil() sem argumentos.
   ============================================================ */

const escolaPublic = e => ({
  id: e.id, nome: e.nome, sigla: e.sigla, zona: e.zona, cor: e.cor, grupoId: e.grupoId || null,
});

const grupoPublic = g => ({
  id: g.id, nome: g.nome, cor: g.cor,
  escolas: (g.escolas || []).map(escolaPublic),
});

export default async function gruposRoutes(fastify) {
  const p = fastify.prisma;
  const rede = [fastify.authenticate, fastify.requirePerfil()]; // admin/secretaria

  // ---------- GET /grupos ----------
  // Grupos com suas escolas + as escolas ainda sem grupo.
  fastify.get('/grupos', { preHandler: rede }, async () => {
    const [grupos, semGrupo] = await Promise.all([
      p.grupoEscola.findMany({
        include: { escolas: { orderBy: { nome: 'asc' } } },
        orderBy: { nome: 'asc' },
      }),
      p.escola.findMany({ where: { grupoId: null }, orderBy: { nome: 'asc' } }),
    ]);
    return { grupos: grupos.map(grupoPublic), semGrupo: semGrupo.map(escolaPublic) };
  });

  // ---------- POST /grupos ----------
  fastify.post('/grupos', {
    preHandler: rede,
    schema: {
      body: {
        type: 'object',
        required: ['nome'],
        properties: {
          nome: { type: 'string', minLength: 2 },
          cor: { type: 'string', default: '#2563eb' },
        },
      },
    },
  }, async (request, reply) => {
    const { nome, cor } = request.body;
    const grupo = await p.grupoEscola.create({
      data: { nome: nome.trim(), cor: cor || '#2563eb', criadoPorId: request.user.sub },
      include: { escolas: true },
    });
    reply.code(201);
    return grupoPublic(grupo);
  });

  // ---------- PATCH /grupos/:id ---------- (renomear / recolorir)
  fastify.patch('/grupos/:id', {
    preHandler: rede,
    schema: {
      body: {
        type: 'object',
        properties: { nome: { type: 'string', minLength: 2 }, cor: { type: 'string' } },
      },
    },
  }, async (request, reply) => {
    const { nome, cor } = request.body;
    const grupo = await p.grupoEscola.update({
      where: { id: request.params.id },
      data: {
        ...(nome !== undefined ? { nome: nome.trim() } : {}),
        ...(cor !== undefined ? { cor } : {}),
      },
      include: { escolas: { orderBy: { nome: 'asc' } } },
    }).catch(() => null);
    if (!grupo) return reply.notFound('Grupo não encontrado.');
    return grupoPublic(grupo);
  });

  // ---------- DELETE /grupos/:id ---------- (escolas voltam a ficar sem grupo)
  fastify.delete('/grupos/:id', { preHandler: rede }, async request => {
    await p.grupoEscola.delete({ where: { id: request.params.id } }).catch(() => null);
    return { ok: true };
  });

  // ---------- PATCH /grupos/escola/:escolaId ---------- (remanejar)
  // body: { grupoId: string | null } — move a escola para o grupo (ou a remove).
  fastify.patch('/grupos/escola/:escolaId', {
    preHandler: rede,
    schema: {
      body: {
        type: 'object',
        required: ['grupoId'],
        properties: { grupoId: { type: ['string', 'null'] } },
      },
    },
  }, async (request, reply) => {
    const { escolaId } = request.params;
    const { grupoId } = request.body;

    if (grupoId) {
      const grupo = await p.grupoEscola.findUnique({ where: { id: grupoId } });
      if (!grupo) return reply.badRequest('Grupo de destino não existe.');
    }
    const escola = await p.escola.update({
      where: { id: escolaId },
      data: { grupoId: grupoId || null },
    }).catch(() => null);
    if (!escola) return reply.notFound('Escola não encontrada.');
    return escolaPublic(escola);
  });
}
