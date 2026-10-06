/* ============================================================
   Testes dos filtros do painel do professor —
   GET /dashboard/evolucao?turma=<id>&comp=<id> (escopo professor).
   SOMENTE LEITURA: não cria, altera nem remove dados. Os valores
   esperados são lidos do próprio banco (prisma) para não depender
   de contagens fixas.

   Execução: node --test test/evolucao-filtros.test.js
   ============================================================ */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import 'dotenv/config';
import { buildApp } from '../src/app.js';
import { planoCasaAnos } from '../src/lib/escopo.js';
import { soTurmasVisiveis, soAlunosVisiveis, soAvaliacoesVisiveis } from '../src/lib/ativos.js';

const EMAILS = {
  professor: 'helena@rededeensino.edu.br', // profId p1
  supervisor: 'camila@rededeensino.edu.br',
  gestor: 'paulo@rededeensino.edu.br',
  secretaria: 'beatriz@rededeensino.edu.br',
};
const URL = '/api/dashboard/evolucao';

let app;
const tok = {};
let prof;          // registro Professor da helena
let turmasProf;    // ids das turmas existentes da helena

const inj = (method, url, { token, body } = {}) =>
  app.inject({
    method, url,
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: 'Bearer ' + token } : {}),
    },
    payload: body !== undefined ? JSON.stringify(body) : undefined,
  });
const get = async (qs, perfil = 'professor') => inj('GET', URL + (qs ? '?' + qs : ''), { token: tok[perfil] });
const parseIds = s => { try { const v = JSON.parse(s || '[]'); return Array.isArray(v) ? v : []; } catch { return []; } };

/** Avaliações esperadas (contagem direta no banco) para turmas/componente. */
const contaAvaliacoes = (turmaIds, compId) => app.prisma.avaliacao.count({
  where: soAvaliacoesVisiveis({ aluno: { turmaId: { in: turmaIds } }, ...(compId ? { habilidade: { compId } } : {}) }),
});

// coerência interna de qualquer resposta 200
function coerente(r) {
  assert.equal(r.statusCode, 200, r.body);
  const d = r.json();
  const somaMeses = d.meses.reduce((s, m) => s + m.avaliacoes, 0);
  assert.equal(somaMeses, d.totais.avaliacoes, 'avaliações dos meses somam o total');
  const somaSemanas = d.meses.reduce((s, m) => s + m.semanas, 0);
  assert.equal(somaSemanas, d.totais.semanasPreenchidas, 'semanas dos meses somam o total');
  for (const e of d.entidades) assert.equal(e.serie.length, d.meses.length, 'série acompanha o eixo de meses');
  return d;
}

before(async () => {
  app = await buildApp({ logger: false });
  await app.ready();
  for (const [perfil, email] of Object.entries(EMAILS)) {
    const r = await inj('POST', '/api/auth/login', { body: { email, senha: 'demo123' } });
    assert.equal(r.statusCode, 200, `login ${perfil} deve ser 200`);
    tok[perfil] = r.json().token;
  }
  const me = (await inj('GET', '/api/auth/me', { token: tok.professor })).json().user;
  prof = await app.prisma.professor.findUnique({ where: { id: me.profId } });
  // turmas existentes e visíveis (turma excluída no SAG é ignorada — lib/ativos.js)
  const existentes = await app.prisma.turma.findMany({
    where: soTurmasVisiveis({ id: { in: parseIds(prof.turmaIds) } }), select: { id: true },
  });
  turmasProf = existentes.map(t => t.id);
  assert.ok(turmasProf.length >= 1, 'a professora demo precisa ter turmas vinculadas');
});
after(async () => { await app.close(); });

