/* ============================================================
   CSV dos relatórios — UTF-8 com BOM (o Excel reconhece os
   acentos) e separador ';' (padrão do Excel em pt-BR).

   Segurança: textos que começam com = + - @ (ou tab/CR) são
   prefixados com apóstrofo para não virarem fórmula na planilha
   (CSV/formula injection — nomes vêm do SAG, origem externa).
   Números ficam como estão (são valores calculados no servidor).
   ============================================================ */

export const BOM = '﻿';
export const SEPARADOR = ';';

const INICIO_FORMULA = /^[=+\-@\t\r]/;
const PRECISA_ASPAS = /[";\r\n]/;

/**
 * Converte um valor numa célula CSV segura.
 * @param {string|number|null|undefined} valor
 * @returns {string}
 */
export function celulaCsv(valor) {
  if (valor == null) return '';
  if (typeof valor === 'number') return Number.isFinite(valor) ? String(valor) : '';
  const texto = INICIO_FORMULA.test(String(valor)) ? `'${valor}` : String(valor);
  return PRECISA_ASPAS.test(texto) ? `"${texto.replace(/"/g, '""')}"` : texto;
}

/**
 * Monta o CSV completo (BOM + cabeçalho + linhas, quebra CRLF).
 * @param {string[]} colunas
 * @param {(string|number|null)[][]} linhas
 * @returns {string}
 */
export function gerarCsv(colunas, linhas) {
  const corpo = [colunas, ...linhas].map(l => l.map(celulaCsv).join(SEPARADOR)).join('\r\n');
  return `${BOM}${corpo}\r\n`;
}

/** Data AAAA-MM-DD (horário local do servidor) para o nome do arquivo. */
export function dataArquivo(d = new Date()) {
  const dois = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${dois(d.getMonth() + 1)}-${dois(d.getDate())}`;
}

/** Trecho seguro para nome de arquivo: sem acentos, só [a-z0-9-]. */
export function slugArquivo(texto, reserva = 'escola') {
  const slug = String(texto || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return slug || reserva;
}
