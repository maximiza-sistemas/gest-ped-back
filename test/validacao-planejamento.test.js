/* ============================================================
   Validação do planejamento docente com reabertura na recusa.

   Fluxo: rascunho → (professor envia) enviado → (gestor escolar)
   validado | recusado; recusado reabre a edição e o professor reenvia.

   Usuários demo (senha demo123): beatriz (secretaria), helena
   (professora p1, turmas na escola sag-18), paulo (gestor escolar
   da sag-18) e camila (supervisor — somente leitura).

   Dados: cria UM planejamento descartável 'QA Validação …' (rede
   toda, LP da helena, m06) e o remove no after() — o cascade leva
   semanas e validações. Nenhum outro registro é alterado; o gestor
   escolar e o supervisor "de outra escola" (sag-19 — escola sem
   turma da helena) são usuários descartáveis 'qa-*-alheio-*' (a
   autenticação relê o usuário no banco), removidos no after().

   Execução: node --test test/validacao-planejamento.test.js
   ============================================================ */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import 'dotenv/config';
import { buildApp } from '../src/app.js';
import { soEscolasVisiveis, soTurmasVisiveis } from '../src/lib/ativos.js';

const EMAILS = {
  secretaria: 'beatriz@rededeensino.edu.br',
  professor: 'helena@rededeensino.edu.br',
  gestor: 'paulo@rededeensino.edu.br',
  supervisor: 'camila@rededeensino.edu.br',
};
const DATA_BR = /^\d{2}\/\d{2}\/\d{4}$/;

let app;
const tok = {};
const users = {};
let planoId = null;
let habs = [];
let profId = null;
// usuários descartáveis vinculados a uma escola SEM turma da helena: { gestor, supervisor } → { id, token }
const alheio = {};
let escolaAlheia = null;

const H = t => (t ? { authorization: 'Bearer ' + t } : {});
const inj = (method, url, { token, body } = {}) => app.inject({
  method, url,
  headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...H(token) },
  payload: body !== undefined ? JSON.stringify(body) : undefined,
});
const urlVal = acao => `/api/planejamentos/${planoId}/validacao/${profId}/${acao}`;
const enviar = token => inj('POST', `/api/planejamentos/${planoId}/validacao/enviar`, { token });
const salvarSemanas = (token, texto) => inj('POST', `/api/planejamentos/${planoId}/semanas`, {
  token, body: { semanas: [{ semana: 1, habilidades: [habs[0]], expectativas: { [habs[0]]: 'QA expectativa' }, sequenciaDidatica: texto }] },
});
const itemDoPlano = lista => lista.find(v => v.planejamentoId === planoId && v.profId === profId);

before(async () => {
  app = await buildApp({ logger: false });
  await app.ready();
  for (const [perfil, email] of Object.entries(EMAILS)) {
    const r = await inj('POST', '/api/auth/login', { body: { email, senha: 'demo123' } });
    assert.equal(r.statusCode, 200, `login ${perfil} (${email})`);
    tok[perfil] = r.json().token;
    users[perfil] = r.json().user;
  }
  assert.equal(users.gestor.perfil, 'gestor', 'paulo deve ser gestor escolar');
  assert.equal(users.supervisor.perfil, 'supervisor', 'camila deve ser supervisor');
  profId = users.professor.profId;
  assert.ok(profId, 'helena precisa estar vinculada a um professor');

  const prof = await app.prisma.professor.findUnique({ where: { id: profId }, select: { compId: true } });
  habs = (await app.prisma.habilidade.findMany({ where: { compId: prof.compId }, take: 2, select: { cod: true } })).map(h => h.cod);
  assert.equal(habs.length, 2, 'precisa de 2 habilidades do componente da professora');

  const r = await inj('POST', '/api/planejamentos', {
    token: tok.secretaria,
    body: { titulo: 'QA Validação ' + Date.now().toString(36), objetivo: '', periodo: 'm06', anos: [], grupos: [], habilidades: habs },
  });
  assert.equal(r.statusCode, 201, 'plano QA criado: ' + r.body);
  planoId = r.json().id;

  // escola sem turma da helena (de preferência a outra escola do supervisor demo, sag-19)
  const { turmaIds } = await app.prisma.professor.findUnique({ where: { id: profId }, select: { turmaIds: true } });
  const turmasHelena = await app.prisma.turma.findMany({ where: soTurmasVisiveis({ id: { in: JSON.parse(turmaIds || '[]') } }), select: { escolaId: true } });
  const escolasHelena = new Set(turmasHelena.map(t => t.escolaId));
  escolaAlheia = users.supervisor.escolaIds.find(id => !escolasHelena.has(id))
    || (await app.prisma.escola.findFirst({ where: soEscolasVisiveis({ id: { notIn: [...escolasHelena] } }), select: { id: true } }))?.id;
  assert.ok(escolaAlheia, 'precisa de uma escola sem turma da professora');

  // gestor escolar e supervisor dessa outra escola: a autenticação relê o usuário
  // no banco, então eles precisam existir (sem login por senha; removidos no after)
  for (const perfil of ['gestor', 'supervisor']) {
    const id = `qa-${perfil}-alheio-${Date.now().toString(36)}`;
    await app.prisma.usuario.create({
      data: {
        id, nome: `QA ${perfil} alheio`, email: id + '@teste.local', senhaHash: '!',
        perfil, cargo: 'QA', iniciais: 'QA', cor: '#64748b', escolaIds: JSON.stringify([escolaAlheia]),
      },
    });
    alheio[perfil] = { id, token: app.jwt.sign({ sub: id, nome: `QA ${perfil}`, perfil, profId: null, escolaIds: [escolaAlheia] }) };
  }
});

