/* ============================================================
   Professora Helena (conta helena@rededeensino.edu.br, Professor
   p1): troca as turmas EXCLUÍDAS no SAG pelas turmas ATIVAS
   equivalentes da mesma escola. Idempotente (reaplicável em
   produção). Decisão do usuário: "Ocultar sem apagar" — a Helena
   passa para as turmas ativas e começa sem histórico nelas; as
   avaliações, eventos e timeline das turmas excluídas NÃO são
   apagados (ficam guardados, ocultos — lib/ativos.js).

   Equivalente = turma VISÍVEL (excluidoNoSag=false, escola idem)
   da MESMA escola e da MESMA série (Turma.ano); havendo mais de
   uma, desempata pelo mesmo turno. Sem equivalente único, NADA é
   gravado e o motivo vai para o relatório. Turmas já visíveis
   ficam como estão. Rode DEPOIS da sincronização que marca
   excluidoNoSag (scripts/sag-ocultar-excluidos.js).

   No DEV (verificado): sag-100 (3 ANO, excluída) → sag-2217
   (3° ANO, ativa); sag-101 (4 ANO, excluída) → sag-2218 (4° ANO,
   ativa) — escola sag-18 EM ESTEFANIO SALDANHA.

   Antes de gravar: BACKUP em JSON da tabela Professor em
   <dir>/helena-turmas-ativas-Professor.json (nunca sobrescreve —
   cópia nova ganha carimbo de data). A gravação roda numa
   transação que confere se Professor.turmaIds não mudou.

   Uso (de dentro de backend/):
     node scripts/helena-turmas-ativas.js --dry-run
     node scripts/helena-turmas-ativas.js --backup-dir <pasta> [--email <conta>]
   ============================================================ */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { PrismaClient } from '@prisma/client';

export const FRENTE = 'helena-turmas-ativas';
export const EMAIL_PADRAO = 'helena@rededeensino.edu.br';

const idsDe = s => { try { const v = JSON.parse(s || '[]'); return Array.isArray(v) ? v : []; } catch { return []; } };
const visivel = t => Boolean(t) && t.excluidoNoSag !== true && t.escola?.excluidoNoSag !== true;

/**
 * Plano de troca das turmas do professor — função pura.
 * @param {string[]} turmaIds  Professor.turmaIds atuais
 * @param {Map<string, {id:string, escolaId:string, ano:number, turno:string, excluidoNoSag:boolean, escola:{excluidoNoSag:boolean}}>} turmasPorId
 *   as turmas atuais do professor E todas as turmas das escolas delas
 * @returns {{ turmaIds: string[], trocas: {de:string, para:string}[], problemas: string[] }}
 *   turmaIds = lista nova (sem duplicadas); com problemas, nada deve ser gravado
 */
export function planejarTroca(turmaIds, turmasPorId) {
  const trocas = [];
  const problemas = [];
  const novas = [];
  const todas = [...turmasPorId.values()];
  for (const id of turmaIds) {
    const t = turmasPorId.get(id);
    if (!t) { problemas.push(`${id}: turma inexistente no espelho`); continue; }
    if (visivel(t)) { novas.push(id); continue; }
    const mesmaSerie = todas.filter(c => c.id !== id && visivel(c) && c.escolaId === t.escolaId && c.ano === t.ano);
    const mesmoTurno = mesmaSerie.filter(c => c.turno === t.turno);
    const escolhida = mesmaSerie.length === 1 ? mesmaSerie[0] : (mesmoTurno.length === 1 ? mesmoTurno[0] : null);
    if (!escolhida) {
      problemas.push(`${id}: ${mesmaSerie.length ? 'mais de uma' : 'nenhuma'} turma ativa da série ${t.ano} na escola ${t.escolaId}`);
      continue;
    }
    trocas.push({ de: id, para: escolhida.id });
    novas.push(escolhida.id);
  }
  return { turmaIds: [...new Set(novas)], trocas, problemas };
}

