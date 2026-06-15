/* ============================================================
   GET /rede — agregados da rede inteira + ranking por escola.
   Shape espelha network.js rede(), com porEscola embutido.
   ============================================================ */
import { distFromGroupBy } from '../lib/agregacoes.js';

export default async function redeRoutes(fastify) {
  const p = fastify.prisma;

  // agregado da rede inteira — restrito a perfis de rede (admin/secretaria)
  fastify.get('/rede', { preHandler: [fastify.authenticate, fastify.requirePerfil()] }, async () => {
    const [escolas, distRows, totAlunos, totTurmas, configRows] = await Promise.all([
      p.escola.findMany({
        include: { turmas: { include: { alunos: { select: { nivelLeitura: true } } } } },
        orderBy: { id: 'asc' },
      }),
      p.aluno.groupBy({ by: ['nivelLeitura'], _count: { _all: true } }),
      p.aluno.count(),
      p.turma.count(),
      p.config.findMany(),
    ]);
    const config = Object.fromEntries(configRows.map(c => [c.chave, c.valor]));

    let alfA = 0, alfT = 0, profs = 0;
    const porEscola = escolas.map(e => {
      profs += e.qtdProfessores;
      const dist = [0, 0, 0, 0, 0, 0];
      let tot = 0, eAlfA = 0, eAlfT = 0;
      for (const t of e.turmas) {
        for (const a of t.alunos) {
          dist[a.nivelLeitura - 1]++; tot++;
          if (t.ano <= 3) {
            eAlfT++; alfT++;
            if (a.nivelLeitura >= 4) { eAlfA++; alfA++; }
          }
        }
      }
      return {
        id: e.id, nome: e.nome, sigla: e.sigla, zona: e.zona, bairro: e.bairro,
        diretor: e.diretor, cor: e.cor, professores: e.qtdProfessores,
        totAlunos: tot, totTurmas: e.turmas.length, dist,
        alfInicial: eAlfT ? Math.round((eAlfA / eAlfT) * 100) : 0,
      };
    });

    return {
      municipio: config.municipio, secretaria: config.secretaria, uf: config.uf, ano: config.anoLetivo,
      escolas: escolas.length,
      alunos: totAlunos,
      turmas: totTurmas,
      professores: profs,
      dist: distFromGroupBy(distRows),
      alfInicial: alfT ? Math.round((alfA / alfT) * 100) : 0,
      porEscola,
    };
  });
}
