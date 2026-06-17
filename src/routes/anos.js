/* ============================================================
   Anos escolares (séries) — catálogo configurável da rede.
   Persistido na tabela Config (chave "anosEscolares": JSON
   [{ ordem, nome }]). Admin e Secretaria gerenciam (superusuários).
   O `ordem` é o valor inteiro referenciado em Turma.ano e em
   Planejamento/Orientacao.anos; o `nome` é o rótulo exibido.
   ============================================================ */
const CHAVE = 'anosEscolares';
export const DEFAULT_ANOS = [1, 2, 3, 4, 5].map(n => ({ ordem: n, nome: n + 'º ano' }));

const parseJSON = (s, fb) => { try { return JSON.parse(s); } catch { return fb; } };
const normaliza = lista => lista
  .map(a => ({ ordem: a.ordem, nome: a.nome }))
  .sort((a, b) => a.ordem - b.ordem);

export async function lerAnos(p) {
  const row = await p.config.findUnique({ where: { chave: CHAVE } });
  const arr = row ? parseJSON(row.valor, null) : null;
  return normaliza(Array.isArray(arr) && arr.length ? arr : DEFAULT_ANOS);
}
async function salvarAnos(p, lista) {
  const valor = JSON.stringify(normaliza(lista));
  await p.config.upsert({ where: { chave: CHAVE }, create: { chave: CHAVE, valor }, update: { valor } });
}

export default async function anosRoutes(fastify) {
  const p = fastify.prisma;
  const gerente = [fastify.authenticate, fastify.requirePerfil('secretaria')]; // admin também passa (superusuário)

  // ---------- GET /anos (catálogo + nº de turmas que usam cada ano) ----------
  fastify.get('/anos', { preHandler: [fastify.authenticate] }, async () => {
    const [anos, grupos] = await Promise.all([
      lerAnos(p),
      p.turma.groupBy({ by: ['ano'], _count: { _all: true } }),
    ]);
    const usoBy = Object.fromEntries(grupos.map(g => [g.ano, g._count._all]));
    return anos.map(a => ({ ...a, turmas: usoBy[a.ordem] || 0 }));
  });

  // ---------- POST /anos (secretaria) ----------
  fastify.post('/anos', {
    preHandler: gerente,
    schema: {
      body: {
        type: 'object', required: ['nome'],
        properties: { nome: { type: 'string', minLength: 1 }, ordem: { type: 'integer', minimum: 1 } },
      },
    },
  }, async (request, reply) => {
    const anos = await lerAnos(p);
    const nome = request.body.nome.trim();
    if (!nome) return reply.badRequest('Informe o nome do ano escolar.');
    const ordem = request.body.ordem ?? (anos.reduce((m, a) => Math.max(m, a.ordem), 0) + 1);
    if (anos.some(a => a.ordem === ordem)) return reply.badRequest(`Já existe um ano escolar com a ordem ${ordem}.`);
    const novo = { ordem, nome };
    await salvarAnos(p, [...anos, novo]);
    reply.code(201);
    return novo;
  });

  // ---------- PATCH /anos/:ordem (secretaria) ----------
  fastify.patch('/anos/:ordem', {
    preHandler: gerente,
    schema: {
      body: {
        type: 'object',
        properties: { nome: { type: 'string', minLength: 1 }, ordem: { type: 'integer', minimum: 1 } },
      },
    },
  }, async (request, reply) => {
    const ordem = Number(request.params.ordem);
    const anos = await lerAnos(p);
    const alvo = anos.find(a => a.ordem === ordem);
    if (!alvo) return reply.notFound('Ano escolar não encontrado.');
    if (request.body.nome !== undefined) alvo.nome = request.body.nome.trim();
    if (request.body.ordem !== undefined && request.body.ordem !== ordem) {
      if (anos.some(a => a.ordem === request.body.ordem)) return reply.badRequest('Já existe um ano escolar com essa ordem.');
      alvo.ordem = request.body.ordem;
    }
    await salvarAnos(p, anos);
    return alvo;
  });

  // ---------- DELETE /anos/:ordem (secretaria) ----------
  fastify.delete('/anos/:ordem', { preHandler: gerente }, async (request, reply) => {
    const ordem = Number(request.params.ordem);
    const anos = await lerAnos(p);
    if (!anos.some(a => a.ordem === ordem)) return reply.notFound('Ano escolar não encontrado.');
    await salvarAnos(p, anos.filter(a => a.ordem !== ordem));
    return { ok: true };
  });
}
