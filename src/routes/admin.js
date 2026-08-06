/* ============================================================
   Admin — CRUD de usuários, escolas, turmas, alunos e config.
   Todas as rotas exigem perfil admin.
   ============================================================ */
import bcrypt from 'bcryptjs';
import { parseBR } from '../lib/datas.js';

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
          perfil: { type: 'string', enum: ['secretaria', 'gestor', 'professor', 'admin'] },
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
        const turmas = await p.turma.findMany({ where: { id: { in: turmaIds } }, select: { id: true } });
        if (turmas.length !== turmaIds.length) return reply.badRequest('Uma ou mais turmas não existem.');
      }
      if (comp && !(await p.componente.findUnique({ where: { id: comp } }))) {
        return reply.badRequest('Componente curricular não existe.');
      }
      if (profId) {
        const prof = await p.professor.findUnique({ where: { id: profId } });
        if (!prof) return reply.badRequest('Professor vinculado não existe.');
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
        escolaIds: JSON.stringify(perfil === 'gestor' ? (escolaIds || []) : []),
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
          perfil: { type: 'string', enum: ['secretaria', 'gestor', 'professor', 'admin'] },
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
    // perfil final (do corpo ou o atual) decide se escolaIds faz sentido
    const perfilFinal = perfil !== undefined ? perfil : existe.perfil;

    // professor: propaga componente/turmas para o vínculo Professor (cria se não houver)
    let profNovo;
    if (perfilFinal === 'professor' && (comp !== undefined || turmaIds !== undefined)) {
      if (turmaIds && turmaIds.length) {
        const turmas = await p.turma.findMany({ where: { id: { in: turmaIds } }, select: { id: true } });
        if (turmas.length !== turmaIds.length) return reply.badRequest('Uma ou mais turmas não existem.');
      }
      const profAlvo = profId !== undefined ? profId : existe.profId;
      if (profAlvo) {
        await p.professor.update({
          where: { id: profAlvo },
          data: {
            ...(comp !== undefined ? { compId: comp } : {}),
            ...(turmaIds !== undefined ? { turmaIds: JSON.stringify(turmaIds) } : {}),
          },
        }).catch(() => null);
      } else {
        const compFinal = comp || (await p.componente.findFirst({ orderBy: { id: 'asc' } }))?.id;
        if (!compFinal) return reply.badRequest('Cadastre um componente curricular antes de criar professores.');
        const nomeFinal = nome !== undefined ? nome : existe.nome;
        const prof = await p.professor.create({
          data: {
            id: 'p-' + Date.now().toString(36),
            nome: nomeFinal, compId: compFinal, cor: cor || existe.cor, iniciais: iniciaisDe(nomeFinal),
            turmaIds: JSON.stringify(turmaIds || []),
          },
        });
        profNovo = prof.id;
      }
    }
    const user = await p.usuario.update({
      where: { id },
      data: {
        ...(nome !== undefined ? { nome, iniciais: iniciaisDe(nome) } : {}),
        ...(email !== undefined ? { email: email.toLowerCase().trim() } : {}),
        ...(senha !== undefined ? { senhaHash: bcrypt.hashSync(senha, 10) } : {}),
        ...(perfil !== undefined ? { perfil } : {}),
        ...(cargo !== undefined ? { cargo } : {}),
        ...(cor !== undefined ? { cor } : {}),
        ...(ativo !== undefined ? { ativo } : {}),
        ...(escolaIds !== undefined ? { escolaIds: JSON.stringify(perfilFinal === 'gestor' ? escolaIds : []) } : {}),
        ...(profId !== undefined ? { profId } : profNovo ? { profId: profNovo } : {}),
      },
    });
    return userPublic(user);
  });

  fastify.delete('/admin/usuarios/:id', { preHandler: admin }, async (request, reply) => {
    const { id } = request.params;
    if (id === request.user.sub) return reply.badRequest('Você não pode excluir o próprio usuário.');
    await p.usuario.delete({ where: { id } }).catch(() => null);
    return { ok: true };
  });

  /* ================= ESCOLAS ================= */

  fastify.post('/admin/escolas', {
    preHandler: admin,
    schema: {
      body: {
        type: 'object',
        required: ['nome', 'sigla'],
        properties: {
          nome: { type: 'string', minLength: 3 }, sigla: { type: 'string', minLength: 2 },
          zona: { type: 'string', enum: ['Urbana', 'Rural'], default: 'Urbana' },
          bairro: { type: 'string', default: '' }, diretor: { type: 'string', default: '' },
          cor: { type: 'string', default: '#2563eb' }, qtdProfessores: { type: 'integer', default: 0 },
        },
      },
    },
  }, async (request, reply) => {
    const { nome, sigla, zona, bairro, diretor, cor, qtdProfessores } = request.body;
    const escola = await p.escola.create({
      data: { id: 'e-' + Date.now().toString(36), nome, sigla, zona, bairro, diretor, cor, qtdProfessores },
    });
    reply.code(201);
    return escola;
  });

  fastify.patch('/admin/escolas/:id', {
    preHandler: admin,
    schema: {
      body: {
        type: 'object',
        properties: {
          nome: { type: 'string' }, sigla: { type: 'string' },
          zona: { type: 'string', enum: ['Urbana', 'Rural'] },
          bairro: { type: 'string' }, diretor: { type: 'string' },
          cor: { type: 'string' }, qtdProfessores: { type: 'integer' },
        },
      },
    },
  }, async (request, reply) => {
    const escola = await p.escola.update({ where: { id: request.params.id }, data: request.body }).catch(() => null);
    if (!escola) return reply.notFound('Escola não encontrada.');
    return escola;
  });

  fastify.delete('/admin/escolas/:id', { preHandler: admin }, async (request, reply) => {
    const turmas = await p.turma.count({ where: { escolaId: request.params.id } });
    if (turmas > 0) return reply.badRequest(`A escola tem ${turmas} turma(s). Exclua ou transfira as turmas antes.`);
    await p.escola.delete({ where: { id: request.params.id } }).catch(() => null);
    return { ok: true };
  });

  /* ================= TURMAS ================= */

  fastify.post('/admin/turmas', {
    preHandler: admin,
    schema: {
      body: {
        type: 'object',
        required: ['escola', 'ano', 'nome'],
        properties: {
          escola: { type: 'string' }, ano: { type: 'integer', minimum: 1, maximum: 9 },
          nome: { type: 'string', minLength: 2 },
          turno: { type: 'string', enum: ['Matutino', 'Vespertino', 'Integral'], default: 'Matutino' },
        },
      },
    },
  }, async (request, reply) => {
    const { escola, ano, nome, turno } = request.body;
    const esc = await p.escola.findUnique({ where: { id: escola } });
    if (!esc) return reply.badRequest('Escola não existe.');
    const turma = await p.turma.create({
      data: { id: 't-' + Date.now().toString(36), escolaId: escola, ano, nome, turno },
    });
    reply.code(201);
    return turma;
  });

  fastify.patch('/admin/turmas/:id', {
    preHandler: admin,
    schema: {
      body: {
        type: 'object',
        properties: {
          nome: { type: 'string' }, ano: { type: 'integer', minimum: 1, maximum: 9 },
          turno: { type: 'string', enum: ['Matutino', 'Vespertino', 'Integral'] },
          escola: { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    const { nome, ano, turno, escola } = request.body;
    const turma = await p.turma.update({
      where: { id: request.params.id },
      data: {
        ...(nome !== undefined ? { nome } : {}),
        ...(ano !== undefined ? { ano } : {}),
        ...(turno !== undefined ? { turno } : {}),
        ...(escola !== undefined ? { escolaId: escola } : {}),
      },
    }).catch(() => null);
    if (!turma) return reply.notFound('Turma não encontrada.');
    return turma;
  });

  fastify.delete('/admin/turmas/:id', { preHandler: admin }, async (request, reply) => {
    const alunos = await p.aluno.count({ where: { turmaId: request.params.id } });
    if (alunos > 0) return reply.badRequest(`A turma tem ${alunos} aluno(s). Transfira-os antes de excluir.`);
    await p.turma.delete({ where: { id: request.params.id } }).catch(() => null);
    return { ok: true };
  });

  /* ================= ALUNOS ================= */

  fastify.post('/admin/alunos', {
    preHandler: admin,
    schema: {
      body: {
        type: 'object',
        required: ['nome', 'turma'],
        properties: {
          nome: { type: 'string', minLength: 3 },
          turma: { type: 'string' },
          nivelLeitura: { type: 'integer', minimum: 1, maximum: 6, default: 1 },
          dataRegistro: { type: 'string', pattern: '^\\d{2}/\\d{2}/\\d{4}$' },
        },
      },
    },
  }, async (request, reply) => {
    const { nome, turma, nivelLeitura, dataRegistro } = request.body;
    const t = await p.turma.findUnique({ where: { id: turma }, include: { _count: { select: { alunos: true } } } });
    if (!t) return reply.badRequest('Turma não existe.');
    const aluno = await p.aluno.create({
      data: {
        id: turma + '-a' + Date.now().toString(36),
        turmaId: turma, nome, numero: t._count.alunos + 1,
        iniciais: iniciaisDe(nome), nivelLeitura: nivelLeitura || 1,
        leituras: { create: [{ data: dataRegistro ? parseBR(dataRegistro) : new Date(), nivel: nivelLeitura || 1 }] },
      },
    });
    reply.code(201);
    return aluno;
  });

  fastify.patch('/admin/alunos/:id', {
    preHandler: admin,
    schema: {
      body: {
        type: 'object',
        properties: {
          nome: { type: 'string' }, turma: { type: 'string' }, numero: { type: 'integer' },
        },
      },
    },
  }, async (request, reply) => {
    const { nome, turma, numero } = request.body;
    const aluno = await p.aluno.update({
      where: { id: request.params.id },
      data: {
        ...(nome !== undefined ? { nome, iniciais: iniciaisDe(nome) } : {}),
        ...(turma !== undefined ? { turmaId: turma } : {}),
        ...(numero !== undefined ? { numero } : {}),
      },
    }).catch(() => null);
    if (!aluno) return reply.notFound('Aluno não encontrado.');
    return aluno;
  });

  fastify.delete('/admin/alunos/:id', { preHandler: admin }, async (request, reply) => {
    await p.aluno.delete({ where: { id: request.params.id } }).catch(() => null);
    return { ok: true };
  });

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
