/* ============================================================
   Espelho do banco do SAG — escolas, turmas e alunos.
   Lê o PostgreSQL do SAG (somente leitura) e sincroniza para o
   banco da plataforma com ids prefixados "sag-". Registros locais
   (seed/manuais, sem o prefixo) nunca são tocados; a remoção de
   itens que sumiram da origem também se limita aos ids "sag-".
   Config: SAG_DATABASE_URL e SAG_SYNC_INTERVALO_MIN no .env.
   As tabelas/colunas da origem são detectadas por nomes candidatos
   (ajuste o MAPA abaixo se o schema do SAG usar outros nomes).
   Nada é inventado: o SAG não informa zona (Escola.zona é legado e
   fica ''); a localização da escola é a REGIÃO (regioes.nome via
   escolas.regiao_id; a região-marcador "Não Definido" do SAG vale
   como sem região). Turno e série sem correspondência ficam '' e
   99 ("Não classificada"), nunca um valor padrão.
   EXCLUÍDOS NA ORIGEM (decisão do usuário: "ocultar sem apagar"):
   escola/turma/aluno com deleted=true — ou cujo pai (turma/escola)
   está deleted=true — continuam no espelho com excluidoNoSag=true
   (preserva avaliações, eventos e timeline) e ficam OCULTOS de todas
   as telas, listas e contagens (filtros de lib/ativos.js). Voltando
   a ativo na origem, voltam a aparecer. Nada é apagado por isso: a
   remoção continua só para ids que SUMIRAM da origem.
   ============================================================ */
import pg from 'pg';
import {
  ANO_HABILIDADES, ANO_INFANTIL_BASE, ANO_INFANTIL_SEM_ETAPA, ANO_EJA, ANO_NAO_CLASSIFICADO,
} from './series.js';

const PREFIXO = 'sag-';
const LOTE = 500; // tamanho do lote de criação (createMany) — origem pode ter milhares de linhas

// nomes candidatos no banco do SAG (schema public)
const MAPA = {
  escolas: {
    tabelas: ['escolas', 'escola', 'schools', 'instituicoes', 'unidades'],
    id: ['id', 'codigo', 'cod', 'uuid'],
    nome: ['nome', 'name', 'descricao', 'razao_social'],
    sigla: ['sigla', 'abreviacao'],
    regiao: ['regiao_id', 'id_regiao', 'regiaoid'],
    bairro: ['bairro', 'endereco_bairro'],
    diretor: ['diretor', 'gestor', 'responsavel'],
    deleted: ['deleted', 'excluido', 'removido'],
  },
  regioes: {
    tabelas: ['regioes', 'regiao', 'regions'],
    id: ['id', 'codigo', 'cod'],
    nome: ['nome', 'name', 'descricao'],
    deleted: ['deleted', 'excluido', 'removido'],
  },
  turmas: {
    tabelas: ['turmas', 'turma', 'classes'],
    id: ['id', 'codigo', 'cod', 'uuid'],
    nome: ['nome', 'name', 'descricao'],
    escola: ['escola_id', 'escolaid', 'id_escola', 'school_id', 'escola'],
    ano: ['ano', 'serie', 'ano_escolar', 'ano_serie'],
    turno: ['turno', 'periodo', 'shift'],
    deleted: ['deleted', 'excluido', 'removido'],
  },
  alunos: {
    tabelas: ['alunos', 'aluno', 'estudantes', 'students', 'matriculas'],
    id: ['id', 'codigo', 'cod', 'uuid', 'matricula'],
    nome: ['nome', 'name', 'nome_completo'],
    turma: ['turma_id', 'turmaid', 'id_turma', 'class_id', 'turma'],
    numero: ['numero', 'num', 'numero_chamada', 'ordem'],
    deleted: ['deleted', 'excluido', 'removido'],
  },
};

const CORES = ['#2563eb', '#0e7490', '#6d4bd1', '#15935f', '#c2410c', '#be185d', '#4d7c0f', '#b45309'];

export const sagConfigurado = () => {
  const url = process.env.SAG_DATABASE_URL || '';
  return url.startsWith('postgres') && !url.includes('COLOQUE_A_SENHA');
};

