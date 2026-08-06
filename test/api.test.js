/* ============================================================
   Testes de integração da API — node:test + Fastify inject.
   Sem dependências extras. Boota o app em processo (não usa porta)
   e consulta o banco configurado em .env.

   Os testes criam os próprios dados (planejamento QA + avaliações)
   e os removem ao final — não dependem do seed demo. As avaliações
   caem junto com o planejamento de teste (o DELETE limpa por
   planejamentoId) e os eventos de timeline gerados são removidos
   no after().

   Execução: npm test   (ou: node --test)
   ============================================================ */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import 'dotenv/config';
import { buildApp } from '../src/app.js';
import { parseBR } from '../src/lib/datas.js';

// data fixa das avaliações QA — permite remover os eventos de timeline no after()
const DATA_QA = '13/06/2026';

const EMAILS = {
  secretaria: 'beatriz@rededeensino.edu.br',
  gestor: 'camila@rededeensino.edu.br',
  professor: 'helena@rededeensino.edu.br',
  admin: 'sergio@rededeensino.edu.br',
};

let app;
const tok = {};
let gestorEscolas = [];

const H = t => (t ? { authorization: 'Bearer ' + t } : {});
// content-type só quando há corpo (json + corpo vazio = 400 no Fastify);
// corpo como string JSON (caminho determinístico do light-my-request).
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
  const me = await inj('GET', '/api/auth/me', { token: tok.gestor });
  gestorEscolas = me.json().user.escolaIds || [];
});
after(async () => {
  // remove os eventos de timeline gerados pelos lotes de avaliação QA
  await app.prisma.timelineEvent.deleteMany({
    where: { tipo: 'avaliacao', turmaId: 't1', habCod: { in: ['EF01LP01', 'hl02'] }, data: parseBR(DATA_QA) },
  });
  await app.close();
});

/* ---------------- Autenticação ---------------- */
test('login válido retorna perfil correto', async () => {
  const r = await inj('POST', '/api/auth/login', { body: { email: EMAILS.secretaria, senha: 'demo123' } });
  assert.equal(r.statusCode, 200);
  assert.equal(r.json().user.perfil, 'secretaria');
});
test('login com senha errada → 401', async () => {
  const r = await inj('POST', '/api/auth/login', { body: { email: EMAILS.admin, senha: 'errada' } });
  assert.equal(r.statusCode, 401);
});
test('login com lembrar=true emite token de sessão longa (~30 dias); padrão continua curto', async () => {
  const r = await inj('POST', '/api/auth/login', { body: { email: EMAILS.professor, senha: 'demo123', lembrar: true } });
  assert.equal(r.statusCode, 200);
  const claims = t => JSON.parse(Buffer.from(t.split('.')[1], 'base64url').toString());
  const longa = claims(r.json().token);
  const dias = (longa.exp - longa.iat) / 86400;
  assert.ok(dias >= 29 && dias <= 31, `validade ~30d (veio ${dias.toFixed(1)}d)`);
  const r2 = await inj('POST', '/api/auth/login', { body: { email: EMAILS.professor, senha: 'demo123' } });
  const curta = claims(r2.json().token);
  assert.ok((curta.exp - curta.iat) <= 13 * 3600, 'sem lembrar: sessão curta (12h)');
});
test('/auth/me sem token → 401', async () => {
  assert.equal((await inj('GET', '/api/auth/me')).statusCode, 401);
});
test('gestor possui escolaIds (escopo de grupo)', () => {
  assert.ok(Array.isArray(gestorEscolas) && gestorEscolas.length > 0);
});

/* ---------------- Meta (catálogos) ---------------- */
test('meta: períodos são os 12 meses (m01..m12) com um atual', async () => {
  const m = (await inj('GET', '/api/meta', { token: tok.professor })).json();
  assert.equal(m.PERIODOS.length, 12);
  assert.ok(m.PERIODOS.every(p => /^m\d{2}$/.test(p.id)));
  assert.equal(m.PERIODOS.filter(p => p.atual).length, 1);
});
test('meta: matrizes incluem CNCA e LEITORA', async () => {
  const ids = (await inj('GET', '/api/meta', { token: tok.professor })).json().MATRIZES.map(x => x.id);
  assert.ok(ids.includes('CNCA'), 'CNCA presente');
  assert.ok(ids.includes('LEITORA'), 'LEITORA presente');
});
test('meta: professor leciona em mais de uma turma (turmaIds)', async () => {
  const helena = (await inj('GET', '/api/meta', { token: tok.professor })).json().PROFESSORES.find(p => p.id === 'p1');
  assert.ok(helena && Array.isArray(helena.turmaIds) && helena.turmaIds.length >= 2);
});

