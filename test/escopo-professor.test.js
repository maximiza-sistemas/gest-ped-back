/* ============================================================
   Escopo do professor — vê só as turmas em que leciona e só os
   planejamentos direcionados ao grupo, ao ano escolar e ao
   componente dessas turmas. Somente leitura (logins demo).
   Execução: node --test test/escopo-professor.test.js   (ou npm test)
   ============================================================ */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import 'dotenv/config';
import { buildApp } from '../src/app.js';

let app;
const tok = {};
let prof; // { compId, turmaIds }
let ctx;  // { grupos:Set, anos:Set }
let compDaHab;

const H = t => (t ? { authorization: 'Bearer ' + t } : {});
const get = (url, token) => app.inject({ method: 'GET', url, headers: H(token) });

before(async () => {
  app = await buildApp({ logger: false });
  await app.ready();
  for (const [perfil, email] of Object.entries({
    secretaria: 'beatriz@rededeensino.edu.br',
    professor: 'helena@rededeensino.edu.br',
  })) {
    const r = await app.inject({
      method: 'POST', url: '/api/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ email, senha: 'demo123' }),
    });
    assert.equal(r.statusCode, 200, `login ${perfil}`);
    tok[perfil] = r.json().token;
    if (perfil === 'professor') prof = r.json().user || r.json().usuario;
  }
  const pr = await app.prisma.professor.findUnique({ where: { id: prof.profId } });
  prof = { compId: pr.compId, turmaIds: JSON.parse(pr.turmaIds || '[]') };
  assert.ok(prof.turmaIds.length > 0, 'professora demo precisa ter turmas vinculadas');
  const turmas = await app.prisma.turma.findMany({ where: { id: { in: prof.turmaIds } }, select: { ano: true, escola: { select: { grupoId: true } } } });
  ctx = { grupos: new Set(turmas.map(t => t.escola.grupoId).filter(Boolean)), anos: new Set(turmas.map(t => t.ano)) };
  compDaHab = new Map((await app.prisma.habilidade.findMany({ select: { cod: true, compId: true } })).map(h => [h.cod, h.compId]));
});
after(async () => { await app.close(); });

// mesma regra do painel: grupo (vazio = rede) E ano (vazio = todos; 0 = coringa) E componente
const direcionado = pl =>
  (pl.grupos.length === 0 || pl.grupos.some(g => ctx.grupos.has(g.id)))
  && (pl.anos.length === 0 || ctx.anos.has(0) || pl.anos.some(a => ctx.anos.has(a)))
  && pl.habilidades.some(h => compDaHab.get(h) === prof.compId);

test('turmas do SAG têm o ano escolar real (não tudo em 1)', async () => {
  const dist = await app.prisma.turma.groupBy({ by: ['ano'], _count: { _all: true } });
  const anos = dist.map(d => d.ano).sort((a, b) => a - b);
  assert.ok(anos.length >= 5, 'esperava várias séries distintas no espelho, obteve ' + JSON.stringify(anos));
});

test('GET /turmas para professor: só as turmas em que leciona', async () => {
  const r = await get('/api/turmas', tok.professor);
  assert.equal(r.statusCode, 200);
  const ids = r.json().map(t => t.id).sort();
  assert.deepEqual(ids, [...prof.turmaIds].sort());
});

test('GET /planejamentos para professor: só planos direcionados a grupo + ano + componente', async () => {
  const [rp, rs] = await Promise.all([get('/api/planejamentos', tok.professor), get('/api/planejamentos', tok.secretaria)]);
  assert.equal(rp.statusCode, 200);
  const doProf = new Set(rp.json().map(pl => pl.id));
  for (const pl of rp.json()) assert.ok(direcionado(pl), `plano "${pl.titulo}" apareceu sem ser direcionado ao professor`);
  for (const pl of rs.json()) {
    if (direcionado(pl)) {
      assert.ok(doProf.has(pl.id), `plano "${pl.titulo}" direcionado não apareceu para o professor`);
    } else {
      assert.ok(!doProf.has(pl.id));
      const rd = await get('/api/planejamentos/' + pl.id, tok.professor);
      assert.equal(rd.statusCode, 403, `detalhe do plano "${pl.titulo}" deveria ser negado ao professor`);
    }
  }
});

test('GET /dashboard/evolucao para professor: habilidades direcionadas respeitam o ano das turmas', async () => {
  const [re, rp] = await Promise.all([get('/api/dashboard/evolucao', tok.professor), get('/api/planejamentos', tok.professor)]);
  assert.equal(re.statusCode, 200);
  const esperado = new Set(rp.json().flatMap(pl => pl.habilidades.filter(h => compDaHab.get(h) === prof.compId)));
  assert.equal(re.json().totais.habilidadesDirecionadas, esperado.size);
});
