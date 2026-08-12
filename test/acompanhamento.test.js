/* ============================================================
   Testes dos eventos de acompanhamento (verificação contínua).
   Cria os próprios dados (planejamento QA + evento) e remove
   tudo ao final via Prisma — nunca usa seed. Regras validadas:
   a data é somente registro; alunos ainda não analisados podem
   ser COMPLETADOS em outro dia no MESMO evento; resultados já
   registrados são IMUTÁVEIS (sem edição nem exclusão).

   Execução: node --test test/acompanhamento.test.js
   ============================================================ */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import 'dotenv/config';
import { buildApp } from '../src/app.js';
import { parseBR } from '../src/lib/datas.js';

const DIA1 = '10/06/2026';
const DIA2 = '12/06/2026';
const HAB = 'EF01LP01';

let app;
const tok = {};
let planoId = null, turmaId = null, alunos = [], eventoId = null;

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
  for (const [perfil, email] of Object.entries({
    secretaria: 'beatriz@rededeensino.edu.br',
    professor: 'helena@rededeensino.edu.br',
  })) {
    const r = await inj('POST', '/api/auth/login', { body: { email, senha: 'demo123' } });
    assert.equal(r.statusCode, 200, `login ${perfil} deve ser 200`);
    tok[perfil] = r.json().token;
  }

  // turma da professora + 3 alunos reais (só leitura; os registros QA são removidos no after)
  const prof = await app.prisma.professor.findUnique({ where: { id: 'p1' } })
    || await app.prisma.professor.findFirst({ where: { usuario: { email: 'helena@rededeensino.edu.br' } } });
  turmaId = JSON.parse(prof.turmaIds || '[]')[0];
  assert.ok(turmaId, 'professora precisa ter ao menos uma turma');
  alunos = await app.prisma.aluno.findMany({ where: { turmaId }, orderBy: { numero: 'asc' }, take: 3, select: { id: true } });
  assert.ok(alunos.length >= 3, 'turma precisa de >= 3 alunos');

  // planejamento QA direcionado (toda a rede) com a habilidade avaliada
  const r = await inj('POST', '/api/planejamentos', {
    token: tok.secretaria,
    body: { titulo: 'QA Acompanhamento', objetivo: 'fixture de teste', periodo: 'm06', anos: [], grupos: [], habilidades: [HAB] },
  });
  assert.equal(r.statusCode, 201, 'cria planejamento QA');
  planoId = r.json().id;
});

after(async () => {
  // teardown via Prisma (eventos são imutáveis pela API): eventos QA em
  // cascata removem as avaliações; o DELETE do plano limpa o restante.
  await app.prisma.acompanhamentoEvento.deleteMany({
    where: { turmaId, habCod: HAB, data: { in: [parseBR(DIA1), parseBR(DIA2)] } },
  });
  if (planoId) await inj('DELETE', '/api/planejamentos/' + planoId, { token: tok.secretaria });
  await app.prisma.timelineEvent.deleteMany({
    where: { tipo: 'avaliacao', habCod: HAB, turmaId, data: { in: [parseBR(DIA1), parseBR(DIA2)] } },
  });
  await app.close();
});

test('acompanhamento: criar evento no dia 1 (parcial)', async () => {
  const [a1, a2] = alunos;
  const r = await inj('POST', '/api/avaliacoes/lote', {
    token: tok.professor,
    body: { planejamentoId: planoId, habCod: HAB, turmaId, data: DIA1, marks: { [a1.id]: 1, [a2.id]: 2 } },
  });
  assert.equal(r.statusCode, 201);
  const d = r.json();
  assert.ok(d.eventoId, 'devolve o id do evento criado');
  assert.equal(d.criado, true);
  assert.equal(d.novas, 2);
  eventoId = d.eventoId;

  const evs = (await inj('GET', '/api/avaliacoes/eventos?turma=' + turmaId, { token: tok.professor })).json();
  const ev = evs.find(e => e.id === eventoId);
  assert.ok(ev, 'evento listado');
  assert.equal(ev.data, DIA1);
  assert.equal(ev.avaliados, 2);
  assert.equal(ev.atingiram, 1);
});

