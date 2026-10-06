/* ============================================================
   Professores reais e limpeza do seed fictício:
   - regra única (lib/professores.js): real = turma existente
     vinculada OU conta de usuário;
   - GET /meta e /professores/resumo só com professores reais;
   - GET /timeline e /dashboard/gestor ignoram eventos de turmas
     inexistentes;
   - vínculo Usuario → Professor: professor com conta de outro
     usuário → 409, inexistente → 400 (antes de qualquer gravação);
   - scripts/limpar-demo-seed.js: critérios, backup e aplicação
     (só sobre registros descartáveis QA).
   Registros 'QA*' criados aqui são removidos no after.
   Execução: node --test --test-concurrency=1 test/professores-reais.test.js
   ============================================================ */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import 'dotenv/config';
import { buildApp } from '../src/app.js';
import { classificarProfessores, professoresReais } from '../src/lib/professores.js';
import {
  avaliarProfessor, eventoDeTurmaFicticia, planejarLimpeza, aplicarLimpeza,
  salvarBackup, nadaARemover, PROFESSORES_SEED,
} from '../scripts/limpar-demo-seed.js';
import { soTurmasVisiveis } from '../src/lib/ativos.js';

const SUF = Date.now().toString(36);
const QA = {
  profFict: `qa-prof-fict-${SUF}`,
  limpezaA: `qa-limpeza-a-${SUF}`,
  limpezaB: `qa-limpeza-b-${SUF}`,
  turmaInexistente: `qa-turma-inexistente-${SUF}`,
  autor: `qa-autor-semana-${SUF}`,
  email: tag => `qa.${tag}.${SUF}@qa.invalid`,
};
const TURMA_REAL = 'sag-2217'; // turma ATIVA da professora demo (helena, p1) — escola sag-18
const TURMA_OCULTA = 'sag-100'; // turma excluída no SAG (oculta), mesma escola — guarda os eventos antigos
const dirBackup = path.join(os.tmpdir(), `qa-limpar-demo-seed-${SUF}`);

let app;
const tok = {};
const users = {};
const criados = { usuarios: [], eventos: [], professores: [], planejamentos: [] };
const H = t => (t ? { authorization: 'Bearer ' + t } : {});
const inj = (method, url, token, body) => app.inject({
  method, url,
  headers: { ...H(token), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
  ...(body !== undefined ? { payload: JSON.stringify(body) } : {}),
});

const criarEventoQA = async (dados) => {
  const ev = await app.prisma.timelineEvent.create({ data: { tipo: 'avaliacao', habCod: null, profId: null, ...dados } });
  criados.eventos.push(ev.id);
  return ev;
};

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
    const r = await inj('POST', '/api/auth/login', null, { email, senha: 'demo123' });
    assert.equal(r.statusCode, 200, `login ${perfil}`);
    tok[perfil] = r.json().token;
    users[perfil] = r.json().user;
  }
  // professor fictício descartável: sem conta e só com turma inexistente
  await app.prisma.professor.create({
    data: { id: QA.profFict, nome: 'QA Professor Ficticio', compId: 'lp', cor: '#475569', iniciais: 'QA', turmaIds: JSON.stringify([QA.turmaInexistente]) },
  });
});

after(async () => {
  const p = app.prisma;
  await p.timelineEvent.deleteMany({ where: { OR: [{ id: { in: criados.eventos } }, { profId: { startsWith: 'qa-limpeza-' } }] } });
  if (criados.planejamentos.length) await p.planejamento.deleteMany({ where: { id: { in: criados.planejamentos } } }); // cascata: semanas
  if (criados.usuarios.length) await p.usuario.deleteMany({ where: { id: { in: criados.usuarios } } });
  await p.usuario.deleteMany({ where: { email: { endsWith: `.${SUF}@qa.invalid` } } });
  // depois das contas: professores QA e os criados pela API para contas QA
  await p.professor.deleteMany({ where: { id: { in: [QA.profFict, QA.limpezaA, QA.limpezaB, QA.autor, ...criados.professores] } } });
  fs.rmSync(dirBackup, { recursive: true, force: true });
  await app.close();
});