/* ---------------- Autorização por perfil ---------------- */
test('secretaria acessa rota admin (superusuário) → 200', async () => {
  assert.equal((await inj('GET', '/api/admin/usuarios', { token: tok.secretaria })).statusCode, 200);
});
test('gestor NÃO acessa rota admin → 403', async () => {
  assert.equal((await inj('GET', '/api/admin/usuarios', { token: tok.gestor })).statusCode, 403);
});
test('professor NÃO cria planejamento → 403', async () => {
  const r = await inj('POST', '/api/planejamentos', { token: tok.professor, body: { titulo: 'xxx', periodo: 'm06', habilidades: ['EF01LP01'] } });
  assert.equal(r.statusCode, 403);
});

/* ---------------- Grupos de escolas ---------------- */
test('grupos: secretaria lê { grupos, semGrupo }; g-centro = e1,e2,e3', async () => {
  const r = await inj('GET', '/api/grupos', { token: tok.secretaria });
  assert.equal(r.statusCode, 200);
  const d = r.json();
  assert.ok(Array.isArray(d.grupos) && Array.isArray(d.semGrupo));
  const centro = d.grupos.find(g => g.id === 'g-centro');
  assert.ok(centro, 'g-centro existe');
  assert.deepEqual(centro.escolas.map(e => e.id).sort(), ['e1', 'e2', 'e3']);
});
test('grupos: gestor → 403 (apenas perfis de rede)', async () => {
  assert.equal((await inj('GET', '/api/grupos', { token: tok.gestor })).statusCode, 403);
});
test('grupos: remanejar escola para um grupo existente (g-rural) e voltar', async () => {
  const mv = await inj('PATCH', '/api/grupos/escola/e5', { token: tok.secretaria, body: { grupoId: 'g-rural' } });
  assert.equal(mv.statusCode, 200);
  const rural = (await inj('GET', '/api/grupos', { token: tok.secretaria })).json().grupos.find(g => g.id === 'g-rural');
  assert.ok(rural.escolas.some(e => e.id === 'e5'), 'e5 remanejada para g-rural');
  // restaura: e5 volta a ficar sem grupo (estado do seed)
  assert.equal((await inj('PATCH', '/api/grupos/escola/e5', { token: tok.secretaria, body: { grupoId: null } })).statusCode, 200);
});
test('grupos: criar e excluir grupo', async () => {
  const c = await inj('POST', '/api/grupos', { token: tok.secretaria, body: { nome: 'TESTE QA Polo', cor: '#123456' } });
  assert.equal(c.statusCode, 201);
  assert.equal((await inj('DELETE', `/api/grupos/${c.json().id}`, { token: tok.secretaria })).statusCode, 200);
});

/* ---------------- Escopo do gestor (grupo de escolas) ---------------- */
test('escopo: gestor vê apenas turmas das suas escolas', async () => {
  const turmas = (await inj('GET', '/api/turmas', { token: tok.gestor })).json();
  assert.ok(turmas.length > 0);
  assert.ok(turmas.every(t => gestorEscolas.includes(t.escola)), 'turmas dentro do escopo');
});
test('escopo: secretaria enxerga mais turmas que o gestor', async () => {
  const g = (await inj('GET', '/api/turmas', { token: tok.gestor })).json();
  const s = (await inj('GET', '/api/turmas', { token: tok.secretaria })).json();
  assert.ok(s.length > g.length);
});
test('escopo: gestor em turma fora do grupo (full) → 403', async () => {
  const fora = (await inj('GET', '/api/turmas', { token: tok.secretaria })).json().find(t => !gestorEscolas.includes(t.escola));
  assert.ok(fora, 'há turma fora do escopo');
  assert.equal((await inj('GET', `/api/turmas/${fora.id}/full`, { token: tok.gestor })).statusCode, 403);
});
test('escopo: /rede e /escolas bloqueados p/ gestor, liberados p/ secretaria', async () => {
  assert.equal((await inj('GET', '/api/rede', { token: tok.gestor })).statusCode, 403);
  assert.equal((await inj('GET', '/api/escolas', { token: tok.gestor })).statusCode, 403);
  assert.equal((await inj('GET', '/api/rede', { token: tok.secretaria })).statusCode, 200);
  assert.equal((await inj('GET', '/api/escolas', { token: tok.secretaria })).statusCode, 200);
});

