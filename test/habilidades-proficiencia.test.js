/* ============================================================
   Nível de proficiência (opcional) no cadastro de habilidades.
   Cria habilidades QA descartáveis (cod com prefixo 'qa-prof-',
   matriz/componente existentes) e as remove no teardown — não
   toca em nenhuma habilidade real.
   Execução: node --test test/habilidades-proficiencia.test.js
   ============================================================ */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import 'dotenv/config';
import { buildApp } from '../src/app.js';
import { NIVEIS_PROFICIENCIA } from '../src/lib/proficiencia.js';

const ESPERADOS = ['Abaixo do básico', 'Básico', 'Proficiente', 'Avançado'];
const PREFIXO = 'qa-prof-';
const sufixo = Date.now().toString(36);
const COD = `${PREFIXO}${sufixo}`;          // criada com nível
const COD_SEM = `${PREFIXO}${sufixo}-sem`;  // criada sem nível ('' → null)
const COD_NEGADO = `${PREFIXO}${sufixo}-x`; // nunca deve existir (inválida / perfis sem permissão)

let app;
let matriz;
let comp;
const tok = {};
const H = t => (t ? { authorization: 'Bearer ' + t } : {});
const req = (method, url, token, body) => app.inject({
  method, url,
  headers: { ...H(token), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
  ...(body !== undefined ? { payload: JSON.stringify(body) } : {}),
});
const habNoMeta = async (cod, token = tok.professor) => {
  const r = await req('GET', '/api/meta', token);
  assert.equal(r.statusCode, 200);
  return r.json().HABILIDADES.find(h => h.cod === cod);
};
const doBanco = cod => app.prisma.habilidade.findUnique({ where: { cod } });
const corpo = (cod, extra = {}) => ({ cod, matriz, comp, desc: 'Habilidade QA descartável do teste de proficiência.', ...extra });

before(async () => {
  app = await buildApp({ logger: false });
  await app.ready();
  for (const [perfil, email] of Object.entries({
    secretaria: 'beatriz@rededeensino.edu.br',
    admin: 'sergio@rededeensino.edu.br',
    supervisor: 'camila@rededeensino.edu.br',
    gestor: 'paulo@rededeensino.edu.br',
    professor: 'helena@rededeensino.edu.br',
  })) {
    const r = await req('POST', '/api/auth/login', null, { email, senha: 'demo123' });
    assert.equal(r.statusCode, 200, `login ${perfil}`);
    tok[perfil] = r.json().token;
  }
  // matriz e componente reais (somente leitura)
  matriz = (await app.prisma.matriz.findFirst({ orderBy: { id: 'asc' } })).id;
  comp = (await app.prisma.componente.findFirst({ orderBy: { id: 'asc' } })).id;
});

after(async () => {
  // teardown: só as habilidades QA criadas por este arquivo
  await app.prisma.habilidade.deleteMany({ where: { cod: { in: [COD, COD_SEM, COD_NEGADO] } } });
  const sobras = await app.prisma.habilidade.count({ where: { cod: { in: [COD, COD_SEM, COD_NEGADO] } } });
  assert.equal(sobras, 0, 'habilidades QA não foram removidas');
  await app.close();
});

test('lista de níveis: fonte única no backend com os 4 valores em ordem crescente', () => {
  assert.deepEqual([...NIVEIS_PROFICIENCIA], ESPERADOS);
});

test('GET /meta expõe NIVEIS_PROFICIENCIA para qualquer perfil autenticado', async () => {
  for (const perfil of ['professor', 'supervisor', 'secretaria']) {
    const r = await req('GET', '/api/meta', tok[perfil]);
    assert.equal(r.statusCode, 200);
    assert.deepEqual(r.json().NIVEIS_PROFICIENCIA, ESPERADOS, `NIVEIS_PROFICIENCIA para ${perfil}`);
  }
});

test('POST com nível válido grava e devolve a proficiência', async () => {
  const r = await req('POST', '/api/habilidades', tok.secretaria, corpo(COD, { nivelProficiencia: 'Proficiente' }));
  assert.equal(r.statusCode, 201, r.body);
  assert.equal(r.json().proficiencia, 'Proficiente');
  assert.equal((await doBanco(COD)).nivelProficiencia, 'Proficiente');
});

test('POST sem nível (string vazia) grava null e omite proficiencia', async () => {
  const r = await req('POST', '/api/habilidades', tok.secretaria, corpo(COD_SEM, { nivelProficiencia: '' }));
  assert.equal(r.statusCode, 201, r.body);
  assert.equal('proficiencia' in r.json(), false);
  assert.equal((await doBanco(COD_SEM)).nivelProficiencia, null);
});

test('POST com nível inválido → 400 com mensagem clara e nada é criado', async () => {
  for (const nivelProficiencia of ['Excelente', 'Intermediário', 42]) {
    const r = await req('POST', '/api/habilidades', tok.secretaria, corpo(COD_NEGADO, { nivelProficiencia }));
    assert.equal(r.statusCode, 400, `nível ${nivelProficiencia}`);
    assert.match(r.json().error.message, /Nível de proficiência inválido/);
    assert.match(r.json().error.message, /Abaixo do básico, Básico, Proficiente, Avançado/);
  }
  assert.equal(await doBanco(COD_NEGADO), null);
});

test('GET /meta traz a proficiência da habilidade QA (e omite quando não informada)', async () => {
  assert.equal((await habNoMeta(COD)).proficiencia, 'Proficiente');
  const sem = await habNoMeta(COD_SEM);
  assert.ok(sem, 'habilidade QA sem nível deve aparecer no catálogo');
  assert.equal('proficiencia' in sem, false);
});

test('PATCH altera o nível (aceita caixa/acentos diferentes e normaliza)', async () => {
  let r = await req('PATCH', `/api/habilidades/${COD}`, tok.secretaria, { nivelProficiencia: 'Avançado' });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().proficiencia, 'Avançado');
  assert.equal((await doBanco(COD)).nivelProficiencia, 'Avançado');

  r = await req('PATCH', `/api/habilidades/${COD}`, tok.secretaria, { nivelProficiencia: '  abaixo do basico ' });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().proficiencia, 'Abaixo do básico');
  assert.equal((await habNoMeta(COD)).proficiencia, 'Abaixo do básico');
});

