/* ============================================================
   Professores REAIS — regra única das listas e contagens.

   Um registro de Professor é REAL quando tem
     · pelo menos uma turma EXISTENTE vinculada
       (Professor.turmaIds ∩ Turma), OU
     · uma conta de usuário (Usuario.profId).
   Professor sem turma existente e sem conta (resíduo do seed /
   protótipo, ou cuja turma sumiu do SAG e não tem conta) não
   entra em lista nenhuma: catálogo PROFESSORES do /meta (select
   de vínculo do cadastro de usuário), /professores/resumo.

   Contagens (rede, escola, grupo — dashboard, evolução, relatórios
   e a coluna "Professores" dos componentes curriculares, que filtra
   PROFESSORES por turmaIds no front) contam só professores com turma existente NO
   escopo (lib/indicadores.js, routes/evolucao.js): quem tem só a
   conta não pertence a escola nenhuma, então não entra nelas.

   Turma EXISTENTE = existente E visível: turma excluída no SAG
   (excluidoNoSag, própria ou da escola — lib/ativos.js) é ignorada
   em Professor.turmaIds, como se não existisse.
   ============================================================ */
import { turmasVisiveisEntre } from './ativos.js';

/** Professor.turmaIds (JSON) → array; valor inválido → []. */
export const turmaIdsDe = pr => {
  try {
    const v = JSON.parse(pr?.turmaIds || '[]');
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
};

/**
 * Classifica os professores — função pura (sem banco).
 * @param {{id:string, turmaIds:string, usuario?:{id:string}|null}[]} professores
 * @param {Set<string>} turmasExistentes  ids de turmas que existem
 * @returns {{...pr, turmaIds:string[], temConta:boolean, real:boolean}[]}
 *   turmaIds só com as turmas existentes
 */
export function classificarProfessores(professores, turmasExistentes) {
  return (professores || []).map(pr => {
    const turmaIds = turmaIdsDe(pr).filter(id => turmasExistentes.has(id));
    const temConta = Boolean(pr.usuario);
    return { ...pr, turmaIds, temConta, real: turmaIds.length > 0 || temConta };
  });
}

/** Só os reais (turma existente ou conta), mesma forma de classificarProfessores. */
export const professoresReais = (professores, turmasExistentes) =>
  classificarProfessores(professores, turmasExistentes).filter(pr => pr.real);

/**
 * Lê do banco e devolve só os professores reais, com turmaIds já
 * restritos às turmas existentes e o indicador temConta.
 * Consulta só as turmas referenciadas (não a rede inteira).
 */
export async function listarProfessoresReais(prisma) {
  const professores = await prisma.professor.findMany({
    include: { usuario: { select: { id: true } } },
    orderBy: { nome: 'asc' },
  });
  const referenciadas = [...new Set(professores.flatMap(turmaIdsDe))];
  // turma "existente" = visível: turma excluída no SAG (oculta) não conta nem aparece em turmaIds
  return professoresReais(professores, new Set(await turmasVisiveisEntre(prisma, referenciadas)));
}
