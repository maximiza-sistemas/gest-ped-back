/* ============================================================
   Mapeamento do espelho do SAG — regras puras, sem banco:
   série (anoDe), turno (turnoDe), região (mapaRegioes/regiaoDe),
   regra do 99 em planoCasaAnos e entradas especiais do catálogo.
   Execução: node --test test/sagsync-mapeamento.test.js
   ============================================================ */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  anoDe, turnoDe, mapaRegioes, regiaoDe, regiaoNaoDefinida,
  deletadoNaOrigem, excluidoNoSagDe, diferencasExclusao,
} from '../src/lib/sagsync.js';
import { planejarTroca } from '../scripts/helena-turmas-ativas.js';
import { planoCasaAnos } from '../src/lib/escopo.js';
import {
  ANO_HABILIDADES, ANO_EJA, ANO_INFANTIL_SEM_ETAPA, ANO_NAO_CLASSIFICADO, ROTULOS_ESPECIAIS,
} from '../src/lib/series.js';
import { entradasFaltantes, jaSincronizadoComRegrasNovas } from '../scripts/sag-regiao-turno-serie.js';

test('anoDe: séries regulares do SAG (1º ao 9º ano)', () => {
  const casos = {
    PRIMEIRO_ANO: 1, SEGUNDO_ANO: 2, TERCEIRO_ANO: 3, QUARTO_ANO: 4, QUINTO_ANO: 5,
    SEXTO_ANO: 6, SETIMO_ANO: 7, 'SÉTIMO ANO': 7, OITAVO_ANO: 8, NONO_ANO: 9,
  };
  for (const [serie, ano] of Object.entries(casos)) assert.equal(anoDe(serie, 'qualquer'), ano, serie);
});

test('anoDe: séries numéricas', () => {
  assert.equal(anoDe('3'), 3);
  assert.equal(anoDe(4), 4);
  assert.equal(anoDe('5º ANO'), 5);
  assert.equal(anoDe('2ª SÉRIE'), 2);
});

test('anoDe: só turma de habilidades / multisseriada / multietapas viram coringa (0)', () => {
  for (const s of ['TURMA_HABILIDADES', 'HABILIDADES', 'MULTISSERIADA', 'MULTISERIADA', 'MULTI_SERIADA', 'MULTISSERIADO', 'MULTI_ETAPAS', 'MULTI ETAPAS', 'MULTIETAPAS', 'MULTI']) {
    assert.equal(anoDe(s), ANO_HABILIDADES, s);
  }
});

test('anoDe: MULTIFUNCIONAL (AEE), MULTIMEIOS etc. NÃO são coringa → 99', () => {
  for (const s of ['SALA_MULTIFUNCIONAL', 'AEE_MULTIFUNCIONAL', 'MULTIMEIOS', 'MULTIDISCIPLINAR']) {
    assert.equal(anoDe(s), ANO_NAO_CLASSIFICADO, s);
  }
  assert.equal(anoDe(null, 'SALA MULTIFUNCIONAL'), ANO_NAO_CLASSIFICADO);
  assert.equal(anoDe(null, 'TURMA MULTI'), ANO_HABILIDADES);
});

test('anoDe: creche e pré-escola são Educação Infantil, nunca 1º/2º ano nem coringa', () => {
  assert.equal(anoDe('INFANTIL_I'), 10);
  assert.equal(anoDe('INFANTIL_II'), 11);
  assert.equal(anoDe('INFANTIL_III'), 12);
  assert.equal(anoDe('INFANTIL_IV'), 13);
  assert.equal(anoDe('INFANTIL_V'), 14);
  // CRECHE N: equivalência com Educação Infantil 1..5 não vem do SAG (e em SJR a
  // creche vem antes do Infantil I) → sem etapa, até a Secretaria confirmar
  assert.equal(anoDe('CRECHE_III', 'CRECHE III'), ANO_INFANTIL_SEM_ETAPA);
  assert.equal(anoDe('CRECHE_I'), ANO_INFANTIL_SEM_ETAPA, 'não colide com PRE_1 (10)');
  assert.equal(anoDe(null, 'CRECHE II'), ANO_INFANTIL_SEM_ETAPA);
  assert.equal(anoDe('PRE_1', 'INFANTIL I'), 10);  // antes: 1 (1º ano)
  assert.equal(anoDe('PRE_2', 'INFANTIL II'), 11); // antes: 2 (2º ano)
  assert.equal(anoDe('PRÉ-ESCOLA II'), 11);
  // sem etapa informada: Educação Infantil, sem inventar a etapa
  assert.equal(anoDe('CRECHE'), ANO_INFANTIL_SEM_ETAPA);
  assert.equal(anoDe('PRE_ESCOLA'), ANO_INFANTIL_SEM_ETAPA);
});

