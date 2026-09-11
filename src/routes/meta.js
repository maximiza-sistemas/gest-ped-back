/* ============================================================
   GET /meta — bootstrap: catálogos e dados estáticos que o
   front hidrata no DATA em uma chamada.
   Escopo: gestor recebe somente as suas escolas, os professores
   com turma nessas escolas e nenhuma lista de usuários (que é
   exclusiva de admin/secretaria).
   ============================================================ */
import { fmtBR } from '../lib/datas.js';
import { gestorEscolas } from '../lib/escopo.js';
import { DEFAULT_ANOS } from './anos.js';

const parseJSON = (s, fb) => { try { return JSON.parse(s); } catch { return fb; } };

export default async function metaRoutes(fastify) {
  fastify.get('/meta', { preHandler: [fastify.authenticate] }, async request => {
    const p = fastify.prisma;
    const escopo = gestorEscolas(request.user); // null = alcance de rede / por professor
    const ehRede = ['admin', 'secretaria'].includes(request.user?.perfil);

    const [niveis, componentes, periodos, matrizes, habilidades, professores, usuarios, escolas, configRows, turmasEscopo] =
      await Promise.all([
        p.nivel.findMany({ orderBy: { id: 'asc' } }),
        p.componente.findMany(),
        p.periodo.findMany({ orderBy: { inicio: 'asc' } }),
        p.matriz.findMany(),
        p.habilidade.findMany(),
        p.professor.findMany(),
        ehRede ? p.usuario.findMany({ where: { ativo: true } }) : Promise.resolve([]),
        p.escola.findMany({
          where: escopo ? { id: { in: escopo } } : undefined,
          select: { id: true, nome: true, sigla: true, zona: true, grupoId: true },
          orderBy: { id: 'asc' },
        }),
        p.config.findMany(),
        escopo ? p.turma.findMany({ where: { escolaId: { in: escopo } }, select: { id: true } }) : Promise.resolve(null),
      ]);

    // gestor: só professores que lecionam em turmas das suas escolas
    const turmasSet = turmasEscopo ? new Set(turmasEscopo.map(t => t.id)) : null;
    const professoresVisiveis = professores
      .map(x => ({ id: x.id, nome: x.nome, comp: x.compId, cor: x.cor, iniciais: x.iniciais, turmaIds: parseJSON(x.turmaIds, []) }))
      .filter(x => !turmasSet || x.turmaIds.some(t => turmasSet.has(t)));

    const config = Object.fromEntries(configRows.map(c => [c.chave, c.valor]));
    const anosArr = parseJSON(config.anosEscolares, null);
    const ANOS = (Array.isArray(anosArr) && anosArr.length ? anosArr : DEFAULT_ANOS)
      .map(a => ({ ordem: a.ordem, nome: a.nome })).sort((a, b) => a.ordem - b.ordem);

    return {
      NIVEIS: niveis,
      ANOS,
      COMPONENTES: componentes,
      PERIODOS: periodos.map(x => ({ id: x.id, nome: x.nome, inicio: fmtBR(x.inicio), fim: fmtBR(x.fim), atual: x.atual })),
      MATRIZES: matrizes,
      HABILIDADES: habilidades.map(h => ({
        cod: h.cod, ...(h.rotulo ? { rotulo: h.rotulo } : {}), matriz: h.matrizId, comp: h.compId, desc: h.desc,
      })),
      PROFESSORES: professoresVisiveis,
      ESCOLAS: escolas,
      // sem senhaHash — só admin/secretaria (gestão de contas e switch demo do topbar)
      USUARIOS: usuarios.map(u => ({
        id: u.id, nome: u.nome, email: u.email, perfil: u.perfil, cargo: u.cargo,
        iniciais: u.iniciais, cor: u.cor, escolaIds: parseJSON(u.escolaIds, []),
        ...(u.profId ? { profId: u.profId } : {}),
      })),
      // sem valores inventados: o que não estiver configurado vem vazio (a UI deriva a escola das turmas do usuário)
      ESCOLA: { nome: config.escolaNome || '', rede: config.redeNome || '', ano: config.anoLetivo || String(new Date().getFullYear()) },
      REDE: { municipio: config.municipio, secretaria: config.secretaria, uf: config.uf, ano: config.anoLetivo },
    };
  });
}
