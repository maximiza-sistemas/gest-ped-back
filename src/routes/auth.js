/* ============================================================
   Rotas de autenticação — login com e-mail/senha, sessão.
   ============================================================ */
import bcrypt from 'bcryptjs';

const parseJSON = (s, fb) => { try { return JSON.parse(s); } catch { return fb; } };

const userPublic = u => ({
  id: u.id, nome: u.nome, perfil: u.perfil, cargo: u.cargo,
  iniciais: u.iniciais, cor: u.cor, profId: u.profId || null,
  escolaIds: parseJSON(u.escolaIds, []),
});

export default async function authRoutes(fastify) {
  fastify.post('/auth/login', {
    schema: {
      body: {
        type: 'object',
        required: ['email', 'senha'],
        properties: {
          email: { type: 'string', minLength: 3 },
          senha: { type: 'string', minLength: 1 },
        },
      },
    },
  }, async (request, reply) => {
    const { email, senha } = request.body;
    const user = await fastify.prisma.usuario.findUnique({ where: { email: email.toLowerCase().trim() } });
    if (!user || !user.ativo || !bcrypt.compareSync(senha, user.senhaHash)) {
      return reply.unauthorized('E-mail ou senha incorretos.');
    }
    const token = fastify.jwt.sign({
      sub: user.id, nome: user.nome, perfil: user.perfil, profId: user.profId || null,
      escolaIds: parseJSON(user.escolaIds, []), // escopo do gestor (grupo de escolas)
    });
    return { token, user: userPublic(user) };
  });

  fastify.get('/auth/me', { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const user = await fastify.prisma.usuario.findUnique({ where: { id: request.user.sub } });
    if (!user || !user.ativo) return reply.unauthorized('Usuário não encontrado ou inativo.');
    return { user: userPublic(user) };
  });
}
