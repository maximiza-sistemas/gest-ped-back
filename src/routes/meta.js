/* ============================================================
   GET /meta — bootstrap: catálogos e dados estáticos que o
   front hidrata no DATA em uma chamada.
   Escopo: supervisor e gestor escolar recebem somente as suas
   escolas, os professores com turma nessas escolas e nenhuma
   lista de usuários (que é exclusiva de admin/secretaria).
   PROFESSORES: só professores REAIS (turma existente vinculada ou
   conta de usuário — lib/professores.js), com turmaIds restritos às
   turmas existentes e temConta (o select de vínculo do cadastro de
   usuário só oferece quem ainda não tem conta).
   Sem zona e sem nível de leitura: a escola é localizada pela
   região (SAG) e pelo grupo de escolas da plataforma.
   Escolas e turmas EXCLUÍDAS no SAG ficam fora (lib/ativos.js):
   não aparecem em ESCOLAS nem em PROFESSORES[].turmaIds.
   ============================================================ */
import { fmtBR } from '../lib/datas.js';
import { soEscolasVisiveis, soTurmasVisiveis } from '../lib/ativos.js';
import { gestorEscolas } from '../lib/escopo.js';
import { listarProfessoresReais } from '../lib/professores.js';
import { NIVEIS_PROFICIENCIA } from '../lib/proficiencia.js';
import { DEFAULT_ANOS } from './anos.js';
import { shapeHabilidade } from './habilidades.js';

const parseJSON = (s, fb) => { try { return JSON.parse(s); } catch { return fb; } };

export default async function metaRoutes(fastify) {
  fastify.get('/meta', { preHandler: [fastify.authenticate] }, async request => {
    const p = fastify.prisma;
    const escopo = gestorEscolas(request.user); // null = alcance de rede / por professor
    const ehRede = ['admin', 'secretaria'].includes(request.user?.perfil);

    const [componentes, periodos, matrizes, habilidades, professores, usuarios, escolas, configRows, turmasEscopo] =
      await Promise.all([
        p.componente.findMany(),
        p.periodo.findMany({ orderBy: { inicio: 'asc' } }),
        p.matriz.findMany(),
        p.habilidade.findMany(),
        listarProfessoresReais(p),
        ehRede ? p.usuario.findMany({ where: { ativo: true } }) : Promise.resolve([]),
        p.escola.findMany({
          where: soEscolasVisiveis(escopo ? { id: { in: escopo } } : {}),
          select: { id: true, nome: true, sigla: true, regiao: true, grupoId: true, grupo: { select: { nome: true } } },
          orderBy: { id: 'asc' },
        }),
        p.config.findMany(),
        escopo ? p.turma.findMany({ where: soTurmasVisiveis({ escolaId: { in: escopo } }), select: { id: true } }) : Promise.resolve(null),
      ]);

    // professores reais; supervisor/gestor escolar: só os que lecionam em turmas das suas escolas
    const turmasSet = turmasEscopo ? new Set(turmasEscopo.map(t => t.id)) : null;
    const professoresVisiveis = professores
      .map(x => ({ id: x.id, nome: x.nome, comp: x.compId, cor: x.cor, iniciais: x.iniciais, turmaIds: x.turmaIds, temConta: x.temConta }))
      .filter(x => !turmasSet || x.turmaIds.some(t => turmasSet.has(t)));

    const config = Object.fromEntries(configRows.map(c => [c.chave, c.valor]));
    const anosArr = parseJSON(config.anosEscolares, null);
    const ANOS = (Array.isArray(anosArr) && anosArr.length ? anosArr : DEFAULT_ANOS)
      .map(a => ({ ordem: a.ordem, nome: a.nome })).sort((a, b) => a.ordem - b.ordem);

    return {
      ANOS,
      COMPONENTES: componentes,
      PERIODOS: periodos.map(x => ({ id: x.id, nome: x.nome, inicio: fmtBR(x.inicio), fim: fmtBR(x.fim), atual: x.atual })),
      MATRIZES: matrizes,
      // proficiencia (nível de proficiência) só aparece quando informado
      HABILIDADES: habilidades.map(shapeHabilidade),
      // valores permitidos do nível de proficiência (ordem crescente) — fonte única no backend
      NIVEIS_PROFICIENCIA: [...NIVEIS_PROFICIENCIA],
      PROFESSORES: professoresVisiveis,
      // região do SAG ('' = não definida) + grupo de escolas da plataforma (busca e chips)
      ESCOLAS: escolas.map(e => ({
        id: e.id, nome: e.nome, sigla: e.sigla, regiao: e.regiao || '',
        grupoId: e.grupoId || null, grupoNome: e.grupo ? e.grupo.nome : '',
      })),
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
