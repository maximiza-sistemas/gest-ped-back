/* ============================================================
   Escopo por escolas — SUPERVISOR (antigo gestor de polo, somente
   leitura) e GESTOR ESCOLAR (perfil 'gestor'). Ambos só enxergam
   dados das escolas vinculadas (Usuario.escolaIds).

   Somente leitura sobre os dados reais: as tentativas de escrita
   usam ids válidos e esperam 403 ANTES de qualquer gravação (o
   corpo é montado para que nem um handler sem guarda chegasse a
   gravar). Registros criados, todos descartáveis 'QA' e removidos
   no after: um usuário supervisor, um planejamento da rede (com
   semanas/validações, removidas em cascata) e um professor que
   leciona fora da escola do gestor escolar.

   Execução: node --test test/escopo-gestor.test.js   (ou npm test)
   ============================================================ */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import 'dotenv/config';
import { buildApp } from '../src/app.js';
import { migrarGestorSupervisor } from '../scripts/migrar-gestor-supervisor.js';

const EMAILS = {
  secretaria: 'beatriz@rededeensino.edu.br',
  supervisor: 'camila@rededeensino.edu.br',
  gestor: 'paulo@rededeensino.edu.br',
  professor: 'helena@rededeensino.edu.br',
};

let app;
const tok = {};
const users = {};
const criadosQA = []; // ids de usuários descartáveis
const qa = { planoId: null, profId: null }; // plano e professor descartáveis (teste do detalhe)

const H = t => (t ? { authorization: 'Bearer ' + t } : {});
const get = (url, token) => app.inject({ method: 'GET', url, headers: H(token) });
const send = (method, url, token, body) => app.inject({
  method, url,
  headers: { ...H(token), 'content-type': 'application/json' },
  payload: JSON.stringify(body ?? {}),
});
const login = (email, senha = 'demo123') => send('POST', '/api/auth/login', null, { email, senha });

before(async () => {
  app = await buildApp({ logger: false });
  await app.ready();
  for (const [perfil, email] of Object.entries(EMAILS)) {
    const r = await login(email);
    assert.equal(r.statusCode, 200, `login ${perfil} (${email}) deve ser 200`);
    tok[perfil] = r.json().token;
    users[perfil] = r.json().user;
  }
});

after(async () => {
  // plano antes do professor: o cascade do plano leva semanas e validações do professor QA
  if (qa.planoId) await app.prisma.planejamento.deleteMany({ where: { id: qa.planoId } });
  if (qa.profId) await app.prisma.professor.deleteMany({ where: { id: qa.profId } });
  if (criadosQA.length) await app.prisma.usuario.deleteMany({ where: { id: { in: criadosQA } } });
  await app.close();
});

/* ---------------- perfis e login ---------------- */

test('login: camila é supervisor e paulo é gestor escolar, ambos com escolas vinculadas', () => {
  assert.equal(users.supervisor.perfil, 'supervisor');
  assert.ok(users.supervisor.escolaIds.length > 0, 'supervisor demo precisa ter escolas vinculadas');
  assert.equal(users.gestor.perfil, 'gestor');
  assert.equal(users.gestor.id, 'u-gestor-escolar');
  assert.deepEqual(users.gestor.escolaIds, ['sag-18']);
});

test('migração gestor → supervisor é única: re-executar não converte o gestor escolar', async () => {
  const r = await migrarGestorSupervisor(app.prisma);
  assert.equal(r.executada, false, 'o marcador já existe — a migração não deve rodar de novo');
  assert.equal(r.migrados, 0);
  const paulo = await app.prisma.usuario.findUnique({ where: { id: 'u-gestor-escolar' }, select: { perfil: true } });
  assert.equal(paulo.perfil, 'gestor');
});

