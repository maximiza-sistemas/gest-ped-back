/* ============================================================
   Excluídos no SAG — "ocultar sem apagar" (excluidoNoSag).
   Sobre os dados reais, SOMENTE LEITURA, exceto um Professor QA
   descartável (removido no after). Valida que escolas, turmas e
   alunos excluídos no SAG (o próprio registro ou o pai):
     · continuam no banco (nada apagado; avaliações guardadas);
     · somem de listas, buscas, contagens, /rede, /escolas, /meta,
       /turmas, /alunos, /grupos, /anos, Evolução e CSV;
     · detalhe por id direto → 404 (escola, turma, aluno, avaliações,
       eventos, relatório da escola);
     · Professor.turmaIds que apontam para turma oculta são ignorados;
     · avaliações de alunos ocultos não entram nas contagens.
   Execução: node --test test/sag-excluidos.test.js
   ============================================================ */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import 'dotenv/config';
import { buildApp } from '../src/app.js';
import {
  soEscolasVisiveis, soTurmasVisiveis, soAlunosVisiveis, soAvaliacoesVisiveis,
} from '../src/lib/ativos.js';

const SUF = Date.now().toString(36);
const PROF_QA = `qa-prof-oculto-${SUF}`;

let app;
const tok = {};
const oculto = {}; // { escola, turma, aluno, turmaDeEscolaAtiva, alunoDeTurmaAtiva }
const get = (url, token) => app.inject({ method: 'GET', url, headers: { authorization: 'Bearer ' + token } });

before(async () => {
  app = await buildApp({ logger: false });
  await app.ready();
  for (const [perfil, email] of Object.entries({
    secretaria: 'beatriz@rededeensino.edu.br',
    supervisor: 'camila@rededeensino.edu.br',
    professor: 'helena@rededeensino.edu.br',
  })) {
    const r = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, senha: 'demo123' } });
    assert.equal(r.statusCode, 200, `login ${perfil}`);
    tok[perfil] = r.json().token;
  }
  const p = app.prisma;
  const [escola, turma, aluno, turmaDeEscolaAtiva, alunoDeTurmaAtiva] = await Promise.all([
    p.escola.findFirst({ where: { excluidoNoSag: true }, select: { id: true, nome: true } }),
    p.turma.findFirst({ where: { excluidoNoSag: true }, select: { id: true, escolaId: true } }),
    p.aluno.findFirst({ where: { excluidoNoSag: true }, select: { id: true, nome: true, turmaId: true } }),
    // turma excluída numa escola ATIVA (ex.: sag-100 na sag-18)
    p.turma.findFirst({ where: { excluidoNoSag: true, escola: { excluidoNoSag: false } }, select: { id: true, escolaId: true } }),
    // aluno excluído numa turma ATIVA
    p.aluno.findFirst({ where: { excluidoNoSag: true, turma: { excluidoNoSag: false, escola: { excluidoNoSag: false } } }, select: { id: true, nome: true, turmaId: true } }),
  ]);
  Object.assign(oculto, { escola, turma, aluno, turmaDeEscolaAtiva, alunoDeTurmaAtiva });
});

after(async () => {
  await app.prisma.professor.deleteMany({ where: { id: PROF_QA } });
  await app.close();
});

const precisa = (v, o) => { if (!v) o.skip('sem registro excluído no SAG neste banco'); return Boolean(v); };

test('nada é apagado: os excluídos continuam no espelho (com excluidoNoSag)', async t => {
  if (!precisa(oculto.turma, t)) return;
  const p = app.prisma;
  assert.ok(await p.turma.count({ where: { excluidoNoSag: true } }) > 0);
  // filho de pai excluído também está marcado (a sincronização propaga)
  const turmasEmEscolaOculta = await p.turma.count({ where: { escola: { excluidoNoSag: true }, excluidoNoSag: false } });
  const alunosEmTurmaOculta = await p.aluno.count({ where: { turma: { excluidoNoSag: true }, excluidoNoSag: false } });
  assert.equal(turmasEmEscolaOculta, 0, 'turma de escola excluída também marcada');
  assert.equal(alunosEmTurmaOculta, 0, 'aluno de turma excluída também marcado');
});

