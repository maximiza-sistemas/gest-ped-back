/* ============================================================
   Status real de cada habilidade (painel do professor) DERIVADO
   da verificação contínua — lib/acompanhamento.js:
     · trabalhada = existe evento COMPLETO (todos os alunos atuais
       da turma analisados) numa turma do recorte;
     · andamento  = há avaliações, mas nenhum evento completo;
     · pendente   = nenhuma avaliação.
   Mais: escopo de turma do professor nas leituras/escritas usadas
   pelo painel, Meus alunos e ficha do aluno.

   Parte 1: unitários puros (sem banco).
   Parte 2: integração — leitura dos dados reais (logins demo) e
   planejamentos descartáveis 'QA Status' com eventos numa data
   fictícia (01/03/2001); TUDO o que foi criado é removido no
   after (eventos → avaliações em cascata, planos, timeline).
   Inclui o escopo do professor em GET /alunos e as regras do
   lote: turma obrigatória, plano direcionado e evento preso ao
   seu planejamento.

   Execução: node --test test/acompanhamento-status.test.js
   ============================================================ */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import 'dotenv/config';
import {
  eventoCompleto, statusTrabalho, montarAcompanhamento, trabalhoDoPlano, chaveTrabalho, TRABALHO_VAZIO,
} from '../src/lib/acompanhamento.js';
import { soAlunosVisiveis, soTurmasVisiveis, alunoVisivel } from '../src/lib/ativos.js';

/* ======================= Parte 1 — unitários ======================= */

const D1 = new Date('2026-09-01T12:00:00Z');
const D2 = new Date('2026-09-08T12:00:00Z');
const av = (id, alunoId, extra = {}) => ({
  id, alunoId, habCod: 'H1', planejamentoId: 'P1', eventoId: 'E1', data: D1, resultado: 2, ...extra,
});
const turmas = new Map([['T1', ['a1', 'a2', 'a3']], ['T2', ['b1']]]);

test('eventoCompleto: todos os alunos ATUAIS da turma analisados', () => {
  assert.equal(eventoCompleto(['a1', 'a2'], ['a1', 'a2']), true);
  assert.equal(eventoCompleto(['a1', 'a2'], new Set(['a2', 'a1', 'x-saiu'])), true, 'aluno que saiu da turma não atrapalha');
  assert.equal(eventoCompleto(['a1', 'a2', 'a3'], ['a1', 'a2', 'x-saiu']), false, 'contar avaliados não basta: falta a3');
  assert.equal(eventoCompleto([], ['a1']), false, 'turma sem alunos nunca completa');
});

test('statusTrabalho: evento completo > avaliações > nada', () => {
  assert.equal(statusTrabalho({ avaliacoes: 3, eventosCompletos: 1 }), 'trabalhada');
  assert.equal(statusTrabalho({ avaliacoes: 2, eventosCompletos: 0 }), 'andamento');
  assert.equal(statusTrabalho({ avaliacoes: 0, eventosCompletos: 0 }), 'pendente');
  assert.equal(statusTrabalho(), 'pendente');
});

test('montarAcompanhamento: evento parcial = andamento; completar o mesmo evento = trabalhada', () => {
  const eventos = [{ id: 'E1', turmaId: 'T1', habCod: 'H1', planejamentoId: 'P1' }];
  const parcial = montarAcompanhamento({ eventos, alunosPorTurma: turmas, avaliacoes: [av('1', 'a1'), av('2', 'a2', { resultado: 1 })] });
  assert.deepEqual(parcial.get(chaveTrabalho('P1', 'H1')), {
    status: 'andamento', avaliacoes: 1, eventos: 1, eventosCompletos: 0, avaliados: 2, atingiram: 1, ultima: '01/09/2026',
  });

  const completo = montarAcompanhamento({
    eventos, alunosPorTurma: turmas,
    avaliacoes: [av('1', 'a1'), av('2', 'a2', { resultado: 1 }), av('3', 'a3', { data: D2 })], // a3 completado em outro dia
  });
  const t = completo.get(chaveTrabalho('P1', 'H1'));
  assert.equal(t.status, 'trabalhada');
  assert.equal(t.avaliacoes, 1, 'um evento = uma verificação, mesmo completado em outro dia');
  assert.equal(t.eventosCompletos, 1);
  assert.equal(t.ultima, '08/09/2026');
});

