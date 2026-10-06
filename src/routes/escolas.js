/* ============================================================
   Escolas — listagem e detalhe (espelho do SAG, consulta).
   Sem ?detalhe=alunos as turmas trazem só a contagem de alunos
   (payload leve para o dashboard); com ele, o roster sem dados
   de nível de leitura. Professores = professores DISTINTOS com
   turma vinculada na escola (lib/indicadores.js).
   Só escolas, turmas e alunos VISÍVEIS: os excluídos no SAG
   (lib/ativos.js) ficam fora; detalhe de escola oculta → 404.
   ============================================================ */
import { shapeEscola } from '../lib/agregacoes.js';
import { contarProfessoresPorEscola } from '../lib/indicadores.js';
import { soEscolasVisiveis, turmasVisiveisDaEscola, alunosVisiveisDaTurma } from '../lib/ativos.js';

const SELECT_ALUNO = { id: true, nome: true, numero: true, iniciais: true };
const ORDEM_TURMAS = [{ ano: 'asc' }, { nome: 'asc' }];
const GRUPO = { select: { id: true, nome: true, cor: true } };

const turmasInclude = incluirAlunos => ({
  ...turmasVisiveisDaEscola(),
  orderBy: ORDEM_TURMAS,
  ...(incluirAlunos
    ? { include: { alunos: { ...alunosVisiveisDaTurma(), select: SELECT_ALUNO, orderBy: { numero: 'asc' } } } }
    : { include: { _count: { select: { alunos: alunosVisiveisDaTurma() } } } }),
});

export default async function escolasRoutes(fastify) {
  const p = fastify.prisma;

  // ---------- GET /escolas ---------- (rede inteira: admin/secretaria)
  fastify.get('/escolas', {
    preHandler: [fastify.authenticate, fastify.requirePerfil()],
    schema: {
      querystring: { type: 'object', properties: { detalhe: { type: 'string' } } },
    },
  }, async request => {
    const incluirAlunos = request.query.detalhe === 'alunos';
    const escolas = await p.escola.findMany({
      where: soEscolasVisiveis(),
      include: { grupo: GRUPO, turmas: turmasInclude(incluirAlunos) },
      orderBy: { id: 'asc' },
    });
    const profs = await contarProfessoresPorEscola(p, escolas.flatMap(e => e.turmas.map(t => ({ id: t.id, escolaId: e.id }))));
    return escolas.map(e => shapeEscola(e, e.turmas, { incluirAlunos, professores: profs.daEscola(e.id) }));
  });

  // ---------- GET /escolas/:id ---------- (detalhe da rede: admin/secretaria)
  fastify.get('/escolas/:id', { preHandler: [fastify.authenticate, fastify.requirePerfil()] }, async (request, reply) => {
    const e = await p.escola.findFirst({
      where: soEscolasVisiveis({ id: request.params.id }),
      include: { grupo: GRUPO, turmas: turmasInclude(true) },
    });
    if (!e) return reply.notFound('Escola não encontrada.');
    const profs = await contarProfessoresPorEscola(p, e.turmas.map(t => ({ id: t.id, escolaId: e.id })));
    return shapeEscola(e, e.turmas, { incluirAlunos: true, professores: profs.daEscola(e.id) });
  });
}