test('anoDe: EJA e segmentos da EJA', () => {
  assert.equal(anoDe('EJA', '4º/5º ANO EJA'), ANO_EJA);
  assert.equal(anoDe('EJA', 'MULTI ETAPAS(2º/3º)'), ANO_EJA); // a série manda, não o nome
  assert.equal(anoDe('I_SEGMENTO', 'EJA'), ANO_EJA);
  assert.equal(anoDe('II_SEGMENTO', 'EJA'), ANO_EJA);
});

test('anoDe: série não reconhecida → 99 (não classificada), sem olhar o nome', () => {
  assert.equal(anoDe('PRIMEIRO_ANO_MEDIO', 'turma test'), ANO_NAO_CLASSIFICADO); // ensino médio ≠ 1º ano
  assert.equal(anoDe('TRANSFERIDOS', '3º ANO A'), ANO_NAO_CLASSIFICADO);
  assert.equal(anoDe('ATENDIMENTO_ESPECIALIZADO'), ANO_NAO_CLASSIFICADO);
  assert.equal(anoDe('10'), ANO_NAO_CLASSIFICADO);
});

test('anoDe: sem série na origem usa o nome da turma; nome sem série → 99', () => {
  assert.equal(anoDe(null, '3 ANO'), 3);
  assert.equal(anoDe('', '1º ANO A'), 1);
  assert.equal(anoDe(undefined, '8ºANOA'), 8);
  assert.equal(anoDe(null, '4º A'), 4);
  assert.equal(anoDe(null, '6A'), 6);
  assert.equal(anoDe(null, 'TURMA MULT'), ANO_HABILIDADES);
  assert.equal(anoDe(null, 'INFANTIL II'), 11);
  assert.equal(anoDe(null, '4º/5º ANO EJA'), ANO_EJA);
  assert.equal(anoDe(null, 'TURMA ESPECIAL'), ANO_NAO_CLASSIFICADO);
  assert.equal(anoDe(null, null), ANO_NAO_CLASSIFICADO);
});

test('turnoDe: valores do SAG', () => {
  assert.equal(turnoDe('MATUTINO'), 'Matutino');
  assert.equal(turnoDe('VESPERTINO'), 'Vespertino');
  assert.equal(turnoDe('NOTURNO'), 'Noturno');
  assert.equal(turnoDe('INTEGRAL'), 'Integral');
  assert.equal(turnoDe('DIURNO'), 'Diurno'); // antes: 'Matutino'
  assert.equal(turnoDe('manhã'), 'Matutino');
  assert.equal(turnoDe('Tarde'), 'Vespertino');
  assert.equal(turnoDe('noite'), 'Noturno');
});

test('turnoDe: vazio ou desconhecido → vazio (nunca "Matutino")', () => {
  for (const v of [null, undefined, '', '   ', 'X', 'INTERMEDIARIO', 'ALTERNADO']) assert.equal(turnoDe(v), '', String(v));
});

test('região: nome pela regiao_id; deletada, inexistente, nula ou marcador "Não Definido" → vazio', () => {
  const linhas = [
    { id: '7', nome: 'Regional Sede', deleted: false },
    { id: 10n, nome: ' Regional Piçarreira / Zona Rural ', deleted: false },
    { id: '11', nome: 'Não Definido', deleted: false },
    { id: '4', nome: 'Não Definido', deleted: true },
    { id: null, nome: 'sem id', deleted: false },
  ];
  const colunas = ['id', 'nome', 'deleted'];
  const col = cands => cands.find(c => colunas.includes(c)) || null;
  const regioes = mapaRegioes(linhas, col);
  assert.equal(regioes.size, 4);
  assert.equal(regiaoDe('7', regioes), 'Regional Sede');
  assert.equal(regiaoDe(7n, regioes), 'Regional Sede');                         // bigint do pg
  assert.equal(regiaoDe(10, regioes), 'Regional Piçarreira / Zona Rural');      // aparado
  assert.equal(regiaoDe('11', regioes), '');                                    // marcador "Não Definido" = sem região
  assert.equal(regiaoDe('4', regioes), '');                                     // deletada
  assert.equal(regiaoDe('999', regioes), '');                                   // inexistente
  assert.equal(regiaoDe(null, regioes), '');
  assert.equal(regiaoDe('', regioes), '');
});