const iniciaisDe = nome => String(nome || '?').trim().split(/\s+/).map(p => p[0]).filter(Boolean).slice(0, 2).join('').toUpperCase();
const siglaDe = nome => String(nome || '').split(/\s+/).map(p => p[0]).filter(c => /[a-zà-ú]/i.test(c)).join('').toUpperCase().slice(0, 4) || 'ESC';
const corDe = id => CORES[[...String(id)].reduce((s, c) => s + c.charCodeAt(0), 0) % CORES.length];
// texto da origem normalizado: maiúsculas, sem acento, "_"/"-" viram espaço
const normaliza = v => String(v ?? '').toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();

// A série no SAG é texto ("SETIMO_ANO", "INFANTIL_II", "CRECHE_III", "PRE_1", "EJA",
// "I_SEGMENTO", "TURMA_HABILIDADES"): mapeia para o `ordem` do catálogo de anos
// escolares (lib/series.js).
const ORDINAIS = { PRIMEIRO: 1, SEGUNDO: 2, TERCEIRO: 3, QUARTO: 4, QUINTO: 5, SEXTO: 6, SETIMO: 7, OITAVO: 8, NONO: 9 };
const ROMANOS = { I: 1, II: 2, III: 3, IV: 4, V: 5 };
// etapa da Educação Infantil: INFANTIL / CRECHE / PRÉ(-ESCOLA), com numeral opcional (I..V ou 1..5)
const RE_INFANTIL = /\b(INFANTIL|CRECHE|PRE(?: ESCOLA)?)\b(?: ([IV]+|[1-5]))?\b/;
// turma de habilidades / multisseriada / multietapas (coringa): só as formas
// explícitas — "MULT"/"MULTI" isolados, MULTI(S)SERIADA, MULTI ETAPAS. Sala
// MULTIFUNCIONAL (AEE), MULTIMEIOS, MULTIDISCIPLINAR etc. NÃO são coringa.
const RE_MULTI = /\bMULTI?\b|\bMULTI ?S?SERIAD[AO]S?\b|\bMULTI ?ETAPAS?\b/;
// "3", "3 ANO", "3º ANO A", "8ºANOA", "4º A", "6A" — série regular pelo número
const RE_NUMERO = /^([1-9])\s*[ºª°]?\s*(?:ANO|SERIE|[A-Z]?$)/;

/** Classifica um texto já normalizado; null = não reconhecido. */
function classificaSerie(s) {
  if (!s) return null;
  // turma de habilidades / multisseriada / multietapas: coringa
  if (/\bHABILIDADES?\b/.test(s) || RE_MULTI.test(s)) return ANO_HABILIDADES;
  // ensino médio não faz parte do catálogo da rede (e "PRIMEIRO ANO MEDIO" não é o 1º ano)
  if (/\bMEDIO\b/.test(s)) return ANO_NAO_CLASSIFICADO;
  // EJA, inclusive os segmentos ("I_SEGMENTO", "II_SEGMENTO")
  if (/\bEJA\b/.test(s) || /\bSEGMENTO\b/.test(s)) return ANO_EJA;
  const inf = s.match(RE_INFANTIL);
  if (inf) {
    // CRECHE N: o SAG não diz a que etapa do catálogo (Educação Infantil 1..5)
    // equivale — em São José de Ribamar a creche vem ANTES do Infantil I —, então
    // fica como Educação Infantil sem etapa até a Secretaria confirmar a equivalência
    if (inf[1] === 'CRECHE') return ANO_INFANTIL_SEM_ETAPA;
    const etapa = inf[2] ? (ROMANOS[inf[2]] || Number(inf[2])) : null;
    return etapa >= 1 && etapa <= 5 ? ANO_INFANTIL_BASE + etapa : ANO_INFANTIL_SEM_ETAPA;
  }
  for (const [k, v] of Object.entries(ORDINAIS)) if (new RegExp(`\\b${k}\\b`).test(s)) return v;
  const n = s.match(RE_NUMERO);
  return n ? Number(n[1]) : null;
}

/**
 * Série (Turma.ano) a partir da série da origem; sem série informada, tenta
 * o nome da turma. Série informada mas não reconhecida → 99 (não classificada):
 * nunca vira coringa (0) nem um ano inventado.
 * @param {unknown} serie  valor da coluna de série no SAG
 * @param {unknown} [nome] nome da turma no SAG (só usado sem série)
 * @returns {number}
 */
export const anoDe = (serie, nome) => {
  const s = normaliza(serie);
  if (s) return classificaSerie(s) ?? ANO_NAO_CLASSIFICADO;
  return classificaSerie(normaliza(nome)) ?? ANO_NAO_CLASSIFICADO;
};

