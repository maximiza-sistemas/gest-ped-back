/* ============================================================
   Seed (idempotente) — exemplos de Orientações e Trilhas.
   Só insere se a tabela Orientacao estiver vazia; não apaga nada.
   Uso:  node prisma/seed-orientacoes.js
   ============================================================ */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const existentes = await prisma.orientacao.count();
  if (existentes > 0) {
    console.log(`Já existem ${existentes} orientação(ões) — nada a fazer.`);
    return;
  }

  console.log('Criando orientações de exemplo...');

  // 1) Escopo específico (escola e1, 1º ano, LP) com habilidades + trilha do professor p1
  await prisma.orientacao.create({
    data: {
      titulo: 'Consolidar a decodificação na alfabetização',
      objetivo: 'Priorizar a relação fonema–grafema e a leitura de palavras de uso frequente nas turmas de 1º ano, garantindo a base da decodificação antes do trabalho com frases.',
      escopo: 'escolas',
      escolaIds: JSON.stringify(['e1']),
      anos: JSON.stringify([1]),
      compId: 'lp',
      modoGeral: false,
      habilidades: JSON.stringify(['EF01LP07', 'EF12LP01', 'hl02']),
      periodoId: 'm06',
      criadoPorId: 'u-gestor',
      status: 'ativa',
      trilhas: {
        create: [{
          profId: 'p1',
          observacao: 'Trilha pensada para aplicação ao longo do 1º bimestre, com sondagem inicial e verificação ao final.',
          status: 'publicada',
          etapas: {
            create: [
              { ordem: 0, titulo: 'Sondagem inicial', descricao: 'Aplicar leitura de palavras isoladas para mapear o ponto de partida de cada aluno.' },
              { ordem: 1, titulo: 'Jogos fonêmicos', descricao: 'Trabalhar sons iniciais e finais com cartões e bingo do alfabeto, 3x por semana.' },
              { ordem: 2, titulo: 'Leitura de palavras frequentes', descricao: 'Baralho de palavras de alta frequência, em duplas, com registro do desempenho.' },
              { ordem: 3, titulo: 'Verificação contínua', descricao: 'Reaplicar a leitura de palavras e comparar com a sondagem inicial.' },
            ],
          },
        }],
      },
    },
  });

  // 2) Escopo geral (toda a rede) em modo geral, sem habilidade específica — ainda sem trilha
  await prisma.orientacao.create({
    data: {
      titulo: 'Rotina diária de leitura em voz alta',
      objetivo: 'Implementar 15 minutos diários de leitura mediada pelo professor em todas as turmas, como prática permanente de formação de leitores.',
      escopo: 'geral',
      escolaIds: JSON.stringify([]),
      anos: JSON.stringify([]),
      compId: 'lp',
      modoGeral: true,
      habilidades: JSON.stringify([]),
      periodoId: null,
      criadoPorId: 'u-gestor',
      status: 'ativa',
    },
  });

  const [nOri, nTri] = await Promise.all([prisma.orientacao.count(), prisma.trilha.count()]);
  console.log(`--- Concluído --- Orientações: ${nOri} | Trilhas: ${nTri}`);
}

main()
  .catch(e => { console.error(e); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); });
