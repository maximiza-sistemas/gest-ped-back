/* ============================================================
   GET /dashboard/evolucao — dashboard evolutivo por perfil.
   Agrega verificações contínuas (Avaliacao), planejamentos
   direcionados, semanas preenchidas e registros de leitura em
   séries mensais (Periodo m01..m12).

   Escopo derivado do token:
     professor        → suas turmas (detalhe por turma e por aluno)
     supervisor/gestor → suas escolas (detalhe por escola) — escopo 'gestor'
     admin/secretaria → rede toda (detalhe por escola)
   Escopo supervisor/gestor:
     ?escola=<id> acrescenta o detalhe das turmas da escola;
     ?turma=<id> acrescenta o detalhe dos alunos da turma (drill).
   Escopo professor — filtros do painel (recortam TODA a resposta):
     ?turma=<id> uma turma do próprio professor (outra turma → 403);
     ?comp=<id>  componente curricular existente (inexistente → 400);
     a resposta traz `filtros` { turmas, componentes, aplicados }.
   ============================================================ */
import { gestorEscolas, perfilEscolar, planoCasaAnos } from '../lib/escopo.js';
import { fmtBR } from '../lib/datas.js';

const j = s => { try { const v = JSON.parse(s || '[]'); return Array.isArray(v) ? v : []; } catch { return []; } };
const pctDe = (atingiu, n) => (n ? Math.round((atingiu / n) * 100) : null);
const mesDe = d => 'm' + String(new Date(d).getUTCMonth() + 1).padStart(2, '0');

const novoAcc = () => ({ n: 0, atingiu: 0, alunos: new Set(), habs: new Set() });
const soma = (map, chave, av) => {
  let acc = map.get(chave);
  if (!acc) { acc = novoAcc(); map.set(chave, acc); }
  acc.n += 1;
  if (av.resultado === 2) acc.atingiu += 1;
  acc.alunos.add(av.alunoId);
  acc.habs.add(av.habCod);
};
const shapeAcc = acc => ({
  avaliacoes: acc ? acc.n : 0,
  pctAtingiu: acc ? pctDe(acc.atingiu, acc.n) : null,
  alunosAvaliados: acc ? acc.alunos.size : 0,
  habilidades: acc ? acc.habs.size : 0,
});

/** Estatísticas individuais por aluno: totais + série mensal de % + tendência. */
function statsAlunos(roster, avs, meses) {
  const geral = new Map(), porMes = new Map();
  for (const av of avs) {
    soma(geral, av.alunoId, av);
    soma(porMes, av.alunoId + '|' + mesDe(av.data), av);
  }
  return roster.map(a => {
    const g = geral.get(a.id);
    const serie = meses.map(m => {
      const acc = porMes.get(a.id + '|' + m);
      return acc ? pctDe(acc.atingiu, acc.n) : null;
    });
    const comDados = serie.filter(v => v != null);
    return {
      id: a.id, nome: a.nome, numero: a.numero, iniciais: a.iniciais,
      nivelLeitura: a.nivelLeitura, turmaId: a.turmaId,
      avaliacoes: g ? g.n : 0,
      pctAtingiu: g ? pctDe(g.atingiu, g.n) : null,
      serie,
      tendencia: comDados.length >= 2 ? comDados[comDados.length - 1] - comDados[0] : null,
    };
  });
}

/**
 * Lê e valida os filtros do painel do professor (?turma, ?comp).
 * @param {{turma?:string, comp?:string}} query
 * @param {{id:string}[]} turmasProf  todas as turmas do professor
 * @param {{id:string}[]} componentes catálogo de componentes curriculares
 * @returns {{turma:string|null, comp:string|null, proibido?:string, invalido?:string}}
 */
function lerFiltrosProfessor(query, turmasProf, componentes) {
  const turma = query.turma || null;
  const comp = query.comp || null;
  if (turma && !turmasProf.some(t => t.id === turma)) {
    return { turma, comp, proibido: 'Turma fora das suas turmas.' };
  }
  if (comp && !componentes.some(c => c.id === comp)) {
    return { turma, comp, invalido: 'Componente curricular inválido.' };
  }
  return { turma, comp };
}