/**
 * Turno (Turma.turno) da origem; vazio ou desconhecido → '' (a UI mostra
 * "Turno não informado"), nunca um turno padrão.
 * @param {unknown} v
 * @returns {'Matutino'|'Vespertino'|'Noturno'|'Integral'|'Diurno'|''}
 */
export const turnoDe = v => {
  const s = normaliza(v);
  if (!s) return '';
  if (s.startsWith('MAT') || s.includes('MANHA')) return 'Matutino';
  if (s.startsWith('VESP') || s.includes('TARDE')) return 'Vespertino';
  if (s.startsWith('NOT') || s.includes('NOITE')) return 'Noturno';
  if (s.startsWith('INTEGRAL')) return 'Integral';
  if (s.startsWith('DIURN')) return 'Diurno';
  return '';
};

/**
 * Regiões da origem por id (String) → { nome, deleted }.
 * @param {Record<string, unknown>[]} rows  linhas da tabela de regiões
 * @param {(cands: string[]) => string|null} col  resolve o nome real da coluna
 * @returns {Map<string, {nome: string, deleted: boolean}>}
 */
export function mapaRegioes(rows, col) {
  const cId = col(MAPA.regioes.id), cNome = col(MAPA.regioes.nome), cDel = col(MAPA.regioes.deleted);
  return new Map((rows || [])
    .filter(r => r[cId] != null)
    .map(r => [String(r[cId]), { nome: String(r[cNome] ?? '').trim(), deleted: cDel ? r[cDel] === true : false }]));
}

/**
 * A região cadastrada no SAG é só um marcador de "sem região" ("Não Definido",
 * "Não definida")? Vale como escola sem região ('').
 * @param {unknown} nome
 * @returns {boolean}
 */
export const regiaoNaoDefinida = nome => /^NAO DEFINID[OA]S?$/.test(normaliza(nome));

/**
 * Nome da região da escola (Escola.regiao): região inexistente, deletada ou
 * marcador "Não Definido" do SAG → ''.
 * @param {unknown} regiaoId  escolas.regiao_id na origem
 * @param {Map<string, {nome: string, deleted: boolean}>} regioes
 * @returns {string}
 */
export const regiaoDe = (regiaoId, regioes) => {
  if (regiaoId == null || regiaoId === '') return '';
  const r = regioes.get(String(regiaoId));
  return r && !r.deleted && !regiaoNaoDefinida(r.nome) ? r.nome : '';
};

/**
 * Valor da coluna deleted da origem → excluído? Só o verdadeiro explícito
 * (boolean true, 1, 't', 'true', '1') exclui; null/ausente = ativo.
 * @param {unknown} v
 * @returns {boolean}
 */
export const deletadoNaOrigem = v => v === true || v === 1
  || ['t', 'true', '1'].includes(String(v ?? '').trim().toLowerCase());

/**
 * Escola/Turma/Aluno.excluidoNoSag: o próprio registro deleted=true na origem
 * OU o pai excluído (escola da turma; turma do aluno — que já carrega a escola).
 * @param {unknown} deletedProprio  coluna deleted do registro na origem
 * @param {boolean} [paiExcluido]
 * @returns {boolean}
 */
export const excluidoNoSagDe = (deletedProprio, paiExcluido = false) =>
  deletadoNaOrigem(deletedProprio) || paiExcluido === true;

/**
 * Ids já espelhados cujo excluidoNoSag precisa mudar — função pura.
 * Registros novos (ausentes de `atuais`) entram no createMany já com o valor certo.
 * @param {Map<string, {excluidoNoSag?: boolean}>} atuais  registros do espelho por id
 * @param {Map<string, boolean>} alvo  id → excluído na origem
 * @returns {{ marcar: string[], desmarcar: string[] }}
 */
export function diferencasExclusao(atuais, alvo) {
  const marcar = [];
  const desmarcar = [];
  for (const [id, excluido] of alvo) {
    const atual = atuais.get(id);
    if (!atual) continue;
    if (excluido && atual.excluidoNoSag !== true) marcar.push(id);
    else if (!excluido && atual.excluidoNoSag === true) desmarcar.push(id);
  }
  return { marcar, desmarcar };
}

