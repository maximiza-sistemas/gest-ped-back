/* ============================================================
   Séries (anos escolares) — códigos do catálogo Config.anosEscolares
   usados em Turma.ano e em Planejamento.anos.

   Regulares: 1..9 = 1º..9º ano · 10..14 = Educação Infantil 1..5 ·
   20 = EJA. Especiais (definidos aqui, fonte única no backend):
     0  = turma de habilidades / multisseriada — CORINGA: recebe
          direcionamento de qualquer série;
     15 = Educação Infantil sem etapa informada na origem (ex.: série
          "CRECHE" sem numeral) — não há como escolher 10..14. Também
          CRECHE N (CRECHE_III…): a equivalência com 10..14 não vem do
          SAG e ainda depende de confirmação da Secretaria;
     99 = série não reconhecida — NUNCA casa com séries específicas,
          só com planejamento de todas as séries (anos vazio).
   O frontend espelha 99 em data.js (ANO_NAO_CLASSIFICADO).
   ============================================================ */

/** Turma de habilidades / multisseriada (coringa). */
export const ANO_HABILIDADES = 0;
/** Educação Infantil etapa N (I..V) → ANO_INFANTIL_BASE + N (10..14). */
export const ANO_INFANTIL_BASE = 9;
/** Educação Infantil sem etapa informada. */
export const ANO_INFANTIL_SEM_ETAPA = 15;
/** Educação de Jovens e Adultos (inclui os segmentos I e II). */
export const ANO_EJA = 20;
/** Série da origem não reconhecida. */
export const ANO_NAO_CLASSIFICADO = 99;

/** Rótulos dos códigos especiais que podem faltar no catálogo da rede. */
export const ROTULOS_ESPECIAIS = Object.freeze({
  [ANO_INFANTIL_SEM_ETAPA]: 'Educação Infantil (etapa não informada)',
  [ANO_NAO_CLASSIFICADO]: 'Não classificada',
});
