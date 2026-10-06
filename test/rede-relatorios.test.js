/* ============================================================
   Dashboard da rede, detalhe da escola e relatórios reais.
   SOMENTE LEITURA sobre os dados reais (não cria, altera nem
   remove nada). Valida:
     · professores por escola = contagem REAL (distintos com turma
       vinculada: Professor.turmaIds ∩ turmas da escola), coerente
       entre /rede, /escolas e /dashboard/evolucao;
     · nenhuma resposta envia zona nem nível de leitura; região
       presente em todas as escolas;
     · alunos que atingiram/não atingiram pelo último resultado
       (≤ alunos avaliados, soma = alunos avaliados);
     · GET /relatorios/rede e /relatorios/escola/:id: CSV (BOM, ';'),
       conteúdo coerente com /rede e com o detalhe, escopo 401/403/404.

   Execução: node --test test/rede-relatorios.test.js
   ============================================================ */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import 'dotenv/config';
import { buildApp } from '../src/app.js';
import { COLUNAS_REDE, COLUNAS_ESCOLA } from '../src/routes/relatorios.js';
import { ultimoResultadoPorAluno } from '../src/lib/indicadores.js';
import { soEscolasVisiveis, soTurmasVisiveis, soAlunosVisiveis, soAvaliacoesVisiveis } from '../src/lib/ativos.js';

const EMAILS = {
  secretaria: 'beatriz@rededeensino.edu.br',
  supervisor: 'camila@rededeensino.edu.br',
  gestor: 'paulo@rededeensino.edu.br',
  professor: 'helena@rededeensino.edu.br',
};
// chaves que não podem mais aparecer em resposta nenhuma
const PROIBIDAS = new Set(['zona', 'nivelLeitura', 'histNivel', 'dist', 'distTurma', 'distPorTurma', 'alfInicial', 'leituraMedia', 'NIVEIS', 'ultimaAplicacao', 'qtdProfessores']);

let app;
const tok = {};
const users = {};
const get = (url, token) => app.inject({ method: 'GET', url, headers: token ? { authorization: 'Bearer ' + token } : {} });

before(async () => {
  app = await buildApp({ logger: false });
  await app.ready();
  for (const [perfil, email] of Object.entries(EMAILS)) {
    const r = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, senha: 'demo123' } });
    assert.equal(r.statusCode, 200, `login ${perfil}`);
    tok[perfil] = r.json().token;
    users[perfil] = r.json().user;
  }
});
after(async () => { await app.close(); });

/** Todas as chaves de objetos (recursivo) de um JSON. */
function chaves(v, acc = new Set()) {
  if (Array.isArray(v)) v.forEach(x => chaves(x, acc));
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { acc.add(k); chaves(x, acc); }
  return acc;
}
const semProibidas = (json, rotulo) => {
  const achadas = [...chaves(json)].filter(k => PROIBIDAS.has(k));
  assert.deepEqual(achadas, [], `${rotulo} não pode enviar ${achadas.join(', ')}`);
};

/** Professores distintos com turma vinculada, por escola — calculado direto do banco. */
async function professoresReais() {
  const [profs, turmas] = await Promise.all([
    app.prisma.professor.findMany({ select: { id: true, turmaIds: true } }),
    app.prisma.turma.findMany({ where: soTurmasVisiveis(), select: { id: true, escolaId: true } }),
  ]);
  const turmaEscola = new Map(turmas.map(t => [t.id, t.escolaId]));
  const porEscola = new Map();
  const todos = new Set();
  for (const pr of profs) {
    let ids = [];
    try { ids = JSON.parse(pr.turmaIds || '[]'); } catch { ids = []; }
    for (const tid of Array.isArray(ids) ? ids : []) {
      const e = turmaEscola.get(tid);
      if (!e) continue;
      todos.add(pr.id);
      porEscola.set(e, new Set([...(porEscola.get(e) || []), pr.id]));
    }
  }
  return { de: id => (porEscola.get(id) || new Set()).size, total: todos.size };
}

