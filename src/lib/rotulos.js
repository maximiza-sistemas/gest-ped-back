/* ============================================================
   Rótulos exibidos nos relatórios — espelham os helpers do
   frontend (frontend/src/data.js: turmaRotulo, anoNome,
   turnoNome, regiaoNome) para o CSV dizer o mesmo que a tela.
   Dados do SAG sem valor inventado: vazio = não definido.
   ============================================================ */
import { ANO_HABILIDADES, ROTULOS_ESPECIAIS } from './series.js';

export const SEM_REGIAO = 'Região não definida';
export const SEM_GRUPO = 'Sem grupo';
export const SEM_TURNO = 'Turno não informado';

/* Rótulo curto da turma a partir do nome vindo do SAG:
   "3 ANO" → "3º ano" · "1º ANO A" / "8ºANOA" → "1º ano A" / "8º ano A" · "4º A" / "8ºB" / "6A" → "4º ano A" / "8º ano B" / "6º ano A".
   Nomes que não são série numérica (TURMA MULT, Infantil I…, EJA combinada) ficam como estão. */
export function turmaRotulo(nome) {
  const s = String(nome || '').trim().replace(/°/g, 'º');
  const comAno = s.match(/^(\d{1,2})\s*[ºª]?\s*ANOS?\s*(.*)$/i);   // 3 ANO · 1º ANO A · 8ºANOA
  const semAno = s.match(/^(\d{1,2})\s*[ºª]\s*([A-Z]{0,2})$/i);   // 4º A · 8ºB
  const colado = s.match(/^(\d{1,2})\s?([A-Z])$/i);               // 6A · 8 A
  const m = comAno || semAno || colado;
  if (!m) return s;
  const resto = (m[2] || '').trim();
  return `${Number(m[1])}º ano${resto ? ' ' + resto.toUpperCase() : ''}`;
}

// a região-marcador "Não Definido" do SAG vale como sem região (o espelho já grava '' —
// lib/sagsync.js regiaoNaoDefinida; aqui é a defesa do CSV, espelhando DATA.regiaoEfetiva)
const REGIAO_MARCADOR = /^nao definid[oa]s?$/;
const normalizaTexto = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
export const regiaoRotulo = regiao => (regiao && !REGIAO_MARCADOR.test(normalizaTexto(regiao)) ? regiao : SEM_REGIAO);
export const grupoRotulo = grupo => (grupo && grupo.nome) || SEM_GRUPO;
export const turnoRotulo = turno => turno || SEM_TURNO;

/**
 * Fábrica do rótulo da série a partir do catálogo da rede (Config.anosEscolares).
 * @param {{ordem:number, nome:string}[]} anos
 * @returns {(ordem:number) => string}
 */
export function rotuladorDeAnos(anos) {
  const porOrdem = new Map((anos || []).map(a => [a.ordem, a.nome]));
  const especiais = { [ANO_HABILIDADES]: 'Turma de habilidades', ...ROTULOS_ESPECIAIS };
  return ordem => porOrdem.get(ordem) || especiais[ordem] || `${ordem}º ano`;
}
