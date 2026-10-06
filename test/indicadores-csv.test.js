/* ============================================================
   Testes unitários (sem banco) — CSV dos relatórios, rótulos e
   regras dos indicadores reais:
     · CSV: BOM, ';', CRLF, aspas e neutralização de fórmulas;
     · último resultado de cada aluno (data; empate → id maior);
     · professores DISTINTOS com turma vinculada por escola.

   Execução: node --test test/indicadores-csv.test.js
   ============================================================ */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BOM, celulaCsv, gerarCsv, dataArquivo, slugArquivo } from '../src/lib/csv.js';
import { turmaRotulo, regiaoRotulo, grupoRotulo, turnoRotulo, rotuladorDeAnos } from '../src/lib/rotulos.js';
import { ultimoResultadoPorAluno, resumoAvaliacoes, professoresPorEscola, agruparPor } from '../src/lib/indicadores.js';

/* ---------------- CSV ---------------- */

test('csv: BOM, separador ";", CRLF e células vazias para null', () => {
  const csv = gerarCsv(['A', 'B', 'C'], [['x', 1, null], ['y', 0, 62]]);
  assert.ok(csv.startsWith(BOM), 'começa com BOM UTF-8');
  assert.equal(csv, `${BOM}A;B;C\r\nx;1;\r\ny;0;62\r\n`);
});

test('csv: aspas, ";" e quebras de linha ficam entre aspas (aspas duplicadas)', () => {
  assert.equal(celulaCsv('EM "Centro"; anexo'), '"EM ""Centro""; anexo"');
  assert.equal(celulaCsv('linha 1\nlinha 2'), '"linha 1\nlinha 2"');
  assert.equal(celulaCsv('Regional Piçarreira / Zona Rural'), 'Regional Piçarreira / Zona Rural');
});

test('csv: texto que vira fórmula é neutralizado; números não', () => {
  assert.equal(celulaCsv('=HYPERLINK("x")'), `"'=HYPERLINK(""x"")"`);
  assert.equal(celulaCsv('+55'), "'+55");
  assert.equal(celulaCsv('-1'), "'-1");
  assert.equal(celulaCsv('@SOMA'), "'@SOMA");
  assert.equal(celulaCsv(-1), '-1');
  assert.equal(celulaCsv(NaN), '');
  assert.equal(celulaCsv(undefined), '');
});

test('csv: data do arquivo AAAA-MM-DD e slug seguro para o nome', () => {
  assert.equal(dataArquivo(new Date(2026, 0, 5)), '2026-01-05');
  assert.equal(slugArquivo('EES'), 'ees');
  assert.equal(slugArquivo('Ç/ã B'), 'c-a-b');
  assert.equal(slugArquivo('', 'sag-18'), 'sag-18');
  assert.equal(slugArquivo('../..', 'escola'), 'escola');
});

/* ---------------- rótulos (espelho de frontend/src/data.js) ---------------- */

test('rótulos: turma, região, grupo, turno e série', () => {
  assert.equal(turmaRotulo('3 ANO'), '3º ano');
  assert.equal(turmaRotulo('9° ANO'), '9º ano');
  assert.equal(turmaRotulo('8ºANOA'), '8º ano A');
  assert.equal(turmaRotulo('4º A'), '4º ano A');
  assert.equal(turmaRotulo('6A'), '6º ano A');
  assert.equal(turmaRotulo('TURMA MULT'), 'TURMA MULT');
  assert.equal(regiaoRotulo(''), 'Região não definida');
  assert.equal(regiaoRotulo('PEDREIRAS'), 'PEDREIRAS');
  assert.equal(grupoRotulo(null), 'Sem grupo');
  assert.equal(grupoRotulo({ nome: 'Grupo 1' }), 'Grupo 1');
  assert.equal(turnoRotulo(''), 'Turno não informado');
  const ano = rotuladorDeAnos([{ ordem: 1, nome: '1º ano' }, { ordem: 20, nome: 'EJA' }]);
  assert.equal(ano(1), '1º ano');
  assert.equal(ano(20), 'EJA');
  assert.equal(ano(0), 'Turma de habilidades');
  assert.equal(ano(99), 'Não classificada');
  assert.equal(ano(7), '7º ano');
});

/* ---------------- indicadores ---------------- */

const av = (id, alunoId, data, resultado) => ({ id, alunoId, data: new Date(data), resultado });

test('último resultado: vale a verificação mais recente; empate na data → a registrada por último', () => {
  const avs = [
    av('c1', 'a1', '2026-03-01', 1), av('c2', 'a1', '2026-04-01', 2), // a1: atingiu no último
    av('c3', 'a2', '2026-04-01', 2), av('c4', 'a2', '2026-03-01', 1), // a2: ordem de chegada não importa
    av('c6', 'a3', '2026-05-01', 2), av('c5', 'a3', '2026-05-01', 1), // a3: empate → id maior (c6)
    av('c7', 'a4', '2026-05-01', 1),
  ];
  const ultimo = ultimoResultadoPorAluno(avs);
  assert.deepEqual(Object.fromEntries(ultimo), { a1: 2, a2: 2, a3: 2, a4: 1 });

  const r = resumoAvaliacoes(avs);
  assert.equal(r.avaliacoes, 7);
  assert.equal(r.pctAtingiu, Math.round((3 / 7) * 100)); // c2, c3, c6 são "Atingiu"
  assert.equal(r.alunosAvaliados, 4);
  assert.equal(r.alunosAtingiram, 3);
  assert.equal(r.alunosNaoAtingiram, 1);
  assert.equal(r.alunosAtingiram + r.alunosNaoAtingiram, r.alunosAvaliados);
  assert.equal(avs[0].id, 'c1', 'a entrada não é reordenada nem alterada');
});

test('resumo sem avaliações: zeros e % nulo (tela mostra "Sem avaliações")', () => {
  assert.deepEqual(resumoAvaliacoes([]), {
    avaliacoes: 0, pctAtingiu: null, alunosAvaliados: 0, alunosAtingiram: 0, alunosNaoAtingiram: 0,
  });
});

test('professores por escola: distintos, só turmas existentes, total sem dupla contagem', () => {
  const turmaEscola = new Map([['t1', 'e1'], ['t2', 'e1'], ['t3', 'e2']]);
  const professores = [
    { id: 'p1', turmaIds: JSON.stringify(['t1', 't2', 't3']) }, // 2 turmas na e1 + 1 na e2
    { id: 'p2', turmaIds: JSON.stringify(['t1']) },
    { id: 'p3', turmaIds: '[]' },                               // sem turma: não conta
    { id: 'p4', turmaIds: JSON.stringify(['t-removida']) },     // turma que não existe mais
    { id: 'p5', turmaIds: 'json inválido' },
  ];
  const r = professoresPorEscola(professores, turmaEscola);
  assert.equal(r.daEscola('e1'), 2);
  assert.equal(r.daEscola('e2'), 1);
  assert.equal(r.daEscola('e3'), 0);
  assert.equal(r.total, 2, 'p1 conta uma vez na rede, mesmo em duas escolas');
});

test('agruparPor: cria grupos novos sem alterar a entrada', () => {
  const itens = [{ k: 'a', v: 1 }, { k: 'b', v: 2 }, { k: 'a', v: 3 }];
  const g = agruparPor(itens, i => i.k);
  assert.deepEqual(g.get('a').map(i => i.v), [1, 3]);
  assert.deepEqual(g.get('b').map(i => i.v), [2]);
  assert.equal(itens.length, 3);
});
