/* ============================================================
   Limpeza dos dados fictícios do seed/protótipo — idempotente
   (reaplicável em produção). Decisão do usuário: "apague os
   professores fictícios".

   Remove SOMENTE:
   1. Professores fictícios do seed (p2 "Rafael Souza", p3 "Beatriz
      Almeida"), conferindo id E nome, e só quando NÃO são reais e
      NÃO têm referência nenhuma:
        · sem conta de usuário (Usuario.profId);
        · sem turma existente vinculada (Professor.turmaIds ∩ Turma);
        · sem Planejamento.profId, PlanejamentoSemana.profId,
          PlanejamentoValidacao.profId, TimelineEvent.profId e
          Trilha.profId.
      Com qualquer referência o professor é MANTIDO e o motivo vai
      para o relatório (nenhum dado real é apagado).
   2. Eventos de TimelineEvent de turmas fictícias: turmaId que não
      existe e NÃO é do espelho do SAG (prefixo "sag-") — a turma
      "t1" do protótipo. Eventos de turma real que sumiu do SAG são
      histórico real: ficam (o GET /timeline já os ignora).

   Antes de apagar: BACKUP em JSON (tabelas Professor e TimelineEvent
   completas + ids a remover) em <dir>/limpar-demo-seed-<Tabela>.json;
   backup existente nunca é sobrescrito (cópia nova ganha carimbo de
   data). A remoção roda numa transação que REAVALIA cada critério.

   Uso (de dentro de backend/):
     node scripts/limpar-demo-seed.js --dry-run
     node scripts/limpar-demo-seed.js --backup-dir <pasta>
   --dry-run  só mostra o que seria removido (nada é gravado).
   ============================================================ */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { PrismaClient } from '@prisma/client';

export const FRENTE = 'limpar-demo-seed';
const PREFIXO_SAG = 'sag-';
const TIMEOUT_TX = 60_000;

/** Professores fictícios do seed — id e nome precisam bater (nunca só o id). */
export const PROFESSORES_SEED = Object.freeze([
  Object.freeze({ id: 'p2', nome: 'Rafael Souza' }),
  Object.freeze({ id: 'p3', nome: 'Beatriz Almeida' }),
]);

const turmaIdsDe = pr => {
  try { const v = JSON.parse(pr?.turmaIds || '[]'); return Array.isArray(v) ? v : []; } catch { return []; }
};

/**
 * Decide se um professor candidato pode ser removido — função pura.
 * @param {{id:string, nome:string, turmaIds:string, usuario?:object|null}} pr
 * @param {{nomeEsperado:string, turmasExistentes:Set<string>, referencias:Record<string, number>}} ctx
 * @returns {{remover:boolean, motivo:string}}
 */
export function avaliarProfessor(pr, { nomeEsperado, turmasExistentes, referencias }) {
  if (pr.nome !== nomeEsperado) return { remover: false, motivo: `nome "${pr.nome}" difere do seed ("${nomeEsperado}")` };
  if (pr.usuario) return { remover: false, motivo: 'tem conta de usuário' };
  if (turmaIdsDe(pr).some(id => turmasExistentes.has(id))) return { remover: false, motivo: 'tem turma existente vinculada' };
  const usos = Object.entries(referencias || {}).filter(([, n]) => n > 0);
  if (usos.length) return { remover: false, motivo: 'referenciado por ' + usos.map(([k, n]) => `${k}=${n}`).join(', ') };
  return { remover: true, motivo: 'sem conta, sem turma existente e sem referências' };
}

/** Evento de turma fictícia: turma inexistente e fora do espelho do SAG. Função pura. */
export const eventoDeTurmaFicticia = (ev, turmasExistentes) =>
  Boolean(ev.turmaId) && !ev.turmaId.startsWith(PREFIXO_SAG) && !turmasExistentes.has(ev.turmaId);

/** Todas as referências conhecidas a um Professor. */
async function referenciasDoProfessor(db, profId) {
  const [planejamento, semana, validacao, timeline, trilha] = await Promise.all([
    db.planejamento.count({ where: { profId } }),
    db.planejamentoSemana.count({ where: { profId } }),
    db.planejamentoValidacao.count({ where: { profId } }),
    db.timelineEvent.count({ where: { profId } }),
    db.trilha.count({ where: { profId } }),
  ]);
  return { planejamento, semana, validacao, timeline, trilha };
}

async function turmasExistentesEntre(db, ids) {
  const unicos = [...new Set(ids.filter(Boolean))];
  if (!unicos.length) return new Set();
  const rows = await db.turma.findMany({ where: { id: { in: unicos } }, select: { id: true } });
  return new Set(rows.map(t => t.id));
}

/**
 * O que seria removido (somente leitura).
 * @param {{ candidatos?: {id:string, nome:string}[], eventoIds?: string[] }} [opts]
 *   eventoIds restringe a avaliação de eventos a esses ids (reavaliação na transação / testes)
 */