// grava a troca de excluidoNoSag em lotes (milhares de alunos: um update por vez seria lento)
async function aplicarExclusoes(model, { marcar, desmarcar }) {
  for (const [ids, valor] of [[marcar, true], [desmarcar, false]]) {
    for (let i = 0; i < ids.length; i += LOTE) {
      await model.updateMany({ where: { id: { in: ids.slice(i, i + LOTE) } }, data: { excluidoNoSag: valor } });
    }
  }
  return { marcados: marcar.length, desmarcados: desmarcar.length };
}

const contaVerdadeiros = mapa => [...mapa.values()].filter(Boolean).length;

// resolve a tabela existente e os nomes reais das colunas da origem
async function resolver(cli, spec) {
  const { rows: tabelas } = await cli.query(
    "select table_name from information_schema.tables where table_schema = 'public'");
  const nomes = tabelas.map(t => t.table_name);
  const tabela = spec.tabelas.find(t => nomes.includes(t));
  if (!tabela) return { erro: `tabela não encontrada (candidatas: ${spec.tabelas.join(', ')}; existentes na origem: ${nomes.join(', ') || 'nenhuma'})` };
  const { rows: cols } = await cli.query(
    "select column_name from information_schema.columns where table_schema = 'public' and table_name = $1", [tabela]);
  const disponiveis = cols.map(c => c.column_name);
  const col = cands => (cands || []).find(c => disponiveis.includes(c)) || null;
  return { tabela, col };
}

let ultimo = null;   // relatório da última execução (para o /status)
let rodando = false; // trava: agendado e manual não rodam ao mesmo tempo
export const ultimoRelatorio = () => ultimo;

