/* ============================================================
   Espelho do SAG — região no lugar de zona; turno e série sem
   valores inventados. Aplicação idempotente.

   ORDEM EM PRODUÇÃO (o servidor sincroniza o SAG na SUBIDA —
   src/server.js —, então o "antes" precisa ser gravado ANTES de o
   código novo subir):
     a) com o código ANTIGO ainda no ar (ou com a sincronização
        automática pausada: SAG_DATABASE_URL vazio temporariamente),
        rodar este script com --so-backup (só lê o banco; não
        depende do lib/sagsync.js novo);
     b) fazer o deploy (o servidor novo sincroniza ao subir);
     c) rodar este script sem --so-backup (catálogo + relatório; a
        sincronização dele não muda mais nada se o servidor já rodou).
   Se o passo (a) for esquecido, o script avisa que o backup já
   reflete as regras novas e NÃO serve de "antes".

   1. BACKUP em JSON de tudo o que a sincronização completa pode
      alterar ou remover: Escola, Turma, Config (anosEscolares) e,
      em cascata da remoção de ausentes, Aluno, Avaliacao e
      LeituraRegistro — em <dir>/sag-espelho-<Tabela>.json. Um backup
      existente NUNCA é sobrescrito: a nova cópia ganha o carimbo de
      data no nome (o arquivo sem carimbo continua sendo o "antes"
      da primeira vez).
   2. Sincroniza o espelho com as regras novas (lib/sagsync.js):
        Escola.regiao = regioes.nome via escolas.regiao_id (região
          deletada ou inexistente → ''); Escola.zona = '' (legado);
        Turma.turno   = turno da origem ('' quando vazio/desconhecido);
        Turma.ano     = série real (0 só p/ turma de habilidades /
          multisseriada; creche/pré → Educação Infantil; 99 p/ série
          não reconhecida).
      A sincronização só toca ids "sag-" (registros locais intactos),
      mas é a COMPLETA: também cria/atualiza alunos e remove os ids
      ausentes na origem (com cascata Aluno → Avaliacao).
   3. Catálogo Config.anosEscolares: acrescenta 99 "Não classificada"
      e, se alguma turma usar, 15 "Educação Infantil (etapa não
      informada)". Nunca altera nem remove as entradas existentes.
   4. Relatório: distribuição das escolas por região e das turmas
      por turno e por série.

   Uso (de dentro de backend/):
     node scripts/sag-regiao-turno-serie.js --backup-dir <pasta> [--so-backup]
   --so-backup  só grava o backup (nada é alterado no banco).
   ============================================================ */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { PrismaClient } from '@prisma/client';
import { ANO_INFANTIL_SEM_ETAPA, ANO_NAO_CLASSIFICADO, ROTULOS_ESPECIAIS } from '../src/lib/series.js';

export const FRENTE = 'sag-espelho';
const CHAVE_ANOS = 'anosEscolares';

const parseJSON = (s, fb) => { try { return JSON.parse(s); } catch { return fb; } };

/** Caminho livre para o backup: o nome canônico ou, se já existir, com carimbo de data. */
export function caminhoBackup(dir, tabela, agora = new Date()) {
  const base = path.join(dir, `${FRENTE}-${tabela}.json`);
  if (!fs.existsSync(base)) return base;
  const carimbo = agora.toISOString().replace(/[:.]/g, '-');
  return path.join(dir, `${FRENTE}-${tabela}-${carimbo}.json`);
}

/**
 * Grava o backup (completo) de tudo o que a sincronização pode alterar ou
 * remover: Escola, Turma, Config e, em cascata, Aluno, Avaliacao e
 * LeituraRegistro — nada é alterado.
 * @returns {Promise<Record<string, string>>} tabela → arquivo gravado
 */
export async function salvarBackup(prisma, dir, origem) {
  fs.mkdirSync(dir, { recursive: true });
  const [escolas, turmas, config, alunos, avaliacoes, leituras] = await Promise.all([
    prisma.escola.findMany({ orderBy: { id: 'asc' } }),
    prisma.turma.findMany({ orderBy: { id: 'asc' } }),
    prisma.config.findMany({ orderBy: { chave: 'asc' } }),
    prisma.aluno.findMany({ orderBy: { id: 'asc' } }),
    prisma.avaliacao.findMany({ orderBy: { id: 'asc' } }),
    prisma.leituraRegistro.findMany({ orderBy: { id: 'asc' } }),
  ]);
  const em = new Date();
  const arquivos = {};
  for (const [tabela, linhas] of [
    ['Escola', escolas], ['Turma', turmas], ['Config', config],
    ['Aluno', alunos], ['Avaliacao', avaliacoes], ['LeituraRegistro', leituras],
  ]) {
    const arq = caminhoBackup(dir, tabela, em);
    fs.writeFileSync(arq, JSON.stringify({ em: em.toISOString(), origem, total: linhas.length, linhas }, null, 1), { flag: 'wx' });
    arquivos[tabela] = arq;
  }
  return arquivos;
}

/**
 * O banco já está com as regras novas? (zona legada vazia em todas as escolas
 * do espelho = o servidor novo já sincronizou; o backup não é o "antes").
 * Função pura (sem banco).
 * @param {{id:string, zona:string}[]} escolas
 */
export function jaSincronizadoComRegrasNovas(escolas) {
  const espelho = (escolas || []).filter(e => String(e.id).startsWith('sag-'));
  return espelho.length > 0 && espelho.every(e => !e.zona);
}