/* ---------------- Planejamento mensal ---------------- */
let planoId;
test('planejamento: secretaria cria (mês + ano + MÚLTIPLOS grupos + habilidade CNCA) → 201', async () => {
  const r = await inj('POST', '/api/planejamentos', { token: tok.secretaria, body: { titulo: 'TESTE QA Plano', objetivo: 'expectativa', periodo: 'm06', anos: [1], grupos: ['g-centro', 'g-rural'], habilidades: ['EF01LP01', 'cnca-lp-01', 'hl02'] } });
  assert.equal(r.statusCode, 201);
  const d = r.json();
  planoId = d.id;
  assert.deepEqual(d.anos, [1]);
  assert.deepEqual(d.grupos.map(g => g.id).sort(), ['g-centro', 'g-rural']);
  assert.ok(d.grupos.some(g => g.nome === 'Polo Urbano Centro'), 'nomes dos grupos resolvidos');
});
test('planejamento: grupo inexistente → 400', async () => {
  const r = await inj('POST', '/api/planejamentos', { token: tok.secretaria, body: { titulo: 'TESTE QA Inválido', periodo: 'm06', grupos: ['nao-existe'], habilidades: ['EF01LP01'] } });
  assert.equal(r.statusCode, 400);
});
test('planejamento: lista traz nSemanas, anos e grupos', async () => {
  const pl = (await inj('GET', '/api/planejamentos', { token: tok.secretaria })).json().find(p => p.id === planoId);
  assert.ok(pl, 'plano de teste aparece na lista');
  assert.equal(typeof pl.nSemanas, 'number');
  assert.deepEqual(pl.anos, [1]);
  assert.equal(pl.grupos.length, 2);
});
test('planejamento: professor salva sequências semanais (com habilidades) → 201', async () => {
  const r = await inj('POST', `/api/planejamentos/${planoId}/semanas`, { token: tok.professor, body: { semanas: [{ semana: 1, habilidades: ['EF01LP01'], sequenciaDidatica: 'SD teste', recursosDidaticos: '', verificacaoAprendizagem: '', referencias: '' }] } });
  assert.equal(r.statusCode, 201);
  assert.deepEqual(r.json()[0].habilidades, ['EF01LP01']);
});
test('planejamento: gestor NÃO preenche semanas → 403', async () => {
  assert.equal((await inj('POST', `/api/planejamentos/${planoId}/semanas`, { token: tok.gestor, body: { semanas: [] } })).statusCode, 403);
});

