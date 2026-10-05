/* ============================================================
   GET /professores/resumo — resumo real do trabalho dos professores.
   Somente leitura; valida escopo por perfil e coerência dos números.
   Execução: node --test test/professores.test.js   (ou npm test)
   ============================================================ */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import 'dotenv/config';
import { buildApp } from '../src/app.js';

let app;
const tok = {};
const users = {};
const H = t => (t ? { authorization: 'Bearer ' + t } : {});
const get = (url, token) => app.inject({ method: 'GET', url, headers: H(token) });

before(async () => {
  app = await buildApp({ logger: false });
  await app.ready();
  for (const [perfil, email] of Object.entries({
    secretaria: 'beatriz@rededeensino.edu.br',
    supervisor: 'camila@rededeensino.edu.br', // antigo gestor de polo (somente leitura)
    gestor: 'paulo@rededeensino.edu.br',      // gestor escolar
    professor: 'helena@rededeensino.edu.br',
  })) {
    const r = await app.inject({
      method: 'POST', url: '/api/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ email, senha: 'demo123' }),
    });
    assert.equal(r.statusCode, 200, `login ${perfil}`);
    tok[perfil] = r.json().token;
    users[perfil] = r.json().user || r.json().usuario;
  }
});
after(async () => { await app.close(); });

const checaShape = pr => {
  for (const k of ['id', 'nome', 'comp', 'turmas', 'habilidadesDirecionadas', 'habilidadesTrabalhadas', 'progresso', 'avaliacoes', 'alunosAvaliados']) {
    assert.ok(k in pr, `campo ${k} ausente no resumo de ${pr.id}`);
  }
  assert.ok(pr.habilidadesTrabalhadas <= pr.habilidadesDirecionadas, 'trabalhadas ≤ direcionadas');
  if (pr.habilidadesDirecionadas === 0) assert.equal(pr.progresso, null);
  else assert.equal(pr.progresso, Math.round((pr.habilidadesTrabalhadas / pr.habilidadesDirecionadas) * 100));
  assert.ok(pr.alunosAvaliados <= pr.avaliacoes, 'alunos avaliados ≤ avaliações');
};

test('resumo exige autenticação', async () => {
  assert.equal((await get('/api/professores/resumo')).statusCode, 401);
});

test('secretaria: todos os professores, shape coerente', async () => {
  const r = await get('/api/professores/resumo', tok.secretaria);
  assert.equal(r.statusCode, 200);
  const lista = r.json();
  assert.ok(lista.length > 0);
  lista.forEach(checaShape);
});

for (const perfil of ['supervisor', 'gestor']) test(`${perfil}: só professores com turma nas suas escolas, e só essas turmas`, async () => {
  const r = await get('/api/professores/resumo', tok[perfil]);
  assert.equal(r.statusCode, 200);
  const escopo = new Set(users[perfil].escolaIds);
  assert.ok(escopo.size > 0, `${perfil} demo precisa ter escolas vinculadas`);
  const lista = r.json();
  for (const pr of lista) {
    checaShape(pr);
    assert.ok(pr.turmas.length > 0, `professor ${pr.id} sem turma no escopo apareceu para ${perfil}`);
    for (const t of pr.turmas) assert.ok(escopo.has(t.escolaId), `turma ${t.id} fora das escolas de ${perfil}`);
  }
});

test('professor: recebe somente o próprio resumo', async () => {
  const r = await get('/api/professores/resumo', tok.professor);
  assert.equal(r.statusCode, 200);
  const lista = r.json();
  assert.equal(lista.length, 1);
  assert.equal(lista[0].id, users.professor.profId);
  checaShape(lista[0]);
});