function caminhoBackup(dir, tabela, agora = new Date()) {
  const base = path.join(dir, `${FRENTE}-${tabela}.json`);
  if (!fs.existsSync(base)) return base;
  return path.join(dir, `${FRENTE}-${tabela}-${agora.toISOString().replace(/[:.]/g, '-')}.json`);
}

function lerArgs(argv) {
  const valor = flag => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : null; };
  return { dir: valor('--backup-dir'), email: valor('--email') || EMAIL_PADRAO, dryRun: argv.includes('--dry-run') };
}

const SELECT_TURMA = { id: true, nome: true, escolaId: true, ano: true, turno: true, excluidoNoSag: true, escola: { select: { excluidoNoSag: true } } };

async function main() {
  const { dir, email, dryRun } = lerArgs(process.argv.slice(2));
  if (!dryRun && !dir) {
    console.error(`[${FRENTE}] informe --backup-dir <pasta> (ou --dry-run). O backup é obrigatório antes de gravar.`);
    process.exitCode = 1;
    return;
  }
  const prisma = new PrismaClient();
  try {
    const usuario = await prisma.usuario.findUnique({ where: { email }, select: { id: true, profId: true } });
    if (!usuario?.profId) { console.log(`[${FRENTE}] conta ${email} inexistente ou sem professor vinculado — nada a fazer.`); return; }
    const prof = await prisma.professor.findUnique({ where: { id: usuario.profId } });
    if (!prof) { console.log(`[${FRENTE}] professor ${usuario.profId} não existe — nada a fazer.`); return; }

    const atuais = idsDe(prof.turmaIds);
    const proprias = await prisma.turma.findMany({ where: { id: { in: atuais } }, select: SELECT_TURMA });
    const escolas = [...new Set(proprias.map(t => t.escolaId))];
    const daEscola = escolas.length ? await prisma.turma.findMany({ where: { escolaId: { in: escolas } }, select: SELECT_TURMA }) : [];
    const turmasPorId = new Map([...proprias, ...daEscola].map(t => [t.id, t]));
    const plano = planejarTroca(atuais, turmasPorId);
    const rotulo = id => { const t = turmasPorId.get(id); return t ? `${id} "${t.nome}" (série ${t.ano}, ${t.turno || 'turno não informado'}, ${visivel(t) ? 'ativa' : 'EXCLUÍDA no SAG'})` : id; };
    console.log(`[${FRENTE}] professor ${prof.id} "${prof.nome}" — turmas atuais:`, atuais.map(rotulo));
    console.log(`[${FRENTE}] trocas:`, plano.trocas.map(x => `${rotulo(x.de)} → ${rotulo(x.para)}`));
    if (plano.problemas.length) {
      console.error(`[${FRENTE}] NADA gravado — sem equivalente único:`, plano.problemas);
      process.exitCode = 1;
      return;
    }
    if (!plano.trocas.length) { console.log(`[${FRENTE}] todas as turmas já estão ativas — nada a fazer.`); return; }
    if (dryRun) { console.log(`[${FRENTE}] --dry-run: turmaIds seria`, plano.turmaIds); return; }

    fs.mkdirSync(dir, { recursive: true });
    const linhas = await prisma.professor.findMany({ orderBy: { id: 'asc' } });
    const arq = caminhoBackup(dir, 'Professor');
    fs.writeFileSync(arq, JSON.stringify({ em: new Date().toISOString(), origem: `antes de ${FRENTE}`, total: linhas.length, linhas }, null, 1), { flag: 'wx' });
    console.log(`[${FRENTE}] backup gravado:`, arq);

    const gravado = await prisma.$transaction(async tx => {
      const agora = await tx.professor.findUnique({ where: { id: prof.id }, select: { turmaIds: true } });
      if (agora?.turmaIds !== prof.turmaIds) throw new Error('Professor.turmaIds mudou durante a execução — rode de novo.');
      return tx.professor.update({ where: { id: prof.id }, data: { turmaIds: JSON.stringify(plano.turmaIds) }, select: { id: true, turmaIds: true } });
    });
    console.log(`[${FRENTE}] gravado:`, gravado);
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