/* ---------------- Verificação contínua ---------------- */
test('verificação: professor registra avaliação em lote (turma t1) → 201', async () => {
  const aluno = (await inj('GET', '/api/turmas/t1/full', { token: tok.professor })).json().alunos[0].id;
  const r = await inj('POST', '/api/avaliacoes/lote', { token: tok.professor, body: { planejamentoId: planoId, habCod: 'EF01LP01', turmaId: 't1', data: DATA_QA, marks: { [aluno]: 2 } } });
  assert.equal(r.statusCode, 201);
});
test('verificação: professor avalia habilidade leitora hl02 e ela aparece na turma (alimenta o gráfico)', async () => {
  const aluno = (await inj('GET', '/api/turmas/t1/full', { token: tok.professor })).json().alunos[0].id;
  const lote = await inj('POST', '/api/avaliacoes/lote', { token: tok.professor, body: { planejamentoId: planoId, habCod: 'hl02', turmaId: 't1', data: DATA_QA, marks: { [aluno]: 2 } } });
  assert.equal(lote.statusCode, 201);
  const d = (await inj('GET', '/api/avaliacoes/turma/t1', { token: tok.professor })).json();
  assert.ok(Object.values(d).some(byHab => byHab['hl02']), 'hl02 avaliada em t1');
});
test('planejamento: detalhe traz semanas (com habilidades) e acompanhamento (avaliados/atingiram)', async () => {
  const d = (await inj('GET', `/api/planejamentos/${planoId}`, { token: tok.professor })).json();
  assert.ok(Array.isArray(d.semanas) && d.semanas.length >= 1);
  assert.deepEqual(d.semanas[0].habilidades, ['EF01LP01']);
  const t = d.trabalho['EF01LP01'];
  assert.ok(t && t.avaliados >= 1 && t.atingiram >= 1, 'acompanhamento reflete a avaliação registrada');
});
test('verificação: reenvio da mesma sessão substitui (edição, sem duplicar)', async () => {
  const aluno = (await inj('GET', '/api/turmas/t1/full', { token: tok.professor })).json().alunos[0].id;
  const b = { planejamentoId: planoId, habCod: 'EF01LP01', turmaId: 't1', data: '14/06/2026', marks: { [aluno]: 1 } };
  assert.equal((await inj('POST', '/api/avaliacoes/lote', { token: tok.professor, body: b })).statusCode, 201);
  assert.equal((await inj('POST', '/api/avaliacoes/lote', { token: tok.professor, body: { ...b, marks: { [aluno]: 2 } } })).statusCode, 201);
  const d = (await inj('GET', '/api/avaliacoes/turma/t1', { token: tok.professor })).json();
  const regs = ((d[aluno] || {})['EF01LP01'] || []).filter(r => r.data === '14/06/2026');
  assert.equal(regs.length, 1, 'sessão substituída, sem duplicatas');
  assert.equal(regs[0].resultado, 2, 'resultado atualizado na edição');
});
test('verificação: excluir sessão remove os registros → 200; inexistente → 404', async () => {
  const r = await inj('DELETE', '/api/avaliacoes/sessao?hab=EF01LP01&turma=t1&data=14%2F06%2F2026', { token: tok.professor });
  assert.equal(r.statusCode, 200);
  const d = (await inj('GET', '/api/avaliacoes/turma/t1', { token: tok.professor })).json();
  const sobra = Object.values(d).some(byHab => (byHab['EF01LP01'] || []).some(x => x.data === '14/06/2026'));
  assert.ok(!sobra, 'registros da sessão removidos');
  assert.equal((await inj('DELETE', '/api/avaliacoes/sessao?hab=EF01LP01&turma=t1&data=14%2F06%2F2026', { token: tok.professor })).statusCode, 404);
});
test('verificação: gestor em avaliações de turma fora do escopo → 403', async () => {
  const fora = (await inj('GET', '/api/turmas', { token: tok.secretaria })).json().find(t => !gestorEscolas.includes(t.escola));
  assert.equal((await inj('GET', `/api/avaliacoes/turma/${fora.id}`, { token: tok.gestor })).statusCode, 403);
});

/* ---------------- Health ---------------- */
test('GET /health → { ok: true }', async () => {
  const r = await inj('GET', '/health');
  assert.equal(r.statusCode, 200);
  assert.equal(r.json().ok, true);
});

/* ---------------- Escopo do gestor: /alunos e /timeline ---------------- */
test('escopo: lista de alunos do gestor fica dentro do grupo', async () => {
  const r = await inj('GET', '/api/alunos', { token: tok.gestor });
  assert.equal(r.statusCode, 200);
  const { alunos } = r.json();
  assert.ok(alunos.length > 0);
  assert.ok(alunos.every(a => gestorEscolas.includes(a.escola)), 'alunos no escopo');
});
test('escopo: ficha de aluno do grupo → 200; fora do grupo → 403', async () => {
  const dentro = (await inj('GET', '/api/alunos', { token: tok.gestor })).json().alunos[0];
  assert.equal((await inj('GET', `/api/alunos/${dentro.id}/full`, { token: tok.gestor })).statusCode, 200);
  const fora = (await inj('GET', '/api/alunos?escola=e3&limit=1', { token: tok.secretaria })).json().alunos[0];
  assert.ok(fora && !gestorEscolas.includes('e3'), 'aluno de e3 está fora do escopo do gestor');
  assert.equal((await inj('GET', `/api/alunos/${fora.id}/full`, { token: tok.gestor })).statusCode, 403);
});
test('escopo: timeline do gestor só traz eventos das turmas do grupo', async () => {
  const turmas = (await inj('GET', '/api/turmas', { token: tok.gestor })).json().map(t => t.id);
  const ev = (await inj('GET', '/api/timeline?limit=50', { token: tok.gestor })).json();
  assert.ok(Array.isArray(ev));
  assert.ok(ev.every(e => !e.turma || turmas.includes(e.turma)), 'eventos no escopo');
});