/**
 * Planejamentos ativos direcionados a um conjunto de turmas/escolas — espelha
 * planosDirecionados() do painel: grupos vazio = toda a rede; no escopo
 * professor exige habilidade do recorte (habDoEscopo) e ano de alguma turma.
 */
function planosDirecionadosA({ planos, escopo, turmas, escolas, habDoEscopo }) {
  const gruposEscopo = new Set(escolas.map(e => e.grupoId).filter(Boolean));
  const anosTurmas = new Set(turmas.map(t => t.ano));
  return planos.filter(pl => {
    const grupos = j(pl.grupos);
    const casaGrupo = escopo === 'rede' || !grupos.length || !turmas.length
      || grupos.some(g => gruposEscopo.has(g));
    const casaComp = escopo !== 'professor' || pl.habilidades.some(h => habDoEscopo(h.habCod));
    // professor: o plano precisa ser direcionado ao ano de alguma turma dele (0 = coringa)
    const casaAno = escopo !== 'professor' || !turmas.length || planoCasaAnos(pl.anos, anosTurmas);
    return casaGrupo && casaComp && casaAno;
  });
}

/**
 * Semanas de planejamento do professor no recorte do painel. A base é SEMPRE a
 * mesma (todas as semanas que ele preencheu, de qualquer status de plano), com
 * ou sem filtro — o filtro só estreita:
 *   ?comp  → semanas de planejamentos com alguma habilidade do componente
 *            (plano sem habilidades: vale o compId do próprio plano);
 *   ?turma → semanas de planejamentos direcionados ao ano da turma
 *            (planoCasaAnos: plano sem anos vale para todas as séries).
 * Semanas não são registradas por turma: com ?turma, uma semana de plano
 * direcionado a vários anos conta em cada turma desses anos.
 * @param {{planejamento:{anos:string, compId:string|null, habilidades:{habCod:string}[]}}[]} semanas
 * @param {{comp:string|null, turma:{ano:number}|null, habComp:Map<string,string>}} recorte
 */
function semanasDoRecorte(semanas, { comp, turma, habComp }) {
  if (!comp && !turma) return semanas;
  const anosTurma = turma ? new Set([turma.ano]) : null;
  const planoDoComp = pl => (pl.habilidades.length
    ? pl.habilidades.some(h => habComp.get(h.habCod) === comp)
    : pl.compId === comp);
  return semanas.filter(({ planejamento: pl }) =>
    (!comp || planoDoComp(pl)) && (!anosTurma || planoCasaAnos(pl.anos, anosTurma)));
}

/**
 * Opções dos filtros do painel do professor, independentes do recorte aplicado:
 * todas as turmas dele e os componentes relevantes (o dele, os das habilidades
 * avaliadas nas turmas dele e os das habilidades direcionadas a ele).
 */
function opcoesFiltrosProfessor({ prof, turmasProf, escolaById, componentes, habComp, habsAvaliadas, planosProf, doComp, recorte }) {
  const ids = new Set([prof.compId]);
  for (const { habCod } of habsAvaliadas) ids.add(habComp.get(habCod));
  for (const pl of planosProf) {
    for (const h of pl.habilidades) if (doComp(h.habCod)) ids.add(habComp.get(h.habCod));
  }
  if (recorte.comp) ids.add(recorte.comp); // o select sempre consegue exibir o filtro aplicado
  const ordem = c => (c.id === prof.compId ? 0 : 1);
  return {
    // escola (sigla) desambigua turmas homônimas de escolas diferentes no select
    turmas: turmasProf.map(t => ({ id: t.id, nome: t.nome, ano: t.ano, escola: (escolaById.get(t.escolaId) || {}).sigla || '' })),
    componentes: componentes
      .filter(c => ids.has(c.id))
      .sort((a, b) => ordem(a) - ordem(b) || a.nome.localeCompare(b.nome, 'pt-BR'))
      .map(c => ({ id: c.id, nome: c.nome })),
    aplicados: { turma: recorte.turma, comp: recorte.comp },
  };
}

