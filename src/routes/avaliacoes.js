/* ============================================================
   Avaliações (verificação contínua).
   Shape de leitura espelha DATA.AVALIACOES:
   { [habCod]: [{ data, resultado }] }
   ============================================================ */
import { fmtBR, parseBR } from '../lib/datas.js';
import { gestorEscolas } from '../lib/escopo.js';

export default async function avaliacoesRoutes(fastify) {
  const p = fastify.prisma;

  // ---------- GET /avaliacoes?alunoId= ----------
  fastify.get('/avaliacoes', {
    preHandler: [fastify.authenticate],
    schema: {
      querystring: {
        type: 'object',
        required: ['alunoId'],
        properties: { alunoId: { type: 'string' } },
      },
    },
  }, async request => {
    const rows = await p.avaliacao.findMany({
      where: { alunoId: request.query.alunoId },
      orderBy: { data: 'asc' },
    });
    const out = {};
    for (const r of rows) {
      (out[r.habCod] ||= []).push({ data: fmtBR(r.data), resultado: r.resultado });
    }
    return out;
  });

  // ---------- GET /avaliacoes/turma/:turmaId?hab= ----------
  // { [alunoId]: { [habCod]: [{data, resultado}] } } — sem N+1 no cliente
  fastify.get('/avaliacoes/turma/:turmaId', {
    preHandler: [fastify.authenticate],
    schema: {
      querystring: { type: 'object', properties: { hab: { type: 'string' } } },
    },
  }, async (request, reply) => {
    const { turmaId } = request.params;
    const { hab } = request.query;

    const escopo = gestorEscolas(request.user);
    if (escopo) {
      const t = await p.turma.findUnique({ where: { id: turmaId }, select: { escolaId: true } });
      if (!t || !escopo.includes(t.escolaId)) return reply.forbidden('Turma fora do seu grupo de escolas.');
    }

    const rows = await p.avaliacao.findMany({
      where: {
        aluno: { turmaId },
        ...(hab ? { habCod: hab } : {}),
      },
      orderBy: { data: 'asc' },
    });
    const out = {};
    for (const r of rows) {
      ((out[r.alunoId] ||= {})[r.habCod] ||= []).push({ data: fmtBR(r.data), resultado: r.resultado });
    }
    return out;
  });

  // ---------- POST /avaliacoes/lote (professor) ----------
  fastify.post('/avaliacoes/lote', {
    preHandler: [fastify.authenticate, fastify.requirePerfil('professor', 'gestor')],
    schema: {
      body: {
        type: 'object',
        required: ['planejamentoId', 'habCod', 'data', 'marks'],
        properties: {
          planejamentoId: { type: 'string' },
          habCod: { type: 'string' },
          turmaId: { type: 'string' }, // turma avaliada (professor pode lecionar em várias)
          data: { type: 'string', pattern: '^\\d{2}/\\d{2}/\\d{4}$' },
          marks: {
            type: 'object',
            additionalProperties: { type: 'integer', enum: [1, 2] },
            minProperties: 1,
          },
        },
      },
    },
  }, async (request, reply) => {
    const { planejamentoId, habCod, turmaId, data, marks } = request.body;

    const plano = await p.planejamento.findUnique({ where: { id: planejamentoId } });
    if (!plano) return reply.notFound('Planejamento não encontrado.');
    // planejamento mensal não é direcionado a um professor específico; só valida
    // se o planejamento (legado) tiver profId definido.
    if (request.user.perfil === 'professor' && plano.profId && plano.profId !== request.user.profId) {
      return reply.forbidden('Este planejamento não está direcionado a você.');
    }

    const trabalho = await p.trabalhoHabilidade.findUnique({
      where: { planejamentoId_habCod: { planejamentoId, habCod } },
    });
    if (!trabalho) return reply.badRequest('Habilidade não pertence a este planejamento.');

    // turma avaliada: a informada pelo professor (select) ou a legada do plano.
    const turmaAval = turmaId || plano.turmaId;
    const alunoIds = Object.keys(marks);
    const alunos = await p.aluno.findMany({
      where: { id: { in: alunoIds }, ...(turmaAval ? { turmaId: turmaAval } : {}) },
      select: { id: true },
    });
    if (alunos.length !== alunoIds.length) return reply.badRequest('Um ou mais alunos não pertencem à turma selecionada.');

    const dataAval = parseBR(data);
    const hab = await p.habilidade.findUnique({ where: { cod: habCod } });

    await p.$transaction([
      p.avaliacao.createMany({
        data: alunoIds.map(alunoId => ({
          alunoId, habCod, planejamentoId, data: dataAval, resultado: marks[alunoId],
        })),
      }),
      p.trabalhoHabilidade.update({
        where: { planejamentoId_habCod: { planejamentoId, habCod } },
        data: {
          ultima: dataAval,
          ...(trabalho.status === 'pendente' ? { status: 'andamento' } : {}),
        },
      }),
      p.timelineEvent.create({
        data: {
          data: dataAval, tipo: 'avaliacao', habCod,
          texto: `Verificação contínua — ${alunoIds.length} aluno${alunoIds.length > 1 ? 's' : ''} avaliado${alunoIds.length > 1 ? 's' : ''} em ${hab?.rotulo || habCod}.`,
          profId: plano.profId || request.user.profId || null, turmaId: turmaAval,
        },
      }),
    ]);

    reply.code(201);
    return { ok: true, registradas: alunoIds.length };
  });
}