test('montarAcompanhamento: recorte por planejamento — evento do plano A não marca o plano B', () => {
  const r = montarAcompanhamento({
    eventos: [{ id: 'E1', turmaId: 'T2', habCod: 'H1', planejamentoId: 'PA' }],
    alunosPorTurma: turmas,
    avaliacoes: [av('1', 'b1', { planejamentoId: 'PA' })],
  });
  assert.equal(r.get(chaveTrabalho('PA', 'H1')).status, 'trabalhada');
  assert.equal(r.get(chaveTrabalho('PB', 'H1')), undefined, 'plano B segue sem verificação');
  const planoB = trabalhoDoPlano({ id: 'PB', habilidades: [{ habCod: 'H1' }] }, r);
  assert.deepEqual(planoB.H1, { ...TRABALHO_VAZIO });
  assert.notEqual(planoB.H1, TRABALHO_VAZIO, 'devolve cópia, nunca o objeto compartilhado');
});

test('montarAcompanhamento: avaliações legadas (sem evento) = andamento, uma verificação por data', () => {
  const legado = { eventoId: null };
  const r = montarAcompanhamento({
    eventos: [], alunosPorTurma: turmas,
    avaliacoes: [av('1', 'a1', legado), av('2', 'a2', legado), av('3', 'a1', { ...legado, data: D2, resultado: 1 })],
  });
  const t = r.get(chaveTrabalho('P1', 'H1'));
  assert.equal(t.status, 'andamento', 'sem evento completo nunca é trabalhada');
  assert.equal(t.avaliacoes, 2, 'duas datas distintas');
  assert.equal(t.avaliados, 2);
  assert.equal(t.atingiram, 1, 'a1 vale pelo último resultado (não atingiu)');
});

test('montarAcompanhamento: evento sem avaliações e avaliação de evento fora do recorte não contam', () => {
  const r = montarAcompanhamento({
    eventos: [{ id: 'E-vazio', turmaId: 'T1', habCod: 'H1', planejamentoId: 'P1' }],
    alunosPorTurma: turmas,
    avaliacoes: [av('1', 'a1', { eventoId: 'E-de-outra-turma' })],
  });
  assert.equal(r.size, 0);
});

/* ======================= Parte 2 — integração ======================= */

const DATA_QA = '01/03/2001';
const HAB_QA = 'EF01LP01';
let app;
let parseBR;
const tok = {};
const qa = {
  planoId: null, turmaId: null, alunos: [], eventoId: null, turmaAlheia: null, alunoAlheio: null, alunoTurma2: null,
  minhasTurmas: [], compProf: null, planosExtras: [], eventosExtras: [], habsTimeline: [HAB_QA],
};

const H = t => (t ? { authorization: 'Bearer ' + t } : {});
const inj = (method, url, { token, body } = {}) => app.inject({
  method, url,
  headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...H(token) },
  payload: body !== undefined ? JSON.stringify(body) : undefined,
});
const get = (url, token) => inj('GET', url, { token });