/* ---------------- regra pura ---------------- */
test('classificarProfessores: real = turma existente OU conta; turmaIds só com as existentes', () => {
  const existentes = new Set(['sag-1', 'sag-2']);
  const [comTurma, soConta, ficticio, invalido] = classificarProfessores([
    { id: 'a', turmaIds: '["sag-1","t1"]', usuario: null },
    { id: 'b', turmaIds: '[]', usuario: { id: 'u-b' } },
    { id: 'c', turmaIds: '["t1"]', usuario: null },
    { id: 'd', turmaIds: 'não é json', usuario: null },
  ], existentes);
  assert.deepEqual([comTurma.real, comTurma.turmaIds, comTurma.temConta], [true, ['sag-1'], false]);
  assert.deepEqual([soConta.real, soConta.turmaIds, soConta.temConta], [true, [], true]);
  assert.deepEqual([ficticio.real, ficticio.turmaIds], [false, []]);
  assert.deepEqual([invalido.real, invalido.turmaIds], [false, []]);
  assert.deepEqual(professoresReais([{ id: 'x', turmaIds: '["t9"]' }], existentes), []);
});

test('avaliarProfessor: só remove com nome do seed, sem conta, sem turma existente e sem referências', () => {
  const base = { id: 'p2', nome: 'Rafael Souza', turmaIds: '["t1"]', usuario: null };
  const ctx = { nomeEsperado: 'Rafael Souza', turmasExistentes: new Set(['sag-1']), referencias: { planejamento: 0, timeline: 0 } };
  assert.equal(avaliarProfessor(base, ctx).remover, true);
  assert.match(avaliarProfessor({ ...base, nome: 'Outro' }, ctx).motivo, /difere do seed/);
  assert.match(avaliarProfessor({ ...base, usuario: { id: 'u' } }, ctx).motivo, /conta de usuário/);
  assert.match(avaliarProfessor({ ...base, turmaIds: '["sag-1"]' }, ctx).motivo, /turma existente/);
  const ref = avaliarProfessor(base, { ...ctx, referencias: { planejamento: 0, semana: 2, trilha: 1 } });
  assert.equal(ref.remover, false);
  assert.match(ref.motivo, /semana=2, trilha=1/);
  assert.deepEqual(PROFESSORES_SEED.map(s => s.id), ['p2', 'p3']);
});

test('eventoDeTurmaFicticia: turma inexistente fora do espelho do SAG', () => {
  const existentes = new Set(['sag-1', 't1-real']);
  assert.equal(eventoDeTurmaFicticia({ turmaId: 't1' }, existentes), true);
  assert.equal(eventoDeTurmaFicticia({ turmaId: null }, existentes), false);
  assert.equal(eventoDeTurmaFicticia({ turmaId: 'sag-999' }, existentes), false, 'turma real que sumiu do SAG é histórico');
  assert.equal(eventoDeTurmaFicticia({ turmaId: 't1-real' }, existentes), false);
});

/* ---------------- listas de professores ---------------- */
test('GET /meta: PROFESSORES só com professores reais (sem p2/p3 nem fictício QA)', async () => {
  const r = await inj('GET', '/api/meta', tok.secretaria);
  assert.equal(r.statusCode, 200);
  const profs = r.json().PROFESSORES;
  const ids = profs.map(x => x.id);
  for (const fict of ['p2', 'p3', QA.profFict]) assert.ok(!ids.includes(fict), `${fict} não pode aparecer`);
  const todasTurmas = profs.flatMap(x => x.turmaIds);
  const existentes = new Set((await app.prisma.turma.findMany({ where: { id: { in: todasTurmas } }, select: { id: true } })).map(t => t.id));
  for (const x of profs) {
    assert.equal(typeof x.temConta, 'boolean');
    assert.ok(x.turmaIds.length > 0 || x.temConta, `${x.id} não é real`);
    assert.ok(x.turmaIds.every(t => existentes.has(t)), `${x.id} com turma inexistente`);
  }
  const helena = profs.find(x => x.id === users.professor.profId);
  assert.ok(helena && helena.temConta, 'professora demo (com conta e turmas) aparece');
});