test('filtros: sem filtro, a resposta lista todas as turmas e os componentes do professor', async () => {
  const d = coerente(await get(''));
  assert.equal(d.escopo, 'professor');
  assert.ok(d.filtros, 'escopo professor devolve filtros');
  assert.deepEqual(d.filtros.aplicados, { turma: null, comp: null });
  assert.deepEqual(d.filtros.turmas.map(t => t.id).sort(), [...turmasProf].sort(), 'todas as turmas da professora');
  for (const t of d.filtros.turmas) {
    assert.equal(typeof t.nome, 'string');
    assert.equal(typeof t.ano, 'number');
    assert.equal(typeof t.escola, 'string', 'sigla da escola para desambiguar turmas homônimas');
  }
  assert.equal(d.filtros.componentes[0].id, prof.compId, 'o componente do professor vem primeiro');
  for (const c of d.filtros.componentes) assert.ok(c.id && c.nome, 'componente com id e nome');
  // componentes das habilidades avaliadas nas turmas dela também aparecem
  const avaliadas = await app.prisma.avaliacao.findMany({
    where: { aluno: { turmaId: { in: turmasProf } } }, distinct: ['habCod'],
    select: { habilidade: { select: { compId: true } } },
  });
  for (const a of avaliadas) {
    assert.ok(d.filtros.componentes.some(c => c.id === a.habilidade.compId), 'componente avaliado listado');
  }
});

test('filtros: as duas turmas da helena (sag-100 e sag-101) estão na lista', async () => {
  const d = coerente(await get(''));
  const ids = d.filtros.turmas.map(t => t.id);
  for (const id of ['sag-100', 'sag-101']) {
    if (turmasProf.includes(id)) assert.ok(ids.includes(id), `turma ${id} listada`);
  }
  assert.equal(ids.length, turmasProf.length);
});

test('filtros: ?turma recorta entidades, roster, eventos e totais para a turma', async () => {
  const geral = coerente(await get(''));
  let somaTurmas = 0;
  for (const turmaId of turmasProf) {
    const d = coerente(await get('turma=' + encodeURIComponent(turmaId)));
    assert.equal(d.filtros.aplicados.turma, turmaId);
    assert.equal(d.filtros.turmas.length, turmasProf.length, 'opções de turma não dependem do filtro');
    assert.deepEqual(d.entidades.map(e => e.id), [turmaId], 'entidades = só a turma filtrada');
    assert.equal(d.totais.turmas, 1);
    assert.ok(Array.isArray(d.alunos));
    for (const a of d.alunos) assert.equal(a.turmaId, turmaId, 'roster só da turma filtrada');
    const alunosTurma = await app.prisma.aluno.count({ where: soAlunosVisiveis({ turmaId }) });
    assert.equal(d.alunos.length, alunosTurma, 'roster completo da turma');
    assert.equal(d.totais.alunos, alunosTurma);
    for (const ev of d.eventosAcomp) assert.equal(ev.turmaId, turmaId, 'eventos só da turma filtrada');
    assert.equal(d.totais.avaliacoes, await contaAvaliacoes([turmaId]), 'avaliações da turma');
    assert.equal(d.entidades[0].avaliacoes, d.totais.avaliacoes);
    somaTurmas += d.totais.avaliacoes;
  }
  assert.equal(somaTurmas, geral.totais.avaliacoes, 'as turmas somadas reproduzem o total sem filtro');
});

test('filtros: ?turma de turma que não é do professor → 403', async () => {
  const outra = await app.prisma.turma.findFirst({ where: soTurmasVisiveis({ id: { notIn: turmasProf } }), select: { id: true } });
  if (outra) {
    const r = await get('turma=' + encodeURIComponent(outra.id));
    assert.equal(r.statusCode, 403);
    assert.match(r.json().error.message, /Turma fora das suas turmas/);
  }
  const inexistente = await get('turma=__nao_existe__');
  assert.equal(inexistente.statusCode, 403, 'turma inexistente também fica fora do escopo');
});

test('filtros: ?comp inexistente → 400', async () => {
  const r = await get('comp=__nao_existe__');
  assert.equal(r.statusCode, 400);
  assert.match(r.json().error.message, /Componente curricular inválido/);
});

