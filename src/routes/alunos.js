/* ============================================================
   Alunos — listagem com filtros e ficha completa.
   Sem nível de leitura (retirado da plataforma): o filtro
   ?nivel= deixou de existir e nenhum campo de leitura é enviado.
   Escopo: supervisor/gestor escolar só as escolas vinculadas;
   professor só as turmas em que leciona (Professor.turmaIds).
   Só alunos VISÍVEIS: excluídos no SAG (o aluno, a turma ou a
   escola — lib/ativos.js) ficam fora da lista e da busca; a ficha
   de aluno oculto responde 404.
   ============================================================ */
import { gestorEscolas, alunoNoEscopo, contextoProfessor } from '../lib/escopo.js';
import { soAlunosVisiveis } from '../lib/ativos.js';

export default async function alunosRoutes(fastify) {
  const p = fastify.prisma;

  // ---------- GET /alunos?escola=&turma=&busca=&limit=&offset= ----------
  fastify.get('/alunos', {
    preHandler: [fastify.authenticate],
    schema: {
      querystring: {
        type: 'object',
        // filtros desconhecidos (ex.: o antigo ?nivel=) são descartados, não aplicados
        additionalProperties: false,
        properties: {
          escola: { type: 'string' }, turma: { type: 'string' },
          busca: { type: 'string' },
          limit: { type: 'integer', default: 50 }, offset: { type: 'integer', default: 0 },
        },
      },
    },
  }, async (request, reply) => {
    const { escola, turma, busca, limit, offset } = request.query;
    const escopo = gestorEscolas(request.user); // null p/ perfis sem escopo por escola
    let escolaIn;
    if (escopo) escolaIn = escola && escopo.includes(escola) ? [escola] : escopo;
    else if (escola) escolaIn = [escola];

    // professor: só alunos das turmas em que leciona (sem turmas = lista vazia)
    let turmaIn = turma ? [turma] : null;
    if (request.user.perfil === 'professor') {
      const { turmaIds } = await contextoProfessor(p, request.user.profId);
      if (turma && !turmaIds.includes(turma)) return reply.forbidden('Turma fora das turmas em que você leciona.');
      turmaIn = turma ? [turma] : turmaIds;
    }

    const where = soAlunosVisiveis({
      ...(turmaIn ? { turmaId: { in: turmaIn } } : {}),
      ...(escolaIn ? { turma: { escolaId: { in: escolaIn } } } : {}),
      ...(busca ? { nome: { contains: busca, mode: 'insensitive' } } : {}),
    });
    const [total, rows] = await Promise.all([
      p.aluno.count({ where }),
      p.aluno.findMany({
        where,
        include: { turma: { include: { escola: true } } },
        orderBy: [{ turmaId: 'asc' }, { numero: 'asc' }],
        take: limit, skip: offset,
      }),
    ]);
    return {
      total,
      alunos: rows.map(a => ({
        id: a.id, nome: a.nome, numero: a.numero, iniciais: a.iniciais,
        ano: a.turma.ano, turma: a.turmaId,
        turmaNome: a.turma.nome, turno: a.turma.turno,
        escola: a.turma.escolaId, escolaNome: a.turma.escola.nome, escolaCor: a.turma.escola.cor, escolaSigla: a.turma.escola.sigla,
      })),
    };
  });

  // ---------- GET /alunos/:id/full ----------
  fastify.get('/alunos/:id/full', { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const a = await p.aluno.findFirst({
      where: soAlunosVisiveis({ id: request.params.id }),
      include: { turma: { include: { escola: true } } },
    });
    if (!a) return reply.notFound('Aluno não encontrado.');

    // supervisor/gestor escolar: escolas vinculadas; professor: suas turmas
    const acesso = await alunoNoEscopo(p, request.user, a);
    if (!acesso.ok) return reply.forbidden(acesso.mensagem);
    return {
      id: a.id, nome: a.nome, numero: a.numero, iniciais: a.iniciais,
      ano: a.turma.ano, turma: a.turmaId,
      escola: a.turma.escolaId, escolaNome: a.turma.escola.nome,
      turmaNome: a.turma.nome, turno: a.turma.turno,
    };
  });
}