after(async () => {
  const alheios = Object.values(alheio).map(a => a.id);
  if (alheios.length) await app.prisma.usuario.deleteMany({ where: { id: { in: alheios } } });
  if (planoId) {
    const r = await inj('DELETE', '/api/planejamentos/' + planoId, { token: tok.secretaria });
    assert.equal(r.statusCode, 200, 'teardown: plano QA removido');
    // cascade: nenhuma semana/validação do plano QA pode sobrar
    assert.equal(await app.prisma.planejamentoValidacao.count({ where: { planejamentoId: planoId } }), 0);
    assert.equal(await app.prisma.planejamentoSemana.count({ where: { planejamentoId: planoId } }), 0);
  }
  await app.close();
});

/* ---------------- envio pelo professor ---------------- */

test('professor não envia sem ao menos uma semana salva (400)', async () => {
  const r = await enviar(tok.professor);
  assert.equal(r.statusCode, 400, r.body);
  assert.match(r.json().error.message, /ao menos uma semana/);
});

test('professor salva semanas (201) e o par aparece como rascunho', async () => {
  const r = await salvarSemanas(tok.professor, 'QA semana 1');
  assert.equal(r.statusCode, 201, r.body);

  const l = await inj('GET', '/api/validacoes', { token: tok.professor });
  assert.equal(l.statusCode, 200, l.body);
  assert.ok(l.json().every(v => v.profId === profId), 'professor só vê as próprias validações');
  const item = itemDoPlano(l.json());
  assert.ok(item, 'semanas salvas sem envio aparecem como rascunho');
  assert.equal(item.status, 'rascunho');
  assert.equal(item.nSemanas, 1);
});

test('somente o professor envia: secretaria e gestor escolar recebem 403', async () => {
  for (const perfil of ['secretaria', 'gestor']) {
    const r = await enviar(tok[perfil]);
    assert.equal(r.statusCode, 403, `${perfil}: ${r.body}`);
  }
});

test('professor envia (200, enviado) e não reenvia enquanto aguarda (409)', async () => {
  const r = await enviar(tok.professor);
  assert.equal(r.statusCode, 200, r.body);
  const v = r.json();
  assert.equal(v.status, 'enviado');
  assert.match(v.enviadoEm, DATA_BR);
  assert.equal(v.motivo, '');
  assert.equal(v.historico.length, 1);
  assert.equal(v.historico[0].acao, 'enviado');
  assert.equal(v.historico[0].porNome, users.professor.nome);

  const r2 = await enviar(tok.professor); // reenvio enquanto aguarda o gestor
  assert.match(r2.json().error.message, /aguarde a análise do gestor escolar/);
  assert.equal(r2.statusCode, 409, r2.body);
});

test('enviado trava a edição das semanas (409 com mensagem clara)', async () => {
  const r = await salvarSemanas(tok.professor, 'QA tentativa bloqueada');
  assert.equal(r.statusCode, 409, r.body);
  assert.equal(r.json().error.message, 'Planejamento enviado para validação — aguarde a análise do gestor escolar.');
  // nada mudou nas semanas gravadas
  const semanas = await app.prisma.planejamentoSemana.findMany({ where: { planejamentoId: planoId, profId } });
  assert.equal(semanas.length, 1);
  assert.equal(semanas[0].sequenciaDidatica, 'QA semana 1');
});

/* ---------------- quem pode decidir ---------------- */