test('GET /meta: supervisor só recebe professores com turma nas suas escolas', async () => {
  const profs = (await inj('GET', '/api/meta', tok.supervisor)).json().PROFESSORES;
  const turmas = profs.flatMap(x => x.turmaIds);
  const escolas = new Set((await app.prisma.turma.findMany({ where: { id: { in: turmas } }, select: { escolaId: true } })).map(t => t.escolaId));
  assert.ok([...escolas].every(e => users.supervisor.escolaIds.includes(e)));
  assert.ok(!profs.some(x => x.id === QA.profFict));
});

test('GET /professores/resumo (rede): sem professor fictício', async () => {
  const r = await inj('GET', '/api/professores/resumo', tok.secretaria);
  assert.equal(r.statusCode, 200);
  const ids = r.json().map(x => x.id);
  assert.ok(!ids.includes(QA.profFict) && !ids.includes('p2') && !ids.includes('p3'));
  assert.ok(ids.includes(users.professor.profId));
});

test('evolução da rede: professores ativos nunca excedem os professores do escopo', async () => {
  const r = await inj('GET', '/api/dashboard/evolucao', tok.secretaria);
  assert.equal(r.statusCode, 200);
  const d = r.json();
  for (const m of d.meses) assert.ok(m.professoresAtivos <= d.totais.professores, `${m.id}: ${m.professoresAtivos} > ${d.totais.professores}`);
});

/* ---------------- timeline ---------------- */
test('GET /timeline e /dashboard/gestor ignoram eventos de turma inexistente', async () => {
  const fict = await criarEventoQA({ data: new Date('2099-01-02T12:00:00Z'), texto: `QA evento turma inexistente ${SUF}`, turmaId: QA.turmaInexistente });
  const real = await criarEventoQA({ data: new Date('2099-01-01T12:00:00Z'), texto: `QA evento turma real ${SUF}`, turmaId: TURMA_REAL });

  const rede = (await inj('GET', '/api/timeline?limit=200', tok.secretaria)).json();
  const textos = rede.map(e => e.texto);
  assert.ok(!textos.includes(fict.texto), 'evento de turma inexistente não aparece');
  assert.equal(textos[0], real.texto, 'evento da turma real é o mais recente');
  const turmasUsadas = [...new Set(rede.map(e => e.turma).filter(Boolean))];
  const existentes = await app.prisma.turma.count({ where: soTurmasVisiveis({ id: { in: turmasUsadas } }) });
  assert.equal(existentes, turmasUsadas.length, 'toda turma citada existe e está visível');
  assert.ok(!rede.some(e => e.turma === TURMA_OCULTA), 'eventos de turma excluída no SAG ficam ocultos');
  assert.deepEqual((await inj('GET', `/api/timeline?turma=${TURMA_OCULTA}`, tok.secretaria)).json(), [], 'turma oculta → []');
  assert.ok(!rede.some(e => e.turma === 't1'), 'sem eventos da turma t1 do protótipo');

  assert.deepEqual((await inj('GET', `/api/timeline?turma=${QA.turmaInexistente}`, tok.secretaria)).json(), []);
  assert.equal((await inj('GET', `/api/timeline?turma=${TURMA_REAL}&limit=1`, tok.secretaria)).json()[0].texto, real.texto);

  const dash = await inj('GET', '/api/dashboard/gestor', tok.supervisor);
  assert.equal(dash.statusCode, 200);
  const textosDash = dash.json().timeline.map(e => e.texto);
  assert.ok(!textosDash.includes(fict.texto));
  const escola = users.supervisor.escolaIds[0];
  const turmaNaEscola = await app.prisma.turma.count({ where: { id: TURMA_REAL, escolaId: escola } });
  if (turmaNaEscola) assert.equal(textosDash[0], real.texto, 'dashboard traz a turma real da escola');
  else assert.ok(!textosDash.includes(real.texto), 'dashboard não traz turma de outra escola');
});

/* ---------------- vínculo Usuario → Professor ---------------- */
test('POST /admin/usuarios: professor com conta de outro usuário → 409, nada gravado', async () => {
  const profId = users.professor.profId;
  const antes = await app.prisma.professor.findUnique({ where: { id: profId } });
  const email = QA.email('vinculo');
  const r = await inj('POST', '/api/admin/usuarios', tok.admin, { nome: 'QA Vinculo Duplicado', email, senha: 'qa123456', perfil: 'professor', profId });
  assert.equal(r.statusCode, 409);
  assert.equal(await app.prisma.usuario.count({ where: { email } }), 0);
  assert.deepEqual(await app.prisma.professor.findUnique({ where: { id: profId } }), antes);
});

