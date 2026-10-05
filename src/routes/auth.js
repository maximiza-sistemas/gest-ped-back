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

// validade do token quando o usuário pede para manter a sessão (acesso direto na volta)
const SESSAO_LONGA = '30d';
const SESSAO_PADRAO_S = 12 * 3600; // expiresIn padrão do plugin (12h)

// claims de autorização gravados no JWT
const payloadDe = user => ({
  sub: user.id, nome: user.nome, perfil: user.perfil, profId: user.profId || null,
  escolaIds: parseJSON(user.escolaIds, []), // escopo do supervisor / gestor escolar (escolas vinculadas)
});

// o token em uso ainda reflete o perfil/escopo gravado no banco?
const tokenDesatualizado = (claims, atual) =>
  claims.perfil !== atual.perfil
  || (claims.profId || null) !== atual.profId
  || JSON.stringify(claims.escolaIds || []) !== JSON.stringify(atual.escolaIds);

export default async function authRoutes(fastify) {
  fastify.post('/auth/login', {
    schema: {
      body: {
        type: 'object',
        required: ['email', 'senha'],
        properties: {
          email: { type: 'string', minLength: 3 },
          senha: { type: 'string', minLength: 1 },
          lembrar: { type: 'boolean', default: false }, // sessão longa (30d)
        },
      },
    },
  }, async (request, reply) => {
    const { email, senha, lembrar } = request.body;
    const user = await fastify.prisma.usuario.findUnique({ where: { email: email.toLowerCase().trim() } });
    if (!user || !user.ativo || !bcrypt.compareSync(senha, user.senhaHash)) {
      return reply.unauthorized('E-mail ou senha incorretos.');
    }
    const payload = payloadDe(user);
    const token = lembrar
      ? fastify.jwt.sign(payload, { expiresIn: SESSAO_LONGA })
      : fastify.jwt.sign(payload); // padrão do plugin (12h)
    return { token, user: userPublic(user) };
  });

  // Sessão atual. Se o perfil/escopo mudou no banco depois do login (ex.: a
  // migração gestor → supervisor, ou o admin trocou as escolas), devolve
  // também um token novo com os claims atuais — o front o adota ao restaurar
  // a sessão, sem exigir novo login. A validade (12h ou 30d) é preservada.
  // (A autorização já usa o banco em fastify.authenticate; o token novo só
  // mantém os claims do cliente coerentes.) Compara com os claims ORIGINAIS
  // do token (request.tokenClaims): request.user já vem atualizado do banco.
  fastify.get('/auth/me', { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const user = await fastify.prisma.usuario.findUnique({ where: { id: request.user.sub } });
    if (!user || !user.ativo) return reply.unauthorized('Usuário não encontrado ou inativo.');
    const atual = payloadDe(user);
    const claims = request.tokenClaims || request.user;
    if (!tokenDesatualizado(claims, atual)) return { user: userPublic(user) };
    const { iat, exp } = claims;
    const sessaoLonga = iat && exp && (exp - iat) > SESSAO_PADRAO_S;
    const token = sessaoLonga
      ? fastify.jwt.sign(atual, { expiresIn: SESSAO_LONGA })
      : fastify.jwt.sign(atual);
    return { user: userPublic(user), token };
  });
}
