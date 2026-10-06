/* ============================================================
   Planejamento mensal.
   - Secretaria direciona: mês (periodoId), séries, grupos e habilidades.
     Professor não edita esses campos. (objetivo é legado/opcional.)
   - Professor preenche as sequências didáticas semanais
     (PlanejamentoSemana: habilidades verificadas com a expectativa de
      aprendizagem de cada uma, sequência didática, recursos didáticos,
      verificação de aprendizagem e referências bibliográficas).
   componente/turma/professor são legados/opcionais (verificação contínua).
   - Validação do planejamento docente (routes/validacoes.js): enquanto as
     semanas do professor estão 'enviado' ou 'validado' o POST de semanas
     responde 409; o detalhe traz `validacoes` por professor.
   - Semanas, validações e nSemanas são recortadas por professor conforme o
     perfil (filtroProfessoresDoUsuario): professor = as próprias;
     supervisor/gestor escolar = professores das escolas vinculadas.
   - Acompanhamento por habilidade (`trabalho`) e `progresso` são DERIVADOS
     da verificação contínua nas turmas do recorte do usuário
     (lib/acompanhamento.js): trabalhada = evento completo; andamento = há
     avaliações; pendente = nenhuma. Não há mais status/próxima atividade
     marcados à mão (a rota PATCH .../trabalho/:habCod foi removida).
   - `criadoPorNome`: nome de quem direcionou o plano, resolvido no backend
     (a lista de usuários do /meta é só de admin/secretaria); null quando o
     usuário não existe mais.
   - Semanas trazem o autor resolvido no backend (profNome, profIniciais,
     profCor, profComp): o /meta só lista professores REAIS, então o
     autor de uma semana antiga (conta removida) não está no catálogo
     do front — nunca exibir o id cru (sem registro → null; UI '—').
   ============================================================ */
import { fmtBR } from '../lib/datas.js';
import { progressoPlano } from '../lib/agregacoes.js';
import {
  gestorEscolas, gruposDasEscolas, planoNoEscopo, contextoProfessor, planoDirecionadoAoProfessor,
  filtroProfessoresDoUsuario, turmasDoUsuario,
} from '../lib/escopo.js';
import { carregarAcompanhamento, trabalhoDoPlano } from '../lib/acompanhamento.js';
import { bloqueioEdicao, shapeValidacao } from '../lib/validacao.js';

const parseJSON = (s, fb) => { try { return JSON.parse(s); } catch { return fb; } };

// nomes: Map usuárioId → nome (quem direcionou o plano). Planejamento.criadoPorId
// não tem FK: usuário removido ou id desconhecido → criadoPorNome null (a UI mostra '—')
const shapePlano = (pl, gmap = {}, nomes = new Map()) => ({
  id: pl.id, periodo: pl.periodoId,
  anos: parseJSON(pl.anos, []),
  grupos: parseJSON(pl.grupos, []).map(id => gmap[id]).filter(Boolean), // [{id, nome, cor}] — vazio = toda a rede
  comp: pl.compId || null, turma: pl.turmaId || null, prof: pl.profId || null,
  criadoPor: pl.criadoPorId || null,
  criadoPorNome: (pl.criadoPorId && nomes.get(pl.criadoPorId)) || null,
  titulo: pl.titulo, objetivo: pl.objetivo, criadoEm: fmtBR(pl.criadoEm), status: pl.status,
  habilidades: pl.habilidades.sort((a, b) => a.ordem - b.ordem).map(h => h.habCod),
});

// profs: Map profId → { nome, iniciais, cor, compId } dos autores (Professor existe mesmo
// quando não é mais "real", ex.: conta removida). Nunca o id cru: sem registro → null
// (a UI mostra '—').
const shapeSemana = (s, profs = new Map()) => ({
  id: s.id, semana: s.semana, prof: s.profId,
  profNome: profs.get(s.profId)?.nome || null,
  profIniciais: profs.get(s.profId)?.iniciais || null,
  profCor: profs.get(s.profId)?.cor || null,
  profComp: profs.get(s.profId)?.compId || null,
  habilidades: parseJSON(s.habilidades, []),
  expectativas: parseJSON(s.expectativas, {}), // { habCod: texto } definido pelo professor
  sequenciaDidatica: s.sequenciaDidatica || '',
  recursosDidaticos: s.recursosDidaticos || '',
  verificacaoAprendizagem: s.verificacaoAprendizagem || '',
  referencias: s.referencias || '',
  atualizadoEm: s.atualizadoEm ? fmtBR(s.atualizadoEm) : null,
});