before(async () => {
  ({ parseBR } = await import('../src/lib/datas.js'));
  const { buildApp } = await import('../src/app.js');
  app = await buildApp({ logger: false });
  await app.ready();
  for (const [perfil, email] of Object.entries({
    secretaria: 'beatriz@rededeensino.edu.br',
    professor: 'helena@rededeensino.edu.br',
    gestor: 'paulo@rededeensino.edu.br',
    supervisor: 'camila@rededeensino.edu.br',
  })) {
    const r = await inj('POST', '/api/auth/login', { body: { email, senha: 'demo123' } });
    assert.equal(r.statusCode, 200, `login ${perfil}`);
    tok[perfil] = r.json().token;
  }
  const prof = await app.prisma.professor.findFirst({ where: { usuario: { email: 'helena@rededeensino.edu.br' } } });
  const turmaIds = JSON.parse(prof.turmaIds || '[]');
  assert.ok(turmaIds.length >= 2, 'professora demo precisa de 2 turmas (Meus alunos com várias turmas)');
  qa.minhasTurmas = turmaIds;
  qa.compProf = prof.compId;
  qa.turmaId = turmaIds[0];
  qa.alunos = (await app.prisma.aluno.findMany({ where: soAlunosVisiveis({ turmaId: qa.turmaId }), select: { id: true } })).map(a => a.id);
  assert.ok(qa.alunos.length >= 2, 'turma precisa de >= 2 alunos');
  qa.alunoTurma2 = await app.prisma.aluno.findFirst({ where: soAlunosVisiveis({ turmaId: turmaIds[1] }), select: { id: true } });
  const alheia = await app.prisma.turma.findFirst({
    where: soTurmasVisiveis({ id: { notIn: turmaIds }, alunos: { some: alunoVisivel() } }),
    select: { id: true, alunos: { where: alunoVisivel(), take: 1, select: { id: true } } },
  });
  qa.turmaAlheia = alheia.id;
  qa.alunoAlheio = alheia.alunos[0].id;

  // planejamento QA de toda a rede, todas as séries — direcionado à professora (componente lp)
  const r = await inj('POST', '/api/planejamentos', {
    token: tok.secretaria,
    body: { titulo: 'QA Status derivado', periodo: 'm06', anos: [], grupos: [], habilidades: [HAB_QA] },
  });
  assert.equal(r.statusCode, 201, 'cria planejamento QA');
  qa.planoId = r.json().id;
});

after(async () => {
  if (app) {
    const dataQA = parseBR(DATA_QA);
    // eventos QA (cascata remove as avaliações) → planos QA → timeline QA
    if (qa.eventosExtras.length) await app.prisma.acompanhamentoEvento.deleteMany({ where: { id: { in: qa.eventosExtras } } });
    for (const id of [qa.planoId, ...qa.planosExtras].filter(Boolean)) {
      await app.prisma.acompanhamentoEvento.deleteMany({ where: { planejamentoId: id } });
      await app.prisma.avaliacao.deleteMany({ where: { planejamentoId: id } });
      await app.prisma.planejamento.deleteMany({ where: { id } });
    }
    await app.prisma.timelineEvent.deleteMany({ where: { tipo: 'avaliacao', habCod: { in: qa.habsTimeline }, data: dataQA } });
    await app.close();
  }
});

const trabalhoQA = async token => {
  const r = await get('/api/planejamentos/' + qa.planoId, token);
  assert.equal(r.statusCode, 200);
  return r.json();
};

