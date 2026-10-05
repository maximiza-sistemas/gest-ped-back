/* ============================================================
   Habilidades — escrita no catálogo (apenas admin e secretaria,
   superusuários de rede). A leitura continua no GET /meta.
   Nível de proficiência: campo opcional, valores em
   lib/proficiencia.js (null = não informado).
   ============================================================ */
import { normalizarNivelProficiencia } from '../lib/proficiencia.js';

const DESC_MIN = 5;
const MENSAGEM_DESC_CURTA = `A descrição precisa ter ao menos ${DESC_MIN} caracteres.`;

/** Formato público de uma habilidade (mesmo do GET /meta). Campos opcionais só aparecem quando preenchidos. */
export const shapeHabilidade = h => ({
  cod: h.cod,
  ...(h.rotulo ? { rotulo: h.rotulo } : {}),
  matriz: h.matrizId,
  comp: h.compId,
  desc: h.desc,
  ...(h.nivelProficiencia ? { proficiencia: h.nivelProficiencia } : {}),
});

// string | null — '' e null significam "não informado"
const NIVEL_SCHEMA = { type: ['string', 'null'] };

export default async function habilidadesRoutes(fastify) {
  const p = fastify.prisma;
  const gerente = [fastify.authenticate, fastify.requirePerfil('secretaria')]; // admin também passa (superusuário)

  // ---------- POST /habilidades ----------
  fastify.post('/habilidades', {
    preHandler: gerente,
    schema: {
      body: {
        type: 'object',
        required: ['cod', 'matriz', 'comp', 'desc'],
        properties: {
          cod: { type: 'string', minLength: 2, maxLength: 40 },
          rotulo: { type: 'string', maxLength: 40 },
          matriz: { type: 'string' },
          comp: { type: 'string' },
          desc: { type: 'string', minLength: DESC_MIN },
          nivelProficiencia: NIVEL_SCHEMA,
        },
      },
    },
  }, async (request, reply) => {
    const { cod, rotulo, matriz, comp, desc, nivelProficiencia } = request.body;
    const nivel = normalizarNivelProficiencia(nivelProficiencia);
    if (!nivel.ok) return reply.badRequest(nivel.erro);
    if (desc.trim().length < DESC_MIN) return reply.badRequest(MENSAGEM_DESC_CURTA);

    const [m, c, existe] = await Promise.all([
      p.matriz.findUnique({ where: { id: matriz } }),
      p.componente.findUnique({ where: { id: comp } }),
      p.habilidade.findUnique({ where: { cod: cod.trim() } }),
    ]);
    if (!m) return reply.badRequest('Matriz de referência não existe.');
    if (!c) return reply.badRequest('Componente curricular não existe.');
    if (existe) return reply.conflict('Já existe uma habilidade com este código.');

    const h = await p.habilidade.create({
      data: {
        cod: cod.trim(), rotulo: (rotulo || '').trim() || null, matrizId: matriz, compId: comp, desc: desc.trim(),
        nivelProficiencia: nivel.valor ?? null,
      },
    });
    reply.code(201);
    return shapeHabilidade(h);
  });

  // ---------- PATCH /habilidades/:cod ----------
  // Altera nível de proficiência, rótulo e/ou descrição de uma habilidade
  // existente. Código, matriz e componente não mudam (vínculos com
  // planejamentos e avaliações dependem deles).
  fastify.patch('/habilidades/:cod', {
    preHandler: gerente,
    schema: {
      body: {
        type: 'object',
        properties: {
          nivelProficiencia: NIVEL_SCHEMA,
          rotulo: { type: ['string', 'null'], maxLength: 40 },
          desc: { type: 'string', minLength: DESC_MIN },
        },
      },
    },
  }, async (request, reply) => {
    const body = request.body || {};
    const informados = ['nivelProficiencia', 'rotulo', 'desc'].filter(k => body[k] !== undefined);
    if (!informados.length) {
      return reply.badRequest('Informe ao menos um campo para alterar: nivelProficiencia, rotulo ou desc.');
    }
    const nivel = normalizarNivelProficiencia(body.nivelProficiencia);
    if (!nivel.ok) return reply.badRequest(nivel.erro);
    if (body.desc !== undefined && body.desc.trim().length < DESC_MIN) return reply.badRequest(MENSAGEM_DESC_CURTA);

    const atual = await p.habilidade.findUnique({ where: { cod: request.params.cod } });
    if (!atual) return reply.notFound('Habilidade não encontrada.');

    const data = {
      ...(nivel.valor !== undefined ? { nivelProficiencia: nivel.valor } : {}),
      ...(body.rotulo !== undefined ? { rotulo: (body.rotulo || '').trim() || null } : {}),
      ...(body.desc !== undefined ? { desc: body.desc.trim() } : {}),
    };
    const h = await p.habilidade.update({ where: { cod: atual.cod }, data });
    return shapeHabilidade(h);
  });

  // ---------- DELETE /habilidades/:cod ----------
  fastify.delete('/habilidades/:cod', { preHandler: gerente }, async (request, reply) => {
    const { cod } = request.params;
    const h = await p.habilidade.findUnique({ where: { cod } });
    if (!h) return reply.notFound('Habilidade não encontrada.');
    const [emPlanos, emTrabalhos, emAval] = await Promise.all([
      p.planejamentoHabilidade.count({ where: { habCod: cod } }),
      p.trabalhoHabilidade.count({ where: { habCod: cod } }),
      p.avaliacao.count({ where: { habCod: cod } }),
    ]);
    if (emPlanos || emTrabalhos || emAval) {
      return reply.badRequest('Habilidade em uso por planejamentos ou avaliações — não pode ser excluída.');
    }
    await p.habilidade.delete({ where: { cod } });
    return { ok: true };
  });
}