test('filtros: ?comp recorta avaliações, ranking e direcionadas pelo componente', async () => {
  const geral = coerente(await get(''));
  const componentes = await app.prisma.componente.findMany({ select: { id: true } });
  const habComp = new Map((await app.prisma.habilidade.findMany({ select: { cod: true, compId: true } }))
    .map(h => [h.cod, h.compId]));
  let soma = 0;
  for (const { id: comp } of componentes) {
    const d = coerente(await get('comp=' + comp));
    assert.equal(d.filtros.aplicados.comp, comp);
    assert.equal(d.totais.avaliacoes, await contaAvaliacoes(turmasProf, comp), `avaliações de ${comp}`);
    const ranking = [...d.habilidades.dificuldades, ...d.habilidades.destaques];
    for (const h of ranking) assert.equal(habComp.get(h.cod), comp, 'ranking só com habilidades do componente');
    for (const ev of d.eventosAcomp) assert.equal(habComp.get(ev.habCod), comp, 'eventos só do componente');
    if (comp !== prof.compId) assert.equal(d.totais.habilidadesDirecionadas, 0, 'direcionadas só do componente do professor');
    assert.equal(d.alunos.length, geral.alunos.length, 'o roster não depende do componente');
    assert.equal(d.totais.alunosSemAvaliacao, d.totais.alunos - d.totais.alunosAvaliados);
    soma += d.totais.avaliacoes;
  }
  assert.equal(soma, geral.totais.avaliacoes, 'os componentes somados reproduzem o total sem filtro');
});

test('filtros: ?comp=lp × componente sem avaliações da professora (o segundo dá 0)', async () => {
  const lp = coerente(await get('comp=' + prof.compId));
  assert.equal(lp.totais.avaliacoes, await contaAvaliacoes(turmasProf, prof.compId));

  const componentes = await app.prisma.componente.findMany({ select: { id: true } });
  let vazio = null;
  for (const c of componentes) {
    if (c.id !== prof.compId && (await contaAvaliacoes(turmasProf, c.id)) === 0) { vazio = c.id; break; }
  }
  if (!vazio) return; // todos os componentes têm avaliações — nada a comparar
  const d = coerente(await get('comp=' + vazio));
  assert.equal(d.totais.avaliacoes, 0);
  assert.equal(d.totais.alunosAvaliados, 0);
  assert.equal(d.totais.pctAtingiu, null);
  assert.equal(d.totais.habilidadesAvaliadas, 0);
  assert.deepEqual(d.habilidades.dificuldades, []);
  assert.deepEqual(d.eventosAcomp, []);
  for (const a of d.alunos) assert.equal(a.avaliacoes, 0);
  assert.ok(d.filtros.componentes.some(c => c.id === vazio), 'o componente aplicado aparece nas opções');
});

test('filtros: ?turma + ?comp combinados', async () => {
  const turmaId = turmasProf[0];
  const d = coerente(await get(`turma=${encodeURIComponent(turmaId)}&comp=${prof.compId}`));
  assert.deepEqual(d.filtros.aplicados, { turma: turmaId, comp: prof.compId });
  assert.deepEqual(d.entidades.map(e => e.id), [turmaId]);
  assert.equal(d.totais.avaliacoes, await contaAvaliacoes([turmaId], prof.compId));
  for (const a of d.alunos) assert.equal(a.turmaId, turmaId);
});

