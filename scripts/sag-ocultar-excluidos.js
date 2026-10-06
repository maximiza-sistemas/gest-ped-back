/* ============================================================
   Espelho do SAG — registros EXCLUÍDOS na origem (deleted=true)
   ficam OCULTOS na plataforma, sem apagar nada. Idempotente.
   Decisão do usuário: "Ocultar sem apagar".

   A sincronização (src/lib/sagsync.js) grava Escola/Turma/Aluno
   .excluidoNoSag = true quando o próprio registro OU o pai (turma /
   escola) está deleted=true no SAG, e false caso contrário. Nada é
   apagado por isso: avaliações, eventos e timeline de turmas e
   alunos excluídos ficam guardados (ocultos de telas e contagens).
   A remoção continua só para ids que SUMIRAM da origem.

   ORDEM EM PRODUÇÃO (o servidor sincroniza o SAG na SUBIDA —
   src/server.js —, então o "antes" precisa ser gravado ANTES de o
   código novo subir):
     a) com o código ANTIGO ainda no ar, rodar este script com
        --so-backup (só lê o banco; não depende do sagsync.js novo);
     b) fazer o deploy (o servidor novo sincroniza ao subir);
     c) rodar este script sem --so-backup (novo backup + sincronização,
        que não muda mais nada se o servidor já rodou, + relatório das
        contagens visíveis/ocultas).
   Se o passo (a) for esquecido, o script avisa que o backup já
   reflete a regra nova e NÃO serve de "antes".

   BACKUP em JSON de tudo o que a sincronização completa pode alterar
   ou remover — Escola, Turma, Aluno e, em cascata da remoção de ids
   ausentes, Avaliacao e LeituraRegistro — em
   <dir>/sag-excluidos-<Tabela>.json. Backup existente NUNCA é
   sobrescrito (a cópia nova ganha carimbo de data no nome).

   Uso (de dentro de backend/):
     node scripts/sag-ocultar-excluidos.js --backup-dir <pasta> [--so-backup]
   ============================================================ */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { PrismaClient } from '@prisma/client';

export const FRENTE = 'sag-excluidos';

/** Caminho livre para o backup: o nome canônico ou, se já existir, com carimbo de data. */
export function caminhoBackup(dir, tabela, agora = new Date()) {
  const base = path.join(dir, `${FRENTE}-${tabela}.json`);
  if (!fs.existsSync(base)) return base;
  const carimbo = agora.toISOString().replace(/[:.]/g, '-');
  return path.join(dir, `${FRENTE}-${tabela}-${carimbo}.json`);
}

/**
 * Backup completo (nada é alterado) das tabelas que a sincronização pode
 * alterar ou remover.
 * @returns {Promise<Record<string, string>>} tabela → arquivo gravado
 */
export async function salvarBackup(prisma, dir, origem) {
  fs.mkdirSync(dir, { recursive: true });
  const [escolas, turmas, alunos, avaliacoes, leituras] = await Promise.all([
    prisma.escola.findMany({ orderBy: { id: 'asc' } }),
    prisma.turma.findMany({ orderBy: { id: 'asc' } }),
    prisma.aluno.findMany({ orderBy: { id: 'asc' } }),
    prisma.avaliacao.findMany({ orderBy: { id: 'asc' } }),
    prisma.leituraRegistro.findMany({ orderBy: { id: 'asc' } }),
  ]);
  const em = new Date();
  const arquivos = {};
  for (const [tabela, linhas] of [
    ['Escola', escolas], ['Turma', turmas], ['Aluno', alunos],
    ['Avaliacao', avaliacoes], ['LeituraRegistro', leituras],
  ]) {
    const arq = caminhoBackup(dir, tabela, em);
    fs.writeFileSync(arq, JSON.stringify({ em: em.toISOString(), origem, total: linhas.length, linhas }, null, 1), { flag: 'wx' });
    arquivos[tabela] = arq;
  }
  return arquivos;
}

/**
 * Contagens visíveis × ocultas (excluidoNoSag) de escolas, turmas e alunos.
 * Visível = o próprio registro e os pais não excluídos (mesma regra de lib/ativos.js).
 */
export async function contagens(prisma) {
  const [escolas, escolasOcultas, turmas, turmasVisiveis, alunos, alunosVisiveis] = await Promise.all([
    prisma.escola.count(),
    prisma.escola.count({ where: { excluidoNoSag: true } }),
    prisma.turma.count(),
    prisma.turma.count({ where: { excluidoNoSag: false, escola: { excluidoNoSag: false } } }),
    prisma.aluno.count(),
    prisma.aluno.count({ where: { excluidoNoSag: false, turma: { excluidoNoSag: false, escola: { excluidoNoSag: false } } } }),
  ]);
  return {
    escolas: { total: escolas, visiveis: escolas - escolasOcultas, ocultas: escolasOcultas },
    turmas: { total: turmas, visiveis: turmasVisiveis, ocultas: turmas - turmasVisiveis },
    alunos: { total: alunos, visiveis: alunosVisiveis, ocultos: alunos - alunosVisiveis },
  };
}

function lerArgs(argv) {
  const i = argv.indexOf('--backup-dir');
  return { dir: i >= 0 ? argv[i + 1] : null, soBackup: argv.includes('--so-backup') };
}

async function main() {
  const { dir, soBackup } = lerArgs(process.argv.slice(2));
  if (!dir) {
    console.error(`[${FRENTE}] informe --backup-dir <pasta> (o backup é obrigatório antes de qualquer alteração).`);
    process.exitCode = 1;
    return;
  }
  const prisma = new PrismaClient();
  try {
    const antes = await contagens(prisma);
    const jaMarcado = antes.escolas.ocultas + antes.turmas.ocultas + antes.alunos.ocultos > 0;
    const origem = (soBackup ? `antes da frente ${FRENTE} (só backup)` : `antes da aplicação ${FRENTE}`)
      + (jaMarcado ? ' — banco já com registros marcados excluidoNoSag: o servidor novo já sincronizou' : '');
    const arquivos = await salvarBackup(prisma, dir, origem);
    console.log(`[${FRENTE}] backup gravado:`, arquivos);
    console.log(`[${FRENTE}] contagens antes:`, JSON.stringify(antes));
    if (jaMarcado) {
      console.warn(`[${FRENTE}] ATENÇÃO: já há registros com excluidoNoSag=true — o servidor novo já sincronizou.`
        + ' Este backup NÃO é o "antes": use o backup feito com --so-backup antes do deploy.');
    }
    if (soBackup) return;

    // import tardio: o backup não depende do código novo da sincronização
    const { sincronizarSag } = await import('../src/lib/sagsync.js');
    const sync = await sincronizarSag(prisma);
    if (!sync.ok) throw new Error(sync.motivo || sync.erro || 'sincronização falhou');
    console.log(`[${FRENTE}] sincronização:`, JSON.stringify({ escolas: sync.escolas, turmas: sync.turmas, alunos: sync.alunos, avisos: sync.avisos }));
    console.log(`[${FRENTE}] contagens depois:`, JSON.stringify(await contagens(prisma)));
  } finally {
    await prisma.$disconnect();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(err => {
    console.error(`[${FRENTE}] falhou:`, err.message);
    process.exitCode = 1;
  });
}