export async function planejarLimpeza(db, { candidatos = PROFESSORES_SEED, eventoIds = null } = {}) {
  const profs = await db.professor.findMany({
    where: { id: { in: candidatos.map(c => c.id) } },
    include: { usuario: { select: { id: true } } },
  });
  const porId = new Map(profs.map(pr => [pr.id, pr]));
  const eventos = await db.timelineEvent.findMany({
    where: { turmaId: { not: null }, ...(eventoIds ? { id: { in: eventoIds } } : {}) },
    orderBy: { data: 'asc' },
  });
  const turmasExistentes = await turmasExistentesEntre(db, [...profs.flatMap(turmaIdsDe), ...eventos.map(e => e.turmaId)]);

  const remover = [], manter = [], ausentes = [];
  for (const c of candidatos) {
    const pr = porId.get(c.id);
    if (!pr) { ausentes.push(c.id); continue; }
    const referencias = await referenciasDoProfessor(db, pr.id);
    const decisao = avaliarProfessor(pr, { nomeEsperado: c.nome, turmasExistentes, referencias });
    if (decisao.remover) remover.push(pr);
    else manter.push({ id: pr.id, nome: pr.nome, motivo: decisao.motivo });
  }
  return {
    professores: { remover, manter, ausentes },
    eventos: { remover: eventos.filter(e => eventoDeTurmaFicticia(e, turmasExistentes)) },
  };
}

export const nadaARemover = plano => !plano.professores.remover.length && !plano.eventos.remover.length;

/**
 * Apaga exatamente o que o plano lista e AINDA atende aos critérios
 * (reavaliado dentro da transação). Nunca apaga além do plano.
 */
export async function aplicarLimpeza(prisma, plano) {
  const candidatos = plano.professores.remover.map(pr => {
    const seed = PROFESSORES_SEED.find(s => s.id === pr.id);
    return { id: pr.id, nome: seed ? seed.nome : pr.nome };
  });
  const eventoIds = plano.eventos.remover.map(e => e.id);
  return prisma.$transaction(async tx => {
    const atual = await planejarLimpeza(tx, { candidatos, eventoIds });
    const profIds = atual.professores.remover.map(pr => pr.id);
    const evIds = atual.eventos.remover.map(e => e.id);
    const ev = evIds.length ? await tx.timelineEvent.deleteMany({ where: { id: { in: evIds } } }) : { count: 0 };
    const pr = profIds.length ? await tx.professor.deleteMany({ where: { id: { in: profIds } } }) : { count: 0 };
    return {
      professoresRemovidos: profIds, eventosRemovidos: evIds,
      contagem: { professores: pr.count, eventos: ev.count },
      mantidosNaReavaliacao: atual.professores.manter,
    };
  }, { timeout: TIMEOUT_TX, maxWait: TIMEOUT_TX });
}

/** Caminho livre para o backup: o canônico ou, se já existir, com carimbo de data. */
export function caminhoBackup(dir, tabela, agora = new Date()) {
  const base = path.join(dir, `${FRENTE}-${tabela}.json`);
  if (!fs.existsSync(base)) return base;
  return path.join(dir, `${FRENTE}-${tabela}-${agora.toISOString().replace(/[:.]/g, '-')}.json`);
}

/** Backup das tabelas completas Professor e TimelineEvent + ids que serão removidos. */
export async function salvarBackup(prisma, dir, plano) {
  fs.mkdirSync(dir, { recursive: true });
  const [professores, eventos] = await Promise.all([
    prisma.professor.findMany({ orderBy: { id: 'asc' } }),
    prisma.timelineEvent.findMany({ orderBy: { data: 'asc' } }),
  ]);
  const em = new Date();
  const arquivos = {};
  for (const [tabela, linhas, remover] of [
    ['Professor', professores, plano.professores.remover.map(p => p.id)],
    ['TimelineEvent', eventos, plano.eventos.remover.map(e => e.id)],
  ]) {
    const arq = caminhoBackup(dir, tabela, em);
    const conteudo = { em: em.toISOString(), origem: `antes da frente ${FRENTE}`, total: linhas.length, remover, linhas };
    fs.writeFileSync(arq, JSON.stringify(conteudo, null, 1), { flag: 'wx' });
    arquivos[tabela] = arq;
  }
  return arquivos;
}

const resumoPlano = plano => ({
  professoresARemover: plano.professores.remover.map(p => `${p.id} (${p.nome})`),
  professoresMantidos: plano.professores.manter,
  professoresJaAusentes: plano.professores.ausentes,
  eventosARemover: plano.eventos.remover.map(e => `${e.id} ${e.data.toISOString().slice(0, 10)} turma=${e.turmaId} — ${e.texto}`),
});

function lerArgs(argv) {
  const i = argv.indexOf('--backup-dir');
  return { dir: i >= 0 ? argv[i + 1] : null, dryRun: argv.includes('--dry-run') };
}

async function main() {
  const { dir, dryRun } = lerArgs(process.argv.slice(2));
  if (!dryRun && !dir) {
    console.error(`[${FRENTE}] informe --backup-dir <pasta> (backup obrigatório) ou --dry-run.`);
    process.exitCode = 1;
    return;
  }
  const prisma = new PrismaClient();
  try {
    const plano = await planejarLimpeza(prisma);
    console.log(`[${FRENTE}] plano:`, JSON.stringify(resumoPlano(plano), null, 1));
    if (dryRun) return;
    if (nadaARemover(plano)) {
      console.log(`[${FRENTE}] nada a remover — banco já limpo (idempotente). Nenhum backup necessário.`);
      return;
    }
    console.log(`[${FRENTE}] backup gravado:`, await salvarBackup(prisma, dir, plano));
    const r = await aplicarLimpeza(prisma, plano);
    console.log(`[${FRENTE}] removido:`, JSON.stringify(r, null, 1));
    const [professores, eventos] = await Promise.all([prisma.professor.count(), prisma.timelineEvent.count()]);
    console.log(`[${FRENTE}] depois: professores=${professores} timelineEvents=${eventos}`);
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
