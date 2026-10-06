/* ============================================================
   Nível de proficiência da habilidade — fonte única dos valores.
   Campo OPCIONAL (Habilidade.nivelProficiencia): null = não informado.
   A lista é exposta em GET /meta (NIVEIS_PROFICIENCIA) e o front
   não mantém cópia própria. A ordem é crescente (do menor ao maior
   domínio) — o front usa a posição para a escala de cores.
   ============================================================ */

const TOTAL_NIVEIS = 9;

// N1 (menor domínio) … N9 (maior domínio)
export const NIVEIS_PROFICIENCIA = Object.freeze(Array.from({ length: TOTAL_NIVEIS }, (_, i) => `N${i + 1}`));

// comparação tolerante a caixa, acentos e espaços ("n1", " n 3 " → "N1", "N3")
const chave = s => String(s).normalize('NFD').replace(/\p{Diacritic}/gu, '').replace(/\s+/g, '').toLowerCase();
const CANONICO = new Map(NIVEIS_PROFICIENCIA.map(n => [chave(n), n]));

export const MENSAGEM_NIVEL_INVALIDO =
  `Nível de proficiência inválido. Use um destes valores: ${NIVEIS_PROFICIENCIA.join(', ')} — ou deixe em branco para não informar.`;

/**
 * Normaliza o nível de proficiência recebido na API.
 * @param {unknown} valor  undefined = campo ausente; null ou '' = limpar (não informado)
 * @returns {{ ok: true, valor: string | null | undefined } | { ok: false, erro: string }}
 *   valor undefined só quando o campo veio ausente (o chamador decide se mantém o atual).
 */
export function normalizarNivelProficiencia(valor) {
  if (valor === undefined) return { ok: true, valor: undefined };
  if (valor === null) return { ok: true, valor: null };
  if (typeof valor !== 'string') return { ok: false, erro: MENSAGEM_NIVEL_INVALIDO };
  if (!valor.trim()) return { ok: true, valor: null };
  const canonico = CANONICO.get(chave(valor));
  return canonico ? { ok: true, valor: canonico } : { ok: false, erro: MENSAGEM_NIVEL_INVALIDO };
}
