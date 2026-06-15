/* ============================================================
   Orientações (gestor) + trilhas de aprendizagem (professor).

   Fluxo:
   - A Secretaria de Educação cria uma Orientação indicando habilidade(s)/
     expectativas (ou "modo geral", sem habilidade específica), o escopo
     (toda a rede ou escola(s)) e a(s) série(s). O gestor escolar apenas
     acompanha (view-only).
   - O professor complementa com a Trilha de aprendizagem: etapas
     ordenadas (estratégias) para desenvolver a habilidade.
   ============================================================ */
import { fmtBR } from '../lib/datas.js';

const parseJSON = (s, fb) => { try { return JSON.parse(s); } catch { return fb; } };

const shapeEtapa = e => ({ id: e.id, ordem: e.ordem, titulo: e.titulo, descricao: e.descricao || '' });

const shapeTrilha = t => ({
  id: t.id,
  orientacaoId: t.orientacaoId,
  prof: t.profId,
  observacao: t.observacao || '',
  status: t.status,
  atualizadoEm: t.atualizadoEm ? fmtBR(t.atualizadoEm) : null,
  etapas: (t.etapas || []).slice().sort((a, b) => a.ordem - b.ordem).map(shapeEtapa),
});

const shapeOrientacao = (o, { profId } = {}) => {
  const trilhas = o.trilhas || [];
  const base = {
    id: o.id,
    titulo: o.titulo,
    objetivo: o.objetivo || '',
    escopo: o.escopo,
    escolaIds: parseJSON(o.escolaIds, []),
    anos: parseJSON(o.anos, []),
    comp: o.compId || null,
    modoGeral: o.modoGeral,
    habilidades: parseJSON(o.habilidades, []),
    periodo: o.periodoId || null,
    criadoPor: o.criadoPorId,
    status: o.status,
    criadoEm: o.criadoEm ? fmtBR(o.criadoEm) : null,
    respostas: trilhas.length,
  };
  if (profId !== undefined) {
    const minha = trilhas.find(t => t.profId === profId);
    base.minhaTrilha = minha ? shapeTrilha(minha) : null;
  }
  return base;
};

// Deriva o contexto do professor (escolas/séries/componente) a partir
// das turmas vinculadas aos seus planejamentos.
async function contextoProfessor(p, profId) {
  if (!profId) return null;
  const [prof, planos] = await Promise.all([
    p.professor.findUnique({ where: { id: profId }, select: { compId: true } }),
    p.planejamento.findMany({ where: { profId }, select: { turma: { select: { escolaId: true, ano: true } } } }),
  ]);
  const escolas = [...new Set(planos.map(pl => pl.turma.escolaId))];
  const anos = [...new Set(planos.map(pl => pl.turma.ano))];
  // sem turmas vinculadas → contexto desconhecido (mostra todas as ativas)
  if (!escolas.length && !anos.length) return { comp: prof?.compId || null, escolas: [], anos: [], desconhecido: true };
  return { comp: prof?.compId || null, escolas, anos, desconhecido: false };
}

function aplicaAoProfessor(o, ctx) {
  if (o.status !== 'ativa') return false;
  if (!ctx || ctx.desconhecido) return true;
  const escolaIds = parseJSON(o.escolaIds, []);
  const anos = parseJSON(o.anos, []);
  const okEscola = o.escopo === 'geral' || escolaIds.length === 0 || escolaIds.some(e => ctx.escolas.includes(e));
  const okAno = anos.length === 0 || anos.some(a => ctx.anos.includes(a));
  const okComp = !o.compId || !ctx.comp || o.compId === ctx.comp;
  return okEscola && okAno && okComp;
}