test('região: origem sem coluna de exclusão considera as regiões ativas', () => {
  const col = cands => cands.find(c => ['id', 'nome'].includes(c)) || null;
  const regioes = mapaRegioes([{ id: 1, nome: 'Norte' }], col);
  assert.equal(regiaoDe(1, regioes), 'Norte');
});

test('planoCasaAnos: 99 nunca casa com séries específicas, só com todas as séries', () => {
  const nc = new Set([ANO_NAO_CLASSIFICADO]);
  assert.equal(planoCasaAnos('[]', nc), true);                    // todas as séries
  assert.equal(planoCasaAnos('[1,2,3]', nc), false);
  assert.equal(planoCasaAnos('[99]', nc), false);                 // nem listando o próprio 99
  assert.equal(planoCasaAnos('[3]', new Set([99, 3])), true);     // outra turma do professor casa
  assert.equal(planoCasaAnos('[3]', new Set([ANO_HABILIDADES])), true); // 0 continua coringa
  assert.equal(planoCasaAnos('[3]', new Set([ANO_EJA])), false);
  assert.equal(planoCasaAnos('[12]', new Set([12])), true);
});

test('catálogo: 99 sempre entra; 15 só quando alguma turma usa; nada duplicado', () => {
  const base = [{ ordem: 0, nome: 'Turma de habilidades' }, { ordem: 1, nome: '1º ano' }];
  assert.deepEqual(entradasFaltantes(base, new Set([1])), [{ ordem: 99, nome: ROTULOS_ESPECIAIS[99] }]);
  assert.deepEqual(entradasFaltantes(base, new Set([1, 15])).map(e => e.ordem), [99, 15]);
  const completo = [...base, { ordem: 99, nome: 'Não classificada' }];
  assert.deepEqual(entradasFaltantes(completo, new Set([1])), []);
});

test('script: detecta backup tirado depois de o servidor novo já ter sincronizado', () => {
  assert.equal(jaSincronizadoComRegrasNovas([{ id: 'sag-1', zona: 'Urbana' }, { id: 'sag-2', zona: '' }]), false, 'código antigo: "antes" válido');
  assert.equal(jaSincronizadoComRegrasNovas([{ id: 'sag-1', zona: '' }, { id: 'sag-2', zona: '' }, { id: 'e1', zona: 'Rural' }]), true,
    'zona vazia em todo o espelho (escolas locais não contam)');
  assert.equal(jaSincronizadoComRegrasNovas([{ id: 'e1', zona: '' }]), false, 'sem espelho não há o que afirmar');
});

test('região: o marcador "Não Definido" do SAG (qualquer caixa/acento/gênero) vale como sem região', () => {
  for (const v of ['Não Definido', 'NAO DEFINIDO', 'não definida', ' Nao  Definido ', 'NÃO_DEFINIDO']) assert.equal(regiaoNaoDefinida(v), true, v);
  for (const v of ['Regional Sede', 'Não Definido Norte', '', null]) assert.equal(regiaoNaoDefinida(v), false, String(v));
});

/* ---------- excluídos no SAG: ocultar sem apagar (excluidoNoSag) ---------- */

test('deletadoNaOrigem: só o verdadeiro explícito exclui', () => {
  for (const v of [true, 1, 't', 'true', 'TRUE', '1', ' t ']) assert.equal(deletadoNaOrigem(v), true, String(v));
  for (const v of [false, 0, null, undefined, '', 'f', 'false', '0', 'nao']) assert.equal(deletadoNaOrigem(v), false, String(v));
});