test('supervisor (somente leitura) não valida nem devolve (403)', async () => {
  for (const acao of ['validar', 'recusar']) {
    const r = await inj('POST', urlVal(acao), { token: tok.supervisor, body: { motivo: 'QA motivo qualquer' } });
    assert.equal(r.statusCode, 403, `${acao}: ${r.body}`);
  }
});

test('secretaria (superusuária) também não valida — exclusivo do gestor escolar (403)', async () => {
  const r = await inj('POST', urlVal('validar'), { token: tok.secretaria });
  assert.equal(r.statusCode, 403, r.body);
  assert.match(r.json().error.message, /gestor escolar/);
});

test('gestor escolar de outra escola não decide sobre professor fora das suas escolas (403)', async () => {
  for (const acao of ['validar', 'recusar']) {
    const r = await inj('POST', urlVal(acao), { token: alheio.gestor.token, body: { motivo: 'QA motivo qualquer' } });
    assert.equal(r.statusCode, 403, `${acao}: ${r.body}`);
    assert.match(r.json().error.message, /não leciona/);
  }
});

test('gestor/supervisor de outra escola: plano da rede sem semanas nem validação da professora (sem vazamento)', async () => {
  for (const [perfil, { token }] of Object.entries(alheio)) {
    // plano da rede toda: visível a qualquer escola, mas o conteúdo por professor é recortado
    const d = await inj('GET', '/api/planejamentos/' + planoId, { token });
    assert.equal(d.statusCode, 200, `${perfil}: ${d.body}`);
    assert.deepEqual(d.json().validacoes, [], `${perfil}: validação (status/motivo/histórico) de professor fora das escolas`);
    assert.deepEqual(d.json().semanas, [], `${perfil}: semanas de professor fora das escolas`);

    // coerente com a lista da tela de validação e com nSemanas da listagem
    const l = await inj('GET', '/api/validacoes', { token });
    assert.equal(l.statusCode, 200, `${perfil}: ${l.body}`);
    assert.equal(itemDoPlano(l.json()), undefined, `${perfil}: /validacoes não traz a professora`);
    const pl = (await inj('GET', '/api/planejamentos', { token })).json().find(x => x.id === planoId);
    assert.ok(pl, `${perfil}: o plano da rede aparece na listagem`);
    assert.equal(pl.nSemanas, 0, `${perfil}: nSemanas não conta semanas de fora do escopo`);
  }
});

test('ainda enviado após as tentativas negadas', async () => {
  const v = await app.prisma.planejamentoValidacao.findUnique({ where: { planejamentoId_profId: { planejamentoId: planoId, profId } } });
  assert.equal(v.status, 'enviado');
});

/* ---------------- devolução (recusa) e reabertura ---------------- */

test('gestor escolar não devolve sem motivo (400) nem com motivo curto (400)', async () => {
  const sem = await inj('POST', urlVal('recusar'), { token: tok.gestor, body: {} });
  assert.equal(sem.statusCode, 400, sem.body);
  assert.match(sem.json().error.message, /motivo/);
  const curto = await inj('POST', urlVal('recusar'), { token: tok.gestor, body: { motivo: '  abc  ' } });
  assert.equal(curto.statusCode, 400, curto.body);
});

test('gestor escolar devolve com motivo → recusado (reaberto) com motivo e decisor', async () => {
  const r = await inj('POST', urlVal('recusar'), { token: tok.gestor, body: { motivo: '  Detalhe a verificação de aprendizagem.  ' } });
  assert.equal(r.statusCode, 200, r.body);
  const v = r.json();
  assert.equal(v.status, 'recusado');
  assert.equal(v.motivo, 'Detalhe a verificação de aprendizagem.');
  assert.equal(v.decididoPorNome, users.gestor.nome);
  assert.match(v.decididoEm, DATA_BR);
  assert.deepEqual(v.historico.map(h => h.acao), ['enviado', 'recusado']);
  assert.equal(v.historico[1].motivo, 'Detalhe a verificação de aprendizagem.');

  // validar um devolvido não é permitido: aguarda o reenvio
  const val = await inj('POST', urlVal('validar'), { token: tok.gestor });
  assert.equal(val.statusCode, 409, val.body);
});

test('professor vê a devolução no detalhe (só a própria) e volta a editar (201)', async () => {
  const d = await inj('GET', '/api/planejamentos/' + planoId, { token: tok.professor });
  assert.equal(d.statusCode, 200, d.body);
  const { validacoes } = d.json();
  assert.equal(validacoes.length, 1);
  assert.equal(validacoes[0].profId, profId);
  assert.equal(validacoes[0].status, 'recusado');
  assert.equal(validacoes[0].motivo, 'Detalhe a verificação de aprendizagem.');
  assert.equal(validacoes[0].decididoPorNome, users.gestor.nome);

  const r = await salvarSemanas(tok.professor, 'QA semana 1 ajustada');
  assert.equal(r.statusCode, 201, r.body);
  // continua recusado (motivo visível) até o reenvio
  const v = await app.prisma.planejamentoValidacao.findUnique({ where: { planejamentoId_profId: { planejamentoId: planoId, profId } } });
  assert.equal(v.status, 'recusado');
});