test('detalhe do plano: o status vem da verificação contínua — pendente → andamento → trabalhada', async () => {
  let d = await trabalhoQA(tok.professor);
  assert.equal(d.trabalho[HAB_QA].status, 'pendente');
  assert.equal(d.trabalho[HAB_QA].proxima, undefined, 'não há mais próxima atividade manual');
  assert.deepEqual(d.progresso, { total: 1, trabalhadas: 0, andamento: 0, pendentes: 1 });

  // evento parcial (1 aluno) → andamento
  const [primeiro, ...resto] = qa.alunos;
  const r1 = await inj('POST', '/api/avaliacoes/lote', {
    token: tok.professor,
    body: { planejamentoId: qa.planoId, habCod: HAB_QA, turmaId: qa.turmaId, data: DATA_QA, novo: true, marks: { [primeiro]: 2 } },
  });
  assert.equal(r1.statusCode, 201);
  qa.eventoId = r1.json().eventoId;
  d = await trabalhoQA(tok.professor);
  assert.equal(d.trabalho[HAB_QA].status, 'andamento');
  assert.equal(d.trabalho[HAB_QA].eventos, 1);
  assert.equal(d.trabalho[HAB_QA].eventosCompletos, 0);
  assert.equal(d.progresso.andamento, 1);
  let ev = (await get('/api/avaliacoes/eventos?turma=' + qa.turmaId, tok.professor)).json().find(e => e.id === qa.eventoId);
  assert.equal(ev.completo, false);
  assert.equal(ev.totalAlunos, qa.alunos.length);

  // completa o MESMO evento com os demais alunos → trabalhada
  const r2 = await inj('POST', '/api/avaliacoes/lote', {
    token: tok.professor,
    body: { planejamentoId: qa.planoId, habCod: HAB_QA, turmaId: qa.turmaId, data: DATA_QA, eventoId: qa.eventoId,
      marks: Object.fromEntries(resto.map((id, i) => [id, i % 2 ? 1 : 2])) },
  });
  assert.equal(r2.statusCode, 201);
  d = await trabalhoQA(tok.professor);
  const t = d.trabalho[HAB_QA];
  assert.equal(t.status, 'trabalhada');
  assert.equal(t.avaliacoes, 1, 'um evento = uma verificação');
  assert.equal(t.eventosCompletos, 1);
  assert.equal(t.avaliados, qa.alunos.length);
  assert.equal(t.ultima, DATA_QA);
  assert.deepEqual(d.progresso, { total: 1, trabalhadas: 1, andamento: 0, pendentes: 0 });
  ev = (await get('/api/avaliacoes/eventos?turma=' + qa.turmaId, tok.professor)).json().find(e => e.id === qa.eventoId);
  assert.equal(ev.completo, true);

  // a lista de planos usa a mesma regra
  const lista = (await get('/api/planejamentos', tok.professor)).json();
  assert.deepEqual(lista.find(pl => pl.id === qa.planoId).progresso, d.progresso);
});

test('recorte das turmas: secretaria (rede) e gestor/supervisor da escola veem o mesmo evento completo', async () => {
  for (const perfil of ['secretaria', 'gestor', 'supervisor']) {
    const d = await trabalhoQA(tok[perfil]);
    assert.equal(d.trabalho[HAB_QA].status, 'trabalhada', `${perfil} vê a habilidade trabalhada`);
  }
});

test('TrabalhoHabilidade.status manual não é mais gravado nem lido; a rota PATCH foi removida', async () => {
  const linha = await app.prisma.trabalhoHabilidade.findUnique({
    where: { planejamentoId_habCod: { planejamentoId: qa.planoId, habCod: HAB_QA } }, select: { status: true, ultima: true },
  });
  assert.deepEqual(linha, { status: 'pendente', ultima: null }, 'o lote não grava mais status/última na tabela legada');
  const r = await inj('PATCH', `/api/planejamentos/${qa.planoId}/trabalho/${HAB_QA}`, { token: tok.professor, body: { status: 'trabalhada' } });
  assert.equal(r.statusCode, 404);
});

