/* ============================================================
   Testes do dashboard evolutivo — GET /dashboard/evolucao.
   Somente leitura (não cria nem remove dados); autossuficiente
   em relação ao conteúdo do banco: valida escopo por perfil,
   shape da resposta e coerência interna das agregações.

   Execução: node --test test/evolucao.test.js   (ou npm test)
   ============================================================ */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import 'dotenv/config';
import { buildApp } from '../src/app.js';

const EMAILS = {
  secretaria: 'beatriz@rededeensino.edu.br',
  gestor: 'camila@rededeensino.edu.br',
  professor: 'helena@rededeensino.edu.br',
};

let app;
const tok = {};

const H = t => (t ? { authorization: 'Bearer ' + t } : {});
const inj = (method, url, { token, body } = {}) =>
  app.inject({
    method, url,
    headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...H(token) },
    payload: body !== undefined ? JSON.stringify(body) : undefined,
  });

before(async () => {
  app = await buildApp({ logger: false });
  await app.ready();
  for (const [perfil, email] of Object.entries(EMAILS)) {
    const r = await inj('POST', '/api/auth/login', { body: { email, senha: 'demo123' } });
    assert.equal(r.statusCode, 200, `login ${perfil} deve ser 200`);
    tok[perfil] = r.json().token;
  }
});
after(async () => { await app.close(); });

// coerência comum a todos os escopos
function checaBase(r) {
  const d = r.json();
  assert.equal(r.statusCode, 200);
  assert.ok(d.totais && Array.isArray(d.meses) && Array.isArray(d.entidades), 'shape básico');
  const somaMeses = d.meses.reduce((s, m) => s + m.avaliacoes, 0);
  assert.equal(somaMeses, d.totais.avaliacoes, 'avaliações dos meses somam o total');
  for (const m of d.meses) {
    assert.match(m.id, /^m\d{2}$/, 'mês no formato m01..m12');
    if (m.pctAtingiu != null) assert.ok(m.pctAtingiu >= 0 && m.pctAtingiu <= 100, '% dentro de 0..100');
  }
  for (const e of d.entidades) {
    assert.equal(e.serie.length, d.meses.length, 'série da entidade acompanha o eixo de meses');
  }
  assert.ok(Array.isArray(d.habilidades.dificuldades) && Array.isArray(d.habilidades.destaques));
  return d;
}

test('evolucao: exige autenticação', async () => {
  const r = await inj('GET', '/api/dashboard/evolucao');
  assert.equal(r.statusCode, 401);
});

test('evolucao: professor vê suas turmas e o roster de alunos', async () => {
  const d = checaBase(await inj('GET', '/api/dashboard/evolucao', { token: tok.professor }));
  assert.equal(d.escopo, 'professor');
  assert.ok(d.totais.turmas >= 1, 'professor tem ao menos 1 turma');
  assert.equal(d.entidades.length, d.totais.turmas, 'entidades = turmas do professor');
  assert.ok(Array.isArray(d.alunos), 'roster de alunos presente');
  assert.equal(d.totais.alunos, d.alunos.length, 'contagem de alunos = roster');
  assert.equal(d.totais.alunosSemAvaliacao, d.totais.alunos - d.totais.alunosAvaliados);
  for (const a of d.alunos) {
    assert.equal(a.serie.length, d.meses.length, 'série mensal por aluno acompanha o eixo');
  }
});

test('evolucao: gestor restrito às suas escolas + drill turma→alunos', async () => {
  const d = checaBase(await inj('GET', '/api/dashboard/evolucao', { token: tok.gestor }));
  assert.equal(d.escopo, 'gestor');
  const me = await inj('GET', '/api/auth/me', { token: tok.gestor });
  const escopo = me.json().user.escolaIds || [];
  assert.equal(d.entidades.length, escopo.length, 'entidades = escolas do gestor');
  for (const e of d.entidades) assert.ok(escopo.includes(e.id), 'escola dentro do escopo');
  assert.equal(d.alunos, null, 'sem drill não devolve alunos');

  if (escopo.length) {
    const r2 = await inj('GET', '/api/dashboard/evolucao?escola=' + escopo[0], { token: tok.gestor });
    const d2 = r2.json();
    assert.ok(Array.isArray(d2.turmasDetalhe), 'drill de escola devolve turmas');
    const turma = d2.turmasDetalhe[0];
    if (turma) {
      const r3 = await inj('GET', `/api/dashboard/evolucao?escola=${escopo[0]}&turma=${turma.id}`, { token: tok.gestor });
      const d3 = r3.json();
      assert.ok(Array.isArray(d3.alunos), 'drill de turma devolve alunos');
      assert.equal(d3.alunos.length, turma.totAlunos, 'roster do drill bate com totAlunos');
    }
    // escola fora do escopo do gestor não é detalhada
    const rFora = await inj('GET', '/api/dashboard/evolucao?escola=__fora__', { token: tok.gestor });
    assert.equal(rFora.json().turmasDetalhe, null);
  }
});

test('evolucao: secretaria/admin enxergam a rede toda', async () => {
  const d = checaBase(await inj('GET', '/api/dashboard/evolucao', { token: tok.secretaria }));
  assert.equal(d.escopo, 'rede');
  const [escolas, turmas, alunos] = await Promise.all([
    app.prisma.escola.count(), app.prisma.turma.count(), app.prisma.aluno.count(),
  ]);
  assert.equal(d.totais.escolas, escolas, 'todas as escolas da rede');
  assert.equal(d.totais.turmas, turmas, 'todas as turmas da rede');
  assert.equal(d.totais.alunos, alunos, 'todos os alunos da rede');
  // na rede, entidades listam apenas escolas com verificações
  assert.equal(d.entidades.length, d.totais.escolasComAtividade);
  for (const e of d.entidades) assert.ok(e.avaliacoes > 0);
});
