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

  // ---------- POST /avaliacoes/lote (professor/gestor) ----------
  // Cria ou COMPLETA um evento de acompanhamento. A data é somente registro
  // (não identifica a sessão): quem não foi analisado no dia pode ser
  // completado em outro dia NO MESMO evento. Alunos já analisados são
  // imutáveis (sem edição nem exclusão) — nada é duplicado nem apagado.
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
          eventoId: { type: 'string' }, // evento a continuar (ausente = novo evento)
          novo: { type: 'boolean' }, // true = força evento novo (comparativo), sem reaproveitar por data
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
    const { planejamentoId, habCod, turmaId, eventoId, novo, data, marks } = request.body;

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

    // resolve o evento: o informado, ou um existente de mesma turma+hab+data
    // (evita duplicar por reenvio) — a menos que `novo` force um evento novo
    // (comparativo entre aplicações da mesma habilidade).
    let evento = null;
    if (eventoId) {
      evento = await p.acompanhamentoEvento.findUnique({ where: { id: eventoId } });
      if (!evento || evento.turmaId !== turmaAval || evento.habCod !== habCod) {
        return reply.badRequest('Evento de acompanhamento inválido para esta turma/habilidade.');
      }
    } else if (turmaAval && !novo) {
      evento = await p.acompanhamentoEvento.findFirst({ where: { turmaId: turmaAval, habCod, data: dataAval } });
    }
    const criado = !evento;
    if (!evento) {
      evento = await p.acompanhamentoEvento.create({
        data: { turmaId: turmaAval, habCod, planejamentoId, data: dataAval },
      });
    }

    // completar sem editar: alunos já analisados no evento são PRESERVADOS
    // (resultado e data originais); somente os ainda não analisados entram.
    const atuais = await p.avaliacao.findMany({
      where: { eventoId: evento.id },
      select: { id: true, alunoId: true },
    });
    const jaAnalisados = new Set(atuais.map(a => a.alunoId));
    const ops = [];
    let novas = 0, ignoradas = 0;
    for (const alunoId of alunoIds) {
      if (jaAnalisados.has(alunoId)) { ignoradas += 1; continue; }
      ops.push(p.avaliacao.create({
        data: { alunoId, habCod, planejamentoId, eventoId: evento.id, data: dataAval, resultado: marks[alunoId] },
      }));
      novas += 1;
    }
    ops.push(p.acompanhamentoEvento.update({
      where: { id: evento.id },
      data: { planejamentoId }, // toca atualizadoEm
    }));
    ops.push(p.trabalhoHabilidade.update({
      where: { planejamentoId_habCod: { planejamentoId, habCod } },
      data: {
        ultima: dataAval,
        ...(trabalho.status === 'pendente' ? { status: 'andamento' } : {}),
      },
    }));
    if (criado) {
      ops.push(p.timelineEvent.create({
        data: {
          data: dataAval, tipo: 'avaliacao', habCod,
          texto: `Verificação contínua — ${alunoIds.length} aluno${alunoIds.length > 1 ? 's' : ''} avaliado${alunoIds.length > 1 ? 's' : ''} em ${hab?.rotulo || habCod}.`,
          profId: plano.profId || request.user.profId || null, turmaId: turmaAval,
        },
      }));
    }
    await p.$transaction(ops);

    reply.code(201);
    return { ok: true, eventoId: evento.id, criado, novas, ignoradas, total: atuais.length + novas };
  });

  // escopo de turma por perfil (gestor restrito ao grupo)
  const turmaNoEscopo = async (request, reply, turmaId) => {
    const escopo = gestorEscolas(request.user);
    if (!escopo) return true;
    const t = await p.turma.findUnique({ where: { id: turmaId }, select: { escolaId: true } });
    if (!t || !escopo.includes(t.escolaId)) {
      reply.forbidden('Turma fora do seu grupo de escolas.');
      return false;
    }
    return true;
  };

  // ---------- GET /avaliacoes/eventos?turma= ----------
  // Eventos de acompanhamento da turma, com contadores.
  fastify.get('/avaliacoes/eventos', {
    preHandler: [fastify.authenticate],
    schema: {
      querystring: {
        type: 'object',
        required: ['turma'],
        properties: { turma: { type: 'string' } },
      },
    },
  }, async (request, reply) => {
    const { turma } = request.query;
    if (!(await turmaNoEscopo(request, reply, turma))) return;
    const evs = await p.acompanhamentoEvento.findMany({
      where: { turmaId: turma },
      include: { avaliacoes: { select: { resultado: true } } },
      orderBy: [{ data: 'desc' }, { criadoEm: 'desc' }],
    });
    return evs.map(e => ({
      id: e.id, habCod: e.habCod, planejamentoId: e.planejamentoId,
      data: fmtBR(e.data), atualizadoEm: fmtBR(e.atualizadoEm),
      avaliados: e.avaliacoes.length,
      atingiram: e.avaliacoes.filter(a => a.resultado === 2).length,
    }));
  });

  // ---------- GET /avaliacoes/evento/:id ----------
  // Marcas atuais do evento (para continuar em outro dia).
  fastify.get('/avaliacoes/evento/:id', {
    preHandler: [fastify.authenticate],
  }, async (request, reply) => {
    const e = await p.acompanhamentoEvento.findUnique({
      where: { id: request.params.id },
      include: { avaliacoes: { select: { alunoId: true, resultado: true } } },
    });
    if (!e) return reply.notFound('Evento de acompanhamento não encontrado.');
    if (!(await turmaNoEscopo(request, reply, e.turmaId))) return;
    return {
      id: e.id, turmaId: e.turmaId, habCod: e.habCod, planejamentoId: e.planejamentoId,
      data: fmtBR(e.data), atualizadoEm: fmtBR(e.atualizadoEm),
      marks: Object.fromEntries(e.avaliacoes.map(a => [a.alunoId, a.resultado])),
    };
  });

  // Eventos de acompanhamento são imutáveis após a análise: sem rotas de
  // edição ou exclusão — apenas completar (lote acima) alunos pendentes.

}
