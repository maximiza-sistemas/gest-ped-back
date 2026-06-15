/* ============================================================
   Níveis de leitura — registro em lote (professor).
   ============================================================ */
import { parseBR } from '../lib/datas.js';

export default async function leituraRoutes(fastify) {
  const p = fastify.prisma;

  // ---------- POST /leitura/lote ----------
  fastify.post('/leitura/lote', {
    preHandler: [fastify.authenticate, fastify.requirePerfil('professor', 'gestor')],
    schema: {
      body: {
        type: 'object',
        required: ['data', 'registros'],
        properties: {
          data: { type: 'string', pattern: '^\\d{2}/\\d{2}/\\d{4}$' },
          registros: {
            type: 'array', minItems: 1,
            items: {
              type: 'object',
              required: ['alunoId', 'nivel'],
              properties: {
                alunoId: { type: 'string' },
                nivel: { type: 'integer', minimum: 1, maximum: 6 },
              },
            },
          },
        },
      },
    },
  }, async (request, reply) => {
    const { data, registros } = request.body;
    const dataReg = parseBR(data);

    const ids = registros.map(r => r.alunoId);
    const alunos = await p.aluno.findMany({ where: { id: { in: ids } } });
    if (alunos.length !== ids.length) return reply.badRequest('Um ou mais alunos não foram encontrados.');
    const byId = Object.fromEntries(alunos.map(a => [a.id, a]));

    const avancaram = registros.filter(r => r.nivel > byId[r.alunoId].nivelLeitura).length;
    const turmaId = alunos[0]?.turmaId || null;

    await p.$transaction([
      ...registros.map(r => p.aluno.update({ where: { id: r.alunoId }, data: { nivelLeitura: r.nivel } })),
      p.leituraRegistro.createMany({
        data: registros.map(r => ({ alunoId: r.alunoId, data: dataReg, nivel: r.nivel })),
      }),
      p.timelineEvent.create({
        data: {
          data: dataReg, tipo: 'leitura', habCod: null,
          texto: avancaram > 0
            ? `Atualização de níveis de leitura — ${avancaram} aluno${avancaram > 1 ? 's' : ''} avançaram de nível.`
            : `Atualização de níveis de leitura — ${registros.length} registro${registros.length > 1 ? 's' : ''}.`,
          profId: request.user.profId || null, turmaId,
        },
      }),
    ]);

    reply.code(201);
    return { ok: true, registrados: registros.length, avancaram };
  });
}