/** Parser CSV mínimo (';', aspas duplicadas, CRLF) para conferir o conteúdo. */
function lerCsv(texto) {
  const linhas = [];
  let campo = '', linha = [], aspas = false;
  for (let i = 0; i < texto.length; i++) {
    const c = texto[i];
    if (aspas) {
      if (c === '"' && texto[i + 1] === '"') { campo += '"'; i++; }
      else if (c === '"') aspas = false;
      else campo += c;
    } else if (c === '"') aspas = true;
    else if (c === ';') { linha.push(campo); campo = ''; }
    else if (c === '\r') continue;
    else if (c === '\n') { linha.push(campo); linhas.push(linha); linha = []; campo = ''; }
    else campo += c;
  }
  if (campo || linha.length) { linha.push(campo); linhas.push(linha); }
  return linhas;
}
const num = s => (s === '' ? null : Number(s));
const checaCsv = r => {
  assert.equal(r.statusCode, 200);
  assert.match(r.headers['content-type'], /^text\/csv; charset=utf-8/);
  assert.match(r.headers['content-disposition'], /^attachment; filename="relatorio-[a-z0-9-]+-\d{4}-\d{2}-\d{2}\.csv"$/);
  assert.deepEqual([...r.rawPayload.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'UTF-8 com BOM');
  return lerCsv(r.rawPayload.subarray(3).toString('utf8'));
};

/* ---------------- professores reais e coerência ---------------- */

test('/rede: professores por escola = contagem real, total distinto, sem zona/leitura, região presente', async () => {
  const r = await get('/api/rede', tok.secretaria);
  assert.equal(r.statusCode, 200);
  const d = r.json();
  semProibidas(d, '/rede');
  const reais = await professoresReais();
  assert.equal(d.professores, reais.total, 'total = professores distintos com turma vinculada');
  assert.equal(d.porEscola.length, d.escolas);
  // só o que está visível: excluídos no SAG ficam fora de toda contagem (lib/ativos.js)
  assert.equal(d.escolas, await app.prisma.escola.count({ where: soEscolasVisiveis() }));
  assert.equal(d.alunos, await app.prisma.aluno.count({ where: soAlunosVisiveis() }));
  assert.equal(d.turmas, await app.prisma.turma.count({ where: soTurmasVisiveis() }));
  assert.equal(d.avaliacoes, await app.prisma.avaliacao.count({ where: soAvaliacoesVisiveis() }), 'avaliações de alunos ocultos não contam');
  for (const e of d.porEscola) {
    assert.equal(typeof e.regiao, 'string', `escola ${e.id} com região (string, '' = não definida)`);
    assert.ok('grupo' in e, `escola ${e.id} com grupo (ou null)`);
    assert.equal(e.professores, reais.de(e.id), `professores reais da escola ${e.id}`);
    assert.ok(e.alunosAvaliados <= e.totAlunos);
    if (e.avaliacoes === 0) assert.equal(e.pctAtingiu, null, 'sem avaliações → % nulo');
  }
  assert.equal(d.porEscola.reduce((s, e) => s + e.totAlunos, 0), d.alunos, 'alunos por escola somam a rede');
  assert.equal(d.porEscola.reduce((s, e) => s + e.avaliacoes, 0), d.avaliacoes, 'avaliações por escola somam a rede');
});

test('/escolas e /escolas/:id: professores reais, sem zona/leitura, roster sem nível de leitura', async () => {
  const reais = await professoresReais();
  const r = await get('/api/escolas', tok.secretaria);
  assert.equal(r.statusCode, 200);
  semProibidas(r.json(), '/escolas');
  for (const e of r.json()) {
    assert.equal(e.professores, reais.de(e.id), `professores reais da escola ${e.id}`);
    assert.equal(typeof e.regiao, 'string');
    for (const t of e.turmas) assert.equal(t.alunos, undefined, 'sem ?detalhe=alunos não traz roster');
  }
  const escolaId = users.gestor.escolaIds[0];
  const rd = await get('/api/escolas/' + escolaId, tok.secretaria);
  assert.equal(rd.statusCode, 200);
  semProibidas(rd.json(), '/escolas/:id');
  assert.equal(rd.json().professores, reais.de(escolaId));
  const comAlunos = rd.json().turmas.find(t => t.totAlunos > 0);
  if (comAlunos) assert.equal(comAlunos.alunos.length, comAlunos.totAlunos, 'roster bate com a contagem');
});

test('evolução (rede) usa a mesma regra de professores do /rede', async () => {
  const [ev, rede] = await Promise.all([get('/api/dashboard/evolucao', tok.secretaria), get('/api/rede', tok.secretaria)]);
  assert.equal(ev.statusCode, 200);
  semProibidas(ev.json(), '/dashboard/evolucao (rede)');
  assert.equal(ev.json().totais.professores, rede.json().professores);
  for (const m of ev.json().meses) assert.equal('leituraMedia' in m, false);
});

/* ---------------- nenhuma resposta com zona / nível de leitura ---------------- */

test('meta, turmas, alunos, grupos e evolução não enviam zona nem nível de leitura', async () => {
  const meta = (await get('/api/meta', tok.secretaria)).json();
  semProibidas(meta, '/meta');
  for (const e of meta.ESCOLAS) {
    assert.equal(typeof e.regiao, 'string', 'ESCOLAS com região');
    assert.equal(typeof e.grupoNome, 'string', 'ESCOLAS com o nome do grupo (busca)');
  }
  const grupos = (await get('/api/grupos', tok.secretaria)).json();
  semProibidas(grupos, '/grupos');

  const turmaProf = users.professor.profId
    ? (await get('/api/turmas', tok.professor)).json()[0] : null;
  semProibidas((await get('/api/turmas', tok.professor)).json(), '/turmas');
  if (turmaProf) {
    const full = await get('/api/turmas/' + turmaProf.id + '/full', tok.professor);
    assert.equal(full.statusCode, 200);
    semProibidas(full.json(), '/turmas/:id/full');
    const aluno = full.json().alunos[0];
    if (aluno) {
      const fa = await get('/api/alunos/' + aluno.id + '/full', tok.professor);
      assert.equal(fa.statusCode, 200);
      semProibidas(fa.json(), '/alunos/:id/full');
    }
  }
  const lista = await get('/api/alunos?limit=5', tok.gestor);
  assert.equal(lista.statusCode, 200);
  semProibidas(lista.json(), '/alunos');

  semProibidas((await get('/api/dashboard/evolucao', tok.professor)).json(), '/dashboard/evolucao (professor)');
  const escola = users.gestor.escolaIds[0];
  const drill = (await get('/api/dashboard/evolucao?escola=' + escola, tok.gestor)).json();
  const turma = (drill.turmasDetalhe || []).find(t => t.totAlunos > 0);
  if (turma) {
    const alunos = await get(`/api/dashboard/evolucao?escola=${escola}&turma=${turma.id}`, tok.gestor);
    semProibidas(alunos.json(), '/dashboard/evolucao (drill de alunos)');
    assert.ok(alunos.json().alunos.length > 0);
  }
});

test('/alunos não aceita mais o filtro de nível de leitura (?nivel= é ignorado)', async () => {
  const [sem, com] = await Promise.all([
    get('/api/alunos?limit=1', tok.gestor), get('/api/alunos?limit=1&nivel=3', tok.gestor),
  ]);
  assert.equal(sem.statusCode, 200);
  assert.equal(com.statusCode, 200);
  assert.equal(com.json().total, sem.json().total, 'mesmo total com e sem ?nivel=');
});

/* ---------------- atingiu × não atingiu por aluno ---------------- */

test('detalhe da escola: alunos que atingiram/não atingiram pelo último resultado (≤ avaliados)', async () => {
  const escola = users.gestor.escolaIds[0];
  for (const perfil of ['secretaria', 'gestor']) {
    const r = await get('/api/dashboard/evolucao?escola=' + escola, tok[perfil]);
    assert.equal(r.statusCode, 200);
    const turmas = r.json().turmasDetalhe;
    assert.ok(Array.isArray(turmas), `${perfil}: drill de turmas`);
    for (const t of turmas) {
      assert.ok(t.alunosAtingiram <= t.alunosAvaliados, 'atingiram ≤ avaliados');
      assert.equal(t.alunosAtingiram + t.alunosNaoAtingiram, t.alunosAvaliados, 'atingiram + não atingiram = avaliados');
      assert.ok(t.alunosAvaliados <= t.totAlunos);
    }
  }
  // confere com o banco: último resultado de cada aluno da turma mais avaliada
  const r = (await get('/api/dashboard/evolucao?escola=' + escola, tok.secretaria)).json();
  const alvo = [...r.turmasDetalhe].sort((a, b) => b.avaliacoes - a.avaliacoes)[0];
  if (alvo && alvo.avaliacoes > 0) {
    const avs = await app.prisma.avaliacao.findMany({
      where: soAvaliacoesVisiveis({ aluno: { turmaId: alvo.id } }), select: { id: true, alunoId: true, data: true, resultado: true },
    });
    const ultimo = ultimoResultadoPorAluno(avs);
    assert.equal(alvo.alunosAvaliados, ultimo.size);
    assert.equal(alvo.alunosAtingiram, [...ultimo.values()].filter(v => v === 2).length);
  }
});

/* ---------------- relatórios ---------------- */

test('relatório da rede: escopo (401/403) só admin/secretaria', async () => {
  assert.equal((await get('/api/relatorios/rede')).statusCode, 401);
  for (const perfil of ['supervisor', 'gestor', 'professor']) {
    assert.equal((await get('/api/relatorios/rede', tok[perfil])).statusCode, 403, `${perfil} → 403`);
  }
});

test('relatório da rede: CSV com uma linha por escola + total, coerente com /rede', async () => {
  const [rc, rr] = await Promise.all([get('/api/relatorios/rede', tok.secretaria), get('/api/rede', tok.secretaria)]);
  const linhas = checaCsv(rc);
  const rede = rr.json();
  assert.deepEqual(linhas[0], COLUNAS_REDE, 'cabeçalho');
  const corpo = linhas.slice(1, -1);
  const total = linhas[linhas.length - 1];
  assert.equal(corpo.length, rede.escolas, 'uma linha por escola');
  // mesma fonte e mesma ordem (nome, depois id — há escolas homônimas): compara linha a linha
  for (const [i, [nome, regiao, grupo, turmas, alunos, profs, avs, avaliados, pct]] of corpo.entries()) {
    const e = rede.porEscola[i];
    assert.equal(nome, e.nome, `linha ${i + 1} do CSV = escola ${e.id} do /rede`);
    assert.equal(regiao, e.regiao || 'Região não definida');
    assert.equal(grupo, e.grupo ? e.grupo.nome : 'Sem grupo');
    assert.deepEqual([num(turmas), num(alunos), num(profs), num(avs), num(avaliados), num(pct)],
      [e.totTurmas, e.totAlunos, e.professores, e.avaliacoes, e.alunosAvaliados, e.pctAtingiu], `números de ${nome}`);
  }
  assert.equal(total[0], 'Total da rede');
  assert.deepEqual(total.slice(3).map(num),
    [rede.turmas, rede.alunos, rede.professores, rede.avaliacoes, rede.alunosAvaliados, rede.pctAtingiu]);
});

test('relatório da escola: escopo — rede e escolas vinculadas sim; fora do escopo/professor 403; inexistente 404', async () => {
  const escola = users.gestor.escolaIds[0];
  assert.equal((await get('/api/relatorios/escola/' + escola)).statusCode, 401);
  for (const perfil of ['secretaria', 'supervisor', 'gestor']) {
    const alvo = perfil === 'supervisor' ? users.supervisor.escolaIds[0] : escola;
    assert.equal((await get('/api/relatorios/escola/' + alvo, tok[perfil])).statusCode, 200, `${perfil} → 200`);
  }
  assert.equal((await get('/api/relatorios/escola/' + escola, tok.professor)).statusCode, 403, 'professor → 403');
  const fora = await app.prisma.escola.findFirst({
    where: soEscolasVisiveis({ id: { notIn: [...users.supervisor.escolaIds, ...users.gestor.escolaIds] } }), select: { id: true },
  });
  assert.ok(fora, 'precisa de uma escola fora do escopo');
  assert.equal((await get('/api/relatorios/escola/' + fora.id, tok.supervisor)).statusCode, 403, 'supervisor fora do escopo');
  assert.equal((await get('/api/relatorios/escola/' + fora.id, tok.gestor)).statusCode, 403, 'gestor fora do escopo');
  assert.equal((await get('/api/relatorios/escola/__nao_existe__', tok.secretaria)).statusCode, 404);
});

test('relatório da escola: uma linha por turma + total, coerente com o detalhe e a evolução', async () => {
  const escola = users.gestor.escolaIds[0];
  const [rc, rd, rev] = await Promise.all([
    get('/api/relatorios/escola/' + escola, tok.secretaria),
    get('/api/escolas/' + escola, tok.secretaria),
    get('/api/dashboard/evolucao?escola=' + escola, tok.secretaria),
  ]);
  const linhas = checaCsv(rc);
  assert.match(rc.headers['content-disposition'], /relatorio-escola-[a-z0-9-]+-\d{4}-\d{2}-\d{2}\.csv/);
  assert.deepEqual(linhas[0], COLUNAS_ESCOLA, 'cabeçalho');
  const corpo = linhas.slice(1, -1);
  const total = linhas[linhas.length - 1];
  const detalhe = rd.json();
  assert.equal(corpo.length, detalhe.totTurmas, 'uma linha por turma');
  const evo = new Map(rev.json().turmasDetalhe.map(t => [t.id, t]));
  const turmas = new Map(detalhe.turmas.map(t => [t.id, t]));
  let somaAlunos = 0;
  for (const l of corpo) {
    const [, , , alunos, avaliados, pctAplicado, atingiram, naoAtingiram, avs, pct, id] = l;
    const t = turmas.get(id), ev = evo.get(id);
    assert.ok(t && ev, `turma ${id} existe no detalhe e na evolução`);
    assert.equal(num(alunos), t.totAlunos);
    assert.deepEqual([num(avaliados), num(atingiram), num(naoAtingiram), num(avs), num(pct)],
      [ev.alunosAvaliados, ev.alunosAtingiram, ev.alunosNaoAtingiram, ev.avaliacoes, ev.pctAtingiu], `turma ${id}`);
    assert.ok(num(atingiram) <= num(avaliados));
    if (t.totAlunos) assert.equal(num(pctAplicado), Math.round((ev.alunosAvaliados / t.totAlunos) * 100));
    somaAlunos += num(alunos);
  }
  assert.equal(total[0], 'Total da escola');
  assert.equal(num(total[3]), somaAlunos);
  assert.equal(somaAlunos, detalhe.totAlunos);
});