export default async function orientacoesRoutes(fastify) {
  const p = fastify.prisma;

  // ---------- GET /orientacoes ----------
  // secretaria/admin/gestor: todas (gestor é view-only).
  // professor: apenas as aplicáveis + minha trilha.
  fastify.get('/orientacoes', {
    preHandler: [fastify.authenticate],
    schema: { querystring: { type: 'object', properties: { status: { type: 'string' } } } },
  }, async request => {
    const { perfil, profId } = request.user;
    const where = request.query.status ? { status: request.query.status } : {};
    const orientacoes = await p.orientacao.findMany({
      where,
      include: { trilhas: { include: { etapas: true } } },
      orderBy: { criadoEm: 'desc' },
    });

    if (perfil === 'professor') {
      const ctx = await contextoProfessor(p, profId);
      return orientacoes.filter(o => aplicaAoProfessor(o, ctx)).map(o => shapeOrientacao(o, { profId }));
    }
    return orientacoes.map(o => shapeOrientacao(o));
  });

  // ---------- GET /orientacoes/:id ----------
  fastify.get('/orientacoes/:id', { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const o = await p.orientacao.findUnique({
      where: { id: request.params.id },
      include: { trilhas: { include: { etapas: true } } },
    });
    if (!o) return reply.notFound('Orientação não encontrada.');
    return {
      ...shapeOrientacao(o, request.user.perfil === 'professor' ? { profId: request.user.profId } : {}),
      trilhas: o.trilhas.map(shapeTrilha),
    };
  });

  // ---------- POST /orientacoes (secretaria) ----------
  fastify.post('/orientacoes', {
    preHandler: [fastify.authenticate, fastify.requirePerfil('secretaria')],
    schema: {
      body: {
        type: 'object',
        required: ['titulo', 'escopo'],
        properties: {
          titulo: { type: 'string', minLength: 3 },
          objetivo: { type: 'string', default: '' },
          escopo: { type: 'string', enum: ['geral', 'escolas'] },
          escolaIds: { type: 'array', items: { type: 'string' }, default: [] },
          anos: { type: 'array', items: { type: 'integer' }, default: [] },
          comp: { type: ['string', 'null'], default: null },
          modoGeral: { type: 'boolean', default: false },
          habilidades: { type: 'array', items: { type: 'string' }, default: [] },
          periodo: { type: ['string', 'null'], default: null },
        },
      },
    },
  }, async (request, reply) => {
    const { titulo, objetivo, escopo, escolaIds, anos, comp, modoGeral, habilidades, periodo } = request.body;

    if (!modoGeral && (!habilidades || habilidades.length === 0)) {
      return reply.badRequest('Selecione ao menos uma habilidade ou marque "trabalho geral".');
    }
    if (escopo === 'escolas' && (!escolaIds || escolaIds.length === 0)) {
      return reply.badRequest('Selecione ao menos uma escola para o escopo "escolas".');
    }
    if (habilidades && habilidades.length) {
      const habs = await p.habilidade.findMany({ where: { cod: { in: habilidades } }, select: { cod: true } });
      if (habs.length !== habilidades.length) return reply.badRequest('Uma ou mais habilidades não existem.');
    }

    const o = await p.orientacao.create({
      data: {
        titulo,
        objetivo: objetivo || '',
        escopo,
        escolaIds: JSON.stringify(escopo === 'geral' ? [] : (escolaIds || [])),
        anos: JSON.stringify(anos || []),
        compId: comp || null,
        modoGeral: !!modoGeral,
        habilidades: JSON.stringify(modoGeral ? [] : (habilidades || [])),
        periodoId: periodo || null,
        criadoPorId: request.user.sub,
      },
      include: { trilhas: { include: { etapas: true } } },
    });
    reply.code(201);
    return shapeOrientacao(o);
  });

  // ---------- PATCH /orientacoes/:id (secretaria) — editar/arquivar ----------
  fastify.patch('/orientacoes/:id', {
    preHandler: [fastify.authenticate, fastify.requirePerfil('secretaria')],
    schema: {
      body: {
        type: 'object',
        properties: {
          titulo: { type: 'string' },
          objetivo: { type: 'string' },
          status: { type: 'string', enum: ['ativa', 'arquivada'] },
        },
      },
    },
  }, async (request, reply) => {
    const { id } = request.params;
    const { titulo, objetivo, status } = request.body;
    const existe = await p.orientacao.findUnique({ where: { id } });
    if (!existe) return reply.notFound('Orientação não encontrada.');
    const o = await p.orientacao.update({
      where: { id },
      data: {
        ...(titulo !== undefined ? { titulo } : {}),
        ...(objetivo !== undefined ? { objetivo } : {}),
        ...(status !== undefined ? { status } : {}),
      },
      include: { trilhas: { include: { etapas: true } } },
    });
    return shapeOrientacao(o);
  });

  // ---------- POST /orientacoes/:id/trilha (professor) ----------
  // Cria ou substitui a trilha do professor logado para a orientação.
  fastify.post('/orientacoes/:id/trilha', {
    preHandler: [fastify.authenticate, fastify.requirePerfil('professor')],
    schema: {
      body: {
        type: 'object',
        properties: {
          observacao: { type: 'string', default: '' },
          status: { type: 'string', enum: ['rascunho', 'publicada'], default: 'publicada' },
          etapas: {
            type: 'array',
            items: {
              type: 'object',
              required: ['titulo'],
              properties: {
                titulo: { type: 'string', minLength: 1 },
                descricao: { type: 'string', default: '' },
              },
            },
          },
        },
      },
    },
  }, async (request, reply) => {
    const profId = request.user.profId;
    if (!profId) return reply.forbidden('Seu usuário não está vinculado a um professor.');

    const orientacao = await p.orientacao.findUnique({ where: { id: request.params.id } });
    if (!orientacao) return reply.notFound('Orientação não encontrada.');

    const { observacao = '', status = 'publicada', etapas = [] } = request.body;

    const trilha = await p.$transaction(async tx => {
      const t = await tx.trilha.upsert({
        where: { orientacaoId_profId: { orientacaoId: orientacao.id, profId } },
        create: { orientacaoId: orientacao.id, profId, observacao, status },
        update: { observacao, status },
      });
      await tx.trilhaEtapa.deleteMany({ where: { trilhaId: t.id } });
      if (etapas.length) {
        await tx.trilhaEtapa.createMany({
          data: etapas.map((e, i) => ({ trilhaId: t.id, ordem: i, titulo: e.titulo, descricao: e.descricao || '' })),
        });
      }
      return tx.trilha.findUnique({ where: { id: t.id }, include: { etapas: true } });
    });

    reply.code(201);
    return shapeTrilha(trilha);
  });
}