export async function sincronizarSag(prisma) {
  if (!sagConfigurado()) {
    return { ok: false, motivo: 'SAG_DATABASE_URL não configurada — insira a senha no backend/.env.' };
  }
  if (rodando) return { ok: false, motivo: 'Sincronização já em andamento — aguarde a conclusão.' };
  rodando = true;
  const inicio = Date.now();
  const rel = { ok: true, inicio: new Date().toISOString(), escolas: null, turmas: null, alunos: null, avisos: [] };
  const pool = new pg.Pool({ connectionString: process.env.SAG_DATABASE_URL, max: 2, connectionTimeoutMillis: 15000 });
  try {
    const cli = await pool.connect();
    try {
      /* ---------- regiões (só leitura, para o nome da região da escola) ---------- */
      let regioes = new Map();
      const rR = await resolver(cli, MAPA.regioes);
      if (rR.erro) rel.avisos.push('regiões: ' + rR.erro + ' — Escola.regiao fica vazia');
      else regioes = mapaRegioes((await cli.query(`select * from "${rR.tabela}"`)).rows, rR.col);

      /* ---------- escolas ---------- */
      const escolasVivas = [];
      const rE = await resolver(cli, MAPA.escolas);
      if (rE.erro) rel.avisos.push('escolas: ' + rE.erro);
      else {
        const { rows } = await cli.query(`select * from "${rE.tabela}"`);
        const atuais = new Map((await prisma.escola.findMany({ where: { id: { startsWith: PREFIXO } } })).map(x => [x.id, x]));
        const vistos = new Set();
        const aCriar = [];
        const excluidas = new Map(); // id → excluída na origem
        const delCol = rE.col(MAPA.escolas.deleted);
        if (!delCol) rel.avisos.push('escolas: coluna de exclusão não encontrada — todas tratadas como ativas');
        let novas = 0, atualizadas = 0, semRegiao = 0;
        for (const r of rows) {
          const src = r[rE.col(MAPA.escolas.id)];
          const nome = r[rE.col(MAPA.escolas.nome)];
          if (src == null || !nome) continue;
          const id = PREFIXO + src;
          if (vistos.has(id)) continue; // origem com linhas repetidas
          vistos.add(id);
          escolasVivas.push(id);
          const regiaoCol = rE.col(MAPA.escolas.regiao);
          const data = {
            nome: String(nome).trim(),
            sigla: String(r[rE.col(MAPA.escolas.sigla)] || siglaDe(nome)).trim(),
            zona: '', // legado: o SAG não informa zona
            regiao: regiaoCol ? regiaoDe(r[regiaoCol], regioes) : '',
            bairro: String(r[rE.col(MAPA.escolas.bairro)] || '').trim(),
            diretor: String(r[rE.col(MAPA.escolas.diretor)] || '').trim(),
          };
          if (!data.regiao) semRegiao++;
          const excluidoNoSag = excluidoNoSagDe(delCol ? r[delCol] : false);
          excluidas.set(id, excluidoNoSag);
          const atual = atuais.get(id);
          if (!atual) aCriar.push({ id, cor: corDe(id), excluidoNoSag, ...data });
          else if (Object.keys(data).some(k => atual[k] !== data[k])) {
            await prisma.escola.update({ where: { id }, data });
            atualizadas++;
          }
        }
        for (let i = 0; i < aCriar.length; i += LOTE) {
          await prisma.escola.createMany({ data: aCriar.slice(i, i + LOTE), skipDuplicates: true });
        }
        novas = aCriar.length;
        const exclusao = await aplicarExclusoes(prisma.escola, diferencasExclusao(atuais, excluidas));
        rel.escolas = {
          origem: rE.tabela, lidas: rows.length, novas, atualizadas, semRegiao,
          excluidasNoSag: contaVerdadeiros(excluidas), ...exclusao,
        };
      }

      /* ---------- turmas ---------- */
      const turmasVivas = [];
      const rT = await resolver(cli, MAPA.turmas);
      if (rT.erro) rel.avisos.push('turmas: ' + rT.erro);
      else {
        const { rows } = await cli.query(`select * from "${rT.tabela}"`);
        const atuais = new Map((await prisma.turma.findMany({ where: { id: { startsWith: PREFIXO } } })).map(x => [x.id, x]));
        // escola do espelho → excluída? (já com a marcação desta sincronização)
        const escolasEspelho = new Map((await prisma.escola.findMany({
          where: { id: { startsWith: PREFIXO } }, select: { id: true, excluidoNoSag: true },
        })).map(x => [x.id, x.excluidoNoSag]));
        const aCriar = [];
        const vistas = new Set();
        const excluidas = new Map(); // id → excluída (própria ou da escola)
        const delCol = rT.col(MAPA.turmas.deleted);
        if (!delCol) rel.avisos.push('turmas: coluna de exclusão não encontrada — só a exclusão da escola vale');
        let novas = 0, atualizadas = 0, semEscola = 0;
        for (const r of rows) {
          const src = r[rT.col(MAPA.turmas.id)];
          const nome = r[rT.col(MAPA.turmas.nome)];
          const escolaSrc = r[rT.col(MAPA.turmas.escola)];
          if (src == null || !nome) continue;
          const escolaId = PREFIXO + escolaSrc;
          if (escolaSrc == null || !escolasEspelho.has(escolaId)) { semEscola++; continue; }
          const id = PREFIXO + src;
          if (vistas.has(id)) continue; // origem com linhas repetidas
          vistas.add(id);
          turmasVivas.push(id);
          const excluidoNoSag = excluidoNoSagDe(delCol ? r[delCol] : false, escolasEspelho.get(escolaId));
          excluidas.set(id, excluidoNoSag);
          const data = {
            escolaId,
            nome: String(nome).trim(),
            ano: anoDe(r[rT.col(MAPA.turmas.ano)], nome),
            turno: turnoDe(r[rT.col(MAPA.turmas.turno)]),
          };
          const atual = atuais.get(id);
          if (!atual) aCriar.push({ id, excluidoNoSag, ...data });
          else if (Object.keys(data).some(k => atual[k] !== data[k])) {
            await prisma.turma.update({ where: { id }, data });
            atualizadas++;
          }
        }
        for (let i = 0; i < aCriar.length; i += LOTE) {
          await prisma.turma.createMany({ data: aCriar.slice(i, i + LOTE), skipDuplicates: true });
        }
        novas = aCriar.length;
        const exclusao = await aplicarExclusoes(prisma.turma, diferencasExclusao(atuais, excluidas));
        rel.turmas = {
          origem: rT.tabela, lidas: rows.length, novas, atualizadas, semEscola,
          excluidasNoSag: contaVerdadeiros(excluidas), ...exclusao,
        };
      }

      /* ---------- alunos ---------- */
      const alunosVivos = [];
      const rA = await resolver(cli, MAPA.alunos);
      if (rA.erro) rel.avisos.push('alunos: ' + rA.erro);
      else {
        const { rows } = await cli.query(`select * from "${rA.tabela}"`);
        const atuais = new Map((await prisma.aluno.findMany({ where: { id: { startsWith: PREFIXO } } })).map(x => [x.id, x]));
        // turma do espelho → excluída? (já com a marcação desta sincronização, que inclui a escola)
        const turmasEspelho = new Map((await prisma.turma.findMany({
          where: { id: { startsWith: PREFIXO } }, select: { id: true, excluidoNoSag: true },
        })).map(x => [x.id, x.excluidoNoSag]));
        let novos = 0, atualizados = 0, semTurma = 0, repetidos = 0;
        const seqPorTurma = {};
        const vistos = new Set();
        const aCriar = [];
        const excluidos = new Map(); // id → excluído (próprio, da turma ou da escola)
        const delCol = rA.col(MAPA.alunos.deleted);
        if (!delCol) rel.avisos.push('alunos: coluna de exclusão não encontrada — só a exclusão da turma/escola vale');
        for (const r of rows) {
          const src = r[rA.col(MAPA.alunos.id)];
          const nome = r[rA.col(MAPA.alunos.nome)];
          const turmaSrc = r[rA.col(MAPA.alunos.turma)];
          if (src == null || !nome) continue;
          const turmaId = PREFIXO + turmaSrc;
          if (turmaSrc == null || !turmasEspelho.has(turmaId)) { semTurma++; continue; }
          const id = PREFIXO + src;
          if (vistos.has(id)) { repetidos++; continue; } // origem com linhas repetidas (ex.: várias matrículas)
          vistos.add(id);
          alunosVivos.push(id);
          const excluidoNoSag = excluidoNoSagDe(delCol ? r[delCol] : false, turmasEspelho.get(turmaId));
          excluidos.set(id, excluidoNoSag);
          seqPorTurma[turmaId] = (seqPorTurma[turmaId] || 0) + 1;
          const numeroSrc = parseInt(r[rA.col(MAPA.alunos.numero)], 10);
          const data = {
            turmaId,
            nome: String(nome).trim(),
            numero: Number.isFinite(numeroSrc) && numeroSrc > 0 ? numeroSrc : seqPorTurma[turmaId],
            iniciais: iniciaisDe(nome),
          };
          const atual = atuais.get(id);
          // coluna legada de nível de leitura (retirado da plataforma) fica com o default do schema
          if (!atual) aCriar.push({ id, excluidoNoSag, ...data });
          else if (Object.keys(data).some(k => atual[k] !== data[k])) {
            await prisma.aluno.update({ where: { id }, data });
            atualizados++;
          }
        }
        for (let i = 0; i < aCriar.length; i += LOTE) {
          await prisma.aluno.createMany({ data: aCriar.slice(i, i + LOTE), skipDuplicates: true });
        }
        novos = aCriar.length;
        const exclusao = await aplicarExclusoes(prisma.aluno, diferencasExclusao(atuais, excluidos));
        rel.alunos = {
          origem: rA.tabela, lidos: rows.length, novos, atualizados, semTurma, repetidos,
          excluidosNoSag: contaVerdadeiros(excluidos), ...exclusao,
        };
      }

      /* ---------- remoção do que sumiu da origem (apenas ids sag-) ----------
         SÓ ids AUSENTES na origem: registro deleted=true continua na origem,
         então conta como "vivo" aqui (fica oculto via excluidoNoSag, nunca é
         apagado — preserva avaliações, eventos e timeline).
         A diferença é calculada em JS e apagada em lotes — listas grandes
         estouram o limite de bind variables do PostgreSQL (32767). */
      const removerAusentes = async (model, vivos) => {
        const vivosSet = new Set(vivos);
        const existentes = await model.findMany({ where: { id: { startsWith: PREFIXO } }, select: { id: true } });
        const mortos = existentes.map(x => x.id).filter(id => !vivosSet.has(id));
        for (let i = 0; i < mortos.length; i += LOTE) {
          await model.deleteMany({ where: { id: { in: mortos.slice(i, i + LOTE) } } });
        }
        return mortos.length;
      };
      if (rel.alunos) rel.alunos.removidos = await removerAusentes(prisma.aluno, alunosVivos);
      if (rel.turmas) rel.turmas.removidas = await removerAusentes(prisma.turma, turmasVivas);
      if (rel.escolas) rel.escolas.removidas = await removerAusentes(prisma.escola, escolasVivas);
    } finally {
      cli.release();
    }
  } catch (err) {
    rel.ok = false;
    rel.erro = err.message;
  } finally {
    await pool.end().catch(() => {});
  }
  rel.duracaoMs = Date.now() - inicio;
  ultimo = rel;
  rodando = false;
  return rel;
}