test('detalhe por id de entidade oculta → 404', async t => {
  if (!precisa(oculto.escola && oculto.turma && oculto.aluno, t)) return;
  const s = tok.secretaria;
  const urls = [
    `/api/escolas/${oculto.escola.id}`,
    `/api/relatorios/escola/${oculto.escola.id}`,
    `/api/turmas/${oculto.turma.id}/full`,
    `/api/avaliacoes/turma/${oculto.turma.id}`,
    `/api/avaliacoes/eventos?turma=${oculto.turma.id}`,
    `/api/alunos/${oculto.aluno.id}/full`,
    `/api/avaliacoes?alunoId=${oculto.aluno.id}`,
  ];
  for (const url of urls) assert.equal((await get(url, s)).statusCode, 404, url);
  if (oculto.alunoDeTurmaAtiva) {
    assert.equal((await get(`/api/alunos/${oculto.alunoDeTurmaAtiva.id}/full`, s)).statusCode, 404, 'aluno excluído em turma ativa');
  }
  // eventos de acompanhamento de turma oculta também
  const ev = await app.prisma.acompanhamentoEvento.findFirst({ where: { turmaId: oculto.turma.id }, select: { id: true } });
  if (ev) assert.equal((await get(`/api/avaliacoes/evento/${ev.id}`, s)).statusCode, 404);
});

test('/rede, /escolas, /meta, /turmas, /alunos, /grupos, /anos: só visíveis', async t => {
  if (!precisa(oculto.turma, t)) return;
  const p = app.prisma;
  const s = tok.secretaria;
  const [escolas, turmas, alunos, avaliacoes] = await Promise.all([
    p.escola.count({ where: soEscolasVisiveis() }),
    p.turma.count({ where: soTurmasVisiveis() }),
    p.aluno.count({ where: soAlunosVisiveis() }),
    p.avaliacao.count({ where: soAvaliacoesVisiveis() }),
  ]);
  const rede = (await get('/api/rede', s)).json();
  assert.deepEqual([rede.escolas, rede.turmas, rede.alunos, rede.avaliacoes], [escolas, turmas, alunos, avaliacoes]);
  const idsOcultos = new Set((await p.escola.findMany({ where: { excluidoNoSag: true }, select: { id: true } })).map(e => e.id));
  assert.ok(!rede.porEscola.some(e => idsOcultos.has(e.id)), '/rede sem escola oculta');

  const lista = (await get('/api/escolas', s)).json();
  assert.equal(lista.length, escolas);
  assert.equal(lista.reduce((n, e) => n + e.totTurmas, 0), turmas);
  assert.equal(lista.reduce((n, e) => n + e.totAlunos, 0), alunos);

  const meta = (await get('/api/meta', s)).json();
  assert.equal(meta.ESCOLAS.length, escolas);
  assert.ok(!meta.ESCOLAS.some(e => idsOcultos.has(e.id)));

  const ts = (await get('/api/turmas', s)).json();
  assert.equal(ts.length, turmas);
  assert.ok(!ts.some(x => x.id === oculto.turma.id));

  const al = (await get('/api/alunos?limit=1', s)).json();
  assert.equal(al.total, alunos);
  if (oculto.aluno) {
    const busca = (await get(`/api/alunos?limit=200&busca=${encodeURIComponent(oculto.aluno.nome)}`, s)).json();
    assert.ok(!busca.alunos.some(a => a.id === oculto.aluno.id), 'busca não acha aluno oculto');
  }

  const grupos = (await get('/api/grupos', s)).json();
  const nasListas = [...grupos.grupos.flatMap(g => g.escolas), ...grupos.semGrupo];
  assert.equal(nasListas.length, escolas, 'grupos + sem grupo = escolas visíveis');
  assert.ok(!nasListas.some(e => idsOcultos.has(e.id)));

  const anos = (await get('/api/anos', s)).json();
  assert.equal(anos.reduce((n, a) => n + a.turmas, 0) <= turmas, true);

  const evo = (await get('/api/dashboard/evolucao', s)).json();
  assert.deepEqual([evo.totais.escolas, evo.totais.turmas, evo.totais.alunos, evo.totais.avaliacoes], [escolas, turmas, alunos, avaliacoes]);

  const csv = (await get('/api/relatorios/rede', s)).body;
  assert.equal(csv.replace(/^﻿/, '').trim().split(/\r?\n/).length, escolas + 2, 'cabeçalho + uma linha por escola visível + total');
});