// semanas de planejamento: a mesma base (todas as semanas da professora) com e sem
// filtro; o filtro só estreita — por componente das habilidades do plano e pelo ano
// da turma. Regressão: ?comp=<componente da professora> não pode zerar as semanas.
test('filtros: semanas de planejamento seguem a mesma regra com e sem filtro', async () => {
  const geral = coerente(await get(''));
  const habComp = new Map((await app.prisma.habilidade.findMany({ select: { cod: true, compId: true } }))
    .map(h => [h.cod, h.compId]));
  const semanas = await app.prisma.planejamentoSemana.findMany({
    where: { profId: prof.id },
    select: { planejamento: { select: { periodoId: true, anos: true, compId: true, habilidades: { select: { habCod: true } } } } },
  });
  // componentes de cada plano (plano sem habilidades: o compId do próprio plano)
  const compsDe = pl => new Set(pl.habilidades.length ? pl.habilidades.map(h => habComp.get(h.habCod)) : [pl.compId]);
  const porMes = lista => lista.reduce((m, s) => m.set(s.planejamento.periodoId, (m.get(s.planejamento.periodoId) || 0) + 1), new Map());
  const semanasDosMeses = d => new Map(d.meses.filter(m => m.semanas).map(m => [m.id, m.semanas]));

  assert.equal(geral.totais.semanasPreenchidas, semanas.length, 'sem filtro: todas as semanas preenchidas por ela');

  // ?comp: semanas dos planos com habilidade do componente — inclusive os meses do gráfico
  const componentes = await app.prisma.componente.findMany({ select: { id: true } });
  let somaComps = 0;
  for (const { id: comp } of componentes) {
    const esperadas = semanas.filter(s => compsDe(s.planejamento).has(comp));
    const d = coerente(await get('comp=' + comp));
    assert.equal(d.totais.semanasPreenchidas, esperadas.length, `semanas de ${comp}`);
    assert.deepEqual(semanasDosMeses(d), porMes(esperadas), `semanas por mês de ${comp}`);
    somaComps += d.totais.semanasPreenchidas;
  }
  // planos de um só componente particionam as semanas: a soma reproduz o total
  if (semanas.every(s => compsDe(s.planejamento).size === 1)) {
    assert.equal(somaComps, geral.totais.semanasPreenchidas, 'os componentes somados reproduzem as semanas sem filtro');
  }
  // todos os planos dela no próprio componente → filtrar por ele não muda nada
  if (semanas.every(s => compsDe(s.planejamento).has(prof.compId))) {
    const d = coerente(await get('comp=' + prof.compId));
    assert.equal(d.totais.semanasPreenchidas, geral.totais.semanasPreenchidas, '?comp do professor = sem filtro');
    assert.deepEqual(semanasDosMeses(d), semanasDosMeses(geral), 'mesmas barras de semanas por mês');
  }

  // ?turma: semanas dos planos direcionados ao ano da turma (sem anos = todas as séries)
  const turmas = await app.prisma.turma.findMany({ where: { id: { in: turmasProf } }, select: { id: true, ano: true } });
  for (const t of turmas) {
    const esperadas = semanas.filter(s => planoCasaAnos(s.planejamento.anos, new Set([t.ano])));
    const d = coerente(await get('turma=' + encodeURIComponent(t.id)));
    assert.equal(d.totais.semanasPreenchidas, esperadas.length, `semanas da turma ${t.id}`);
    assert.ok(d.totais.semanasPreenchidas <= geral.totais.semanasPreenchidas, 'o filtro de turma só estreita');
  }
});

// supervisor e gestor escolar: ?turma continua sendo o drill turma→alunos; ?comp é ignorado
for (const perfil of ['supervisor', 'gestor']) test(`filtros: ${perfil} mantém o drill ?turma e não recebe filtros`, async () => {
  const base = coerente(await get('', perfil));
  assert.equal(base.escopo, 'gestor');
  assert.equal(base.filtros, null, 'filtros são exclusivos do escopo professor');
  const ignorado = coerente(await get('comp=__qualquer__', perfil));
  assert.equal(ignorado.totais.avaliacoes, base.totais.avaliacoes, '?comp não afeta o escopo por escolas');

  const escolaIds = (await inj('GET', '/api/auth/me', { token: tok[perfil] })).json().user.escolaIds || [];
  if (!escolaIds.length) return;
  const d2 = coerente(await get('escola=' + escolaIds[0], perfil));
  const turma = (d2.turmasDetalhe || [])[0];
  if (!turma) return;
  const d3 = coerente(await get(`escola=${escolaIds[0]}&turma=${turma.id}`, perfil));
  assert.ok(Array.isArray(d3.alunos), 'drill de turma devolve alunos');
  assert.equal(d3.alunos.length, turma.totAlunos);
  for (const a of d3.alunos) assert.equal(a.turmaId, turma.id);
  // o drill não restringe os totais do escopo (diferente do filtro do professor)
  assert.equal(d3.totais.turmas, base.totais.turmas);
});

test('filtros: secretaria (rede) não recebe filtros e ignora ?comp', async () => {
  const d = coerente(await get('', 'secretaria'));
  assert.equal(d.escopo, 'rede');
  assert.equal(d.filtros, null);
  const r = await get('comp=__qualquer__', 'secretaria');
  assert.equal(r.statusCode, 200);
});
