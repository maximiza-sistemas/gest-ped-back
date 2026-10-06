/* ============================================================
   GET /rede — agregados reais da rede + indicadores por escola
   (região do SAG, grupo da plataforma, turmas, alunos,
   professores com turma vinculada, avaliações, alunos avaliados
   e % de atingimento). Mesma fonte do relatório CSV da rede
   (lib/indicadores.js). Sem zona e sem nível de leitura.
   ============================================================ */
import { indicadoresEscolas } from '../lib/indicadores.js';

export default async function redeRoutes(fastify) {
  const p = fastify.prisma;

  // agregado da rede inteira — restrito a perfis de rede (admin/secretaria)
  fastify.get('/rede', { preHandler: [fastify.authenticate, fastify.requirePerfil()] }, async () => {
    const [{ escolas, totais }, configRows] = await Promise.all([indicadoresEscolas(p), p.config.findMany()]);
    const config = Object.fromEntries(configRows.map(c => [c.chave, c.valor]));
    return {
      municipio: config.municipio, secretaria: config.secretaria, uf: config.uf, ano: config.anoLetivo,
      escolas: totais.escolas,
      alunos: totais.alunos,
      turmas: totais.turmas,
      // professores DISTINTOS com turma vinculada na plataforma (não é soma por escola)
      professores: totais.professores,
      avaliacoes: totais.avaliacoes,
      alunosAvaliados: totais.alunosAvaliados,
      pctAtingiu: totais.pctAtingiu,
      porEscola: escolas,
    };
  });
}