test('professor reenvia → enviado, motivo limpo e decisão anterior só no histórico', async () => {
  const r = await enviar(tok.professor);
  assert.equal(r.statusCode, 200, r.body);
  const v = r.json();
  assert.equal(v.status, 'enviado');
  assert.equal(v.motivo, '');
  assert.equal(v.decididoEm, null);
  assert.equal(v.decididoPorNome, null);
  assert.deepEqual(v.historico.map(h => h.acao), ['enviado', 'recusado', 'enviado']);
});

/* ---------------- validação ---------------- */

test('gestor escolar valida → validado; validar de novo é 409', async () => {
  const r = await inj('POST', urlVal('validar'), { token: tok.gestor });
  assert.equal(r.statusCode, 200, r.body);
  const v = r.json();
  assert.equal(v.status, 'validado');
  assert.equal(v.decididoPorNome, users.gestor.nome);
  assert.match(v.decididoEm, DATA_BR);

  const r2 = await inj('POST', urlVal('validar'), { token: tok.gestor });
  assert.equal(r2.statusCode, 409, r2.body);
});

test('validado trava a edição das semanas (409)', async () => {
  const r = await salvarSemanas(tok.professor, 'QA tentativa pós-validação');
  assert.equal(r.statusCode, 409, r.body);
  assert.equal(r.json().error.message, 'Planejamento já validado pelo gestor escolar.');
  const e = await enviar(tok.professor);
  assert.equal(e.statusCode, 409, e.body);
});

/* ---------------- leitura ---------------- */

test('GET /validacoes como gestor escolar inclui o item validado (e filtra por status)', async () => {
  const r = await inj('GET', '/api/validacoes', { token: tok.gestor });
  assert.equal(r.statusCode, 200, r.body);
  const item = itemDoPlano(r.json());
  assert.ok(item, 'item do plano QA na lista do gestor escolar');
  assert.equal(item.status, 'validado');
  assert.equal(item.profNome, 'Helena Martins');
  assert.equal(item.periodo, 'm06');
  assert.equal(item.nSemanas, 1);
  assert.ok(item.turmas.length > 0, 'turmas da professora nas escolas do gestor');
  assert.ok(item.turmas.every(t => users.gestor.escolaIds.includes(t.escolaId)), 'só turmas das escolas vinculadas');
  assert.ok(item.turmas.every(t => t.nome && t.escolaNome));

  const val = await inj('GET', '/api/validacoes?status=validado', { token: tok.gestor });
  assert.ok(val.json().every(v => v.status === 'validado'));
  assert.ok(itemDoPlano(val.json()));
  const pend = await inj('GET', '/api/validacoes?status=enviado', { token: tok.gestor });
  assert.equal(itemDoPlano(pend.json()), undefined);

  const inv = await inj('GET', '/api/validacoes?status=xyz', { token: tok.gestor });
  assert.equal(inv.statusCode, 400, inv.body);
});

test('GET /validacoes como supervisor inclui o item (somente leitura)', async () => {
  const r = await inj('GET', '/api/validacoes', { token: tok.supervisor });
  assert.equal(r.statusCode, 200, r.body);
  const item = itemDoPlano(r.json());
  assert.ok(item, 'supervisor enxerga a validação das escolas vinculadas');
  assert.equal(item.status, 'validado');
});

test('detalhe do plano para o gestor escolar traz a validação da professora', async () => {
  const d = await inj('GET', '/api/planejamentos/' + planoId, { token: tok.gestor });
  assert.equal(d.statusCode, 200, d.body);
  const v = d.json().validacoes.find(x => x.profId === profId);
  assert.equal(v.status, 'validado');
});

/* ---------------- reabertura de um validado ---------------- */

test('gestor escolar pode devolver um planejamento já validado (reabertura)', async () => {
  const r = await inj('POST', urlVal('recusar'), { token: tok.gestor, body: { motivo: 'Reaberto para incluir referências.' } });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().status, 'recusado');
  assert.deepEqual(r.json().historico.map(h => h.acao), ['enviado', 'recusado', 'enviado', 'validado', 'recusado']);

  const s = await salvarSemanas(tok.professor, 'QA semana reaberta');
  assert.equal(s.statusCode, 201, s.body);
});
