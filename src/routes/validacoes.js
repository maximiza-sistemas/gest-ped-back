/* ============================================================
   Validação do planejamento docente.

   Unidade: as semanas de UM professor em UM planejamento
   (PlanejamentoValidacao: planejamentoId + profId). Regras de
   transição em lib/validacao.js.

   - Professor envia as próprias semanas (rascunho/recusado → enviado).
   - SOMENTE o gestor escolar (perfil 'gestor') valida ou devolve, e só
     professores com turma numa das suas escolas. Checagem explícita do
     perfil: requirePerfil() deixaria admin/secretaria passarem como
     superusuários; o supervisor já é barrado pelo plugin de auth
     (somente leitura).
   - Devolver (recusar) reabre automaticamente para edição; também vale
     para um planejamento já validado (reabertura).
   - Leitura (GET /validacoes): gestor/supervisor = professores das
     escolas vinculadas; secretaria/admin = rede; professor = as próprias.
   ============================================================ */
import {
  gestorEscolas, gruposDasEscolas, planoNoEscopo, contextoProfessor,
  planoDirecionadoAoProfessor, turmasDosProfessores, professorNasEscolas,
} from '../lib/escopo.js';
import {
  STATUS_VALIDACAO, ACAO_HISTORICO, transicao, normalizarMotivo,
  acrescentarHistorico, shapeValidacao, ordenarValidacoes,
} from '../lib/validacao.js';

const CONFLITO_CONCORRENTE = 'O planejamento mudou de situação enquanto você agia. Atualize a página e tente de novo.';
const chave = (planejamentoId, profId) => `${planejamentoId}::${profId}`;

// só o gestor escolar decide (validar / devolver). request.user.perfil é o
// perfil ATUAL do banco (fastify.authenticate relê o usuário): um token antigo
// emitido quando o supervisor ainda era 'gestor' não passa por aqui.
const somenteGestorEscolar = async (request, reply) => {
  if (request.user?.perfil !== 'gestor') {
    return reply.forbidden('Somente o gestor escolar valida ou devolve o planejamento docente.');
  }
};

