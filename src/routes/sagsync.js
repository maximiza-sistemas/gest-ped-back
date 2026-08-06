/* ============================================================
   Espelho do SAG — gatilho manual e status (admin/secretaria).
   A sincronização automática é agendada no server.js.
   ============================================================ */
import { sincronizarSag, sagConfigurado, ultimoRelatorio } from '../lib/sagsync.js';

export default async function sagSyncRoutes(fastify) {
  const admin = [fastify.authenticate, fastify.requirePerfil('admin')]; // secretaria também passa (superusuário)

  // dispara uma sincronização agora e devolve o relatório
  fastify.post('/admin/sag-sync', { preHandler: admin }, async (request, reply) => {
    const rel = await sincronizarSag(fastify.prisma);
    if (!rel.ok && rel.motivo) return reply.badRequest(rel.motivo);
    return rel;
  });

  fastify.get('/admin/sag-sync/status', { preHandler: admin }, async () => ({
    configurado: sagConfigurado(),
    intervaloMin: Number(process.env.SAG_SYNC_INTERVALO_MIN || 30),
    ultimo: ultimoRelatorio(),
  }));
}