test('dados reais da professora: o detalhe de cada plano bate com a regra recalculada do banco', async () => {
  const planos = (await get('/api/planejamentos', tok.professor)).json().filter(pl => pl.id !== qa.planoId);
  const prof = await app.prisma.professor.findFirst({ where: { usuario: { email: 'helena@rededeensino.edu.br' } } });
  const minhas = JSON.parse(prof.turmaIds || '[]');
  for (const pl of planos) {
    const d = (await get('/api/planejamentos/' + pl.id, tok.professor)).json();
    for (const cod of pl.habilidades) {
      const eventos = await app.prisma.acompanhamentoEvento.findMany({
        where: { planejamentoId: pl.id, habCod: cod, turmaId: { in: minhas } },
        include: { avaliacoes: { select: { alunoId: true } } },
      });
      let completos = 0;
      for (const e of eventos) {
        const alunos = await app.prisma.aluno.findMany({ where: soAlunosVisiveis({ turmaId: e.turmaId }), select: { id: true } });
        const analisados = new Set(e.avaliacoes.map(a => a.alunoId));
        if (alunos.length && alunos.every(a => analisados.has(a.id))) completos += 1;
      }
      const temAvaliacao = eventos.some(e => e.avaliacoes.length) || (await app.prisma.avaliacao.count({
        where: { planejamentoId: pl.id, habCod: cod, eventoId: null, aluno: { turmaId: { in: minhas } } },
      })) > 0;
      const esperado = completos ? 'trabalhada' : temAvaliacao ? 'andamento' : 'pendente';
      assert.equal(d.trabalho[cod].status, esperado, `${pl.titulo} · ${cod}`);
    }
  }
});

test('escopo do professor: turma alheia → 403 (roster, avaliações, eventos e registro)', async () => {
  for (const url of [`/api/turmas/${qa.turmaAlheia}/full`, `/api/avaliacoes/turma/${qa.turmaAlheia}`, `/api/avaliacoes/eventos?turma=${qa.turmaAlheia}`]) {
    const r = await get(url, tok.professor);
    assert.equal(r.statusCode, 403, `${url} deveria ser 403 para a professora`);
    assert.match(r.json().error.message, /turmas em que você leciona/);
    assert.equal((await get(url, tok.secretaria)).statusCode, 200, 'secretaria vê a rede toda');
  }
  for (const url of [`/api/turmas/${qa.turmaId}/full`, `/api/avaliacoes/turma/${qa.turmaId}`, `/api/avaliacoes/eventos?turma=${qa.turmaId}`]) {
    assert.equal((await get(url, tok.professor)).statusCode, 200, `${url} (turma da professora)`);
  }
  const antes = await app.prisma.acompanhamentoEvento.count({ where: { turmaId: qa.turmaAlheia } });
  const r = await inj('POST', '/api/avaliacoes/lote', {
    token: tok.professor,
    body: { planejamentoId: qa.planoId, habCod: HAB_QA, turmaId: qa.turmaAlheia, data: DATA_QA, novo: true, marks: { [qa.alunoAlheio]: 2 } },
  });
  assert.equal(r.statusCode, 403, 'não registra verificação em turma alheia');
  assert.equal(await app.prisma.acompanhamentoEvento.count({ where: { turmaId: qa.turmaAlheia } }), antes, 'nada gravado');
});

test('ficha do aluno sob demanda: aluno da 2ª turma da professora traz a turma real', async () => {
  const id = qa.alunoTurma2.id;
  const r = await get(`/api/alunos/${id}/full`, tok.professor);
  assert.equal(r.statusCode, 200);
  const a = r.json();
  const turma = await app.prisma.turma.findUnique({ where: { id: a.turma }, include: { escola: true } });
  assert.equal(a.turmaNome, turma.nome);
  assert.equal(a.escolaNome, turma.escola.nome);
  assert.equal(a.turno, turma.turno);
  assert.equal(a.nivelLeitura, undefined, 'sem nível de leitura');
  assert.equal((await get('/api/avaliacoes?alunoId=' + id, tok.professor)).statusCode, 200);
  // gestor escolar e supervisor das escolas vinculadas também abrem a ficha
  for (const perfil of ['gestor', 'supervisor']) {
    assert.equal((await get(`/api/alunos/${id}/full`, tok[perfil])).statusCode, 200, `${perfil} abre a ficha`);
  }
});

/* ---------- escopo do professor em GET /alunos ---------- */