export default async function validacoesRoutes(fastify) {
  const p = fastify.prisma;

  /** usuarioId → nome, para os decisores informados */
  const nomesUsuarios = async ids => {
    const unicos = [...new Set(ids.filter(Boolean))];
    if (!unicos.length) return new Map();
    const us = await p.usuario.findMany({ where: { id: { in: unicos } }, select: { id: true, nome: true } });
    return new Map(us.map(u => [u.id, u.nome]));
  };

  const buscarValidacao = (planejamentoId, profId) =>
    p.planejamentoValidacao.findUnique({ where: { planejamentoId_profId: { planejamentoId, profId } } });

  /**
   * Grava a transição com controle otimista: só altera se a linha ainda
   * estiver no status/versão lidos (evita duas decisões simultâneas).
   * @returns linha gravada, ou null quando houve conflito concorrente
   */
  async function gravarTransicao({ planejamentoId, profId, atual, destino, dados, entrada }) {
    const historico = acrescentarHistorico(atual?.historico, entrada);
    if (!atual) {
      try {
        return await p.planejamentoValidacao.create({
          data: { planejamentoId, profId, status: destino, historico, ...dados },
        });
      } catch (err) {
        if (err.code === 'P2002') return null; // criada em paralelo (unique planejamentoId+profId)
        throw err;
      }
    }
    const r = await p.planejamentoValidacao.updateMany({
      where: { id: atual.id, status: atual.status, atualizadoEm: atual.atualizadoEm },
      data: { status: destino, historico, ...dados },
    });
    return r.count ? p.planejamentoValidacao.findUnique({ where: { id: atual.id } }) : null;
  }

  const responder = async (reply, linha) => {
    if (!linha) return reply.conflict(CONFLITO_CONCORRENTE);
    return shapeValidacao(linha, await nomesUsuarios([linha.decididoPorId]));
  };

  // ---------- POST /planejamentos/:id/validacao/enviar (professor) ----------
  fastify.post('/planejamentos/:id/validacao/enviar', {
    preHandler: [fastify.authenticate],
  }, async (request, reply) => {
    const { user } = request;
    if (user.perfil !== 'professor') {
      return reply.forbidden('Somente o professor envia o próprio planejamento para validação.');
    }
    if (!user.profId) return reply.forbidden('Seu usuário não está vinculado a um professor.');

    const pl = await p.planejamento.findUnique({
      where: { id: request.params.id },
      include: { habilidades: { select: { habCod: true } } },
    });
    if (!pl) return reply.notFound('Planejamento não encontrado.');

    const ctx = await contextoProfessor(p, user.profId);
    const habs = await p.habilidade.findMany({
      where: { cod: { in: pl.habilidades.map(h => h.habCod) } }, select: { cod: true, compId: true },
    });
    if (!planoDirecionadoAoProfessor(pl, ctx, new Map(habs.map(h => [h.cod, h.compId])))) {
      return reply.forbidden('Planejamento não direcionado ao ano, grupo ou componente das suas turmas.');
    }

    const nSemanas = await p.planejamentoSemana.count({ where: { planejamentoId: pl.id, profId: user.profId } });
    if (!nSemanas) {
      return reply.badRequest('Salve ao menos uma semana do planejamento antes de enviar para validação.');
    }

    const atual = await buscarValidacao(pl.id, user.profId);
    const t = transicao('enviar', atual?.status);
    if (!t.ok) return reply.conflict(t.mensagem);

    const agora = new Date();
    const linha = await gravarTransicao({
      planejamentoId: pl.id, profId: user.profId, atual, destino: t.destino,
      // novo ciclo: a decisão anterior fica só no histórico
      dados: { enviadoEm: agora, motivo: '', decididoEm: null, decididoPorId: null },
      entrada: { acao: ACAO_HISTORICO.enviar, porId: user.sub, porNome: user.nome, em: agora.toISOString() },
    });
    return responder(reply, linha);
  });

  /**
   * Contexto comum de validar/devolver: plano no escopo do gestor escolar
   * e professor com turma numa das escolas dele.
   * @returns {Promise<{pl: object, atual: object|null} | null>} null = resposta de erro já enviada
   */
  async function contextoDecisao(request, reply) {
    const { id, profId } = request.params;
    const pl = await p.planejamento.findUnique({ where: { id }, select: { id: true, grupos: true } });
    if (!pl) { reply.notFound('Planejamento não encontrado.'); return null; }

    const escolas = gestorEscolas(request.user) || [];
    if (!planoNoEscopo(pl.grupos, await gruposDasEscolas(p, escolas))) {
      reply.forbidden('Planejamento fora do grupo das suas escolas.');
      return null;
    }
    const turmas = (await turmasDosProfessores(p, [profId])).get(profId);
    if (!turmas) { reply.notFound('Professor não encontrado.'); return null; }
    if (!professorNasEscolas(turmas, escolas)) {
      reply.forbidden('Este professor não leciona em nenhuma das escolas vinculadas a você.');
      return null;
    }
    return { pl, atual: await buscarValidacao(pl.id, profId) };
  }

  // ---------- POST /planejamentos/:id/validacao/:profId/validar (gestor escolar) ----------
  fastify.post('/planejamentos/:id/validacao/:profId/validar', {
    preHandler: [fastify.authenticate, somenteGestorEscolar],
  }, async (request, reply) => {
    const ctx = await contextoDecisao(request, reply);
    if (!ctx) return reply;
    const t = transicao('validar', ctx.atual?.status);
    if (!t.ok) return reply.conflict(t.mensagem);

    const agora = new Date();
    const { user } = request;
    const linha = await gravarTransicao({
      planejamentoId: ctx.pl.id, profId: request.params.profId, atual: ctx.atual, destino: t.destino,
      dados: { decididoEm: agora, decididoPorId: user.sub, motivo: '' },
      entrada: { acao: ACAO_HISTORICO.validar, porId: user.sub, porNome: user.nome, em: agora.toISOString() },
    });
    return responder(reply, linha);
  });

  // ---------- POST /planejamentos/:id/validacao/:profId/recusar (gestor escolar) ----------
  // Devolve para ajustes: reabre automaticamente as semanas para edição do professor.
  fastify.post('/planejamentos/:id/validacao/:profId/recusar', {
    // sem JSON Schema de corpo: o motivo (obrigatório) é validado no handler,
    // com mensagem clara em português mesmo quando o corpo vem vazio
    preHandler: [fastify.authenticate, somenteGestorEscolar],
  }, async (request, reply) => {
    const motivo = normalizarMotivo(request.body?.motivo);
    if (!motivo.ok) return reply.badRequest(motivo.mensagem);

    const ctx = await contextoDecisao(request, reply);
    if (!ctx) return reply;
    const t = transicao('recusar', ctx.atual?.status);
    if (!t.ok) return reply.conflict(t.mensagem);

    const agora = new Date();
    const { user } = request;
    const linha = await gravarTransicao({
      planejamentoId: ctx.pl.id, profId: request.params.profId, atual: ctx.atual, destino: t.destino,
      dados: { decididoEm: agora, decididoPorId: user.sub, motivo: motivo.valor },
      entrada: { acao: ACAO_HISTORICO.recusar, porId: user.sub, porNome: user.nome, em: agora.toISOString(), motivo: motivo.valor },
    });
    return responder(reply, linha);
  });

  // ---------- GET /validacoes?status= ----------
  fastify.get('/validacoes', {
    preHandler: [fastify.authenticate],
    schema: { querystring: { type: 'object', properties: { status: { type: 'string' } } } },
  }, async (request, reply) => {
    const { status } = request.query;
    if (status && status !== 'todos' && !STATUS_VALIDACAO.includes(status)) {
      return reply.badRequest(`Status inválido. Use um destes valores: ${STATUS_VALIDACAO.join(', ')}.`);
    }
    const { user } = request;
    const ehProfessor = user.perfil === 'professor';
    if (ehProfessor && !user.profId) return [];
    const escolas = gestorEscolas(user); // supervisor/gestor: escolas vinculadas; demais: null

    // escopo de professores
    const turmasPorProf = await turmasDosProfessores(p, ehProfessor ? [user.profId] : undefined);
    let profIds = null; // null = rede toda (secretaria/admin)
    if (ehProfessor) profIds = [user.profId];
    else if (escolas) profIds = [...turmasPorProf].filter(([, ts]) => professorNasEscolas(ts, escolas)).map(([id]) => id);
    if (profIds && !profIds.length) return [];
    const whereProf = profIds ? { profId: { in: profIds } } : {};

    const [linhas, pares] = await Promise.all([
      p.planejamentoValidacao.findMany({ where: whereProf }),
      p.planejamentoSemana.groupBy({ by: ['planejamentoId', 'profId'], where: whereProf, _count: { _all: true } }),
    ]);
    const nSemanas = new Map(pares.map(x => [chave(x.planejamentoId, x.profId), x._count._all]));
    const porChave = new Map(linhas.map(v => [chave(v.planejamentoId, v.profId), v]));
    // semanas salvas sem linha de validação = rascunho (nada é gravado aqui)
    for (const x of pares) {
      const k = chave(x.planejamentoId, x.profId);
      if (!porChave.has(k)) porChave.set(k, { planejamentoId: x.planejamentoId, profId: x.profId, status: 'rascunho' });
    }

    const todas = [...porChave.values()];
    const [planos, profs, nomes, gruposEscopo] = await Promise.all([
      p.planejamento.findMany({
        where: { id: { in: [...new Set(todas.map(v => v.planejamentoId))] } },
        select: { id: true, titulo: true, periodoId: true, grupos: true },
      }),
      p.professor.findMany({ where: { id: { in: [...new Set(todas.map(v => v.profId))] } }, select: { id: true, nome: true } }),
      nomesUsuarios(todas.map(v => v.decididoPorId)),
      escolas ? gruposDasEscolas(p, escolas) : Promise.resolve(null),
    ]);
    const planoPorId = new Map(planos.map(pl => [pl.id, pl]));
    const nomeProf = new Map(profs.map(pr => [pr.id, pr.nome]));

    const visiveis = todas.filter(v => {
      const pl = planoPorId.get(v.planejamentoId);
      return pl && (!gruposEscopo || planoNoEscopo(pl.grupos, gruposEscopo));
    });
    const filtradas = status && status !== 'todos' ? visiveis.filter(v => v.status === status) : visiveis;

    return ordenarValidacoes(filtradas).map(v => {
      const pl = planoPorId.get(v.planejamentoId);
      const turmas = (turmasPorProf.get(v.profId) || [])
        // supervisor/gestor só veem as turmas das escolas vinculadas
        .filter(t => !escolas || escolas.includes(t.escolaId))
        .map(t => ({ id: t.id, nome: t.nome, escolaId: t.escolaId, escolaNome: t.escolaNome }));
      return {
        ...shapeValidacao(v, nomes),
        titulo: pl.titulo,
        periodo: pl.periodoId,
        profNome: nomeProf.get(v.profId) || v.profId,
        turmas,
        nSemanas: nSemanas.get(chave(v.planejamentoId, v.profId)) || 0,
      };
    });
  });
}