test('/auth/me renova o token quando o perfil gravado mudou depois do login', async () => {
  // token "antigo" emitido antes da migração (perfil ainda 'gestor')
  const antigo = app.jwt.sign({ sub: users.supervisor.id, nome: 'x', perfil: 'gestor', profId: null, escolaIds: users.supervisor.escolaIds });
  const r = await get('/api/auth/me', antigo);
  assert.equal(r.statusCode, 200);
  assert.equal(r.json().user.perfil, 'supervisor');
  assert.ok(r.json().token, 'deve devolver um token novo');
  assert.equal(app.jwt.decode(r.json().token).perfil, 'supervisor');

  // token em dia: sem renovação
  const r2 = await get('/api/auth/me', tok.supervisor);
  assert.equal(r2.statusCode, 200);
  assert.equal(r2.json().token, undefined);
});

test('autorização segue o banco: token antigo com perfil "gestor" não decide como gestor escolar', async () => {
  // token de 30 dias emitido antes da migração (camila ainda 'gestor'); o plano não
  // existe, então nem uma guarda falha chegaria a gravar — passaria só a 404
  const antigo = app.jwt.sign(
    { sub: users.supervisor.id, nome: 'x', perfil: 'gestor', profId: null, escolaIds: users.supervisor.escolaIds },
    { expiresIn: '30d' },
  );
  for (const acao of ['validar', 'recusar']) {
    const r = await send('POST', `/api/planejamentos/__qa_inexistente__/validacao/p1/${acao}`, antigo, { motivo: 'QA motivo qualquer' });
    assert.equal(r.statusCode, 403, `${acao}: ${r.body}`);
    assert.match(r.json().error.message, /somente de visualização/i);
  }
  // escopo de leitura também vem do banco: claims mais amplos não ampliam o acesso
  const amplo = app.jwt.sign({ sub: users.gestor.id, nome: 'x', perfil: 'secretaria', profId: null, escolaIds: [] });
  const rm = await get('/api/meta', amplo);
  assert.equal(rm.statusCode, 200);
  assert.deepEqual(rm.json().ESCOLAS.map(e => e.id), ['sag-18']);
  assert.equal((await get('/api/escolas', amplo)).statusCode, 403);
});

test('token de usuário inexistente é recusado (401)', async () => {
  const fantasma = app.jwt.sign({ sub: 'qa-inexistente-' + Date.now().toString(36), nome: 'QA', perfil: 'secretaria', profId: null, escolaIds: [] });
  assert.equal((await get('/api/meta', fantasma)).statusCode, 401);
});

/* ---------------- escopo de leitura (supervisor) ---------------- */

test('GET /meta para supervisor: só as suas escolas, professores do escopo e sem lista de usuários', async () => {
  const [rg, rs, rt] = await Promise.all([
    get('/api/meta', tok.supervisor), get('/api/meta', tok.secretaria), get('/api/turmas', tok.supervisor),
  ]);
  assert.equal(rg.statusCode, 200);
  assert.equal(rs.statusCode, 200);
  const mg = rg.json(), ms = rs.json();
  const escopo = new Set(users.supervisor.escolaIds);

  assert.ok(mg.ESCOLAS.length > 0, 'supervisor deve receber pelo menos uma escola');
  for (const e of mg.ESCOLAS) assert.ok(escopo.has(e.id), `escola ${e.id} fora do escopo do supervisor`);
  assert.ok(ms.ESCOLAS.length >= mg.ESCOLAS.length, 'secretaria vê a rede toda');

  assert.deepEqual(mg.USUARIOS, []);
  assert.ok(ms.USUARIOS.length > 0);

  const turmasEscopo = new Set(rt.json().map(t => t.id));
  for (const pr of mg.PROFESSORES) {
    assert.ok(pr.turmaIds.some(t => turmasEscopo.has(t)), `professor ${pr.id} sem turma no escopo do supervisor`);
  }
  assert.ok(ms.PROFESSORES.length >= mg.PROFESSORES.length);

  assert.deepEqual(mg.HABILIDADES.length, ms.HABILIDADES.length);
  assert.deepEqual(mg.PERIODOS.length, ms.PERIODOS.length);
});

