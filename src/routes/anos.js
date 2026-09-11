/* ============================================================
   Anos escolares (séries) — catálogo configurável da rede.
   Persistido na tabela Config (chave "anosEscolares": JSON
   [{ ordem, nome }]). Admin e Secretaria gerenciam (superusuários).
   O `ordem` é o valor inteiro referenciado em Turma.ano e em
   Planejamento/Orientacao.anos; o `nome` é o rótulo exibido.
   ============================================================ */
const CHAVE = 'anosEscolares';
export const DEFAULT_ANOS = [1, 2, 3, 4, 5].map(n => ({ ordem: n, nome: n + 'º ano' }));

const parseJSON = (s, fb) => { try { return JSON.parse(s); } catch { return fb; } };
const normaliza = lista => lista
  .map(a => ({ ordem: a.ordem, nome: a.nome }))
  .sort((a, b) => a.ordem - b.ordem);

export async function lerAnos(p) {
  const row = await p.config.findUnique({ where: { chave: CHAVE } });
  const arr = row ? parseJSON(row.valor, null) : null;
  return normaliza(Array.isArray(arr) && arr.length ? arr : DEFAULT_ANOS);
}

export default async function anosRoutes(fastify) {
  const p = fastify.prisma;
  // ---------- GET /anos (catálogo + nº de turmas que usam cada ano) ----------
  fastify.get('/anos', { preHandler: [fastify.authenticate] }, async () => {
    const [anos, grupos] = await Promise.all([
      lerAnos(p),
      p.turma.groupBy({ by: ['ano'], _count: { _all: true } }),
    ]);
    const usoBy = Object.fromEntries(grupos.map(g => [g.ano, g._count._all]));
    return anos.map(a => ({ ...a, turmas: usoBy[a.ordem] || 0 }));
  });

  // Sem rotas de escrita: o catálogo de anos escolares é derivado da série das
  // turmas espelhadas do SAG (Config.anosEscolares é mantido pela sincronização).
}