test('acompanhamento: completar em outro dia preserva os já analisados', async () => {
  const [a1, , a3] = alunos;
  const antes = (await inj('GET', '/api/avaliacoes/eventos?turma=' + turmaId, { token: tok.professor })).json().length;

  // dia 2: tentativa de "editar" a1 (1→2) deve ser IGNORADA; a3 é pendente e entra
  const r = await inj('POST', '/api/avaliacoes/lote', {
    token: tok.professor,
    body: { planejamentoId: planoId, habCod: HAB, turmaId, eventoId, data: DIA2, marks: { [a1.id]: 2, [a3.id]: 2 } },
  });
  assert.equal(r.statusCode, 201);
  const d = r.json();
  assert.equal(d.eventoId, eventoId, 'mesmo evento');
  assert.equal(d.criado, false);
  assert.equal(d.novas, 1, 'só o aluno pendente cria registro');
  assert.equal(d.ignoradas, 1, 'aluno já analisado é ignorado (imutável)');

  const evs = (await inj('GET', '/api/avaliacoes/eventos?turma=' + turmaId, { token: tok.professor })).json();
  assert.equal(evs.length, antes, 'nenhum evento novo foi criado');
  const ev = evs.find(e => e.id === eventoId);
  assert.equal(ev.data, DIA1, 'a data de registro original é preservada');
  assert.equal(ev.avaliados, 3);

  // marcas atuais: a1 permanece com o resultado ORIGINAL (imutável)
  const marks = (await inj('GET', '/api/avaliacoes/evento/' + eventoId, { token: tok.professor })).json().marks;
  assert.equal(marks[a1.id], 1, 'resultado original preservado (edição ignorada)');
  assert.equal(marks[a3.id], 2, 'pendente completado');

  const avA1 = (await inj('GET', '/api/avaliacoes?alunoId=' + a1.id, { token: tok.professor })).json()[HAB] || [];
  assert.equal(avA1.length, 1, 'não duplicou');
  assert.equal(avA1[0].data, DIA1, 'data original preservada');
  const avA3 = (await inj('GET', '/api/avaliacoes?alunoId=' + a3.id, { token: tok.professor })).json()[HAB] || [];
  assert.equal(avA3[0].data, DIA2, 'pendente recebe a data do dia em que foi completado');
});

test('acompanhamento: eventos são imutáveis — rotas de exclusão não existem', async () => {
  const r1 = await inj('DELETE', '/api/avaliacoes/evento/' + eventoId, { token: tok.professor });
  assert.equal(r1.statusCode, 404, 'DELETE de evento não existe mais');
  const r2 = await inj('DELETE', `/api/avaliacoes/sessao?hab=${HAB}&turma=${turmaId}&data=${encodeURIComponent(DIA1)}`, { token: tok.professor });
  assert.equal(r2.statusCode, 404, 'DELETE de sessão legada não existe mais');
});

test('acompanhamento: `novo` força evento separado para comparativo (mesma data)', async () => {
  const [a1] = alunos;
  const mk = () => inj('POST', '/api/avaliacoes/lote', {
    token: tok.professor,
    body: { planejamentoId: planoId, habCod: HAB, turmaId, data: DIA1, novo: true, marks: { [a1.id]: 2 } },
  });
  const e1 = (await mk()).json().eventoId;
  const e2 = (await mk()).json().eventoId;
  assert.ok(e1 && e2 && e1 !== e2, 'dois eventos distintos mesmo com a mesma data');
  // limpeza direta via Prisma (API não expõe exclusão)
  await app.prisma.acompanhamentoEvento.deleteMany({ where: { id: { in: [e1, e2] } } });
});
