/* ============================================================
   Plugin de autenticação — JWT + autorização por perfil.
   Token payload: { sub, nome, perfil, profId, escolaIds }

   O token só IDENTIFICA o usuário (sub). Perfil, escolas, vínculo
   de professor e situação (ativo) são relidos do banco a cada
   requisição autenticada: uma troca de perfil (ex.: a migração
   gestor → supervisor), de escolas ou uma desativação feita pelo
   admin vale na hora, sem esperar o token expirar (até 30 dias com
   "Manter conectado").
   ============================================================ */
import fp from 'fastify-plugin';
import jwt from '@fastify/jwt';

// Perfis somente leitura: visualização e análise, sem intervenção direta.
const PERFIS_SOMENTE_LEITURA = new Set(['supervisor']);
const METODOS_LEITURA = new Set(['GET', 'HEAD', 'OPTIONS']);

const parseEscolaIds = s => {
  try {
    const v = JSON.parse(s || '[]');
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
};

export default fp(async fastify => {
  await fastify.register(jwt, {
    secret: process.env.JWT_SECRET,
    sign: { expiresIn: '12h' },
  });

  // claims exatamente como vieram no token (antes de serem trocados pelos do
  // banco) — o /auth/me compara com o banco para decidir se reemite o token
  fastify.decorateRequest('tokenClaims', null);

  // preHandler: exige token válido de usuário existente e ativo; popula
  // request.user com os claims de autorização ATUAIS do banco.
  // Defesa em profundidade: perfis somente leitura (supervisor) são barrados
  // em QUALQUER método de escrita, mesmo que uma rota futura esqueça de
  // restringir o perfil no requirePerfil(). O login (POST /auth/login) não
  // passa por aqui.
  fastify.decorate('authenticate', async (request, reply) => {
    try {
      await request.jwtVerify();
    } catch {
      return reply.unauthorized('Sessão inválida ou expirada. Faça login novamente.');
    }
    const claims = request.user;
    const atual = claims?.sub
      ? await fastify.prisma.usuario.findUnique({
        where: { id: claims.sub },
        select: { nome: true, perfil: true, ativo: true, escolaIds: true, profId: true },
      })
      : null;
    if (!atual || !atual.ativo) {
      return reply.unauthorized('Usuário não encontrado ou inativo. Faça login novamente.');
    }
    request.tokenClaims = claims;
    request.user = {
      ...claims,
      nome: atual.nome,
      perfil: atual.perfil,
      profId: atual.profId || null,
      escolaIds: parseEscolaIds(atual.escolaIds),
    };
    if (PERFIS_SOMENTE_LEITURA.has(request.user.perfil) && !METODOS_LEITURA.has(request.method)) {
      return reply.forbidden('O perfil Supervisor é somente de visualização e análise.');
    }
  });

  // factory de preHandler: exige um dos perfis.
  // admin e secretaria são superusuários (mesmas atribuições) e sempre passam.
  fastify.decorate('requirePerfil', (...perfis) => async (request, reply) => {
    const p = request.user?.perfil;
    if (p === 'admin' || p === 'secretaria' || perfis.includes(p)) return;
    return reply.forbidden('Seu perfil não tem acesso a esta operação.');
  });
}, { name: 'auth', dependencies: ['prisma'] }); // authenticate relê o usuário no banco