test('GET /planejamentos para supervisor: só planos da rede ou de grupos das suas escolas', async () => {
  const [rg, rs, rm] = await Promise.all([
    get('/api/planejamentos', tok.supervisor), get('/api/planejamentos', tok.secretaria), get('/api/meta', tok.supervisor),
  ]);
  assert.equal(rg.statusCode, 200);
  const gruposEscopo = new Set(rm.json().ESCOLAS.map(e => e.grupoId).filter(Boolean));
  const noEscopo = pl => pl.grupos.length === 0 || pl.grupos.some(g => gruposEscopo.has(g.id));

  const visiveis = rg.json();
  for (const pl of visiveis) assert.ok(noEscopo(pl), `plano "${pl.titulo}" fora do escopo apareceu para o supervisor`);

  const ids = new Set(visiveis.map(pl => pl.id));
  for (const pl of rs.json()) {
    if (noEscopo(pl)) {
      assert.ok(ids.has(pl.id), `plano "${pl.titulo}" do escopo não apareceu para o supervisor`);
    } else {
      assert.ok(!ids.has(pl.id));
      const rd = await get('/api/planejamentos/' + pl.id, tok.supervisor);
      assert.equal(rd.statusCode, 403, `detalhe do plano "${pl.titulo}" deveria ser negado ao supervisor`);
    }
  }
});

test('rotas de rede continuam negadas ao supervisor e ao gestor escolar', async () => {
  for (const perfil of ['supervisor', 'gestor']) {
    for (const url of ['/api/escolas', '/api/rede', '/api/grupos', '/api/admin/usuarios']) {
      const r = await get(url, tok[perfil]);
      assert.equal(r.statusCode, 403, `${url} deveria ser 403 para ${perfil}`);
    }
  }
});

test('análise individual (drill turma → alunos) disponível ao supervisor', async () => {
  const escola = users.supervisor.escolaIds[0];
  const r = await get('/api/dashboard/evolucao?escola=' + escola, tok.supervisor);
  assert.equal(r.statusCode, 200);
  assert.equal(r.json().escopo, 'gestor', 'escopo por escolas mantém o valor "gestor" no contrato');
  const turma = (r.json().turmasDetalhe || []).find(t => t.totAlunos > 0);
  if (!turma) return; // escola sem alunos: nada a detalhar
  const r2 = await get(`/api/dashboard/evolucao?escola=${escola}&turma=${turma.id}`, tok.supervisor);
  assert.equal(r2.statusCode, 200);
  assert.ok(Array.isArray(r2.json().alunos) && r2.json().alunos.length === turma.totAlunos);
});

/* ---------------- somente leitura: escrita negada ---------------- */

// ids reais do escopo: plano visível com habilidade, turma do escopo e um aluno
// de OUTRA turma (assim nem um handler sem guarda passaria da validação de alunos)
async function alvosDeEscrita() {
  const planos = (await get('/api/planejamentos', tok.supervisor)).json();
  const plano = planos.find(pl => pl.habilidades.length > 0);
  assert.ok(plano, 'precisa de um planejamento visível com habilidade');
  const habCod = plano.habilidades[0];
  const turmas = (await get('/api/turmas', tok.supervisor)).json().filter(t => t.totAlunos > 0);
  assert.ok(turmas.length > 0, 'precisa de uma turma com alunos no escopo');
  const turmaId = turmas[0].id;
  const alunoOutraTurma = await app.prisma.aluno.findFirst({ where: { turmaId: { not: turmaId } }, select: { id: true } });
  assert.ok(alunoOutraTurma);
  return { plano, habCod, turmaId, alunoId: alunoOutraTurma.id };
}

async function retratoEscrita(planoId, habCod) {
  const [trabalho, avaliacoes, eventos, semanas] = await Promise.all([
    app.prisma.trabalhoHabilidade.findUnique({ where: { planejamentoId_habCod: { planejamentoId: planoId, habCod } } }),
    app.prisma.avaliacao.count({ where: { planejamentoId: planoId } }),
    app.prisma.acompanhamentoEvento.count(),
    app.prisma.planejamentoSemana.count({ where: { planejamentoId: planoId } }),
  ]);
  return { trabalho, avaliacoes, eventos, semanas };
}