test('PATCH /admin/usuarios: vínculo com professor de outra conta → 409; inexistente → 400', async () => {
  const c = await inj('POST', '/api/admin/usuarios', tok.admin, { nome: 'QA Conta Vinculo', email: QA.email('patch'), senha: 'qa123456', perfil: 'secretaria' });
  assert.equal(c.statusCode, 201);
  const id = c.json().id;
  criados.usuarios.push(id);
  assert.equal((await inj('PATCH', `/api/admin/usuarios/${id}`, tok.admin, { profId: users.professor.profId })).statusCode, 409);
  assert.equal((await inj('PATCH', `/api/admin/usuarios/${id}`, tok.admin, { profId: `qa-nao-existe-${SUF}` })).statusCode, 400);
  assert.equal((await app.prisma.usuario.findUnique({ where: { id } })).profId, null);
});

/* ---------------- script de limpeza (só QA) ---------------- */
test('limpar-demo-seed: planeja, faz backup e remove só o que atende aos critérios', async () => {
  const p = app.prisma;
  await p.professor.createMany({
    data: [
      { id: QA.limpezaA, nome: 'QA Limpeza A', compId: 'lp', cor: '#475569', iniciais: 'QA', turmaIds: '[]' },
      { id: QA.limpezaB, nome: 'QA Limpeza B', compId: 'lp', cor: '#475569', iniciais: 'QA', turmaIds: '[]' },
    ],
  });
  // B referenciado por um evento (de turma real) → mantido
  await criarEventoQA({ data: new Date('2001-01-01T12:00:00Z'), texto: `QA ref B ${SUF}`, turmaId: TURMA_REAL, profId: QA.limpezaB });
  const evFict = await criarEventoQA({ data: new Date('2001-01-02T12:00:00Z'), texto: `QA limpeza ficticio ${SUF}`, turmaId: QA.turmaInexistente });
  const evSag = await criarEventoQA({ data: new Date('2001-01-03T12:00:00Z'), texto: `QA limpeza sag sumida ${SUF}`, turmaId: `sag-qa-${SUF}` });

  const opts = {
    candidatos: [
      { id: QA.limpezaA, nome: 'QA Limpeza A' },
      { id: QA.limpezaB, nome: 'QA Limpeza B' },
      { id: `qa-ausente-${SUF}`, nome: 'QA Ausente' },
    ],
    eventoIds: [evFict.id, evSag.id],
  };
  const plano = await planejarLimpeza(p, opts);
  assert.deepEqual(plano.professores.remover.map(x => x.id), [QA.limpezaA]);
  assert.equal(plano.professores.manter.length, 1);
  assert.match(plano.professores.manter[0].motivo, /timeline=1/);
  assert.deepEqual(plano.professores.ausentes, [`qa-ausente-${SUF}`]);
  assert.deepEqual(plano.eventos.remover.map(e => e.id), [evFict.id], 'evento de turma sag- sumida é histórico real');

  // nome diferente do esperado → nunca remove
  const outroNome = await planejarLimpeza(p, { candidatos: [{ id: QA.limpezaA, nome: 'Outro Nome' }], eventoIds: [] });
  assert.equal(outroNome.professores.remover.length, 0);

  const arquivos = await salvarBackup(p, dirBackup, plano);
  const bkProf = JSON.parse(fs.readFileSync(arquivos.Professor, 'utf8'));
  assert.deepEqual(bkProf.remover, [QA.limpezaA]);
  assert.ok(bkProf.linhas.some(l => l.id === QA.limpezaA), 'backup traz a linha a remover');
  const bkEv = JSON.parse(fs.readFileSync(arquivos.TimelineEvent, 'utf8'));
  assert.deepEqual(bkEv.remover, [evFict.id]);
  const segundo = await salvarBackup(p, dirBackup, plano);
  assert.notEqual(segundo.Professor, arquivos.Professor, 'backup existente não é sobrescrito');

  const r = await aplicarLimpeza(p, plano);
  assert.deepEqual(r.contagem, { professores: 1, eventos: 1 });
  assert.equal(await p.professor.count({ where: { id: QA.limpezaA } }), 0);
  assert.equal(await p.professor.count({ where: { id: QA.limpezaB } }), 1);
  assert.equal(await p.timelineEvent.count({ where: { id: evFict.id } }), 0);
  assert.equal(await p.timelineEvent.count({ where: { id: evSag.id } }), 1);

  assert.equal(nadaARemover(await planejarLimpeza(p, opts)), true, 'segunda execução não remove nada');
});

