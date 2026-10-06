/* ============================================================
   Agregações pedagógicas — progresso de planejamento e o shape
   do detalhe de escola. O nível de leitura foi retirado da
   plataforma: nenhuma agregação por nível é calculada/enviada.
   ============================================================ */

/**
 * Progresso de um planejamento a partir do acompanhamento DERIVADO de cada
 * habilidade (lib/acompanhamento.js) — nunca de TrabalhoHabilidade.status.
 * @param {{status:string}[]} trabalhos
 */
export function progressoPlano(trabalhos) {
  const total = trabalhos.length;
  const trabalhadas = trabalhos.filter(t => t.status === 'trabalhada').length;
  const andamento = trabalhos.filter(t => t.status === 'andamento').length;
  const pendentes = total - trabalhadas - andamento;
  return { total, trabalhadas, andamento, pendentes };
}

/** Nº de alunos de uma turma vinda com `alunos` (roster) ou com `_count.alunos`. */
const alunosDaTurma = t => (Array.isArray(t.alunos) ? t.alunos.length : (t._count?.alunos ?? 0));

/**
 * Monta o detalhe de uma escola:
 * { id, nome, sigla, regiao, grupo, bairro, diretor, cor, professores,
 *   anos, turmas:[{id, escola, ano, nome, turno, totAlunos, alunos?}], totAlunos, totTurmas }
 * @param {object} escola  Escola (com `grupo` opcional)
 * @param {object[]} turmas  turmas com `alunos` (roster) ou `_count.alunos`
 * @param {{ incluirAlunos?: boolean, professores?: number }} [opts]
 *   professores = professores distintos com turma vinculada na escola (lib/indicadores.js)
 */
export function shapeEscola(escola, turmas, { incluirAlunos = true, professores = 0 } = {}) {
  const anosSet = new Set(turmas.map(t => t.ano));
  const turmasOut = turmas.map(t => {
    const base = { id: t.id, escola: escola.id, ano: t.ano, nome: t.nome, turno: t.turno, totAlunos: alunosDaTurma(t) };
    if (!incluirAlunos || !Array.isArray(t.alunos)) return base;
    return {
      ...base,
      alunos: t.alunos.map(a => ({ id: a.id, nome: a.nome, numero: a.numero, iniciais: a.iniciais, ano: t.ano, turma: t.id })),
    };
  });
  return {
    id: escola.id, nome: escola.nome, sigla: escola.sigla,
    // localização = região do SAG ('' = não definida) + grupo de escolas da plataforma
    regiao: escola.regiao || '',
    grupo: escola.grupo ? { id: escola.grupo.id, nome: escola.grupo.nome, cor: escola.grupo.cor } : null,
    // bairro/diretor só têm valor quando informados (a tela omite os vazios)
    bairro: escola.bairro || '', diretor: escola.diretor || '', cor: escola.cor,
    professores,
    anos: [...anosSet].sort((a, b) => a - b),
    turmas: turmasOut,
    totAlunos: turmasOut.reduce((s, t) => s + t.totAlunos, 0),
    totTurmas: turmas.length,
  };
}