test('supervisor recebe 403 em todas as rotas de escrita, sem alterar dados', async () => {
  const { plano, habCod, turmaId, alunoId } = await alvosDeEscrita();
  const antes = await retratoEscrita(plano.id, habCod);

  const tentativas = [
    // reenvia o status atual: mesmo sem guarda, nada mudaria
    ['PATCH', `/api/planejamentos/${plano.id}/trabalho/${habCod}`, { status: antes.trabalho.status }],
    ['POST', '/api/avaliacoes/lote', { planejamentoId: plano.id, habCod, turmaId, data: '01/01/2000', marks: { [alunoId]: 2 } }],
    ['POST', `/api/planejamentos/${plano.id}/semanas`, { semanas: [] }],
  ];
  for (const [method, url, body] of tentativas) {
    const r = await send(method, url, tok.supervisor, body);
    assert.equal(r.statusCode, 403, `${method} ${url} deveria ser 403 para supervisor (veio ${r.statusCode})`);
    assert.match(r.json().error.message, /somente de visualização/i, 'barrado pela guarda de somente leitura');
  }
  assert.deepEqual(await retratoEscrita(plano.id, habCod), antes, 'nenhum dado pode mudar');
});

test('gestor escolar também não tem as escritas legadas do antigo gestor (trabalho, lote)', async () => {
  const { plano, habCod, turmaId, alunoId } = await alvosDeEscrita();
  const antes = await retratoEscrita(plano.id, habCod);
  const r1 = await send('PATCH', `/api/planejamentos/${plano.id}/trabalho/${habCod}`, tok.gestor, { status: antes.trabalho.status });
  assert.equal(r1.statusCode, 403);
  const r2 = await send('POST', '/api/avaliacoes/lote', tok.gestor,
    { planejamentoId: plano.id, habCod, turmaId, data: '01/01/2000', marks: { [alunoId]: 2 } });
  assert.equal(r2.statusCode, 403);
  assert.deepEqual(await retratoEscrita(plano.id, habCod), antes);
});

/* ---------------- gestor escolar: escopo restrito à sua escola ---------------- */

test('gestor escolar (paulo) enxerga só a escola sag-18', async () => {
  const [rm, rt, re, rp] = await Promise.all([
    get('/api/meta', tok.gestor), get('/api/turmas', tok.gestor),
    get('/api/dashboard/evolucao', tok.gestor), get('/api/professores/resumo', tok.gestor),
  ]);
  assert.equal(rm.statusCode, 200);
  assert.deepEqual(rm.json().ESCOLAS.map(e => e.id), ['sag-18']);
  assert.deepEqual(rm.json().USUARIOS, []);

  assert.equal(rt.statusCode, 200);
  assert.ok(rt.json().length > 0);
  for (const t of rt.json()) assert.equal(t.escola, 'sag-18', `turma ${t.id} fora da escola do gestor`);

  assert.equal(re.statusCode, 200);
  assert.equal(re.json().escopo, 'gestor');
  assert.deepEqual(re.json().entidades.map(e => e.id), ['sag-18']);

  assert.equal(rp.statusCode, 200);
  for (const pr of rp.json()) for (const t of pr.turmas) assert.equal(t.escolaId, 'sag-18');
});

test('turma de outra escola do supervisor é negada ao gestor escolar', async () => {
  const outra = users.supervisor.escolaIds.find(id => id !== 'sag-18');
  if (!outra) return;
  const turma = await app.prisma.turma.findFirst({ where: { escolaId: outra }, select: { id: true } });
  if (!turma) return;
  assert.equal((await get(`/api/turmas/${turma.id}/full`, tok.supervisor)).statusCode, 200);
  assert.equal((await get(`/api/turmas/${turma.id}/full`, tok.gestor)).statusCode, 403);
  assert.equal((await get(`/api/avaliacoes/eventos?turma=${turma.id}`, tok.gestor)).statusCode, 403);
});

