/* ============================================================
   Relatórios reais em CSV (UTF-8 com BOM, separador ';').

   GET /relatorios/rede        — uma linha por escola + total da
                                 rede. Só admin/secretaria.
   GET /relatorios/escola/:id  — uma linha por turma + total da
                                 escola. Admin/secretaria (qualquer
                                 escola); supervisor e gestor escolar
                                 só das escolas vinculadas (403).

   Os números saem de lib/indicadores.js — a mesma fonte de
   GET /rede e do detalhe da escola, para o arquivo bater com a
   tela — inclusive na regra de visibilidade: escolas, turmas e
   alunos excluídos no SAG não entram (escola oculta → 404).
   ============================================================ */
import { gerarCsv, dataArquivo, slugArquivo } from '../lib/csv.js';
import { indicadoresEscolas, indicadoresTurmasEscola } from '../lib/indicadores.js';
import { gestorEscolas } from '../lib/escopo.js';
import { soEscolasVisiveis } from '../lib/ativos.js';
import { turmaRotulo, regiaoRotulo, grupoRotulo, turnoRotulo, rotuladorDeAnos } from '../lib/rotulos.js';
import { lerAnos } from './anos.js';

export const COLUNAS_REDE = [
  'Escola', 'Região', 'Grupo', 'Turmas', 'Alunos', 'Professores com turma',
  'Avaliações', 'Alunos avaliados', '% de atingimento',
];

export const COLUNAS_ESCOLA = [
  'Turma', 'Ano', 'Turno', 'Alunos', 'Alunos avaliados', '% aplicado',
  'Alunos que atingiram', 'Alunos que não atingiram', 'Avaliações', '% de atingimento', 'Código da turma',
];

const enviarCsv = (reply, nomeArquivo, csv) => reply
  .header('content-type', 'text/csv; charset=utf-8')
  .header('content-disposition', `attachment; filename="${nomeArquivo}"`)
  .header('cache-control', 'no-store')
  .send(csv);

export default async function relatoriosRoutes(fastify) {
  const p = fastify.prisma;

  // ---------- GET /relatorios/rede ---------- (admin/secretaria)
  fastify.get('/relatorios/rede', { preHandler: [fastify.authenticate, fastify.requirePerfil()] }, async (request, reply) => {
    const { escolas, totais } = await indicadoresEscolas(p);
    const linhas = escolas.map(e => [
      e.nome, regiaoRotulo(e.regiao), grupoRotulo(e.grupo), e.totTurmas, e.totAlunos, e.professores,
      e.avaliacoes, e.alunosAvaliados, e.pctAtingiu,
    ]);
    const total = [
      'Total da rede', '', '', totais.turmas, totais.alunos, totais.professores,
      totais.avaliacoes, totais.alunosAvaliados, totais.pctAtingiu,
    ];
    return enviarCsv(reply, `relatorio-rede-${dataArquivo()}.csv`, gerarCsv(COLUNAS_REDE, [...linhas, total]));
  });

  // ---------- GET /relatorios/escola/:id ---------- (rede + supervisor/gestor das suas escolas)
  fastify.get('/relatorios/escola/:id', {
    preHandler: [fastify.authenticate, fastify.requirePerfil('supervisor', 'gestor')],
    schema: { params: { type: 'object', required: ['id'], properties: { id: { type: 'string', minLength: 1, maxLength: 100 } } } },
  }, async (request, reply) => {
    const { id } = request.params;
    const escopo = gestorEscolas(request.user); // null = rede (admin/secretaria)
    if (escopo && !escopo.includes(id)) return reply.forbidden('Escola fora das suas escolas vinculadas.');

    // escola excluída no SAG (oculta — lib/ativos.js) responde como inexistente
    const escola = await p.escola.findFirst({ where: soEscolasVisiveis({ id }), select: { id: true, sigla: true } });
    if (!escola) return reply.notFound('Escola não encontrada.');

    const [{ turmas, totais }, anos] = await Promise.all([indicadoresTurmasEscola(p, id), lerAnos(p)]);
    const anoRotulo = rotuladorDeAnos(anos);
    const linhas = turmas.map(t => [
      turmaRotulo(t.nome), anoRotulo(t.ano), turnoRotulo(t.turno), t.alunos, t.alunosAvaliados, t.pctAplicado,
      t.alunosAtingiram, t.alunosNaoAtingiram, t.avaliacoes, t.pctAtingiu, t.id,
    ]);
    const total = [
      'Total da escola', '', '', totais.alunos, totais.alunosAvaliados, totais.pctAplicado,
      totais.alunosAtingiram, totais.alunosNaoAtingiram, totais.avaliacoes, totais.pctAtingiu, '',
    ];
    const nome = `relatorio-escola-${slugArquivo(escola.sigla, slugArquivo(escola.id))}-${dataArquivo()}.csv`;
    return enviarCsv(reply, nome, gerarCsv(COLUNAS_ESCOLA, [...linhas, total]));
  });
}