test('GET /alunos: professor só lista alunos das turmas em que leciona; turma alheia → 403', async () => {
  const total = await app.prisma.aluno.count({ where: soAlunosVisiveis({ turmaId: { in: qa.minhasTurmas } }) });
  const r = await get('/api/alunos?limit=1000', tok.professor);
  assert.equal(r.statusCode, 200);
  assert.equal(r.json().total, total, 'só os alunos das turmas da professora, nunca a rede');
  assert.ok(r.json().alunos.every(a => qa.minhasTurmas.includes(a.turma)));

  const propria = await get('/api/alunos?turma=' + qa.turmaId, tok.professor);
  assert.equal(propria.statusCode, 200);
  assert.equal(propria.json().total, qa.alunos.length);
  assert.ok(propria.json().alunos.every(a => a.turma === qa.turmaId));

  const alheia = await get('/api/alunos?turma=' + qa.turmaAlheia, tok.professor);
  assert.equal(alheia.statusCode, 403);
  assert.match(alheia.json().error.message, /turmas em que você leciona/);
  const busca = await get('/api/alunos?busca=a&limit=1000', tok.professor);
  assert.ok(busca.json().alunos.every(a => qa.minhasTurmas.includes(a.turma)), 'a busca também respeita o escopo');

  // secretaria segue com a rede toda
  const rede = await get('/api/alunos?turma=' + qa.turmaAlheia, tok.secretaria);
  assert.equal(rede.statusCode, 200);
  assert.ok(rede.json().total > 0);
});

/* ---------- regras do lote (POST /avaliacoes/lote) ---------- */

/** Planejamento QA extra da rede toda (removido no after). */
const criarPlanoExtra = async (titulo, habCod) => {
  const r = await inj('POST', '/api/planejamentos', {
    token: tok.secretaria, body: { titulo, periodo: 'm06', anos: [], grupos: [], habilidades: [habCod] },
  });
  assert.equal(r.statusCode, 201, 'cria ' + titulo);
  qa.planosExtras.push(r.json().id);
  return r.json().id;
};
const lote = body => inj('POST', '/api/avaliacoes/lote', { token: tok.professor, body: { habCod: HAB_QA, data: DATA_QA, ...body } });

test('lote: sem turma avaliada → 400, nada gravado', async () => {
  const antes = await app.prisma.acompanhamentoEvento.count();
  const r = await lote({ planejamentoId: qa.planoId, novo: true, marks: { [qa.alunos[0]]: 2 } });
  assert.equal(r.statusCode, 400);
  assert.match(r.json().error.message, /Informe a turma avaliada/);
  assert.equal(await app.prisma.acompanhamentoEvento.count(), antes);
});

test('lote: plano não direcionado ao componente da professora → 403, nada gravado', async () => {
  const habOutra = await app.prisma.habilidade.findFirst({ where: { compId: { not: qa.compProf } }, orderBy: { cod: 'asc' } });
  assert.ok(habOutra, 'precisa de uma habilidade de outro componente');
  qa.habsTimeline.push(habOutra.cod);
  const planoAlheio = await criarPlanoExtra('QA Status não direcionado', habOutra.cod);
  assert.equal((await get('/api/planejamentos/' + planoAlheio, tok.professor)).statusCode, 403, 'o detalhe já barrava');
  const r = await lote({ planejamentoId: planoAlheio, habCod: habOutra.cod, turmaId: qa.turmaId, novo: true, marks: { [qa.alunos[0]]: 2 } });
  assert.equal(r.statusCode, 403);
  assert.equal(await app.prisma.acompanhamentoEvento.count({ where: { planejamentoId: planoAlheio } }), 0);
});

