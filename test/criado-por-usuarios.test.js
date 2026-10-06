/* ============================================================
   Telas de supervisor / gestor escolar / admin:
   - `criadoPorNome` em GET /planejamentos e /planejamentos/:id
     (nome real de quem direcionou; null quando o usuário não existe);
   - GET /admin/usuarios traz contas inativas com `ativo: false`
     (o /meta continua só com as ativas — switch demo do topbar).
   Registros descartáveis 'QA*' criados aqui são removidos no after.
   Execução: node --test --test-concurrency=1 test/criado-por-usuarios.test.js
   ============================================================ */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import 'dotenv/config';
import { buildApp } from '../src/app.js';

let app;
const tok = {};
const users = {};
const criados = { planos: [], usuarios: [] };
const H = t => (t ? { authorization: 'Bearer ' + t } : {});
const inj = (method, url, token, body) => app.inject({
  method, url,
  headers: { ...H(token), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
  ...(body !== undefined ? { payload: JSON.stringify(body) } : {}),
});
const login = (email, senha) => inj('POST', '/api/auth/login', null, { email, senha });

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
    const r = await login(email, 'demo123');
    assert.equal(r.statusCode, 200, `login ${perfil}`);
    tok[perfil] = r.json().token;
    users[perfil] = r.json().user;
  }
});

after(async () => {
  const p = app.prisma;
  if (criados.planos.length) {
    await p.avaliacao.deleteMany({ where: { planejamentoId: { in: criados.planos } } });
    await p.planejamento.deleteMany({ where: { id: { in: criados.planos } } }); // cascade: habilidades, trabalhos, semanas
  }
  if (criados.usuarios.length) await p.usuario.deleteMany({ where: { id: { in: criados.usuarios } } });
  await app.close();
});

/** Plano descartável da rede toda (sem séries/grupos), criado pela secretaria. */
const criarPlanoQA = async () => {
  const p = app.prisma;
  const [periodo, hab] = await Promise.all([
    p.periodo.findFirst({ orderBy: { inicio: 'asc' } }),
    p.habilidade.findFirst({ where: { compId: 'lp' }, orderBy: { cod: 'asc' } }),
  ]);
  assert.ok(periodo && hab, 'precisa de um período e de uma habilidade de LP no catálogo');
  const r = await inj('POST', '/api/planejamentos', tok.secretaria, {
    titulo: 'QA Criado por', objetivo: '', periodo: periodo.id, anos: [], grupos: [], habilidades: [hab.cod],
  });
  assert.equal(r.statusCode, 201);
  criados.planos.push(r.json().id);
  return r.json();
};

/* ---------------- criadoPorNome ---------------- */

test('POST /planejamentos devolve criadoPorNome de quem direcionou', async () => {
  const plano = await criarPlanoQA();
  assert.equal(plano.criadoPor, users.secretaria.id);
  assert.equal(plano.criadoPorNome, users.secretaria.nome);
});

test('GET /planejamentos: criadoPorNome bate com o nome do usuário no banco, para todos os perfis', async () => {
  const nomes = new Map((await app.prisma.usuario.findMany({ select: { id: true, nome: true } })).map(u => [u.id, u.nome]));
  for (const perfil of ['supervisor', 'gestor', 'professor', 'secretaria']) {
    const r = await inj('GET', '/api/planejamentos', tok[perfil]);
    assert.equal(r.statusCode, 200, perfil);
    const lista = r.json();
    for (const pl of lista) {
      assert.ok('criadoPorNome' in pl, `${perfil}: plano ${pl.id} sem criadoPorNome`);
      assert.equal(pl.criadoPorNome, pl.criadoPor ? (nomes.get(pl.criadoPor) ?? null) : null, `${perfil}: plano ${pl.id}`);
      // plano legado sem criador: criadoPor e criadoPorNome são null (checado acima)
      if (pl.criadoPor) assert.notEqual(pl.criadoPorNome, pl.criadoPor, 'nunca o id cru no lugar do nome');
    }
    // o plano QA é da rede toda com habilidade de LP: chega a todos esses perfis
    const qa = lista.find(pl => criados.planos.includes(pl.id));
    assert.ok(qa, `${perfil} deveria ver o plano QA`);
    assert.equal(qa.criadoPorNome, users.secretaria.nome);
  }
});

test('GET /planejamentos/:id: supervisor e gestor escolar recebem o nome real do criador', async () => {
  const [id] = criados.planos;
  for (const perfil of ['supervisor', 'gestor']) {
    const r = await inj('GET', '/api/planejamentos/' + id, tok[perfil]);
    assert.equal(r.statusCode, 200, perfil);
    assert.equal(r.json().criadoPorNome, users.secretaria.nome, perfil);
  }
});