test('PATCH com null limpa o nível; string vazia também', async () => {
  let r = await req('PATCH', `/api/habilidades/${COD}`, tok.secretaria, { nivelProficiencia: null });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal('proficiencia' in r.json(), false);
  assert.equal((await doBanco(COD)).nivelProficiencia, null);
  assert.equal('proficiencia' in (await habNoMeta(COD)), false);

  await req('PATCH', `/api/habilidades/${COD}`, tok.secretaria, { nivelProficiencia: 'Básico' });
  r = await req('PATCH', `/api/habilidades/${COD}`, tok.secretaria, { nivelProficiencia: '' });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal((await doBanco(COD)).nivelProficiencia, null);
});

test('PATCH: admin (superusuário) também altera; rótulo e descrição editáveis sem mexer no nível', async () => {
  let r = await req('PATCH', `/api/habilidades/${COD}`, tok.admin, { nivelProficiencia: 'Básico' });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().proficiencia, 'Básico');

  r = await req('PATCH', `/api/habilidades/${COD}`, tok.secretaria, { rotulo: 'QA1', desc: '  Descrição QA alterada no teste.  ' });
  assert.equal(r.statusCode, 200, r.body);
  const h = r.json();
  assert.equal(h.rotulo, 'QA1');
  assert.equal(h.desc, 'Descrição QA alterada no teste.');
  assert.equal(h.proficiencia, 'Básico', 'nível não informado no PATCH deve ser mantido');
  assert.equal(h.matriz, matriz);
  assert.equal(h.comp, comp);

  r = await req('PATCH', `/api/habilidades/${COD}`, tok.secretaria, { rotulo: '' });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal('rotulo' in r.json(), false);
});

test('PATCH inválido → 400 sem alterar; inexistente → 404; corpo vazio → 400', async () => {
  const antes = (await doBanco(COD)).nivelProficiencia;
  let r = await req('PATCH', `/api/habilidades/${COD}`, tok.secretaria, { nivelProficiencia: 'Ótimo' });
  assert.equal(r.statusCode, 400);
  assert.match(r.json().error.message, /Nível de proficiência inválido/);
  assert.equal((await doBanco(COD)).nivelProficiencia, antes);

  r = await req('PATCH', `/api/habilidades/${COD}`, tok.secretaria, { desc: '  ab ' });
  assert.equal(r.statusCode, 400);
  assert.match(r.json().error.message, /descrição/i);

  r = await req('PATCH', `/api/habilidades/${COD_NEGADO}`, tok.secretaria, { nivelProficiencia: 'Básico' });
  assert.equal(r.statusCode, 404);
  assert.equal(await doBanco(COD_NEGADO), null);

  r = await req('PATCH', `/api/habilidades/${COD}`, tok.secretaria, {});
  assert.equal(r.statusCode, 400);
  assert.match(r.json().error.message, /ao menos um campo/);
});

test('professor, supervisor e gestor escolar não criam nem alteram (403); sem token → 401', async () => {
  const antes = (await doBanco(COD)).nivelProficiencia;
  for (const perfil of ['professor', 'supervisor', 'gestor']) {
    const c = await req('POST', '/api/habilidades', tok[perfil], corpo(COD_NEGADO, { nivelProficiencia: 'Básico' }));
    assert.equal(c.statusCode, 403, `POST ${perfil}`);
    const u = await req('PATCH', `/api/habilidades/${COD}`, tok[perfil], { nivelProficiencia: 'Avançado' });
    assert.equal(u.statusCode, 403, `PATCH ${perfil}`);
  }
  assert.equal((await req('PATCH', `/api/habilidades/${COD}`, null, { nivelProficiencia: 'Avançado' })).statusCode, 401);
  assert.equal(await doBanco(COD_NEGADO), null, 'nenhum perfil sem permissão pode ter criado a habilidade');
  assert.equal((await doBanco(COD)).nivelProficiencia, antes, 'nível não pode ter mudado');
});

test('DELETE remove a habilidade QA sem uso (secretaria)', async () => {
  const r = await req('DELETE', `/api/habilidades/${COD_SEM}`, tok.secretaria);
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(await doBanco(COD_SEM), null);
});
