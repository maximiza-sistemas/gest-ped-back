/* ============================================================
   GET /meta — bootstrap: catálogos e dados estáticos que o
   front hidrata no DATA em uma chamada.
   ============================================================ */
import { fmtBR } from '../lib/datas.js';
import { DEFAULT_ANOS } from './anos.js';

const parseJSON = (s, fb) => { try { return JSON.parse(s); } catch { return fb; } };

export default async function metaRoutes(fastify) {
  fastify.get('/meta', { preHandler: [fastify.authenticate] }, async () => {
    const p = fastify.prisma;
    const [niveis, componentes, periodos, matrizes, habilidades, professores, usuarios, escolas, configRows] =
      await Promise.all([
        p.nivel.findMany({ orderBy: { id: 'asc' } }),
        p.componente.findMany(),
        p.periodo.findMany({ orderBy: { inicio: 'asc' } }),
        p.matriz.findMany(),
        p.habilidade.findMany(),
        p.professor.findMany(),
        p.usuario.findMany({ where: { ativo: true } }),
        p.escola.findMany({ select: { id: true, nome: true, sigla: true, zona: true }, orderBy: { id: 'asc' } }),
        p.config.findMany(),
      ]);

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
      PROFESSORES: professores.map(x => ({ id: x.id, nome: x.nome, comp: x.compId, cor: x.cor, iniciais: x.iniciais, turmaIds: parseJSON(x.turmaIds, []) })),
      ESCOLAS: escolas,
      // sem senhaHash — usado pelo switch de usuário demo no topbar
      USUARIOS: usuarios.map(u => ({
        id: u.id, nome: u.nome, email: u.email, perfil: u.perfil, cargo: u.cargo,
        iniciais: u.iniciais, cor: u.cor, escolaIds: parseJSON(u.escolaIds, []),
        ...(u.profId ? { profId: u.profId } : {}),
      })),
      ESCOLA: { nome: config.escolaNome || 'EMEF Anísio Teixeira', rede: config.redeNome || 'Rede Municipal de Ensino', ano: config.anoLetivo || '2026' },
      REDE: { municipio: config.municipio, secretaria: config.secretaria, uf: config.uf, ano: config.anoLetivo },
    };
  });
}