/* ---------------- timeline: escopo (achados F2 e F7) ---------------- */
test('GET /timeline: supervisor/gestor com ?turma inexistente ou fora do escopo → [] (nunca o escopo todo)', async () => {
  const fora = await app.prisma.turma.findFirst({
    where: soTurmasVisiveis({ escolaId: { notIn: [...users.supervisor.escolaIds, ...users.gestor.escolaIds] } }), select: { id: true },
  });
  assert.ok(fora, 'precisa de uma turma visível fora das escolas do supervisor/gestor');
  await criarEventoQA({ data: new Date('2099-02-01T12:00:00Z'), texto: `QA escopo dentro ${SUF}`, turmaId: TURMA_REAL });
  await criarEventoQA({ data: new Date('2099-02-02T12:00:00Z'), texto: `QA escopo fora ${SUF}`, turmaId: fora.id });
  for (const perfil of ['supervisor', 'gestor']) {
    for (const turma of [QA.turmaInexistente, fora.id, 't1', TURMA_OCULTA]) {
      const r = await inj('GET', `/api/timeline?turma=${encodeURIComponent(turma)}`, tok[perfil]);
      assert.equal(r.statusCode, 200);
      assert.deepEqual(r.json(), [], `${perfil} ?turma=${turma} → []`);
    }
    const semFiltro = (await inj('GET', '/api/timeline?limit=200', tok[perfil])).json().map(e => e.texto);
    assert.ok(semFiltro.includes(`QA escopo dentro ${SUF}`), `${perfil}: evento da escola vinculada aparece`);
    assert.ok(!semFiltro.includes(`QA escopo fora ${SUF}`), `${perfil}: evento de outra escola não aparece`);
  }
});

test('GET /timeline: professor só vê as próprias turmas; ?turma/?prof de outros → 403', async () => {
  const minhas = (await app.prisma.professor.findUnique({ where: { id: users.professor.profId }, select: { turmaIds: true } })).turmaIds;
  const alheia = await app.prisma.turma.findFirst({ where: soTurmasVisiveis({ id: { notIn: JSON.parse(minhas) } }), select: { id: true } });
  await criarEventoQA({ data: new Date('2099-03-01T12:00:00Z'), texto: `QA prof minha ${SUF}`, turmaId: TURMA_REAL, profId: users.professor.profId });
  await criarEventoQA({ data: new Date('2099-03-02T12:00:00Z'), texto: `QA prof alheia ${SUF}`, turmaId: alheia.id, profId: QA.profFict });
  await criarEventoQA({ data: new Date('2099-03-03T12:00:00Z'), texto: `QA prof sem turma ${SUF}` });

  const r = await inj('GET', '/api/timeline?limit=200', tok.professor);
  assert.equal(r.statusCode, 200);
  const textos = r.json().map(e => e.texto);
  assert.ok(textos.includes(`QA prof minha ${SUF}`), 'evento da própria turma aparece');
  assert.ok(!textos.includes(`QA prof alheia ${SUF}`), 'evento de turma alheia não aparece');
  assert.ok(!textos.includes(`QA prof sem turma ${SUF}`), 'evento sem turma (rede) não aparece para o professor');
  assert.ok(r.json().every(e => JSON.parse(minhas).includes(e.turma)), 'só turmas da professora');

  assert.equal((await inj('GET', `/api/timeline?turma=${alheia.id}`, tok.professor)).statusCode, 403);
  assert.equal((await inj('GET', `/api/timeline?turma=${TURMA_OCULTA}`, tok.professor)).statusCode, 403, 'turma antiga (oculta) não é mais dela');
  assert.equal((await inj('GET', `/api/timeline?prof=${QA.profFict}`, tok.professor)).statusCode, 403);
  const proprio = await inj('GET', `/api/timeline?turma=${TURMA_REAL}&prof=${users.professor.profId}&limit=1`, tok.professor);
  assert.equal(proprio.statusCode, 200);
  assert.equal(proprio.json()[0].texto, `QA prof minha ${SUF}`);
});