/**
 * Entradas que faltam no catálogo para os códigos especiais: 99 sempre;
 * 15 só quando alguma turma usa. Função pura (sem banco).
 * @param {{ordem:number, nome:string}[]} catalogo
 * @param {Set<number>} anosEmUso
 */
export function entradasFaltantes(catalogo, anosEmUso) {
  const tem = new Set((catalogo || []).map(a => a.ordem));
  const exigidos = [ANO_NAO_CLASSIFICADO, ...(anosEmUso.has(ANO_INFANTIL_SEM_ETAPA) ? [ANO_INFANTIL_SEM_ETAPA] : [])];
  return exigidos.filter(o => !tem.has(o)).map(o => ({ ordem: o, nome: ROTULOS_ESPECIAIS[o] }));
}

/** Acrescenta ao Config.anosEscolares as entradas especiais que faltam (idempotente). */
export async function garantirCatalogo(prisma) {
  return prisma.$transaction(async tx => {
    const row = await tx.config.findUnique({ where: { chave: CHAVE_ANOS } });
    const catalogo = row ? parseJSON(row.valor, []) : [];
    if (!row || !Array.isArray(catalogo) || !catalogo.length) {
      // sem catálogo gravado a API usa o padrão; não inventa um catálogo inteiro aqui
      return { adicionados: [], aviso: `Config.${CHAVE_ANOS} ausente ou inválido — nada alterado.` };
    }
    const emUso = new Set((await tx.turma.groupBy({ by: ['ano'] })).map(g => g.ano));
    const faltam = entradasFaltantes(catalogo, emUso);
    if (!faltam.length) return { adicionados: [] };
    const novo = [...catalogo, ...faltam].sort((a, b) => a.ordem - b.ordem);
    await tx.config.update({ where: { chave: CHAVE_ANOS }, data: { valor: JSON.stringify(novo) } });
    return { adicionados: faltam };
  });
}

/** Distribuições após a aplicação (para o relatório). */
export async function relatorio(prisma) {
  const [regioes, turnos, anos, escolas, semRegiao, zonas] = await Promise.all([
    prisma.escola.groupBy({ by: ['regiao'], _count: { _all: true } }),
    prisma.turma.groupBy({ by: ['turno'], _count: { _all: true } }),
    prisma.turma.groupBy({ by: ['ano'], _count: { _all: true } }),
    prisma.escola.count(),
    prisma.escola.count({ where: { regiao: '' } }),
    prisma.escola.groupBy({ by: ['zona'], _count: { _all: true } }),
  ]);
  const dist = (rows, k) => Object.fromEntries(rows
    .map(r => [r[k] === '' ? '(vazio)' : r[k], r._count._all])
    .sort((a, b) => b[1] - a[1]));
  return {
    escolas, semRegiao,
    regioes: dist(regioes, 'regiao'),
    zonaLegado: dist(zonas, 'zona'),
    turnos: dist(turnos, 'turno'),
    anos: Object.fromEntries(anos.map(r => [r.ano, r._count._all]).sort((a, b) => a[0] - b[0])),
  };
}

function lerArgs(argv) {
  const i = argv.indexOf('--backup-dir');
  return { dir: i >= 0 ? argv[i + 1] : null, soBackup: argv.includes('--so-backup') };
}

async function main() {
  const { dir, soBackup } = lerArgs(process.argv.slice(2));
  if (!dir) {
    console.error('[sag-espelho] informe --backup-dir <pasta> (o backup é obrigatório antes de qualquer alteração).');
    process.exitCode = 1;
    return;
  }
  const prisma = new PrismaClient();
  try {
    const regrasNovas = jaSincronizadoComRegrasNovas(await prisma.escola.findMany({ select: { id: true, zona: true } }));
    const origem = (soBackup ? 'antes da frente sag-espelho (só backup)' : 'antes da aplicação sag-espelho')
      + (regrasNovas ? ' — banco já com zona vazia: o servidor novo já sincronizou (não é o "antes" da troca zona → região)' : '');
    const arquivos = await salvarBackup(prisma, dir, origem);
    console.log('[sag-espelho] backup gravado:', arquivos);
    if (regrasNovas) {
      console.warn('[sag-espelho] ATENÇÃO: as escolas do espelho já estão com zona vazia — o servidor novo já sincronizou.'
        + ' Este backup NÃO é o "antes": use o backup feito com --so-backup antes do deploy.');
    }
    if (soBackup) return;

    // import tardio: o backup não depende do código novo da sincronização
    const { sincronizarSag } = await import('../src/lib/sagsync.js');
    const sync = await sincronizarSag(prisma);
    if (!sync.ok) throw new Error(sync.motivo || sync.erro || 'sincronização falhou');
    console.log('[sag-espelho] sincronização:', JSON.stringify({ escolas: sync.escolas, turmas: sync.turmas, alunos: sync.alunos, avisos: sync.avisos }));

    const cat = await garantirCatalogo(prisma);
    console.log('[sag-espelho] catálogo de séries:', cat.aviso || (cat.adicionados.length ? 'acrescentado ' + JSON.stringify(cat.adicionados) : 'já completo (nada alterado)'));

    console.log('[sag-espelho] relatório:', JSON.stringify(await relatorio(prisma), null, 1));
  } finally {
    await prisma.$disconnect();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(err => {
    console.error('[sag-espelho] falhou:', err.message);
    process.exitCode = 1;
  });
}