test('avaliações de aluno seguem o escopo por escolas (mesma regra da ficha do aluno)', async () => {
  const outra = users.supervisor.escolaIds.find(id => id !== 'sag-18');
  assert.ok(outra, 'supervisor demo precisa de uma escola além da sag-18');
  const [daEscola, daOutra, foraDoSupervisor] = await Promise.all([
    app.prisma.aluno.findFirst({ where: { turma: { escolaId: 'sag-18' } }, select: { id: true } }),
    app.prisma.aluno.findFirst({ where: { turma: { escolaId: outra } }, select: { id: true } }),
    app.prisma.aluno.findFirst({ where: { turma: { escolaId: { notIn: users.supervisor.escolaIds } } }, select: { id: true } }),
  ]);
  assert.ok(daEscola && daOutra, 'precisa de alunos na sag-18 e na outra escola do supervisor');

  assert.equal((await get('/api/avaliacoes?alunoId=' + daEscola.id, tok.gestor)).statusCode, 200);
  for (const url of [`/api/avaliacoes?alunoId=${daOutra.id}`, `/api/alunos/${daOutra.id}/full`]) {
    const r = await get(url, tok.gestor);
    assert.equal(r.statusCode, 403, `${url} deveria ser 403 para o gestor escolar da sag-18`);
    assert.match(r.json().error.message, /fora do seu grupo de escolas/);
    assert.equal((await get(url, tok.supervisor)).statusCode, 200, `${url}: a outra escola é do supervisor`);
  }
  if (foraDoSupervisor) {
    assert.equal((await get('/api/avaliacoes?alunoId=' + foraDoSupervisor.id, tok.supervisor)).statusCode, 403);
    assert.equal((await get('/api/avaliacoes?alunoId=' + foraDoSupervisor.id, tok.secretaria)).statusCode, 200);
  }
  assert.equal((await get('/api/avaliacoes?alunoId=__qa_inexistente__', tok.gestor)).statusCode, 404);
});

/* ---------------- detalhe do plano: conteúdo recortado por escola ---------------- */

test('plano da rede: semanas, validações e nSemanas só de professores do escopo de cada perfil', async () => {
  const outra = users.supervisor.escolaIds.find(id => id !== 'sag-18');
  assert.ok(outra, 'supervisor demo precisa de uma escola além da sag-18');
  const turmaOutra = await app.prisma.turma.findFirst({ where: { escolaId: outra }, select: { id: true } });
  assert.ok(turmaOutra, 'precisa de uma turma na outra escola');
  const p1 = users.professor.profId; // helena: turmas só na sag-18
  const { compId } = await app.prisma.professor.findUnique({ where: { id: p1 }, select: { compId: true } });
  const hab = await app.prisma.habilidade.findFirst({ where: { compId }, select: { cod: true } });
  assert.ok(hab, 'precisa de uma habilidade do componente da professora');

  // plano QA da rede toda (visível a todos os perfis, direcionado à helena), com
  // semana e validação da helena (sag-18) e de um professor QA só da outra escola
  const rc = await send('POST', '/api/planejamentos', tok.secretaria, {
    titulo: 'QA Escopo semanas ' + Date.now().toString(36), periodo: 'm06', anos: [], grupos: [], habilidades: [hab.cod],
  });
  assert.equal(rc.statusCode, 201, rc.body);
  qa.planoId = rc.json().id;
  qa.profId = 'qa-prof-' + Date.now().toString(36);
  await app.prisma.professor.create({
    data: { id: qa.profId, nome: 'QA Professor Outra Escola', compId, cor: '#64748b', iniciais: 'QA', turmaIds: JSON.stringify([turmaOutra.id]) },
  });
  const profs = [p1, qa.profId];
  await app.prisma.planejamentoSemana.createMany({
    data: profs.map(profId => ({
      planejamentoId: qa.planoId, profId, semana: 1, habilidades: JSON.stringify([hab.cod]), sequenciaDidatica: 'QA ' + profId,
    })),
  });
  await app.prisma.planejamentoValidacao.createMany({
    data: profs.map(profId => ({ planejamentoId: qa.planoId, profId, status: 'rascunho' })),
  });

  const esperado = {
    secretaria: [p1, qa.profId],
    supervisor: [p1, qa.profId], // sag-18 + a outra escola
    gestor: [p1],                // só sag-18: o professor QA não aparece
    professor: [p1],             // só as próprias
  };
  const ordenar = xs => [...xs].sort();
  for (const [perfil, visiveis] of Object.entries(esperado)) {
    const rd = await get('/api/planejamentos/' + qa.planoId, tok[perfil]);
    assert.equal(rd.statusCode, 200, `${perfil}: ${rd.body}`);
    assert.deepEqual(ordenar(rd.json().semanas.map(s => s.prof)), ordenar(visiveis), `${perfil}: semanas`);
    assert.deepEqual(ordenar(rd.json().validacoes.map(v => v.profId)), ordenar(visiveis), `${perfil}: validações`);
    const item = (await get('/api/planejamentos', tok[perfil])).json().find(pl => pl.id === qa.planoId);
    assert.ok(item, `${perfil}: o plano da rede deve aparecer na listagem`);
    assert.equal(item.nSemanas, visiveis.length, `${perfil}: nSemanas na listagem`);
  }
});