/* ---------------- Dashboards ---------------- */
test('dashboard: gestor → 200 com stats e distribuição por turma', async () => {
  const r = await inj('GET', '/api/dashboard/gestor', { token: tok.gestor });
  assert.equal(r.statusCode, 200);
  const d = r.json();
  assert.ok(d.stats && typeof d.stats.alunos === 'number');
  assert.ok(Array.isArray(d.distPorTurma));
});
test('dashboard: professor → 200 com planejamentos', async () => {
  const r = await inj('GET', '/api/dashboard/professor', { token: tok.professor });
  assert.equal(r.statusCode, 200);
  assert.ok(Array.isArray(r.json().planejamentos));
});
test('dashboard: professor NÃO acessa dashboard do gestor → 403', async () => {
  assert.equal((await inj('GET', '/api/dashboard/gestor', { token: tok.professor })).statusCode, 403);
});

/* ---------------- Trabalho por habilidade (legado, verificação) ---------------- */
test('planejamento: professor edita trabalho de habilidade (legado) → 200', async () => {
  const r = await inj('PATCH', `/api/planejamentos/${planoId}/trabalho/EF01LP01`, { token: tok.professor, body: { status: 'andamento', recursos: 'QA recursos' } });
  assert.equal(r.statusCode, 200);
  assert.equal(r.json().recursos, 'QA recursos');
});