test('criador inexistente (sem FK) → criadoPorNome null, sem quebrar a rota', async () => {
  const [id] = criados.planos;
  await app.prisma.planejamento.update({ where: { id }, data: { criadoPorId: 'u-qa-inexistente' } });
  const r = await inj('GET', '/api/planejamentos/' + id, tok.gestor);
  assert.equal(r.statusCode, 200);
  assert.equal(r.json().criadoPor, 'u-qa-inexistente');
  assert.equal(r.json().criadoPorNome, null);
  const lista = (await inj('GET', '/api/planejamentos', tok.gestor)).json();
  assert.equal(lista.find(pl => pl.id === id).criadoPorNome, null);
});

/* ---------------- /admin/usuarios com inativos ---------------- */

test('GET /admin/usuarios inclui conta inativa (ativo: false); /meta e o login não', async () => {
  const email = `qa.inativa.${Date.now().toString(36)}@qa.invalid`;
  const c = await inj('POST', '/api/admin/usuarios', tok.admin, {
    nome: 'QA Conta Inativa', email, senha: 'qa-senha-123', perfil: 'gestor', cargo: 'QA', escolaIds: [],
  });
  assert.equal(c.statusCode, 201);
  const id = c.json().id;
  criados.usuarios.push(id);
  assert.equal(c.json().ativo, true);

  const d = await inj('PATCH', '/api/admin/usuarios/' + id, tok.admin, { ativo: false });
  assert.equal(d.statusCode, 200);
  assert.equal(d.json().ativo, false);

  for (const perfil of ['admin', 'secretaria']) {
    const r = await inj('GET', '/api/admin/usuarios', tok[perfil]);
    assert.equal(r.statusCode, 200, perfil);
    const lista = r.json();
    const qa = lista.find(u => u.id === id);
    assert.ok(qa, `${perfil}: conta inativa precisa continuar listada`);
    assert.equal(qa.ativo, false);
    assert.ok(lista.every(u => typeof u.ativo === 'boolean'), 'todo usuário traz o status real');
    assert.ok(lista.every(u => !('senhaHash' in u)), 'sem hash de senha');
  }

  // /meta (switch demo e nomes) segue só com as contas ativas
  const meta = (await inj('GET', '/api/meta', tok.admin)).json();
  assert.ok(!meta.USUARIOS.some(u => u.id === id), 'conta inativa não entra no /meta');

  // conta inativa não entra
  assert.equal((await login(email, 'qa-senha-123')).statusCode, 401);
});

test('PATCH /admin/usuarios/:id: ninguém desativa a própria conta (como no DELETE)', async () => {
  const email = `qa.auto.${Date.now().toString(36)}@qa.invalid`;
  const c = await inj('POST', '/api/admin/usuarios', tok.admin, {
    nome: 'QA Autodesativação', email, senha: 'qa-senha-123', perfil: 'secretaria', cargo: 'QA',
  });
  assert.equal(c.statusCode, 201);
  const id = c.json().id;
  criados.usuarios.push(id);
  const l = await login(email, 'qa-senha-123');
  assert.equal(l.statusCode, 200);
  const tokQA = l.json().token;

  const r = await inj('PATCH', '/api/admin/usuarios/' + id, tokQA, { ativo: false });
  assert.equal(r.statusCode, 400);
  assert.match(r.json().error.message, /desativar o próprio usuário/);
  assert.equal((await app.prisma.usuario.findUnique({ where: { id }, select: { ativo: true } })).ativo, true, 'nada gravado');
  // editar outros dados da própria conta continua permitido
  assert.equal((await inj('PATCH', '/api/admin/usuarios/' + id, tokQA, { cargo: 'QA editado', ativo: true })).statusCode, 200);
  // outro administrador pode desativá-la
  const d = await inj('PATCH', '/api/admin/usuarios/' + id, tok.admin, { ativo: false });
  assert.equal(d.statusCode, 200);
  assert.equal(d.json().ativo, false);
});

test('GET /admin/usuarios é exclusivo de admin/secretaria', async () => {
  for (const perfil of ['supervisor', 'gestor', 'professor']) {
    assert.equal((await inj('GET', '/api/admin/usuarios', tok[perfil])).statusCode, 403, perfil);
  }
  assert.equal((await inj('GET', '/api/admin/usuarios')).statusCode, 401);
});
