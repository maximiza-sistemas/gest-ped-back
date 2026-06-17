/* ============================================================
   Montagem do app Fastify — plugins, rotas, erros.
   ============================================================ */
import Fastify from 'fastify';
import cors from '@fastify/cors';
import sensible from '@fastify/sensible';
import prismaPlugin from './plugins/prisma.js';
import authPlugin from './plugins/auth.js';

import authRoutes from './routes/auth.js';
import metaRoutes from './routes/meta.js';
import planejamentosRoutes from './routes/planejamentos.js';
import avaliacoesRoutes from './routes/avaliacoes.js';
import alunosRoutes from './routes/alunos.js';
import turmasRoutes from './routes/turmas.js';
import escolasRoutes from './routes/escolas.js';
import gruposRoutes from './routes/grupos.js';
import anosRoutes from './routes/anos.js';
import redeRoutes from './routes/rede.js';
import dashboardRoutes from './routes/dashboard.js';
import timelineRoutes from './routes/timeline.js';
import adminRoutes from './routes/admin.js';

export async function buildApp(opts = {}) {
  const app = Fastify({ logger: opts.logger ?? true });

  // CORS: em produção restrinja via CORS_ORIGIN (lista separada por vírgula);
  // sem a variável, libera todas as origens (conveniente em desenvolvimento).
  const corsOrigin = process.env.CORS_ORIGIN
    ? process.env.CORS_ORIGIN.split(',').map(s => s.trim())
    : true;
  await app.register(cors, { origin: corsOrigin });
  await app.register(sensible);
  await app.register(prismaPlugin);
  await app.register(authPlugin);

  app.setErrorHandler((err, request, reply) => {
    const status = err.statusCode || 500;
    if (status >= 500) request.log.error(err);
    reply.code(status).send({
      error: {
        message: status >= 500 ? 'Erro interno do servidor.' : err.message,
        statusCode: status,
      },
    });
  });

  await app.register(async api => {
    await api.register(authRoutes);
    await api.register(metaRoutes);
    await api.register(planejamentosRoutes);
    await api.register(avaliacoesRoutes);
    await api.register(alunosRoutes);
    await api.register(turmasRoutes);
    await api.register(escolasRoutes);
    await api.register(gruposRoutes);
    await api.register(anosRoutes);
    await api.register(redeRoutes);
    await api.register(dashboardRoutes);
    await api.register(timelineRoutes);
    await api.register(adminRoutes);
  }, { prefix: '/api' });

  app.get('/health', async () => ({ ok: true }));

  return app;
}