test('excluidoNoSagDe: o próprio registro deleted OU o pai excluído', () => {
  // escola: só a própria coluna
  assert.equal(excluidoNoSagDe(true), true);
  assert.equal(excluidoNoSagDe(false), false);
  assert.equal(excluidoNoSagDe(null), false, 'sem a coluna = ativo');
  // turma ativa em escola excluída → oculta; turma excluída em escola ativa → oculta
  assert.equal(excluidoNoSagDe(false, true), true);
  assert.equal(excluidoNoSagDe(true, false), true);
  assert.equal(excluidoNoSagDe(false, false), false);
  // aluno ativo em turma excluída (ou de escola excluída — a turma já carrega) → oculto
  const escolaExcl = excluidoNoSagDe(true);
  const turmaDaEscolaExcl = excluidoNoSagDe(false, escolaExcl);
  assert.equal(excluidoNoSagDe(false, turmaDaEscolaExcl), true);
  // aluno excluído em turma ativa → oculto; pai indefinido (turma nova) não exclui
  assert.equal(excluidoNoSagDe('t', false), true);
  assert.equal(excluidoNoSagDe(false, undefined), false);
});

test('diferencasExclusao: marca/desmarca só o que mudou; novos ficam para o createMany', () => {
  const atuais = new Map([
    ['sag-1', { excluidoNoSag: false }], // passa a excluído
    ['sag-2', { excluidoNoSag: true }],  // voltou a ativo na origem
    ['sag-3', { excluidoNoSag: true }],  // continua excluído
    ['sag-4', { excluidoNoSag: false }], // continua ativo
    ['sag-9', { excluidoNoSag: false }], // sumiu da origem: não é tratado aqui (removerAusentes)
  ]);
  const alvo = new Map([['sag-1', true], ['sag-2', false], ['sag-3', true], ['sag-4', false], ['sag-5', true]]);
  assert.deepEqual(diferencasExclusao(atuais, alvo), { marcar: ['sag-1'], desmarcar: ['sag-2'] });
  assert.deepEqual(diferencasExclusao(new Map(), alvo), { marcar: [], desmarcar: [] }, 'tudo novo: nada a atualizar');
});

test('helena-turmas-ativas: troca a turma excluída pela ativa da mesma escola e série', () => {
  const t = (id, escolaId, ano, turno, excl = false, escolaExcl = false) => [id, { id, escolaId, ano, turno, excluidoNoSag: excl, escola: { excluidoNoSag: escolaExcl } }];
  const turmas = new Map([
    t('sag-100', 'sag-18', 3, 'Matutino', true), t('sag-101', 'sag-18', 4, 'Matutino', true),
    t('sag-2217', 'sag-18', 3, 'Matutino'), t('sag-2218', 'sag-18', 4, 'Matutino'),
    t('sag-2216', 'sag-18', 2, 'Matutino'), t('sag-99', 'sag-18', 2, 'Matutino', true),
    t('sag-500', 'sag-19', 3, 'Matutino'), // outra escola: nunca é equivalente
  ]);
  assert.deepEqual(planejarTroca(['sag-100', 'sag-101'], turmas), {
    turmaIds: ['sag-2217', 'sag-2218'],
    trocas: [{ de: 'sag-100', para: 'sag-2217' }, { de: 'sag-101', para: 'sag-2218' }],
    problemas: [],
  });
  // idempotente: turmas já ativas ficam como estão
  assert.deepEqual(planejarTroca(['sag-2217', 'sag-2218'], turmas), { turmaIds: ['sag-2217', 'sag-2218'], trocas: [], problemas: [] });
  // ativa + excluída da mesma série: sem duplicar
  assert.deepEqual(planejarTroca(['sag-2217', 'sag-100'], turmas).turmaIds, ['sag-2217']);
  // ambiguidade (duas ativas da série, turnos diferentes do original) → problema, nada a gravar
  const ambiguas = new Map([...turmas, t('sag-2300', 'sag-18', 3, 'Vespertino'), t('sag-2301', 'sag-18', 3, 'Vespertino')]);
  ambiguas.set('sag-2217', { ...ambiguas.get('sag-2217'), turno: 'Noturno' });
  assert.equal(planejarTroca(['sag-100'], ambiguas).problemas.length, 1);
  // desempate pelo mesmo turno
  const comTurno = new Map([...turmas, t('sag-2300', 'sag-18', 3, 'Vespertino')]);
  assert.deepEqual(planejarTroca(['sag-100'], comTurno).turmaIds, ['sag-2217']);
  // escola excluída: nenhuma turma ativa equivalente
  const escolaFechada = new Map([t('sag-7', 'sag-2', 1, 'Matutino', false, true)]);
  assert.match(planejarTroca(['sag-7'], escolaFechada).problemas[0], /nenhuma turma ativa/);
});