export default async function evolucaoRoutes(fastify) {
  const p = fastify.prisma;

  fastify.get('/dashboard/evolucao', {
    preHandler: [fastify.authenticate],
    schema: {
      querystring: {
        type: 'object',
        properties: {
          escola: { type: 'string', maxLength: 100 },
          turma: { type: 'string', maxLength: 100 },
          comp: { type: 'string', maxLength: 100 }, // só no escopo professor
        },
      },
    },
  }, async (request, reply) => {
    const user = request.user;
    // supervisor e gestor escolar compartilham o escopo por escolas; o valor
    // 'gestor' no campo escopo da resposta é mantido (contrato com o frontend).
    const escopo = user.perfil === 'professor' ? 'professor'
      : (perfilEscolar(user.perfil) ? 'gestor' : 'rede');

    // ---------- escopo de turmas ----------
    let prof = null, turmaWhere = {};
    if (escopo === 'professor') {
      if (!user.profId) return reply.badRequest('Usuário não está vinculado a um professor.');
      prof = await p.professor.findUnique({ where: { id: user.profId } });
      if (!prof) return reply.badRequest('Professor não encontrado.');
      turmaWhere = { id: { in: j(prof.turmaIds) } };
    } else if (escopo === 'gestor') {
      turmaWhere = { escolaId: { in: gestorEscolas(user) || [] } };
    }

    const [turmasEscopo, periodos, professores, habCatalogo, planos, componentes] = await Promise.all([
      p.turma.findMany({
        where: turmaWhere,
        select: { id: true, nome: true, ano: true, escolaId: true },
        orderBy: [{ escolaId: 'asc' }, { ano: 'asc' }, { nome: 'asc' }],
      }),
      p.periodo.findMany({ orderBy: { id: 'asc' } }),
      p.professor.findMany({ select: { id: true, nome: true, compId: true, turmaIds: true } }),
      p.habilidade.findMany({ select: { cod: true, compId: true } }),
      p.planejamento.findMany({
        where: { status: 'ativo' },
        select: { id: true, periodoId: true, grupos: true, anos: true, habilidades: { select: { habCod: true } } },
      }),
      p.componente.findMany({ select: { id: true, nome: true }, orderBy: { nome: 'asc' } }),
    ]);

    // ---------- filtros do painel do professor (?turma, ?comp) ----------
    // no escopo professor, ?turma e ?comp recortam TODA a resposta; nos demais
    // escopos ?comp é ignorado e ?turma segue sendo o drill turma→alunos.
    const recorte = escopo === 'professor'
      ? lerFiltrosProfessor(request.query, turmasEscopo, componentes)
      : { turma: null, comp: null };
    if (recorte.proibido) return reply.forbidden(recorte.proibido);
    if (recorte.invalido) return reply.badRequest(recorte.invalido);
    const compQ = recorte.comp;
    const filtrado = Boolean(recorte.turma || recorte.comp);
    const turmas = recorte.turma ? turmasEscopo.filter(t => t.id === recorte.turma) : turmasEscopo;
    if (recorte.turma) turmaWhere = { id: recorte.turma };

    const escolasWhere = escopo === 'rede' ? {}
      : { id: { in: escopo === 'gestor' ? (gestorEscolas(user) || []) : [...new Set(turmasEscopo.map(t => t.escolaId))] } };
    const escolasTodas = await p.escola.findMany({
      where: escolasWhere,
      select: { id: true, nome: true, sigla: true, cor: true, grupoId: true },
      orderBy: { nome: 'asc' },
    });
    // professor com ?turma: só a escola da turma filtrada entra nos totais e no direcionamento
    const escolasDoRecorte = new Set(turmas.map(t => t.escolaId));
    const escolas = escopo === 'professor' ? escolasTodas.filter(e => escolasDoRecorte.has(e.id)) : escolasTodas;

    const [avs, semanasAll, leituras, alunosCount, habsAvaliadas] = await Promise.all([
      p.avaliacao.findMany({
        where: { aluno: { turma: turmaWhere }, ...(compQ ? { habilidade: { compId: compQ } } : {}) },
        select: { data: true, resultado: true, alunoId: true, habCod: true, aluno: { select: { turmaId: true } } },
      }),
      p.planejamentoSemana.findMany({
        where: escopo === 'professor' ? { profId: user.profId } : {},
        select: {
          profId: true,
          // professor: anos/habilidades do plano para o recorte por turma/componente
          planejamento: {
            select: escopo === 'professor'
              ? { periodoId: true, anos: true, compId: true, habilidades: { select: { habCod: true } } }
              : { periodoId: true },
          },
        },
      }),
      p.leituraRegistro.findMany({
        where: { aluno: { turma: turmaWhere } },
        select: { data: true, nivel: true },
      }),
      p.aluno.count({ where: { turma: turmaWhere } }),
      // opções do filtro de componente: habilidades avaliadas em TODAS as turmas do professor
      escopo === 'professor'
        ? p.avaliacao.findMany({
          where: { aluno: { turmaId: { in: turmasEscopo.map(t => t.id) } } },
          distinct: ['habCod'], select: { habCod: true },
        })
        : Promise.resolve([]),
    ]);

    // ---------- mapas de apoio ----------
    const turmaEscola = new Map(turmas.map(t => [t.id, t.escolaId]));
    const turmasSet = new Set(turmas.map(t => t.id));
    const habComp = new Map(habCatalogo.map(h => [h.cod, h.compId]));
    const escolaById = new Map(escolasTodas.map(e => [e.id, e]));

    // professores que lecionam em turmas do escopo (via turmaIds JSON);
    // com ?comp (professor), só os do componente filtrado
    const turmaProfs = new Map();
    const profsEscopo = new Set();
    for (const pr of professores) {
      if (compQ && pr.compId !== compQ) continue;
      for (const tid of j(pr.turmaIds)) {
        if (!turmasSet.has(tid)) continue;
        profsEscopo.add(pr.id);
        if (!turmaProfs.has(tid)) turmaProfs.set(tid, []);
        turmaProfs.get(tid).push(pr);
      }
    }

    // planejamentos direcionados ao escopo; no professor, habilidades do seu
    // componente (doComp) e, com ?comp, só as do componente filtrado
    const doComp = c => !prof || habComp.get(c) === prof.compId;
    const habDoEscopo = c => doComp(c) && (!compQ || habComp.get(c) === compQ);
    const planosEscopo = planosDirecionadosA({ planos, escopo, turmas, escolas, habDoEscopo });
    const direcionadas = new Set(planosEscopo.flatMap(pl => pl.habilidades.map(h => h.habCod).filter(habDoEscopo)));
    // semanas: gestor → professores do escopo; professor → mesma regra com e sem
    // filtro, só estreitada pelo recorte (turma/componente); rede → todas
    const semanas = escopo === 'gestor' ? semanasAll.filter(s => profsEscopo.has(s.profId))
      : escopo === 'professor'
        ? semanasDoRecorte(semanasAll, { comp: compQ, turma: recorte.turma ? turmas[0] : null, habComp })
        : semanasAll;

    // ---------- agregação mensal ----------
    const porMes = new Map(), porEnt = new Map(), porEntMes = new Map(), porHab = new Map();
    const profsAtivosMes = new Map();
    const marcaAtivo = (mes, profId) => {
      if (!profsAtivosMes.has(mes)) profsAtivosMes.set(mes, new Set());
      profsAtivosMes.get(mes).add(profId);
    };
    const entDe = escopo === 'professor'
      ? (av => av.aluno.turmaId)
      : (av => turmaEscola.get(av.aluno.turmaId));

    let atingiuTotal = 0;
    for (const av of avs) {
      if (av.resultado === 2) atingiuTotal += 1;
      const mes = mesDe(av.data);
      soma(porMes, mes, av);
      soma(porHab, av.habCod, av);
      const ent = entDe(av);
      if (ent) { soma(porEnt, ent, av); soma(porEntMes, ent + '|' + mes, av); }
      const comp = habComp.get(av.habCod);
      for (const pr of (turmaProfs.get(av.aluno.turmaId) || [])) {
        if (!comp || pr.compId === comp) marcaAtivo(mes, pr.id);
      }
    }

    const planosMes = new Map();
    for (const pl of planosEscopo) planosMes.set(pl.periodoId, (planosMes.get(pl.periodoId) || 0) + 1);
    const semanasMes = new Map();
    for (const s of semanas) {
      const m = s.planejamento.periodoId;
      semanasMes.set(m, (semanasMes.get(m) || 0) + 1);
      marcaAtivo(m, s.profId);
    }
    const leituraMes = new Map();
    for (const l of leituras) {
      const m = mesDe(l.data);
      const acc = leituraMes.get(m) || { soma: 0, n: 0 };
      acc.soma += l.nivel; acc.n += 1;
      leituraMes.set(m, acc);
    }

    // meses com alguma atividade, na ordem do catálogo de períodos
    const idsAtivos = new Set([...porMes.keys(), ...planosMes.keys(), ...semanasMes.keys(), ...leituraMes.keys()]);
    const meses = periodos.filter(pe => idsAtivos.has(pe.id)).map(pe => pe.id);
    const nomeMes = new Map(periodos.map(pe => [pe.id, pe.nome]));

    const mesesOut = meses.map(m => ({
      id: m, nome: nomeMes.get(m) || m,
      ...shapeAcc(porMes.get(m)),
      planejamentos: planosMes.get(m) || 0,
      semanas: semanasMes.get(m) || 0,
      professoresAtivos: (profsAtivosMes.get(m) || new Set()).size,
      leituraMedia: leituraMes.has(m)
        ? Math.round((leituraMes.get(m).soma / leituraMes.get(m).n) * 10) / 10
        : null,
    }));
    const comAval = mesesOut.filter(m => m.avaliacoes > 0);
    const deltaPct = comAval.length >= 2
      ? comAval[comAval.length - 1].pctAtingiu - comAval[comAval.length - 2].pctAtingiu
      : null;

    // ---------- entidades: turmas (professor) ou escolas (gestor/rede) ----------
    const serieDe = ent => meses.map(m => {
      const acc = porEntMes.get(ent + '|' + m);
      return { mes: m, avaliacoes: acc ? acc.n : 0, pctAtingiu: acc ? pctDe(acc.atingiu, acc.n) : null };
    });
    let entidades;
    if (escopo === 'professor') {
      entidades = turmas.map(t => ({
        id: t.id, nome: t.nome, ano: t.ano,
        sub: (escolaById.get(t.escolaId) || {}).sigla || '',
        cor: null,
        ...shapeAcc(porEnt.get(t.id)),
        serie: serieDe(t.id),
      }));
    } else {
      const base = escopo === 'gestor' ? escolas : escolas.filter(e => porEnt.has(e.id));
      entidades = base.map(e => ({
        id: e.id, nome: e.nome, sub: e.sigla, cor: e.cor,
        ...shapeAcc(porEnt.get(e.id)),
        serie: serieDe(e.id),
      })).sort((a, b) => b.avaliacoes - a.avaliacoes);
    }

    // ---------- ranking de habilidades ----------
    const habsStats = [...porHab.entries()].map(([cod, acc]) => ({
      cod, avaliacoes: acc.n, alunosAvaliados: acc.alunos.size, pctAtingiu: pctDe(acc.atingiu, acc.n),
    }));
    const dificuldades = [...habsStats].sort((a, b) => a.pctAtingiu - b.pctAtingiu || b.avaliacoes - a.avaliacoes).slice(0, 6);
    const destaques = [...habsStats].sort((a, b) => b.pctAtingiu - a.pctAtingiu || b.avaliacoes - a.avaliacoes).slice(0, 6);
    const avaliadasDirecionadas = [...porHab.keys()].filter(c => direcionadas.has(c)).length;

    // ---------- drill: turmas de uma escola (?escola=) ----------
    let turmasDetalhe = null;
    const escolaQ = request.query.escola;
    if (escolaQ && escopo !== 'professor' && escolaById.has(escolaQ)) {
      const tot = await p.aluno.groupBy({
        by: ['turmaId'], where: { turma: { escolaId: escolaQ } }, _count: { _all: true },
      });
      const totMap = new Map(tot.map(r => [r.turmaId, r._count._all]));
      const accT = new Map(), accTM = new Map();
      for (const av of avs) {
        if (turmaEscola.get(av.aluno.turmaId) !== escolaQ) continue;
        soma(accT, av.aluno.turmaId, av);
        soma(accTM, av.aluno.turmaId + '|' + mesDe(av.data), av);
      }
      turmasDetalhe = turmas.filter(t => t.escolaId === escolaQ).map(t => ({
        id: t.id, nome: t.nome, ano: t.ano, totAlunos: totMap.get(t.id) || 0,
        ...shapeAcc(accT.get(t.id)),
        atingiram: (accT.get(t.id) || { atingiu: 0 }).atingiu,
        serie: meses.map(m => {
          const a = accTM.get(t.id + '|' + m);
          return a ? pctDe(a.atingiu, a.n) : null;
        }),
      }));
    }

    // ---------- alunos: roster do professor ou drill de turma (?turma=) ----------
    const selAluno = { id: true, nome: true, numero: true, iniciais: true, nivelLeitura: true, turmaId: true };
    let alunos = null;
    const turmaQ = request.query.turma;
    if (escopo === 'professor') {
      const roster = await p.aluno.findMany({
        where: { turma: turmaWhere }, select: selAluno,
        orderBy: [{ turmaId: 'asc' }, { numero: 'asc' }],
      });
      alunos = statsAlunos(roster, avs, meses);
    } else if (escopo === 'gestor' && turmaQ && turmasSet.has(turmaQ)) {
      // análise individual por turma: supervisor e gestor escolar; o escopo de rede
      // (admin/secretaria) acompanha de forma agregada por escola/turma
      const roster = await p.aluno.findMany({
        where: { turmaId: turmaQ }, select: selAluno, orderBy: { numero: 'asc' },
      });
      alunos = statsAlunos(roster, avs.filter(a => a.aluno.turmaId === turmaQ), meses);
    }

    // eventos de acompanhamento do professor (eixo do gráfico de atingimento):
    // cada evento é um ponto, na ordem em que foi registrado
    let eventosAcomp = null;
    if (escopo === 'professor') {
      const habsDoComp = compQ ? habCatalogo.filter(h => h.compId === compQ).map(h => h.cod) : null;
      const evs = await p.acompanhamentoEvento.findMany({
        where: { turmaId: { in: turmas.map(t => t.id) }, ...(habsDoComp ? { habCod: { in: habsDoComp } } : {}) },
        include: { avaliacoes: { select: { resultado: true } } },
        orderBy: [{ data: 'asc' }, { criadoEm: 'asc' }],
      });
      eventosAcomp = evs.map(e => ({
        id: e.id, habCod: e.habCod, turmaId: e.turmaId, data: fmtBR(e.data),
        avaliados: e.avaliacoes.length,
        atingiram: e.avaliacoes.filter(a => a.resultado === 2).length,
      }));
    }

    // opções dos filtros do painel do professor (independentes do recorte aplicado)
    const filtros = escopo === 'professor'
      ? opcoesFiltrosProfessor({
        prof, turmasProf: turmasEscopo, escolaById, componentes, habComp, habsAvaliadas, recorte, doComp,
        planosProf: filtrado
          ? planosDirecionadosA({ planos, escopo, turmas: turmasEscopo, escolas: escolasTodas, habDoEscopo: doComp })
          : planosEscopo,
      })
      : null;

    const alunosAvaliados = new Set(avs.map(a => a.alunoId)).size;
    return {
      escopo,
      filtros,
      totais: {
        escolas: escolas.length,
        turmas: turmas.length,
        alunos: alunosCount,
        professores: escopo === 'rede' ? professores.length : profsEscopo.size,
        avaliacoes: avs.length,
        alunosAvaliados,
        alunosSemAvaliacao: Math.max(0, alunosCount - alunosAvaliados),
        pctAtingiu: pctDe(atingiuTotal, avs.length),
        deltaPct,
        habilidadesAvaliadas: porHab.size,
        habilidadesDirecionadas: direcionadas.size,
        cobertura: direcionadas.size ? Math.round((avaliadasDirecionadas / direcionadas.size) * 100) : null,
        planejamentosAtivos: planosEscopo.length,
        semanasPreenchidas: semanas.length,
        escolasComAtividade: escopo === 'professor' ? null : porEnt.size,
      },
      meses: mesesOut,
      entidades,
      turmasDetalhe,
      alunos,
      eventosAcomp,
      habilidades: { dificuldades, destaques },
    };
  });
}