/* ---------------- Admin — CRUD ---------------- */
test('admin: CRUD de usuário (criar gestor c/ escolaIds, editar, excluir)', async () => {
  const c = await inj('POST', '/api/admin/usuarios', { token: tok.admin, body: { nome: 'QA Teste User', email: 'qa.user.teste@rededeensino.edu.br', senha: 'demo123', perfil: 'gestor', cargo: 'Coord QA', escolaIds: ['e1'] } });
  assert.equal(c.statusCode, 201);
  const u = c.json();
  assert.equal(u.perfil, 'gestor');
  assert.deepEqual(u.escolaIds, ['e1']);
  const e = await inj('PATCH', `/api/admin/usuarios/${u.id}`, { token: tok.admin, body: { cargo: 'Coord QA 2', ativo: false } });
  assert.equal(e.statusCode, 200);
  assert.equal(e.json().cargo, 'Coord QA 2');
  assert.equal((await inj('DELETE', `/api/admin/usuarios/${u.id}`, { token: tok.admin })).statusCode, 200);
});
test('admin: cria usuário professor com componente + turmas (novo vínculo Professor)', async () => {
  const c = await inj('POST', '/api/admin/usuarios', { token: tok.admin, body: { nome: 'QA Prof Teste', email: 'qa.prof.teste@rededeensino.edu.br', senha: 'demo123', perfil: 'professor', comp: 'lp', turmaIds: ['t1', 't2'] } });
  assert.equal(c.statusCode, 201);
  const u = c.json();
  assert.ok(u.profId, 'vínculo Professor criado automaticamente');
  let m = (await inj('GET', '/api/meta', { token: tok.admin })).json();
  let prof = m.PROFESSORES.find(x => x.id === u.profId);
  assert.deepEqual([...prof.turmaIds].sort(), ['t1', 't2']);
  assert.equal(prof.comp, 'lp');
  // edição: reduzir as turmas atualiza o vínculo
  assert.equal((await inj('PATCH', `/api/admin/usuarios/${u.id}`, { token: tok.admin, body: { turmaIds: ['t1'] } })).statusCode, 200);
  m = (await inj('GET', '/api/meta', { token: tok.admin })).json();
  prof = m.PROFESSORES.find(x => x.id === u.profId);
  assert.deepEqual(prof.turmaIds, ['t1']);
  // turma inexistente → 400
  assert.equal((await inj('POST', '/api/admin/usuarios', { token: tok.admin, body: { nome: 'QA Prof X', email: 'qa.prof.x@rededeensino.edu.br', senha: 'demo123', perfil: 'professor', turmaIds: ['nao-existe'] } })).statusCode, 400);
  // teardown: usuário e vínculo Professor de teste
  assert.equal((await inj('DELETE', `/api/admin/usuarios/${u.id}`, { token: tok.admin })).statusCode, 200);
  await app.prisma.professor.delete({ where: { id: u.profId } });
});
test('admin: e-mail duplicado → 409', async () => {
  const r = await inj('POST', '/api/admin/usuarios', { token: tok.admin, body: { nome: 'Dup', email: 'helena@rededeensino.edu.br', senha: 'demo123', perfil: 'professor' } });
  assert.equal(r.statusCode, 409);
});
test('admin: gestor NÃO cria usuário → 403', async () => {
  // corpo válido (validação roda antes do preHandler) para o teste medir a autorização
  const r = await inj('POST', '/api/admin/usuarios', { token: tok.gestor, body: { nome: 'Gestor QA Bloqueado', email: 'bloqueado.qa@rededeensino.edu.br', senha: 'demo123', perfil: 'professor' } });
  assert.equal(r.statusCode, 403);
});
test('admin: CRUD escola → turma → aluno (com teardown)', async () => {
  const esc = await inj('POST', '/api/admin/escolas', { token: tok.admin, body: { nome: 'EMEF QA Teste', sigla: 'EQA', zona: 'Urbana' } });
  assert.equal(esc.statusCode, 201);
  const escolaId = esc.json().id;
  const tur = await inj('POST', '/api/admin/turmas', { token: tok.admin, body: { escola: escolaId, ano: 1, nome: '1º Ano QA', turno: 'Matutino' } });
  assert.equal(tur.statusCode, 201);
  const turmaId = tur.json().id;
  const al = await inj('POST', '/api/admin/alunos', { token: tok.admin, body: { nome: 'Aluno QA Teste', turma: turmaId, nivelLeitura: 2 } });
  assert.equal(al.statusCode, 201);
  const alunoId = al.json().id;
  assert.equal((await inj('PATCH', `/api/admin/alunos/${alunoId}`, { token: tok.admin, body: { nome: 'Aluno QA Editado' } })).statusCode, 200);
  assert.equal((await inj('PATCH', `/api/admin/escolas/${escolaId}`, { token: tok.admin, body: { bairro: 'Centro QA' } })).statusCode, 200);
  // teardown na ordem inversa
  assert.equal((await inj('DELETE', `/api/admin/alunos/${alunoId}`, { token: tok.admin })).statusCode, 200);
  assert.equal((await inj('DELETE', `/api/admin/turmas/${turmaId}`, { token: tok.admin })).statusCode, 200);
  assert.equal((await inj('DELETE', `/api/admin/escolas/${escolaId}`, { token: tok.admin })).statusCode, 200);
});
test('admin: escola com turmas não pode ser excluída → 400', async () => {
  assert.equal((await inj('DELETE', '/api/admin/escolas/e1', { token: tok.admin })).statusCode, 400);
});
test('admin: config GET + PATCH idempotente', async () => {
  const cfg = (await inj('GET', '/api/admin/config', { token: tok.admin })).json();
  assert.ok('periodoAtual' in cfg);
  assert.equal((await inj('PATCH', '/api/admin/config', { token: tok.admin, body: { periodoAtual: cfg.periodoAtual } })).statusCode, 200);
});

/* ---------------- Espelho do SAG ---------------- */
test('sag-sync: protegido por perfil e responde conforme a configuração', async () => {
  assert.equal((await inj('POST', '/api/admin/sag-sync', { token: tok.gestor })).statusCode, 403);
  const s = await inj('GET', '/api/admin/sag-sync/status', { token: tok.secretaria });
  assert.equal(s.statusCode, 200);
  assert.equal(typeof s.json().configurado, 'boolean');
  const r = await inj('POST', '/api/admin/sag-sync', { token: tok.admin });
  if (s.json().configurado) {
    assert.equal(r.statusCode, 200); // sincroniza de verdade contra o banco do SAG
  } else {
    assert.equal(r.statusCode, 400);
    assert.match(r.json().error.message, /SAG_DATABASE_URL/);
  }
});

