/* ============================================================
   GET /professores/resumo — trabalho real de cada professor,
   calculado do banco (nada estimado):
     · turmas (no escopo do usuário) e alunos
     · habilidades direcionadas (planos ativos do grupo/ano/componente)
       × habilidades já avaliadas → progresso
     · avaliações registradas, alunos avaliados, última avaliação
   Escopo: supervisor/gestor escolar → só turmas das suas escolas; professor → ele
   mesmo; admin/secretaria → rede toda, só professores REAIS (turma existente
   ou conta de usuário — lib/professores.js).
   Só turmas, alunos e avaliações VISÍVEIS (lib/ativos.js): turma
   excluída no SAG não conta como turma do professor.
   ============================================================ */
import { fmtBR } from '../lib/datas.js';
import { soTurmasVisiveis, soAvaliacoesVisiveis, alunosVisiveisDaTurma } from '../lib/ativos.js';
import { gestorEscolas, planoNoEscopo, planoCasaAnos } from '../lib/escopo.js';
import { classificarProfessores } from '../lib/professores.js';

export default async function professoresRoutes(fastify) {
  const p = fastify.prisma;

  fastify.get('/professores/resumo', { preHandler: [fastify.authenticate] }, async request => {
    const escopo = gestorEscolas(request.user); // null = rede / professor
    const soEu = request.user.perfil === 'professor' ? request.user.profId : null;

    const [professores, turmas, planos, habilidades] = await Promise.all([
      p.professor.findMany({ include: { usuario: { select: { id: true } } } }),
      p.turma.findMany({
        where: soTurmasVisiveis(escopo ? { escolaId: { in: escopo } } : {}),
        select: { id: true, nome: true, ano: true, escolaId: true, escola: { select: { nome: true, grupoId: true } }, _count: { select: { alunos: alunosVisiveisDaTurma() } } },
      }),
      p.planejamento.findMany({ where: { status: 'ativo' }, select: { grupos: true, anos: true, habilidades: { select: { habCod: true } } } }),
      p.habilidade.findMany({ select: { cod: true, compId: true } }),
    ]);
    const turmaById = new Map(turmas.map(t => [t.id, t]));
    const compDaHab = new Map(habilidades.map(h => [h.cod, h.compId]));

    // professores visíveis: com turma no escopo (supervisor/gestor), ele mesmo (professor),
    // os REAIS na rede — turma existente ou conta de usuário (lib/professores.js)
    const lista = classificarProfessores(professores, new Set(turmaById.keys()))
      .filter(pr => (soEu ? pr.id === soEu : escopo ? pr.turmaIds.length > 0 : pr.real));

    // avaliações das turmas desses professores, agregadas por turma
    const turmaIds = [...new Set(lista.flatMap(pr => pr.turmaIds))];
    // Avaliacao não guarda a turma: chega pela turma atual do aluno
    const avaliacoes = turmaIds.length
      ? await p.avaliacao.findMany({
          where: soAvaliacoesVisiveis({ aluno: { turmaId: { in: turmaIds } } }),
          select: { habCod: true, alunoId: true, data: true, aluno: { select: { turmaId: true } } },
        })
      : [];
    const porTurma = new Map();
    for (const av of avaliacoes) {
      const acc = porTurma.get(av.aluno.turmaId) || { n: 0, habs: new Set(), alunos: new Set(), ultima: null };
      acc.n += 1;
      acc.habs.add(av.habCod);
      acc.alunos.add(av.alunoId);
      if (!acc.ultima || av.data > acc.ultima) acc.ultima = av.data;
      porTurma.set(av.aluno.turmaId, acc);
    }

    return lista.map(pr => {
      const ts = pr.turmaIds.map(id => turmaById.get(id));
      const grupos = new Set(ts.map(t => t.escola.grupoId).filter(Boolean));
      const anos = new Set(ts.map(t => t.ano));

      // habilidades direcionadas: planos ativos que casam grupo e ano de alguma turma, do componente do professor
      const direcionadas = new Set();
      for (const pl of planos) {
        if (!planoNoEscopo(pl.grupos, grupos) || !planoCasaAnos(pl.anos, anos)) continue;
        for (const h of pl.habilidades) if (compDaHab.get(h.habCod) === pr.compId) direcionadas.add(h.habCod);
      }

      const avaliadas = new Set();
      const alunos = new Set();
      let n = 0, ultima = null;
      for (const t of ts) {
        const acc = porTurma.get(t.id);
        if (!acc) continue;
        n += acc.n;
        acc.habs.forEach(h => avaliadas.add(h));
        acc.alunos.forEach(al => alunos.add(al));
        if (!ultima || acc.ultima > ultima) ultima = acc.ultima;
      }
      const trabalhadas = [...direcionadas].filter(h => avaliadas.has(h)).length;

      return {
        id: pr.id, nome: pr.nome, comp: pr.compId, cor: pr.cor, iniciais: pr.iniciais,
        turmas: ts.map(t => ({ id: t.id, nome: t.nome, ano: t.ano, escolaId: t.escolaId, escolaNome: t.escola.nome, alunos: t._count.alunos })),
        habilidadesDirecionadas: direcionadas.size,
        habilidadesTrabalhadas: trabalhadas,
        progresso: direcionadas.size ? Math.round((trabalhadas / direcionadas.size) * 100) : null,
        avaliacoes: n,
        alunosAvaliados: alunos.size,
        ultimaAvaliacao: ultima ? fmtBR(ultima) : null,
      };
    });
  });
}