/* ---------------- cadastro: perfil supervisor no admin ---------------- */

test('admin cadastra supervisor com escolas; escolas são descartadas ao virar perfil de rede', async () => {
  const email = `qa-supervisor-${Date.now().toString(36)}@teste.local`;
  const rc = await send('POST', '/api/admin/usuarios', tok.secretaria, {
    nome: 'QA Supervisor Teste', email, senha: 'qa-123456', perfil: 'supervisor', cargo: 'QA', escolaIds: ['sag-18'],
  });
  assert.equal(rc.statusCode, 201, rc.body);
  criadosQA.push(rc.json().id);
  assert.equal(rc.json().perfil, 'supervisor');
  assert.deepEqual(rc.json().escolaIds, ['sag-18']);

  // o supervisor recém-criado entra, lê o seu escopo e não escreve
  const rl = await login(email, 'qa-123456');
  assert.equal(rl.statusCode, 200);
  const tokQA = rl.json().token;
  const rmeta = await get('/api/meta', tokQA);
  assert.deepEqual(rmeta.json().ESCOLAS.map(e => e.id), ['sag-18']);
  const rw = await send('POST', '/api/avaliacoes/lote', tokQA,
    { planejamentoId: '__qa__', habCod: '__qa__', data: '01/01/2000', marks: { __qa__: 2 } });
  assert.equal(rw.statusCode, 403);

  // autorização segue o banco: a troca de escolas pelo admin vale na hora, com o MESMO token
  const outra = users.supervisor.escolaIds.find(id => id !== 'sag-18');
  if (outra) {
    const re = await send('PATCH', '/api/admin/usuarios/' + rc.json().id, tok.secretaria, { escolaIds: [outra] });
    assert.equal(re.statusCode, 200, re.body);
    assert.deepEqual((await get('/api/meta', tokQA)).json().ESCOLAS.map(e => e.id), [outra]);
  }
  // desativado pelo admin: o token deixa de valer na hora (401), sem esperar expirar
  const ri = await send('PATCH', '/api/admin/usuarios/' + rc.json().id, tok.secretaria, { ativo: false });
  assert.equal(ri.statusCode, 200, ri.body);
  assert.equal((await get('/api/meta', tokQA)).statusCode, 401);

  const rp = await send('PATCH', '/api/admin/usuarios/' + rc.json().id, tok.secretaria, { perfil: 'secretaria', escolaIds: ['sag-18'] });
  assert.equal(rp.statusCode, 200);
  assert.deepEqual(rp.json().escolaIds, [], 'perfil de rede não guarda escolas');

  const rx = await send('POST', '/api/admin/usuarios', tok.secretaria, {
    nome: 'QA Perfil Invalido', email: `qa-invalido-${Date.now().toString(36)}@teste.local`, senha: 'qa-123456', perfil: 'polo',
  });
  if (rx.statusCode === 201) criadosQA.push(rx.json().id); // nunca deixar lixo, mesmo se falhar
  assert.equal(rx.statusCode, 400, 'perfil fora da lista é rejeitado');
});
