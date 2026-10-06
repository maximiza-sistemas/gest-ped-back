/* ============================================================
   Admin — CRUD de usuários, escolas, turmas, alunos e config.
   Todas as rotas exigem perfil admin (secretaria também passa).
   ============================================================ */
import bcrypt from 'bcryptjs';
import { PERFIS, perfilEscolar } from '../lib/escopo.js';
import { turmasVisiveisEntre } from '../lib/ativos.js';

const MSG_TURMAS_INVALIDAS = 'Uma ou mais turmas não existem ou foram excluídas no SAG.';

const parseJSON = (s, fb) => { try { return JSON.parse(s); } catch { return fb; } };

const userPublic = u => ({
  id: u.id, nome: u.nome, email: u.email, perfil: u.perfil, cargo: u.cargo,
  iniciais: u.iniciais, cor: u.cor, ativo: u.ativo, profId: u.profId || null,
  escolaIds: parseJSON(u.escolaIds, []),
});

const iniciaisDe = nome => nome.trim().split(/\s+/).map(p => p[0]).filter(Boolean).slice(0, 2).join('').toUpperCase();

export default async function adminRoutes(fastify) {
  const p = fastify.prisma;
  const admin = [fastify.authenticate, fastify.requirePerfil('admin')];

  /**
   * Vínculo Usuario → Professor (Usuario.profId é único): o professor precisa
   * existir e não pode ter conta de OUTRO usuário. Checado antes de qualquer
   * gravação. @returns {Promise<null | {code:number, msg:string}>}
   */
  const erroVinculoProfessor = async (profId, usuarioId = null) => {
    const prof = await p.professor.findUnique({ where: { id: profId }, include: { usuario: { select: { id: true } } } });
    if (!prof) return { code: 400, msg: 'Professor vinculado não existe.' };
    if (prof.usuario && prof.usuario.id !== usuarioId) {
      return { code: 409, msg: 'Este professor já está vinculado a outra conta de usuário.' };
    }
    return null;
  };
  const responderErro = (reply, e) => (e.code === 409 ? reply.conflict(e.msg) : reply.badRequest(e.msg));

  /** Alguma turma informada não existe ou está oculta (excluída no SAG — lib/ativos.js)? */
  const turmasInvalidas = async turmaIds =>
    (await turmasVisiveisEntre(p, turmaIds)).length !== new Set(turmaIds).size;

  /* ================= USUÁRIOS ================= */

  fastify.get('/admin/usuarios', { preHandler: admin }, async () => {
    const users = await p.usuario.findMany({ orderBy: { nome: 'asc' } });
    return users.map(userPublic);
  });

  fastify.post('/admin/usuarios', {
    preHandler: admin,
    schema: {
      body: {
        type: 'object',
        required: ['nome', 'email', 'senha', 'perfil'],
        properties: {
          nome: { type: 'string', minLength: 3 },
          email: { type: 'string', minLength: 5 },
          senha: { type: 'string', minLength: 6 },
          perfil: { type: 'string', enum: PERFIS },
          cargo: { type: 'string', default: '' },
          cor: { type: 'string', default: '#475569' },
          escolaIds: { type: 'array', items: { type: 'string' }, default: [] },
          profId: { type: ['string', 'null'] },
          comp: { type: 'string' }, // componente curricular do professor
          turmaIds: { type: 'array', items: { type: 'string' }, default: [] }, // turmas do professor
        },
      },
    },
  }, async (request, reply) => {
    const { nome, email, senha, perfil, cargo, cor, escolaIds, profId, comp, turmaIds } = request.body;
    const emailNorm = email.toLowerCase().trim();
    const existe = await p.usuario.findUnique({ where: { email: emailNorm } });
    if (existe) return reply.conflict('Já existe um usuário com este e-mail.');

    // professor: valida componente/turmas e cria (ou atualiza) o vínculo Professor
    let profIdFinal = null;
    if (perfil === 'professor') {
      if (turmaIds && turmaIds.length) {
        if (await turmasInvalidas(turmaIds)) return reply.badRequest(MSG_TURMAS_INVALIDAS);
      }
      if (comp && !(await p.componente.findUnique({ where: { id: comp } }))) {
        return reply.badRequest('Componente curricular não existe.');
      }
      if (profId) {
        const erro = await erroVinculoProfessor(profId);
        if (erro) return responderErro(reply, erro);
        await p.professor.update({
          where: { id: profId },
          data: {
            ...(comp ? { compId: comp } : {}),
            ...(turmaIds && turmaIds.length ? { turmaIds: JSON.stringify(turmaIds) } : {}),
          },
        });
        profIdFinal = profId;
      } else {
        const compFinal = comp || (await p.componente.findFirst({ orderBy: { id: 'asc' } }))?.id;
        if (!compFinal) return reply.badRequest('Cadastre um componente curricular antes de criar professores.');
        const prof = await p.professor.create({
          data: {
            id: 'p-' + Date.now().toString(36),
            nome, compId: compFinal, cor: cor || '#475569', iniciais: iniciaisDe(nome),
            turmaIds: JSON.stringify(turmaIds || []),
          },
        });
        profIdFinal = prof.id;
      }
    }

    const user = await p.usuario.create({
      data: {
        id: 'u-' + Date.now().toString(36),
        nome, email: emailNorm, senhaHash: bcrypt.hashSync(senha, 10),
        perfil, cargo: cargo || '', cor: cor || '#475569',
        iniciais: iniciaisDe(nome),
        // escolas vinculadas só fazem sentido para supervisor e gestor escolar
        escolaIds: JSON.stringify(perfilEscolar(perfil) ? (escolaIds || []) : []),
        profId: profIdFinal,
      },
    });
    reply.code(201);
    return userPublic(user);
  });

  fastify.patch('/admin/usuarios/:id', {
    preHandler: admin,
    schema: {
      body: {
        type: 'object',
        properties: {
          nome: { type: 'string' }, email: { type: 'string' },
          senha: { type: 'string', minLength: 6 },
          perfil: { type: 'string', enum: PERFIS },
          cargo: { type: 'string' }, cor: { type: 'string' },
          ativo: { type: 'boolean' },
          escolaIds: { type: 'array', items: { type: 'string' } },
          profId: { type: ['string', 'null'] },
          comp: { type: 'string' }, // componente curricular do professor
          turmaIds: { type: 'array', items: { type: 'string' } }, // turmas do professor
        },
      },
    },
  }, async (request, reply) => {
    const { id } = request.params;
    const { nome, email, senha, perfil, cargo, cor, ativo, escolaIds, profId, comp, turmaIds } = request.body;
    const existe = await p.usuario.findUnique({ where: { id } });
    if (!existe) return reply.notFound('Usuário não encontrado.');
    // mesma proteção do DELETE: ninguém se tranca fora desativando a própria conta
    if (id === request.user.sub && ativo === false) return reply.badRequest('Você não pode desativar o próprio usuário.');
    // perfil final (do corpo ou o atual) decide se escolaIds faz sentido
    const perfilFinal = perfil !== undefined ? perfil : existe.perfil;
    if (profId && profId !== existe.profId) {
      const erro = await erroVinculoProfessor(profId, id);
      if (erro) return responderErro(reply, erro);
    }

    // professor: propaga componente/turmas para o vínculo Professor; sem professor
    // alvo (profId null = "— novo professor —", ou conta sem vínculo) cria um
    const sincronizaProfessor = perfilFinal === 'professor' && (comp !== undefined || turmaIds !== undefined);
    const profAlvo = profId !== undefined ? profId : existe.profId;
    let compNovo = null;
    if (sincronizaProfessor) {
      if (turmaIds && turmaIds.length && await turmasInvalidas(turmaIds)) return reply.badRequest(MSG_TURMAS_INVALIDAS);
      if (!profAlvo) {
        compNovo = comp || (await p.componente.findFirst({ orderBy: { id: 'asc' } }))?.id;
        if (!compNovo) return reply.badRequest('Cadastre um componente curricular antes de criar professores.');
      }
    }

    // uma transação: o Professor criado aqui nunca fica órfão (sem a conta que o originou)
    const user = await p.$transaction(async tx => {
      let profNovo = null;
      if (sincronizaProfessor && profAlvo) {
        await tx.professor.updateMany({
          where: { id: profAlvo },
          data: {
            ...(comp !== undefined ? { compId: comp } : {}),
            ...(turmaIds !== undefined ? { turmaIds: JSON.stringify(turmaIds) } : {}),
          },
        });
      } else if (sincronizaProfessor) {
        const nomeFinal = nome !== undefined ? nome : existe.nome;
        profNovo = (await tx.professor.create({
          data: {
            id: 'p-' + Date.now().toString(36),
            nome: nomeFinal, compId: compNovo, cor: cor || existe.cor, iniciais: iniciaisDe(nomeFinal),
            turmaIds: JSON.stringify(turmaIds || []),
          },
        })).id;
      }
      return tx.usuario.update({
        where: { id },
        data: {
          ...(nome !== undefined ? { nome, iniciais: iniciaisDe(nome) } : {}),
          ...(email !== undefined ? { email: email.toLowerCase().trim() } : {}),
          ...(senha !== undefined ? { senhaHash: bcrypt.hashSync(senha, 10) } : {}),
          ...(perfil !== undefined ? { perfil } : {}),
          ...(cargo !== undefined ? { cargo } : {}),
          ...(cor !== undefined ? { cor } : {}),
          ...(ativo !== undefined ? { ativo } : {}),
          ...(escolaIds !== undefined ? { escolaIds: JSON.stringify(perfilEscolar(perfilFinal) ? escolaIds : []) } : {}),
          // o professor recém-criado tem prioridade sobre o profId: null do corpo
          // (o front manda null para "— novo professor —") — senão ele ficaria órfão
          ...(profNovo ? { profId: profNovo } : profId !== undefined ? { profId } : {}),
        },
      });
    });
    return userPublic(user);
  });

  fastify.delete('/admin/usuarios/:id', { preHandler: admin }, async (request, reply) => {
    const { id } = request.params;
    if (id === request.user.sub) return reply.badRequest('Você não pode excluir o próprio usuário.');
    await p.usuario.delete({ where: { id } }).catch(() => null);
    return { ok: true };
  });

  /* ================= ESCOLAS / TURMAS / ALUNOS =================
     Sem rotas de escrita: são espelhados automaticamente do SAG
     (fonte da verdade externa) — a plataforma apenas consome. */

  /* ================= CONFIG ================= */

  fastify.get('/admin/config', { preHandler: admin }, async () => {
    const [rows, periodos] = await Promise.all([
      p.config.findMany(),
      p.periodo.findMany({ orderBy: { inicio: 'asc' } }),
    ]);
    const config = Object.fromEntries(rows.map(c => [c.chave, c.valor]));
    const atual = periodos.find(x => x.atual);
    return { ...config, periodoAtual: atual?.id || null };
  });

  fastify.patch('/admin/config', {
    preHandler: admin,
    schema: {
      body: {
        type: 'object',
        properties: {
          periodoAtual: { type: 'string' },
          anoLetivo: { type: 'string' },
          municipio: { type: 'string' },
          secretaria: { type: 'string' },
          uf: { type: 'string' },
          redeNome: { type: 'string' },
          escolaNome: { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    const { periodoAtual, ...chaves } = request.body;

    if (periodoAtual) {
      const periodo = await p.periodo.findUnique({ where: { id: periodoAtual } });
      if (!periodo) return reply.badRequest('Período não existe.');
      await p.$transaction([
        p.periodo.updateMany({ data: { atual: false } }),
        p.periodo.update({ where: { id: periodoAtual }, data: { atual: true } }),
      ]);
    }
    for (const [chave, valor] of Object.entries(chaves)) {
      if (valor === undefined) continue;
      await p.config.upsert({ where: { chave }, create: { chave, valor }, update: { valor } });
    }
    return { ok: true };
  });
}
