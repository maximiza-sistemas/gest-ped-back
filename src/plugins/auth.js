/* ============================================================
   Plugin de autenticação — JWT + autorização por perfil.
   Token payload: { sub, nome, perfil, profId }
   ============================================================ */
import fp from 'fastify-plugin';
import jwt from '@fastify/jwt';

export default fp(async fastify => {
  await fastify.register(jwt, {
    secret: process.env.JWT_SECRET,
    sign: { expiresIn: '12h' },
  });

  // preHandler: exige token válido; popula request.user
  fastify.decorate('authenticate', async (request, reply) => {
    try {
      await request.jwtVerify();
    } catch {
      return reply.unauthorized('Sessão inválida ou expirada. Faça login novamente.');
    }
  });

  // factory de preHandler: exige um dos perfis.
  // admin e secretaria são superusuários (mesmas atribuições) e sempre passam.
  fastify.decorate('requirePerfil', (...perfis) => async (request, reply) => {
    const p = request.user?.perfil;
    if (p === 'admin' || p === 'secretaria' || perfis.includes(p)) return;
    return reply.forbidden('Seu perfil não tem acesso a esta operação.');
  });
}, { name: 'auth', dependencies: [] });