test('lote: evento de outro planejamento (mesma habilidade) não é transferido → 400', async () => {
  const planoB = await criarPlanoExtra('QA Status plano B', HAB_QA);
  // evento parcial no plano A
  const r1 = await lote({ planejamentoId: qa.planoId, turmaId: qa.turmaId, novo: true, marks: { [qa.alunos[0]]: 2 } });
  assert.equal(r1.statusCode, 201);
  const eventoA = r1.json().eventoId;
  // tentar completá-lo pelo plano B
  const r2 = await lote({ planejamentoId: planoB, turmaId: qa.turmaId, eventoId: eventoA, marks: { [qa.alunos[1]]: 1 } });
  assert.equal(r2.statusCode, 400);
  assert.match(r2.json().error.message, /outro planejamento/);
  const ev = await app.prisma.acompanhamentoEvento.findUnique({ where: { id: eventoA }, include: { avaliacoes: true } });
  assert.equal(ev.planejamentoId, qa.planoId, 'o evento continua no plano A');
  assert.equal(ev.avaliacoes.length, 1, 'nenhuma avaliação acrescentada');
  // sem eventoId e sem `novo`, o reaproveitamento por data também é do próprio plano
  const r3 = await lote({ planejamentoId: planoB, turmaId: qa.turmaId, marks: { [qa.alunos[1]]: 1 } });
  assert.equal(r3.statusCode, 201);
  assert.notEqual(r3.json().eventoId, eventoA, 'não reaproveita o evento do plano A');
  assert.equal((await app.prisma.acompanhamentoEvento.findUnique({ where: { id: r3.json().eventoId } })).planejamentoId, planoB);
  // completar pelo próprio plano segue funcionando, sem trocar o plano
  const r4 = await lote({ planejamentoId: qa.planoId, turmaId: qa.turmaId, eventoId: eventoA, marks: { [qa.alunos[1]]: 1 } });
  assert.equal(r4.statusCode, 201);
  assert.equal((await app.prisma.acompanhamentoEvento.findUnique({ where: { id: eventoA } })).planejamentoId, qa.planoId);
});

test('eventos: órfãos (plano excluído) e vazios ficam fora; DELETE do plano limpa os eventos dele', async () => {
  const planoB = qa.planosExtras[qa.planosExtras.length - 1];
  const dataQA = parseBR(DATA_QA);
  const orfao = await app.prisma.acompanhamentoEvento.create({
    data: {
      turmaId: qa.turmaId, habCod: HAB_QA, planejamentoId: 'qa-plano-excluido', data: dataQA,
      avaliacoes: { create: [{ alunoId: qa.alunos[0], habCod: HAB_QA, planejamentoId: 'qa-plano-excluido', data: dataQA, resultado: 2 }] },
    },
  });
  const vazio = await app.prisma.acompanhamentoEvento.create({
    data: { turmaId: qa.turmaId, habCod: HAB_QA, planejamentoId: qa.planoId, data: dataQA },
  });
  qa.eventosExtras.push(orfao.id, vazio.id);

  const ids = (await get('/api/avaliacoes/eventos?turma=' + qa.turmaId, tok.professor)).json().map(e => e.id);
  assert.ok(!ids.includes(orfao.id), 'evento de plano excluído não aparece');
  assert.ok(!ids.includes(vazio.id), 'evento sem avaliação não aparece');
  assert.ok(ids.includes(qa.eventoId), 'eventos válidos continuam');

  const doA = await app.prisma.acompanhamentoEvento.count({ where: { planejamentoId: qa.planoId } });
  assert.ok(await app.prisma.acompanhamentoEvento.count({ where: { planejamentoId: planoB } }) > 0);
  assert.equal((await inj('DELETE', '/api/planejamentos/' + planoB, { token: tok.secretaria })).statusCode, 200);
  assert.equal(await app.prisma.acompanhamentoEvento.count({ where: { planejamentoId: planoB } }), 0, 'sem eventos órfãos do plano excluído');
  assert.equal(await app.prisma.acompanhamentoEvento.count({ where: { planejamentoId: qa.planoId } }), doA, 'eventos de outro plano intactos');
});
