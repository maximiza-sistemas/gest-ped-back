/* ============================================================
   Escopo do gestor — o gestor só enxerga dados das escolas a que
   está vinculado (Usuario.escolaIds). Somente leitura: não cria
   nem remove registros; usa os logins demo.

   Execução: node --test test/escopo-gestor.test.js   (ou npm test)
   ============================================================ */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import 'dotenv/config';
import { buildApp } from '../src/app.js';

let app;
const tok = {};
let gestor; // usuário logado (com escolaIds)

const H = t => (t ? { authorization: 'Bearer ' + t } : {});
const get = (url, token) => app.inject({ method: 'GET', url, headers: H(token) });

before(async () => {
  app = await buildApp({ logger: false });
  await app.ready();
  for (const [perfil, email] of Object.entries({
    secretaria: 'beatriz@rededeensino.edu.br',
    gestor: 'camila@rededeensino.edu.br',
  })) {
    const r = await app.inject({
      method: 'POST', url: '/api/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ email, senha: 'demo123' }),
    });
    assert.equal(r.statusCode, 200, `login ${perfil} deve ser 200`);
    tok[perfil] = r.json().token;
    if (perfil === 'gestor') gestor = r.json().user || r.json().usuario;
  }
  assert.ok(Array.isArray(gestor?.escolaIds) && gestor.escolaIds.length > 0, 'gestor demo precisa ter escolas vinculadas');
});
after(async () => { await app.close(); });

test('GET /meta para gestor: só as suas escolas, professores do escopo e sem lista de usuários', async () => {
  const [rg, rs, rt] = await Promise.all([
    get('/api/meta', tok.gestor), get('/api/meta', tok.secretaria), get('/api/turmas', tok.gestor),
  ]);
  assert.equal(rg.statusCode, 200);
  assert.equal(rs.statusCode, 200);
  const mg = rg.json(), ms = rs.json();
  const escopo = new Set(gestor.escolaIds);

  // escolas: subconjunto exato do vínculo
  assert.ok(mg.ESCOLAS.length > 0, 'gestor deve receber pelo menos uma escola');
  for (const e of mg.ESCOLAS) assert.ok(escopo.has(e.id), `escola ${e.id} fora do escopo do gestor`);
  assert.ok(ms.ESCOLAS.length >= mg.ESCOLAS.length, 'secretaria vê a rede toda');

  // usuários: exclusivo de admin/secretaria
  assert.deepEqual(mg.USUARIOS, []);
  assert.ok(ms.USUARIOS.length > 0);

  // professores: só quem tem turma nas escolas do gestor
  const turmasEscopo = new Set(rt.json().map(t => t.id));
  for (const pr of mg.PROFESSORES) {
    assert.ok(pr.turmaIds.some(t => turmasEscopo.has(t)), `professor ${pr.id} sem turma no escopo do gestor`);
  }
  assert.ok(ms.PROFESSORES.length >= mg.PROFESSORES.length);

  // catálogos continuam completos (não dependem de escopo)
  assert.deepEqual(mg.HABILIDADES.length, ms.HABILIDADES.length);
  assert.deepEqual(mg.PERIODOS.length, ms.PERIODOS.length);
});

test('GET /planejamentos para gestor: só planos da rede ou de grupos das suas escolas', async () => {
  const [rg, rs, rm] = await Promise.all([
    get('/api/planejamentos', tok.gestor), get('/api/planejamentos', tok.secretaria), get('/api/meta', tok.gestor),
  ]);
  assert.equal(rg.statusCode, 200);
  const gruposEscopo = new Set(rm.json().ESCOLAS.map(e => e.grupoId).filter(Boolean));
  const noEscopo = pl => pl.grupos.length === 0 || pl.grupos.some(g => gruposEscopo.has(g.id));

  const visiveis = rg.json();
  for (const pl of visiveis) assert.ok(noEscopo(pl), `plano "${pl.titulo}" fora do escopo apareceu para o gestor`);

  // tudo que a secretaria vê e está no escopo também aparece para o gestor; o resto é negado no detalhe
  const idsGestor = new Set(visiveis.map(pl => pl.id));
  for (const pl of rs.json()) {
    if (noEscopo(pl)) {
      assert.ok(idsGestor.has(pl.id), `plano "${pl.titulo}" do escopo não apareceu para o gestor`);
    } else {
      assert.ok(!idsGestor.has(pl.id));
      const rd = await get('/api/planejamentos/' + pl.id, tok.gestor);
      assert.equal(rd.statusCode, 403, `detalhe do plano "${pl.titulo}" deveria ser negado ao gestor`);
    }
  }
});

test('rotas de rede continuam negadas ao gestor', async () => {
  for (const url of ['/api/escolas', '/api/rede', '/api/grupos']) {
    const r = await get(url, tok.gestor);
    assert.equal(r.statusCode, 403, `${url} deveria ser 403 para gestor`);
  }
});
