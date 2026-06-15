/* ============================================================
   Conversão de datas — a API trafega 'dd/mm/yyyy' (formato que
   as views já exibem); o banco armazena DateTime.
   ============================================================ */

/** 'dd/mm/yyyy' -> Date (meio-dia UTC para evitar shift de fuso) */
export function parseBR(s) {
  if (!s) return null;
  const [d, m, y] = s.split('/').map(Number);
  if (!d || !m || !y) return null;
  return new Date(Date.UTC(y, m - 1, d, 12));
}

/** Date -> 'dd/mm/yyyy' */
export function fmtBR(date) {
  if (!date) return null;
  const d = new Date(date);
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${dd}/${mm}/${d.getUTCFullYear()}`;
}
