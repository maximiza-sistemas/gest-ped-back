/* ============================================================
   Regras puras da validação do planejamento docente
   (lib/validacao.js) — sem banco, sem app.
   Execução: node --test test/validacao-regras.test.js
   ============================================================ */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  STATUS_VALIDACAO, MOTIVO_MIN, MOTIVO_MAX, transicao, bloqueioEdicao, normalizarMotivo,
  lerHistorico, acrescentarHistorico, shapeValidacao, ordenarValidacoes,
} from '../src/lib/validacao.js';

test('status canônicos, na ordem do fluxo, e imutáveis', () => {
  assert.deepEqual([...STATUS_VALIDACAO], ['rascunho', 'enviado', 'validado', 'recusado']);
  assert.ok(Object.isFrozen(STATUS_VALIDACAO));
});

test('transições permitidas', () => {
  const casos = [
    ['enviar', undefined, 'enviado'], ['enviar', null, 'enviado'], ['enviar', 'rascunho', 'enviado'], ['enviar', 'recusado', 'enviado'],
    ['validar', 'enviado', 'validado'],
    ['recusar', 'enviado', 'recusado'], ['recusar', 'validado', 'recusado'],
  ];
  for (const [acao, de, para] of casos) assert.deepEqual(transicao(acao, de), { ok: true, destino: para }, `${acao} a partir de ${de}`);
});

test('transições negadas trazem mensagem em português', () => {
  const casos = [
    ['enviar', 'enviado', /aguarde a análise do gestor escolar/], ['enviar', 'validado', /já validado/],
    ['validar', undefined, /ainda não enviou/], ['validar', 'rascunho', /ainda não enviou/],
    ['validar', 'validado', /já foi validado/], ['validar', 'recusado', /aguarde o reenvio/],
    ['recusar', 'rascunho', /ainda não enviou/], ['recusar', 'recusado', /aguarde o reenvio/],
  ];
  for (const [acao, de, msg] of casos) {
    const t = transicao(acao, de);
    assert.equal(t.ok, false, `${acao} a partir de ${de}`);
    assert.match(t.mensagem, msg);
  }
  assert.throws(() => transicao('apagar', 'enviado'), /desconhecida/);
});

test('edição travada só em enviado e validado', () => {
  assert.match(bloqueioEdicao('enviado'), /aguarde a análise/);
  assert.match(bloqueioEdicao('validado'), /já validado/);
  for (const s of [undefined, null, 'rascunho', 'recusado']) assert.equal(bloqueioEdicao(s), null);
});

test('motivo: obrigatório, com trim e limites', () => {
  for (const m of [undefined, null, '', '    ', 'abcd', ' ab  ', 42, {}]) assert.equal(normalizarMotivo(m).ok, false, JSON.stringify(m));
  assert.deepEqual(normalizarMotivo('  ajuste a semana 2  '), { ok: true, valor: 'ajuste a semana 2' });
  assert.equal(normalizarMotivo('x'.repeat(MOTIVO_MIN)).ok, true);
  assert.equal(normalizarMotivo('x'.repeat(MOTIVO_MAX)).ok, true);
  assert.match(normalizarMotivo('x'.repeat(MOTIVO_MAX + 1)).mensagem, /no máximo/);
});

test('histórico: leitura tolerante e acréscimo sem mutar o original', () => {
  assert.deepEqual(lerHistorico('não-json'), []);
  assert.deepEqual(lerHistorico('{"a":1}'), []);
  assert.deepEqual(lerHistorico(undefined), []);
  const original = JSON.stringify([{ acao: 'enviado' }]);
  const novo = acrescentarHistorico(original, { acao: 'validado' });
  assert.equal(original, JSON.stringify([{ acao: 'enviado' }]));
  assert.deepEqual(JSON.parse(novo).map(h => h.acao), ['enviado', 'validado']);
});

test('shapeValidacao: datas dd/mm/aaaa, nome do decisor e rascunho sem linha', () => {
  const v = {
    planejamentoId: 'pl1', profId: 'p1', status: 'recusado', motivo: 'Ajustar',
    enviadoEm: new Date(Date.UTC(2026, 5, 3, 12)), decididoEm: new Date(Date.UTC(2026, 5, 4, 12)), decididoPorId: 'u1',
    historico: JSON.stringify([{ acao: 'recusado', porId: 'u1', porNome: 'Paulo', em: '2026-06-04T12:00:00.000Z', motivo: 'Ajustar' }]),
  };
  const s = shapeValidacao(v, new Map([['u1', 'Paulo']]));
  assert.equal(s.enviadoEm, '03/06/2026');
  assert.equal(s.decididoEm, '04/06/2026');
  assert.equal(s.decididoPorNome, 'Paulo');
  assert.deepEqual(s.historico, [{ acao: 'recusado', porNome: 'Paulo', em: '04/06/2026', motivo: 'Ajustar' }]);
  assert.equal('porId' in s.historico[0], false, 'id do usuário não vaza no histórico');

  const vazio = shapeValidacao(null);
  assert.equal(vazio.status, 'rascunho');
  assert.equal(vazio.enviadoEm, null);
  assert.deepEqual(vazio.historico, []);
});

test('ordenação: pendentes primeiro (fila), depois devolvidos, validados e rascunhos', () => {
  const d = dia => new Date(Date.UTC(2026, 5, dia, 12));
  const linhas = [
    { id: 'rasc', status: 'rascunho' },
    { id: 'val-antigo', status: 'validado', decididoEm: d(2) },
    { id: 'env-novo', status: 'enviado', enviadoEm: d(9) },
    { id: 'rec', status: 'recusado', decididoEm: d(5) },
    { id: 'val-novo', status: 'validado', decididoEm: d(8) },
    { id: 'env-antigo', status: 'enviado', enviadoEm: d(1) },
  ];
  const copia = [...linhas];
  assert.deepEqual(ordenarValidacoes(linhas).map(l => l.id), ['env-antigo', 'env-novo', 'rec', 'val-novo', 'val-antigo', 'rasc']);
  assert.deepEqual(linhas, copia, 'não altera o array recebido');
});
