/* ============================================================
   Planejamento mensal.
   - Secretaria direciona: mês (periodoId), habilidades e expectativa
     de aprendizagem (objetivo). Professor não edita esses campos.
   - Professor preenche as sequências didáticas semanais
     (PlanejamentoSemana: sequência didática, recursos didáticos,
      verificação de aprendizagem e referências bibliográficas).
   componente/turma/professor são legados/opcionais (verificação contínua).
   ============================================================ */
import { fmtBR } from '../lib/datas.js';
import { progressoPlano } from '../lib/agregacoes.js';

const parseJSON = (s, fb) => { try { return JSON.parse(s); } catch { return fb; } };

const shapePlano = pl => ({
  id: pl.id, periodo: pl.periodoId,
  anos: parseJSON(pl.anos, []),
  grupo: pl.grupoId || null,
  grupoNome: pl.grupo ? pl.grupo.nome : null,
  grupoCor: pl.grupo ? pl.grupo.cor : null,
  comp: pl.compId || null, turma: pl.turmaId || null, prof: pl.profId || null,
  criadoPor: pl.criadoPorId || null,
  titulo: pl.titulo, objetivo: pl.objetivo, criadoEm: fmtBR(pl.criadoEm), status: pl.status,
  habilidades: pl.habilidades.sort((a, b) => a.ordem - b.ordem).map(h => h.habCod),
});

const shapeTrabalho = t => ({
  status: t.status,
  avaliacoes: t._avalCount ?? 0,
  proxima: t.proxima || null,
  atividades: JSON.parse(t.atividades || '[]'),
  recursos: t.recursos || '',
  ultima: t.ultima ? fmtBR(t.ultima) : null,
});

const shapeSemana = s => ({
  id: s.id, semana: s.semana, prof: s.profId,
  habilidades: parseJSON(s.habilidades, []),
  sequenciaDidatica: s.sequenciaDidatica || '',
  recursosDidaticos: s.recursosDidaticos || '',
  verificacaoAprendizagem: s.verificacaoAprendizagem || '',
  referencias: s.referencias || '',
  atualizadoEm: s.atualizadoEm ? fmtBR(s.atualizadoEm) : null,
});