/* ---------------- PATCH /admin/usuarios: professor recém-criado (achado F1 do seed) ---------------- */
test('PATCH /admin/usuarios: virar professor com profId null cria o Professor e o VINCULA (sem órfão)', async () => {
  const c = await inj('POST', '/api/admin/usuarios', tok.admin, { nome: 'QA Vira Professor', email: QA.email('vira-prof'), senha: 'qa123456', perfil: 'secretaria' });
  assert.equal(c.statusCode, 201);
  const id = c.json().id;
  criados.usuarios.push(id);
  const antes = await app.prisma.professor.count();

  // o front manda profId: null para "— novo professor —"
  const r = await inj('PATCH', `/api/admin/usuarios/${id}`, tok.admin, { perfil: 'professor', profId: null, comp: 'lp', turmaIds: [TURMA_REAL] });
  assert.equal(r.statusCode, 200, r.body);
  const u = r.json();
  assert.ok(u.profId, 'conta vinculada ao professor recém-criado');
  criados.professores.push(u.profId);
  const prof = await app.prisma.professor.findUnique({ where: { id: u.profId }, include: { usuario: { select: { id: true } } } });
  assert.equal(prof.usuario?.id, id);
  assert.deepEqual(JSON.parse(prof.turmaIds), [TURMA_REAL]);
  assert.equal(prof.compId, 'lp');
  assert.equal(await app.prisma.professor.count(), antes + 1, 'exatamente um Professor novo — nenhum órfão');
  assert.equal((await app.prisma.usuario.findUnique({ where: { id } })).profId, u.profId);

  // turma excluída no SAG (oculta) não pode ser vinculada; nada muda
  const oculta = await inj('PATCH', `/api/admin/usuarios/${id}`, tok.admin, { perfil: 'professor', profId: u.profId, turmaIds: [TURMA_OCULTA] });
  assert.equal(oculta.statusCode, 400);
  assert.deepEqual(JSON.parse((await app.prisma.professor.findUnique({ where: { id: u.profId } })).turmaIds), [TURMA_REAL]);
});

/* ---------------- autor das semanas nunca como id cru (achado F5 do seed) ---------------- */
test('GET /planejamentos/:id: semanas trazem o nome do autor mesmo fora do /meta', async () => {
  const pl = await inj('POST', '/api/planejamentos', tok.secretaria, { titulo: `QA Autor semana ${SUF}`, periodo: 'm06', anos: [], grupos: [], habilidades: ['EF01LP01'] });
  assert.equal(pl.statusCode, 201);
  criados.planejamentos.push(pl.json().id);
  // autor sem conta e sem turma: não é "real", fica fora do /meta
  await app.prisma.professor.create({ data: { id: QA.autor, nome: 'QA Autor Removido', compId: 'lp', cor: '#123456', iniciais: 'QR', turmaIds: '[]' } });
  await app.prisma.planejamentoSemana.create({ data: { planejamentoId: pl.json().id, profId: QA.autor, semana: 1 } });

  const meta = (await inj('GET', '/api/meta', tok.secretaria)).json();
  assert.ok(!meta.PROFESSORES.some(x => x.id === QA.autor), 'autor não está no catálogo do /meta');
  const d = await inj('GET', `/api/planejamentos/${pl.json().id}`, tok.secretaria);
  assert.equal(d.statusCode, 200);
  const s = d.json().semanas.find(x => x.prof === QA.autor);
  assert.ok(s, 'semana do autor');
  assert.deepEqual([s.profNome, s.profIniciais, s.profCor, s.profComp], ['QA Autor Removido', 'QR', '#123456', 'lp']);
  for (const x of d.json().semanas) assert.notEqual(x.profNome, x.prof, 'nunca o id cru');
});
