/* ============================================================
   Agregações pedagógicas — espelham as funções de network.js
   (dist[6], alfInicial) computadas no servidor via groupBy.
   ============================================================ */

/** Distribuição de níveis [n1..n6] a partir de linhas groupBy({nivelLeitura, _count}) */
export function distFromGroupBy(rows) {
  const dist = [0, 0, 0, 0, 0, 0];
  for (const r of rows) {
    if (r.nivelLeitura >= 1 && r.nivelLeitura <= 6) dist[r.nivelLeitura - 1] += r._count._all;
  }
  return dist;
}

/** Distribuição de níveis a partir de uma lista de alunos */
export function distFromAlunos(alunos) {
  const dist = [0, 0, 0, 0, 0, 0];
  for (const a of alunos) {
    if (a.nivelLeitura >= 1 && a.nivelLeitura <= 6) dist[a.nivelLeitura - 1]++;
  }
  return dist;
}

/**
 * % de alfabetização nos anos iniciais: alunos de turmas de 1º–3º ano
 * com nivelLeitura >= 4 (lê frases ou textos). Regra de network.js.
 */
export function alfInicialFromAlunos(alunos /* [{nivelLeitura, ano}] */) {
  let alfT = 0, alfA = 0;
  for (const a of alunos) {
    if (a.ano <= 3) { alfT++; if (a.nivelLeitura >= 4) alfA++; }
  }
  return alfT ? Math.round((alfA / alfT) * 100) : 0;
}

/** Progresso de um planejamento a partir dos TrabalhoHabilidade */
export function progressoPlano(trabalhos) {
  const total = trabalhos.length;
  const trabalhadas = trabalhos.filter(t => t.status === 'trabalhada').length;
  const andamento = trabalhos.filter(t => t.status === 'andamento').length;
  const pendentes = total - trabalhadas - andamento;
  return { total, trabalhadas, andamento, pendentes };
}

/**
 * Monta o detalhe de uma escola no shape de network.js buildEscola():
 * { ...escola, anos, turmas:[{id, escola, ano, nome, turno, alunos}], dist,
 *   totAlunos, totTurmas, alfInicial, professores }
 */
export function shapeEscola(escola, turmas, { incluirAlunos = true } = {}) {
  const dist = [0, 0, 0, 0, 0, 0];
  let totAl = 0, alfA = 0, alfT = 0;
  const anosSet = new Set();
  const turmasOut = turmas.map(t => {
    anosSet.add(t.ano);
    const tdist = [0, 0, 0, 0, 0, 0];
    for (const a of t.alunos) {
      dist[a.nivelLeitura - 1]++; tdist[a.nivelLeitura - 1]++; totAl++;
      if (t.ano <= 3) { alfT++; if (a.nivelLeitura >= 4) alfA++; }
    }
    const base = { id: t.id, escola: escola.id, ano: t.ano, nome: t.nome, turno: t.turno, dist: tdist, totAlunos: t.alunos.length };
    if (incluirAlunos) {
      base.alunos = t.alunos.map(a => ({
        id: a.id, nome: a.nome, numero: a.numero, iniciais: a.iniciais,
        nivelLeitura: a.nivelLeitura, ano: t.ano, turma: t.id,
      }));
    }
    return base;
  });
  return {
    id: escola.id, nome: escola.nome, sigla: escola.sigla, zona: escola.zona,
    bairro: escola.bairro, diretor: escola.diretor, cor: escola.cor,
    professores: escola.qtdProfessores,
    anos: [...anosSet].sort((a, b) => a - b),
    turmas: turmasOut,
    dist, totAlunos: totAl, totTurmas: turmas.length,
    alfInicial: alfT ? Math.round((alfA / alfT) * 100) : 0,
  };
}