export default async function planejamentosRoutes(fastify) {
  const p = fastify.prisma;

  // ---------- GET /planejamentos ----------
  fastify.get('/planejamentos', {
    preHandler: [fastify.authenticate],
    schema: {
      querystring: {
        type: 'object',
        properties: {
          periodo: { type: 'string' }, turma: { type: 'string' },
          prof: { type: 'string' }, status: { type: 'string' },
        },
      },
    },
  }, async request => {
    const { periodo, turma, prof, status } = request.query;
    const where = {
      ...(periodo ? { periodoId: periodo } : {}),
      ...(turma ? { turmaId: turma } : {}),
      ...(prof ? { profId: prof } : {}),
      ...(status ? { status } : {}),
    };
    const planos = await p.planejamento.findMany({
      where,
      include: {
        habilidades: true, trabalhos: { select: { status: true } },
        semanas: { select: { id: true } }, grupo: { select: { nome: true, cor: true } },
      },
      orderBy: { criadoEm: 'asc' },
    });
    return planos.map(pl => ({
      ...shapePlano(pl),
      progresso: progressoPlano(pl.trabalhos),
      nSemanas: pl.semanas.length,
    }));
  });

  // ---------- GET /planejamentos/:id (trabalho + semanas) ----------
  fastify.get('/planejamentos/:id', { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const pl = await p.planejamento.findUnique({
      where: { id: request.params.id },
      include: {
        habilidades: true,
        trabalhos: true,
        semanas: { orderBy: [{ profId: 'asc' }, { semana: 'asc' }] },
        grupo: { select: { nome: true, cor: true } },
      },
    });
    if (!pl) return reply.notFound('Planejamento não encontrado.');

    // sessões por habilidade (datas distintas) + acompanhamento (último resultado por aluno)
    const avals = await p.avaliacao.findMany({
      where: { planejamentoId: pl.id },
      select: { alunoId: true, habCod: true, data: true, resultado: true },
      orderBy: { data: 'asc' },
    });
    const sessoesBy = {};       // habCod -> Set(timestamps distintos)
    const ultimoPorAluno = {};  // habCod -> { alunoId: resultado mais recente }
    for (const a of avals) {
      (sessoesBy[a.habCod] ||= new Set()).add(+a.data);
      (ultimoPorAluno[a.habCod] ||= {})[a.alunoId] = a.resultado; // ordem asc → último vence
    }

    const trabalho = {};
    for (const t of pl.trabalhos) {
      const ultimos = Object.values(ultimoPorAluno[t.habCod] || {});
      trabalho[t.habCod] = {
        ...shapeTrabalho({ ...t, _avalCount: sessoesBy[t.habCod] ? sessoesBy[t.habCod].size : 0 }),
        avaliados: ultimos.length,
        atingiram: ultimos.filter(r => r === 2).length,
      };
    }
    return {
      ...shapePlano(pl),
      progresso: progressoPlano(pl.trabalhos),
      trabalho,
      semanas: pl.semanas.map(shapeSemana),
    };
  });

  // ---------- POST /planejamentos (secretaria) ----------
  fastify.post('/planejamentos', {
    preHandler: [fastify.authenticate, fastify.requirePerfil('secretaria')],
    schema: {
      body: {
        type: 'object',
        required: ['titulo', 'periodo', 'habilidades'],
        properties: {
          titulo: { type: 'string', minLength: 3 },
          objetivo: { type: 'string', default: '' }, // expectativa de aprendizagem
          periodo: { type: 'string' }, // mês
          anos: { type: 'array', items: { type: 'integer' }, default: [] }, // séries direcionadas
          grupo: { type: ['string', 'null'], default: null }, // grupo de escolas
          habilidades: { type: 'array', items: { type: 'string' }, minItems: 1 },
        },
      },
    },
  }, async (request, reply) => {
    const { titulo, objetivo, periodo, anos, grupo, habilidades } = request.body;

    const habs = await p.habilidade.findMany({ where: { cod: { in: habilidades } }, select: { cod: true } });
    if (habs.length !== habilidades.length) return reply.badRequest('Uma ou mais habilidades não existem.');
    if (grupo) {
      const g = await p.grupoEscola.findUnique({ where: { id: grupo } });
      if (!g) return reply.badRequest('Grupo de escolas não existe.');
    }

    const plano = await p.planejamento.create({
      data: {
        titulo, objetivo: objetivo || '', periodoId: periodo,
        anos: JSON.stringify(anos || []), grupoId: grupo || null,
        criadoPorId: request.user.sub,
        habilidades: { create: habilidades.map((cod, i) => ({ habCod: cod, ordem: i })) },
        trabalhos: { create: habilidades.map(cod => ({ habCod: cod })) },
      },
      include: {
        habilidades: true, trabalhos: { select: { status: true } },
        semanas: { select: { id: true } }, grupo: { select: { nome: true, cor: true } },
      },
    });
    reply.code(201);
    return { ...shapePlano(plano), progresso: progressoPlano(plano.trabalhos), nSemanas: 0 };
  });

  // ---------- PATCH /planejamentos/:id (secretaria) ----------
  fastify.patch('/planejamentos/:id', {
    preHandler: [fastify.authenticate, fastify.requirePerfil('secretaria')],
    schema: {
      body: {
        type: 'object',
        properties: {
          titulo: { type: 'string' }, objetivo: { type: 'string' },
          status: { type: 'string', enum: ['ativo', 'concluído', 'arquivado'] },
          periodo: { type: 'string' },
          anos: { type: 'array', items: { type: 'integer' } },
          grupo: { type: ['string', 'null'] },
          habilidades: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  }, async (request, reply) => {
    const { id } = request.params;
    const { titulo, objetivo, status, periodo, anos, grupo, habilidades } = request.body;
    const existe = await p.planejamento.findUnique({ where: { id }, include: { habilidades: true } });
    if (!existe) return reply.notFound('Planejamento não encontrado.');

    const data = {
      ...(titulo !== undefined ? { titulo } : {}),
      ...(objetivo !== undefined ? { objetivo } : {}),
      ...(status !== undefined ? { status } : {}),
      ...(periodo !== undefined ? { periodoId: periodo } : {}),
      ...(anos !== undefined ? { anos: JSON.stringify(anos) } : {}),
      ...(grupo !== undefined ? { grupoId: grupo || null } : {}),
    };

    const plano = await p.$transaction(async tx => {
      if (habilidades) {
        const atuais = existe.habilidades.map(h => h.habCod);
        const remover = atuais.filter(c => !habilidades.includes(c));
        const adicionar = habilidades.filter(c => !atuais.includes(c));
        if (remover.length) {
          await tx.planejamentoHabilidade.deleteMany({ where: { planejamentoId: id, habCod: { in: remover } } });
          await tx.trabalhoHabilidade.deleteMany({ where: { planejamentoId: id, habCod: { in: remover } } });
        }
        if (adicionar.length) {
          await tx.planejamentoHabilidade.createMany({ data: adicionar.map(c => ({ planejamentoId: id, habCod: c, ordem: habilidades.indexOf(c) })) });
          await tx.trabalhoHabilidade.createMany({ data: adicionar.map(c => ({ planejamentoId: id, habCod: c })) });
        }
        for (const [i, cod] of habilidades.entries()) {
          await tx.planejamentoHabilidade.update({ where: { planejamentoId_habCod: { planejamentoId: id, habCod: cod } }, data: { ordem: i } });
        }
      }
      return tx.planejamento.update({
        where: { id }, data,
        include: {
          habilidades: true, trabalhos: { select: { status: true } },
          semanas: { select: { id: true } }, grupo: { select: { nome: true, cor: true } },
        },
      });
    });
    return { ...shapePlano(plano), progresso: progressoPlano(plano.trabalhos), nSemanas: plano.semanas.length };
  });

  // ---------- POST /planejamentos/:id/semanas (professor) ----------
  // Substitui as sequências semanais do professor logado para este planejamento.
  fastify.post('/planejamentos/:id/semanas', {
    preHandler: [fastify.authenticate, fastify.requirePerfil('professor')],
    schema: {
      body: {
        type: 'object',
        properties: {
          semanas: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                semana: { type: 'integer', minimum: 1 },
                habilidades: { type: 'array', items: { type: 'string' }, default: [] },
                sequenciaDidatica: { type: 'string', default: '' },
                recursosDidaticos: { type: 'string', default: '' },
                verificacaoAprendizagem: { type: 'string', default: '' },
                referencias: { type: 'string', default: '' },
              },
            },
          },
        },
      },
    },
  }, async (request, reply) => {
    const profId = request.user.profId;
    if (!profId) return reply.forbidden('Seu usuário não está vinculado a um professor.');

    const plano = await p.planejamento.findUnique({ where: { id: request.params.id } });
    if (!plano) return reply.notFound('Planejamento não encontrado.');

    const semanas = request.body.semanas || [];
    const saved = await p.$transaction(async tx => {
      await tx.planejamentoSemana.deleteMany({ where: { planejamentoId: plano.id, profId } });
      if (semanas.length) {
        await tx.planejamentoSemana.createMany({
          data: semanas.map((s, i) => ({
            planejamentoId: plano.id, profId, semana: s.semana ?? i + 1,
            habilidades: JSON.stringify(s.habilidades || []),
            sequenciaDidatica: s.sequenciaDidatica || '', recursosDidaticos: s.recursosDidaticos || '',
            verificacaoAprendizagem: s.verificacaoAprendizagem || '', referencias: s.referencias || '',
          })),
        });
      }
      return tx.planejamentoSemana.findMany({ where: { planejamentoId: plano.id, profId }, orderBy: { semana: 'asc' } });
    });
    reply.code(201);
    return saved.map(shapeSemana);
  });

  // ---------- PATCH /planejamentos/:id/trabalho/:habCod (legado — verificação) ----------
  fastify.patch('/planejamentos/:id/trabalho/:habCod', {
    preHandler: [fastify.authenticate, fastify.requirePerfil('professor', 'gestor')],
    schema: {
      body: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['pendente', 'andamento', 'trabalhada'] },
          atividades: { type: 'array', items: { type: 'string' } },
          recursos: { type: 'string' },
          proxima: { type: ['string', 'null'] },
        },
      },
    },
  }, async (request, reply) => {
    const { id, habCod } = request.params;
    const { status, atividades, recursos, proxima } = request.body;

    const plano = await p.planejamento.findUnique({ where: { id } });
    if (!plano) return reply.notFound('Planejamento não encontrado.');
    if (request.user.perfil === 'professor' && plano.profId && plano.profId !== request.user.profId) {
      return reply.forbidden('Este planejamento não está direcionado a você.');
    }

    const data = {
      ...(status !== undefined ? { status } : {}),
      ...(atividades !== undefined ? { atividades: JSON.stringify(atividades) } : {}),
      ...(recursos !== undefined ? { recursos } : {}),
      ...(proxima !== undefined ? { proxima } : {}),
    };

    const t = await p.trabalhoHabilidade.update({
      where: { planejamentoId_habCod: { planejamentoId: id, habCod } },
      data,
    }).catch(() => null);
    if (!t) return reply.notFound('Habilidade não pertence a este planejamento.');

    const sessoes = await p.avaliacao.groupBy({ by: ['data'], where: { planejamentoId: id, habCod } });
    return shapeTrabalho({ ...t, _avalCount: sessoes.length });
  });
}
