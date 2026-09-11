/* ============================================================
   Expectativa de aprendizagem por habilidade nas semanas do
   professor (PlanejamentoSemana.expectativas).
   Cria um planejamento QA descartável (secretaria), grava semanas
   como professora e remove tudo no final (cascade).
   Execução: node --test test/semanas-expectativas.test.js
   ============================================================ */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import 'dotenv/config';
import { buildApp } from '../src/app.js';

let app;
const tok = {};
let planoId = null;
let habs = [];

const H = t => (t ? { authorization: 'Bearer ' + t } : {});
const inj = (method, url, { token, body } = {}) => app.inject({
  method, url,
  headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...H(token) },
  payload: body !== undefined ? JSON.stringify(body) : undefined,
});

before(async () => {
  app = await buildApp({ logger: false });
  await app.ready();
  for (const [perfil, email] of Object.entries({ secretaria: 'beatriz@rededeensino.edu.br', professor: 'helena@rededeensino.edu.br' })) {
    const r = await inj('POST', '/api/auth/login', { body: { email, senha: 'demo123' } });
    assert.equal(r.statusCode, 200, `login ${perfil}`);
    tok[perfil] = r.json().token;
  }
  // habilidades do componente da professora (LP)
  const prof = await app.prisma.usuario.findFirst({ where: { email: 'helena@rededeensino.edu.br' }, include: { professor: true } });
  habs = (await app.prisma.habilidade.findMany({ where: { compId: prof.professor.compId }, take: 2, select: { cod: true } })).map(h => h.cod);
  assert.equal(habs.length, 2);
  const r = await inj('POST', '/api/planejamentos', {
    token: tok.secretaria,
    body: { titulo: 'QA Expectativas', objetivo: '', periodo: 'm06', anos: [], grupos: [], habilidades: habs },
  });
  assert.equal(r.statusCode, 201, 'plano QA criado: ' + r.body);
  planoId = r.json().id;
});
after(async () => {
  if (planoId) await inj('DELETE', '/api/planejamentos/' + planoId, { token: tok.secretaria });
  await app.close();
});

test('secretaria não precisa informar expectativa (objetivo opcional)', async () => {
  const r = await inj('GET', '/api/planejamentos/' + planoId, { token: tok.secretaria });
  assert.equal(r.statusCode, 200);
  assert.equal(r.json().objetivo, '');
});

test('professor grava expectativa por habilidade verificada e ela volta na leitura', async () => {
  const [h1, h2] = habs;
  const r = await inj('POST', `/api/planejamentos/${planoId}/semanas`, {
    token: tok.professor,
    body: { semanas: [
      { semana: 1, habilidades: [h1], expectativas: { [h1]: '  Ler palavras com sílabas simples  ', [h2]: 'ignorada: não marcada' }, sequenciaDidatica: 'QA' },
      { semana: 2, habilidades: [h1, h2], expectativas: { [h2]: 'Escrever o nome completo', [h1]: '' } },
    ] },
  });
  assert.equal(r.statusCode, 201, r.body);
  const semanas = r.json();
  assert.deepEqual(semanas[0].expectativas, { [h1]: 'Ler palavras com sílabas simples' }); // só habilidade marcada, sem espaços
  assert.deepEqual(semanas[1].expectativas, { [h2]: 'Escrever o nome completo' });       // texto vazio não é guardado

  const d = await inj('GET', '/api/planejamentos/' + planoId, { token: tok.professor });
  assert.equal(d.statusCode, 200);
  const s1 = d.json().semanas.find(s => s.semana === 1);
  assert.deepEqual(s1.expectativas, { [h1]: 'Ler palavras com sílabas simples' });
});