test('escola ativa com turma oculta: detalhe, CSV e Evolução sem a turma oculta', async t => {
  if (!precisa(oculto.turmaDeEscolaAtiva, t)) return;
  const { id: turmaId, escolaId } = oculto.turmaDeEscolaAtiva;
  const s = tok.secretaria;
  const det = (await get(`/api/escolas/${escolaId}`, s)).json();
  assert.ok(!det.turmas.some(x => x.id === turmaId));
  assert.equal(det.totTurmas, await app.prisma.turma.count({ where: soTurmasVisiveis({ escolaId }) }));
  const csv = (await get(`/api/relatorios/escola/${escolaId}`, s)).body;
  assert.ok(!csv.includes(`;${turmaId}`), 'CSV da escola sem a turma oculta');
  const evo = (await get(`/api/dashboard/evolucao?escola=${escolaId}`, s)).json();
  assert.ok(!(evo.turmasDetalhe || []).some(x => x.id === turmaId));
  const tl = (await get(`/api/timeline?turma=${turmaId}`, s)).json();
  assert.deepEqual(tl, [], 'timeline da turma oculta fica oculta');
});

test('Professor.turmaIds com turma oculta: ignorada no /meta e no /professores/resumo', async t => {
  if (!precisa(oculto.turmaDeEscolaAtiva, t)) return;
  const visivel = await app.prisma.turma.findFirst({ where: soTurmasVisiveis({ escolaId: oculto.turmaDeEscolaAtiva.escolaId }), select: { id: true } });
  await app.prisma.professor.create({
    data: { id: PROF_QA, nome: 'QA Professor Turma Oculta', compId: 'lp', cor: '#475569', iniciais: 'QA', turmaIds: JSON.stringify([oculto.turmaDeEscolaAtiva.id, visivel.id]) },
  });
  const meta = (await get('/api/meta', tok.secretaria)).json();
  const pr = meta.PROFESSORES.find(x => x.id === PROF_QA);
  assert.deepEqual(pr?.turmaIds, [visivel.id], 'só a turma visível');
  const resumo = (await get('/api/professores/resumo', tok.secretaria)).json().find(x => x.id === PROF_QA);
  assert.deepEqual(resumo.turmas.map(x => x.id), [visivel.id]);

  // só com a turma oculta: deixa de ser professor "real" (fora das listas)
  await app.prisma.professor.update({ where: { id: PROF_QA }, data: { turmaIds: JSON.stringify([oculto.turmaDeEscolaAtiva.id]) } });
  const meta2 = (await get('/api/meta', tok.secretaria)).json();
  assert.ok(!meta2.PROFESSORES.some(x => x.id === PROF_QA));
});

test('supervisor: escopo sem turmas/alunos ocultos; professora sem as turmas antigas', async () => {
  const sup = (await get('/api/turmas', tok.supervisor)).json();
  const ocultas = new Set((await app.prisma.turma.findMany({ where: { NOT: soTurmasVisiveis() }, select: { id: true } })).map(x => x.id));
  assert.ok(!sup.some(x => ocultas.has(x.id)), 'supervisor não vê turma oculta');
  const prof = (await get('/api/turmas', tok.professor)).json();
  assert.ok(prof.length > 0 && !prof.some(x => ocultas.has(x.id)), 'professora só com turmas visíveis');
  const evo = (await get('/api/dashboard/evolucao', tok.professor)).json();
  assert.ok(evo.filtros.turmas.every(x => !ocultas.has(x.id)));
});
