/* ============================================================
   Avaliações (verificação contínua).
   Shape de leitura espelha DATA.AVALIACOES:
   { [habCod]: [{ data, resultado }] }
   Escopo de turma (turmaNoEscopo): supervisor/gestor escolar só
   turmas das escolas vinculadas; professor só as turmas em que
   leciona; secretaria/admin a rede toda.
   Só turmas/alunos VISÍVEIS (lib/ativos.js): turma ou aluno excluído
   no SAG responde 404 (leitura e registro) e as avaliações dos
   alunos ocultos não entram em lista nem contagem — ficam guardadas.
   ============================================================ */
import { fmtBR, parseBR } from '../lib/datas.js';
import { alunoNoEscopo, turmaNoEscopo, contextoProfessor, planoDirecionadoAoProfessor } from '../lib/escopo.js';
import { eventoCompleto } from '../lib/acompanhamento.js';
import { soTurmasVisiveis, soAlunosVisiveis, soAvaliacoesVisiveis, alunoVisivel } from '../lib/ativos.js';

// avaliações do evento contadas: só de alunos visíveis
const AVALIACOES_VISIVEIS = { where: { aluno: alunoVisivel() }, select: { alunoId: true, resultado: true } };

export default async function avaliacoesRoutes(fastify) {
  const p = fastify.prisma;

  // turma existente, não oculta (excluída no SAG) e no escopo do usuário;
  // responde 404/403 e devolve false se não
  const turmaVisivel = async (request, reply, turmaId) => {
    const t = turmaId ? await p.turma.findFirst({ where: soTurmasVisiveis({ id: turmaId }), select: { id: true, escolaId: true } }) : null;
    if (!t) {
      reply.notFound('Turma não encontrada.');
      return false;
    }
    const acesso = await turmaNoEscopo(p, request.user, t);
    if (!acesso.ok) {
      reply.forbidden(acesso.mensagem);
      return false;
    }
    return true;
  };

  // ---------- GET /avaliacoes?alunoId= ----------
  // Mesmo escopo da ficha (/alunos/:id/full): supervisor/gestor escolar só
  // alunos das escolas vinculadas; professor só alunos das suas turmas.
  fastify.get('/avaliacoes', {
    preHandler: [fastify.authenticate],
    schema: {
      querystring: {
        type: 'object',
        required: ['alunoId'],
        properties: { alunoId: { type: 'string' } },
      },
    },
  }, async (request, reply) => {
    const { alunoId } = request.query;
    const aluno = await p.aluno.findFirst({
      where: soAlunosVisiveis({ id: alunoId }),
      select: { turmaId: true, turma: { select: { escolaId: true } } },
    });
    if (!aluno) return reply.notFound('Aluno não encontrado.');
    const acesso = await alunoNoEscopo(p, request.user, aluno);
    if (!acesso.ok) return reply.forbidden(acesso.mensagem);

    const rows = await p.avaliacao.findMany({
      where: { alunoId },
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
    if (!(await turmaVisivel(request, reply, turmaId))) return;

    const rows = await p.avaliacao.findMany({
      where: soAvaliacoesVisiveis({
        aluno: { turmaId },
        ...(hab ? { habCod: hab } : {}),
      }),
      orderBy: { data: 'asc' },
    });
    const out = {};
    for (const r of rows) {
      ((out[r.alunoId] ||= {})[r.habCod] ||= []).push({ data: fmtBR(r.data), resultado: r.resultado });
    }
    return out;
  });

  // ---------- POST /avaliacoes/lote (professor) ----------
  // Cria ou COMPLETA um evento de acompanhamento. A data é somente registro
  // (não identifica a sessão): quem não foi analisado no dia pode ser
  // completado em outro dia NO MESMO evento. Alunos já analisados são
  // imutáveis (sem edição nem exclusão) — nada é duplicado nem apagado.
  // Decisão (perfis supervisor × gestor escolar): a verificação contínua é registro
  // do professor (admin/secretaria passam como superusuários). O antigo 'gestor'
  // perdeu esta escrita — no frontend só a tela do professor registra lotes;
  // supervisor é somente leitura e o gestor escolar só valida planejamento.
  fastify.post('/avaliacoes/lote', {
    preHandler: [fastify.authenticate, fastify.requirePerfil('professor')],
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

    const plano = await p.planejamento.findUnique({
      where: { id: planejamentoId }, include: { habilidades: { select: { habCod: true } } },
    });
    if (!plano) return reply.notFound('Planejamento não encontrado.');
    // planejamento mensal não é direcionado a um professor específico; só valida
    // se o planejamento (legado) tiver profId definido.
    if (request.user.perfil === 'professor' && plano.profId && plano.profId !== request.user.profId) {
      return reply.forbidden('Este planejamento não está direcionado a você.');
    }
    // professor: só registra em plano direcionado ao grupo/ano/componente das
    // suas turmas (mesma regra de GET /planejamentos/:id)
    if (request.user.perfil === 'professor') {
      const ctx = await contextoProfessor(p, request.user.profId);
      const habs = await p.habilidade.findMany({
        where: { cod: { in: plano.habilidades.map(h => h.habCod) } }, select: { cod: true, compId: true },
      });
      if (!planoDirecionadoAoProfessor(plano, ctx, new Map(habs.map(h => [h.cod, h.compId])))) {
        return reply.forbidden('Planejamento não direcionado ao ano, grupo ou componente das suas turmas.');
      }
    }

    const trabalho = await p.trabalhoHabilidade.findUnique({
      where: { planejamentoId_habCod: { planejamentoId, habCod } },
    });
    if (!trabalho) return reply.badRequest('Habilidade não pertence a este planejamento.');

    // turma avaliada: a informada pelo professor (select) ou a legada do plano —
    // obrigatória (o evento é sempre de uma turma); o professor só registra nas
    // turmas em que leciona
    const turmaAval = turmaId || plano.turmaId;
    if (!turmaAval) return reply.badRequest('Informe a turma avaliada.');
    if (!(await turmaVisivel(request, reply, turmaAval))) return;
    const alunoIds = Object.keys(marks);
    // só alunos visíveis da turma (aluno excluído no SAG não recebe registro novo)
    const alunos = await p.aluno.findMany({
      where: soAlunosVisiveis({ id: { in: alunoIds }, turmaId: turmaAval }),
      select: { id: true },
    });
    if (alunos.length !== alunoIds.length) return reply.badRequest('Um ou mais alunos não pertencem à turma selecionada.');

    const dataAval = parseBR(data);
    const hab = await p.habilidade.findUnique({ where: { cod: habCod } });

    // resolve o evento: o informado, ou um existente de mesma turma+hab+plano+data
    // (evita duplicar por reenvio) — a menos que `novo` force um evento novo
    // (comparativo entre aplicações da mesma habilidade). O evento pertence ao
    // seu planejamento: completar por outro plano o transferiria (e às avaliações).
    let evento = null;
    if (eventoId) {
      evento = await p.acompanhamentoEvento.findUnique({ where: { id: eventoId } });
      if (!evento || evento.turmaId !== turmaAval || evento.habCod !== habCod) {
        return reply.badRequest('Evento de acompanhamento inválido para esta turma/habilidade.');
      }
      if (evento.planejamentoId && evento.planejamentoId !== planejamentoId) {
        return reply.badRequest('Este evento de acompanhamento pertence a outro planejamento.');
      }
    } else if (!novo) {
      evento = await p.acompanhamentoEvento.findFirst({ where: { turmaId: turmaAval, habCod, planejamentoId, data: dataAval } });
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
    // toca atualizadoEm; nunca troca o plano de um evento existente
    ops.push(p.acompanhamentoEvento.update({
      where: { id: evento.id },
      data: evento.planejamentoId ? { atualizadoEm: new Date() } : { planejamentoId },
    }));
    // o status/última verificação da habilidade não são mais gravados à parte:
    // são derivados dos eventos e avaliações (lib/acompanhamento.js)
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

  // ---------- GET /avaliacoes/eventos?turma= ----------
  // Eventos de acompanhamento da turma, com contadores. `completo` = todos os
  // alunos atuais da turma foram analisados no evento (mesma regra do status
  // "trabalhada" do acompanhamento — lib/acompanhamento.js). Eventos sem
  // avaliação ou de planejamento já excluído não são verificação: ficam fora.
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
    if (!(await turmaVisivel(request, reply, turma))) return;
    const [evs, alunos] = await Promise.all([
      p.acompanhamentoEvento.findMany({
        where: { turmaId: turma },
        include: { avaliacoes: AVALIACOES_VISIVEIS },
        orderBy: [{ data: 'desc' }, { criadoEm: 'desc' }],
      }),
      p.aluno.findMany({ where: soAlunosVisiveis({ turmaId: turma }), select: { id: true } }),
    ]);
    const idsPlanos = [...new Set(evs.map(e => e.planejamentoId).filter(Boolean))];
    const planosVivos = new Set(idsPlanos.length
      ? (await p.planejamento.findMany({ where: { id: { in: idsPlanos } }, select: { id: true } })).map(pl => pl.id)
      : []);
    const validos = evs.filter(e => e.avaliacoes.length > 0 && (!e.planejamentoId || planosVivos.has(e.planejamentoId)));
    const alunosDaTurma = alunos.map(a => a.id);
    return validos.map(e => ({
      id: e.id, habCod: e.habCod, planejamentoId: e.planejamentoId,
      data: fmtBR(e.data), atualizadoEm: fmtBR(e.atualizadoEm),
      avaliados: e.avaliacoes.length,
      atingiram: e.avaliacoes.filter(a => a.resultado === 2).length,
      totalAlunos: alunosDaTurma.length,
      completo: eventoCompleto(alunosDaTurma, e.avaliacoes.map(a => a.alunoId)),
    }));
  });

  // ---------- GET /avaliacoes/evento/:id ----------
  // Marcas atuais do evento (para continuar em outro dia).
  fastify.get('/avaliacoes/evento/:id', {
    preHandler: [fastify.authenticate],
  }, async (request, reply) => {
    const e = await p.acompanhamentoEvento.findUnique({
      where: { id: request.params.id },
      include: { avaliacoes: AVALIACOES_VISIVEIS },
    });
    if (!e) return reply.notFound('Evento de acompanhamento não encontrado.');
    if (!(await turmaVisivel(request, reply, e.turmaId))) return;
    return {
      id: e.id, turmaId: e.turmaId, habCod: e.habCod, planejamentoId: e.planejamentoId,
      data: fmtBR(e.data), atualizadoEm: fmtBR(e.atualizadoEm),
      marks: Object.fromEntries(e.avaliacoes.map(a => [a.alunoId, a.resultado])),
    };
  });

  // Eventos de acompanhamento são imutáveis após a análise: sem rotas de
  // edição ou exclusão — apenas completar (lote acima) alunos pendentes.

}