/* ---------------- Validação / erros ---------------- */
test('validação: planejamento sem título → 400', async () => {
  assert.equal((await inj('POST', '/api/planejamentos', { token: tok.secretaria, body: { periodo: 'm06', habilidades: ['EF01LP01'] } })).statusCode, 400);
});
test('validação: grupo com nome curto → 400', async () => {
  assert.equal((await inj('POST', '/api/grupos', { token: tok.secretaria, body: { nome: 'x' } })).statusCode, 400);
});
test('validação: login sem campos → 400', async () => {
  assert.equal((await inj('POST', '/api/auth/login', { body: {} })).statusCode, 400);
});
test('404: planejamento inexistente', async () => {
  assert.equal((await inj('GET', '/api/planejamentos/nao-existe-123', { token: tok.secretaria })).statusCode, 404);
});

/* ---------------- Componentes curriculares (apenas admin/secretaria) ---------------- */
test('componentes: secretaria cria → 201 e aparece no meta', async () => {
  const r = await inj('POST', '/api/componentes', { token: tok.secretaria, body: { id: 'qa-comp', nome: 'QA Componente' } });
  assert.equal(r.statusCode, 201);
  const m = (await inj('GET', '/api/meta', { token: tok.secretaria })).json();
  assert.ok(m.COMPONENTES.some(c => c.id === 'qa-comp'));
});
test('componentes: professor e gestor NÃO criam → 403', async () => {
  assert.equal((await inj('POST', '/api/componentes', { token: tok.professor, body: { id: 'qa-x', nome: 'Bloqueado' } })).statusCode, 403);
  assert.equal((await inj('POST', '/api/componentes', { token: tok.gestor, body: { id: 'qa-x', nome: 'Bloqueado' } })).statusCode, 403);
});
test('componentes: duplicado → 409; edita nome → 200', async () => {
  assert.equal((await inj('POST', '/api/componentes', { token: tok.secretaria, body: { id: 'qa-comp', nome: 'Duplicado' } })).statusCode, 409);
  const e = await inj('PATCH', '/api/componentes/qa-comp', { token: tok.secretaria, body: { nome: 'QA Componente Editado' } });
  assert.equal(e.statusCode, 200);
  assert.equal(e.json().nome, 'QA Componente Editado');
});
test('componentes: em uso não pode ser excluído → 400; o de teste sai → 200', async () => {
  assert.equal((await inj('DELETE', '/api/componentes/lp', { token: tok.secretaria })).statusCode, 400);
  assert.equal((await inj('DELETE', '/api/componentes/qa-comp', { token: tok.secretaria })).statusCode, 200);
  assert.equal((await inj('DELETE', '/api/componentes/qa-comp', { token: tok.secretaria })).statusCode, 404);
});

/* ---------------- Habilidades (catálogo — apenas admin/secretaria) ---------------- */
test('habilidades: secretaria cria → 201 e aparece no meta', async () => {
  const r = await inj('POST', '/api/habilidades', { token: tok.secretaria, body: { cod: 'QA-HAB-01', rotulo: 'QA1', matriz: 'BNCC', comp: 'lp', desc: 'Habilidade de teste QA' } });
  assert.equal(r.statusCode, 201);
  assert.equal(r.json().matriz, 'BNCC');
  const m = (await inj('GET', '/api/meta', { token: tok.secretaria })).json();
  assert.ok(m.HABILIDADES.some(h => h.cod === 'QA-HAB-01'));
});
test('habilidades: professor e gestor NÃO criam → 403', async () => {
  assert.equal((await inj('POST', '/api/habilidades', { token: tok.professor, body: { cod: 'QA-HAB-02', matriz: 'BNCC', comp: 'lp', desc: 'bloqueada' } })).statusCode, 403);
  assert.equal((await inj('POST', '/api/habilidades', { token: tok.gestor, body: { cod: 'QA-HAB-02', matriz: 'BNCC', comp: 'lp', desc: 'bloqueada' } })).statusCode, 403);
  assert.equal((await inj('DELETE', '/api/habilidades/QA-HAB-01', { token: tok.gestor })).statusCode, 403);
});
test('habilidades: código duplicado → 409; matriz inexistente → 400', async () => {
  assert.equal((await inj('POST', '/api/habilidades', { token: tok.secretaria, body: { cod: 'QA-HAB-01', matriz: 'BNCC', comp: 'lp', desc: 'duplicada' } })).statusCode, 409);
  assert.equal((await inj('POST', '/api/habilidades', { token: tok.admin, body: { cod: 'QA-HAB-03', matriz: 'NAO-EXISTE', comp: 'lp', desc: 'matriz errada' } })).statusCode, 400);
});
test('habilidades: em uso não pode ser excluída → 400; a de teste sai → 200', async () => {
  assert.equal((await inj('DELETE', '/api/habilidades/EF01LP01', { token: tok.secretaria })).statusCode, 400);
  assert.equal((await inj('DELETE', '/api/habilidades/QA-HAB-01', { token: tok.secretaria })).statusCode, 200);
  assert.equal((await inj('DELETE', '/api/habilidades/QA-HAB-01', { token: tok.secretaria })).statusCode, 404);
});