export default async function planejamentosRoutes(fastify) {
  const p = fastify.prisma;

  // mapa id → { id, nome, cor } dos grupos de escolas (resolve nomes no shape)
  const gruposMap = async () =>
    Object.fromEntries((await p.grupoEscola.findMany()).map(g => [g.id, { id: g.id, nome: g.nome, cor: g.cor }]));

  // mapa profId → { nome, iniciais, cor, compId } dos autores das semanas — uma consulta só
  const autoresSemanas = async semanas => {
    const ids = [...new Set(semanas.map(s => s.profId).filter(Boolean))];
    if (!ids.length) return new Map();
    const profs = await p.professor.findMany({ where: { id: { in: ids } }, select: { id: true, nome: true, iniciais: true, cor: true, compId: true } });
    return new Map(profs.map(pr => [pr.id, pr]));
  };

  // mapa id → nome dos usuários citados (criador do plano, decisor da validação) — uma consulta só
  const nomesUsuarios = async ids => {
    const unicos = [...new Set(ids.filter(Boolean))];
    if (!unicos.length) return new Map();
    const us = await p.usuario.findMany({ where: { id: { in: unicos } }, select: { id: true, nome: true } });
    return new Map(us.map(u => [u.id, u.nome]));
  };

  // acompanhamento derivado dos planos nas turmas do recorte do usuário
  const acompanhamentoDe = async (user, planos) =>
    carregarAcompanhamento(p, { planejamentoIds: planos.map(pl => pl.id), turmaIds: await turmasDoUsuario(p, user) });
  const progressoDe = (pl, acompanhamento) => progressoPlano(Object.values(trabalhoDoPlano(pl, acompanhamento)));

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
    const todos = await p.planejamento.findMany({
      where,
      include: { habilidades: true, semanas: { select: { profId: true } } },
      orderBy: { criadoEm: 'asc' },
    });
    // supervisor/gestor escolar: só planos da rede toda ou direcionados a um grupo das suas escolas
    const escopo = gestorEscolas(request.user);
    const gruposEscopo = escopo ? await gruposDasEscolas(p, escopo) : null;
    let planos = gruposEscopo ? todos.filter(pl => planoNoEscopo(pl.grupos, gruposEscopo)) : todos;
    // professor: só planos direcionados ao grupo, ao ano e ao componente das suas turmas
    if (request.user.perfil === 'professor') {
      const ctx = await contextoProfessor(p, request.user.profId);
      const compDaHab = new Map((await p.habilidade.findMany({ select: { cod: true, compId: true } })).map(h => [h.cod, h.compId]));
      planos = planos.filter(pl => planoDirecionadoAoProfessor(pl, ctx, compDaHab));
    }
    // nSemanas conta só as semanas de professores visíveis ao usuário (mesmo recorte do detalhe)
    const visivel = await filtroProfessoresDoUsuario(p, request.user, planos.flatMap(pl => pl.semanas.map(s => s.profId)));
    const [gmap, acompanhamento, nomes] = await Promise.all([
      gruposMap(), acompanhamentoDe(request.user, planos), nomesUsuarios(planos.map(pl => pl.criadoPorId)),
    ]);
    return planos.map(pl => ({
      ...shapePlano(pl, gmap, nomes),
      progresso: progressoDe(pl, acompanhamento),
      nSemanas: pl.semanas.filter(s => visivel(s.profId)).length,
    }));
  });

  // ---------- GET /planejamentos/:id (trabalho + semanas) ----------
  fastify.get('/planejamentos/:id', { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const pl = await p.planejamento.findUnique({
      where: { id: request.params.id },
      include: {
        habilidades: true,
        semanas: { orderBy: [{ profId: 'asc' }, { semana: 'asc' }] },
        validacoes: true,
      },
    });
    if (!pl) return reply.notFound('Planejamento não encontrado.');
    const escopo = gestorEscolas(request.user);
    if (escopo && !planoNoEscopo(pl.grupos, await gruposDasEscolas(p, escopo))) {
      return reply.forbidden('Planejamento fora do seu grupo de escolas.');
    }
    if (request.user.perfil === 'professor') {
      const ctx = await contextoProfessor(p, request.user.profId);
      const compDaHab = new Map((await p.habilidade.findMany({ select: { cod: true, compId: true } })).map(h => [h.cod, h.compId]));
      if (!planoDirecionadoAoProfessor(pl, ctx, compDaHab)) {
        return reply.forbidden('Planejamento não direcionado ao ano, grupo ou componente das suas turmas.');
      }
    }

    // acompanhamento real de cada habilidade nas turmas do recorte do usuário:
    // { status, avaliacoes, eventos, eventosCompletos, avaliados, atingiram, ultima }
    const trabalho = trabalhoDoPlano(pl, await acompanhamentoDe(request.user, [pl]));
    // semanas e validação do planejamento docente por professor, recortadas pelo
    // escopo: professor = as próprias; supervisor/gestor escolar = professores
    // das escolas vinculadas (um plano da rede ou de um grupo reúne professores
    // de outras escolas); secretaria/admin = todas
    const visivel = await filtroProfessoresDoUsuario(p, request.user,
      [...pl.semanas.map(s => s.profId), ...pl.validacoes.map(v => v.profId)]);
    const semanas = pl.semanas.filter(s => visivel(s.profId));
    const validacoes = pl.validacoes.filter(v => visivel(v.profId));
    // nomes dos decisores da validação e de quem direcionou o plano; autores das semanas
    const [nomes, autores] = await Promise.all([
      nomesUsuarios([...validacoes.map(v => v.decididoPorId), pl.criadoPorId]),
      autoresSemanas(semanas),
    ]);

    return {
      ...shapePlano(pl, await gruposMap(), nomes),
      progresso: progressoPlano(Object.values(trabalho)),
      trabalho,
      semanas: semanas.map(s => shapeSemana(s, autores)),
      validacoes: validacoes.map(v => {
        const { profId, status, motivo, enviadoEm, decididoEm, decididoPorNome, historico } = shapeValidacao(v, nomes);
        return { profId, status, motivo, enviadoEm, decididoEm, decididoPorNome, historico };
      }),
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
          grupos: { type: 'array', items: { type: 'string' }, default: [] }, // grupos de escolas (vazio = toda a rede)
          habilidades: { type: 'array', items: { type: 'string' }, minItems: 1 },
        },
      },
    },
  }, async (request, reply) => {
    const { titulo, objetivo, periodo, anos, grupos, habilidades } = request.body;

    const habs = await p.habilidade.findMany({ where: { cod: { in: habilidades } }, select: { cod: true } });
    if (habs.length !== habilidades.length) return reply.badRequest('Uma ou mais habilidades não existem.');
    if (grupos && grupos.length) {
      const gs = await p.grupoEscola.findMany({ where: { id: { in: grupos } }, select: { id: true } });
      if (gs.length !== grupos.length) return reply.badRequest('Um ou mais grupos de escolas não existem.');
    }

    const plano = await p.planejamento.create({
      data: {
        titulo, objetivo: objetivo || '', periodoId: periodo,
        anos: JSON.stringify(anos || []), grupos: JSON.stringify(grupos || []),
        criadoPorId: request.user.sub,
        habilidades: { create: habilidades.map((cod, i) => ({ habCod: cod, ordem: i })) },
        trabalhos: { create: habilidades.map(cod => ({ habCod: cod })) },
      },
      include: { habilidades: true },
    });
    reply.code(201);
    // plano novo: nenhuma verificação ainda → todas as habilidades pendentes
    const [gmap, nomes] = await Promise.all([gruposMap(), nomesUsuarios([plano.criadoPorId])]);
    return { ...shapePlano(plano, gmap, nomes), progresso: progressoDe(plano, new Map()), nSemanas: 0 };
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
          grupos: { type: 'array', items: { type: 'string' } },
          habilidades: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  }, async (request, reply) => {
    const { id } = request.params;
    const { titulo, objetivo, status, periodo, anos, grupos, habilidades } = request.body;
    const existe = await p.planejamento.findUnique({ where: { id }, include: { habilidades: true } });
    if (!existe) return reply.notFound('Planejamento não encontrado.');
    if (grupos && grupos.length) {
      const gs = await p.grupoEscola.findMany({ where: { id: { in: grupos } }, select: { id: true } });
      if (gs.length !== grupos.length) return reply.badRequest('Um ou mais grupos de escolas não existem.');
    }

    const data = {
      ...(titulo !== undefined ? { titulo } : {}),
      ...(objetivo !== undefined ? { objetivo } : {}),
      ...(status !== undefined ? { status } : {}),
      ...(periodo !== undefined ? { periodoId: periodo } : {}),
      ...(anos !== undefined ? { anos: JSON.stringify(anos) } : {}),
      ...(grupos !== undefined ? { grupos: JSON.stringify(grupos) } : {}),
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
        include: { habilidades: true, semanas: { select: { id: true } } },
      });
    });
    const [gmap, acompanhamento, nomes] = await Promise.all([
      gruposMap(), acompanhamentoDe(request.user, [plano]), nomesUsuarios([plano.criadoPorId]),
    ]);
    return { ...shapePlano(plano, gmap, nomes), progresso: progressoDe(plano, acompanhamento), nSemanas: plano.semanas.length };
  });

  // ---------- DELETE /planejamentos/:id (secretaria) ----------
  fastify.delete('/planejamentos/:id', {
    preHandler: [fastify.authenticate, fastify.requirePerfil('secretaria')],
  }, async (request, reply) => {
    const { id } = request.params;
    const existe = await p.planejamento.findUnique({ where: { id } });
    if (!existe) return reply.notFound('Planejamento não encontrado.');
    // avaliações e eventos de acompanhamento referenciam planejamentoId por
    // string (sem FK) — limpa junto; só eventos que ficaram sem avaliação
    // (nunca apaga em cascata avaliação de outro plano)
    await p.avaliacao.deleteMany({ where: { planejamentoId: id } });
    await p.acompanhamentoEvento.deleteMany({ where: { planejamentoId: id, avaliacoes: { none: {} } } });
    // cascade remove habilidades, trabalhos e sequências semanais do planejamento
    await p.planejamento.delete({ where: { id } });
    return { ok: true };
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
                // expectativa de aprendizagem por habilidade verificada: { habCod: texto }
                expectativas: { type: 'object', additionalProperties: { type: 'string' }, default: {} },
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
      // validação do planejamento docente: enviado/validado trava a edição;
      // rascunho e recusado (reaberto pelo gestor escolar) continuam editáveis
      const validacao = await tx.planejamentoValidacao.findUnique({
        where: { planejamentoId_profId: { planejamentoId: plano.id, profId } }, select: { status: true },
      });
      const bloqueio = bloqueioEdicao(validacao?.status);
      if (bloqueio) throw fastify.httpErrors.conflict(bloqueio);
      await tx.planejamentoSemana.deleteMany({ where: { planejamentoId: plano.id, profId } });
      if (semanas.length) {
        await tx.planejamentoSemana.createMany({
          data: semanas.map((s, i) => ({
            planejamentoId: plano.id, profId, semana: s.semana ?? i + 1,
            habilidades: JSON.stringify(s.habilidades || []),
            // guarda só expectativas de habilidades marcadas na semana, sem texto vazio
            expectativas: JSON.stringify(Object.fromEntries(Object.entries(s.expectativas || {})
              .filter(([cod, txt]) => (s.habilidades || []).includes(cod) && String(txt || '').trim())
              .map(([cod, txt]) => [cod, String(txt).trim()]))),
            sequenciaDidatica: s.sequenciaDidatica || '', recursosDidaticos: s.recursosDidaticos || '',
            verificacaoAprendizagem: s.verificacaoAprendizagem || '', referencias: s.referencias || '',
          })),
        });
      }
      return tx.planejamentoSemana.findMany({ where: { planejamentoId: plano.id, profId }, orderBy: { semana: 'asc' } });
    });
    reply.code(201);
    const autores = await autoresSemanas(saved);
    return saved.map(s => shapeSemana(s, autores));
  });

  // Status, atividades e próxima atividade marcados à mão (antiga rota
  // PATCH /planejamentos/:id/trabalho/:habCod) foram removidos: o
  // acompanhamento de cada habilidade é derivado da verificação contínua
  // (lib/acompanhamento.js) e as próximas atividades vêm das semanas do
  // Meu planejamento do professor.
}