/* ---------------- Edição / arquivamento (por último — arquiva os de teste) ---------------- */
test('planejamento: secretaria edita e arquiva → status arquivado', async () => {
  const r = await inj('PATCH', `/api/planejamentos/${planoId}`, { token: tok.secretaria, body: { status: 'arquivado', titulo: 'TESTE QA Plano (editado)' } });
  assert.equal(r.statusCode, 200);
  assert.equal(r.json().status, 'arquivado');
  assert.equal(r.json().titulo, 'TESTE QA Plano (editado)');
});
test('planejamento: professor/gestor NÃO apagam → 403', async () => {
  assert.equal((await inj('DELETE', `/api/planejamentos/${planoId}`, { token: tok.professor })).statusCode, 403);
  assert.equal((await inj('DELETE', `/api/planejamentos/${planoId}`, { token: tok.gestor })).statusCode, 403);
});
test('planejamento: secretaria apaga → 200 e some (404 no detalhe)', async () => {
  assert.equal((await inj('DELETE', `/api/planejamentos/${planoId}`, { token: tok.secretaria })).statusCode, 200);
  assert.equal((await inj('GET', `/api/planejamentos/${planoId}`, { token: tok.secretaria })).statusCode, 404);
});
test('planejamento: apagar inexistente → 404', async () => {
  assert.equal((await inj('DELETE', '/api/planejamentos/nao-existe-123', { token: tok.secretaria })).statusCode, 404);
});

/* ---------------- Anos escolares (séries) ---------------- */
let anoOrdem;
test('anos: GET retorna catálogo (ordem+nome)', async () => {
  const r = await inj('GET', '/api/anos', { token: tok.professor });
  assert.equal(r.statusCode, 200);
  const lista = r.json();
  assert.ok(Array.isArray(lista) && lista.length >= 1 && lista[0].nome);
});
test('anos: secretaria cria → 201 (ordem auto)', async () => {
  const r = await inj('POST', '/api/anos', { token: tok.secretaria, body: { nome: 'TESTE QA ano' } });
  assert.equal(r.statusCode, 201);
  anoOrdem = r.json().ordem;
  assert.ok(anoOrdem >= 1);
});
test('anos: professor/gestor NÃO criam → 403', async () => {
  assert.equal((await inj('POST', '/api/anos', { token: tok.professor, body: { nome: 'XYZ' } })).statusCode, 403);
  assert.equal((await inj('POST', '/api/anos', { token: tok.gestor, body: { nome: 'XYZ' } })).statusCode, 403);
});
test('anos: secretaria edita nome → 200', async () => {
  const r = await inj('PATCH', `/api/anos/${anoOrdem}`, { token: tok.secretaria, body: { nome: 'TESTE QA ano (editado)' } });
  assert.equal(r.statusCode, 200);
  assert.equal(r.json().nome, 'TESTE QA ano (editado)');
});
test('anos: secretaria apaga → 200 e some do catálogo', async () => {
  assert.equal((await inj('DELETE', `/api/anos/${anoOrdem}`, { token: tok.secretaria })).statusCode, 200);
  const lista = (await inj('GET', '/api/anos', { token: tok.secretaria })).json();
  assert.ok(!lista.some(a => a.ordem === anoOrdem));
});
test('meta: traz ANOS (catálogo de séries)', async () => {
  const m = (await inj('GET', '/api/meta', { token: tok.professor })).json();
  assert.ok(Array.isArray(m.ANOS) && m.ANOS.length >= 1 && typeof m.ANOS[0].ordem === 'number');
});
