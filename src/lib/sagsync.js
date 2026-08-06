/* ============================================================
   Espelho do banco do SAG — escolas, turmas e alunos.
   Lê o PostgreSQL do SAG (somente leitura) e sincroniza para o
   banco da plataforma com ids prefixados "sag-". Registros locais
   (seed/manuais, sem o prefixo) nunca são tocados; a remoção de
   itens que sumiram da origem também se limita aos ids "sag-".
   Config: SAG_DATABASE_URL e SAG_SYNC_INTERVALO_MIN no .env.
   As tabelas/colunas da origem são detectadas por nomes candidatos
   (ajuste o MAPA abaixo se o schema do SAG usar outros nomes).
   ============================================================ */
import pg from 'pg';

const PREFIXO = 'sag-';
const LOTE = 500; // tamanho do lote de criação (createMany) — origem pode ter milhares de linhas

// nomes candidatos no banco do SAG (schema public)
const MAPA = {
  escolas: {
    tabelas: ['escolas', 'escola', 'schools', 'instituicoes', 'unidades'],
    id: ['id', 'codigo', 'cod', 'uuid'],
    nome: ['nome', 'name', 'descricao', 'razao_social'],
    sigla: ['sigla', 'abreviacao'],
    zona: ['zona', 'area'],
    bairro: ['bairro', 'endereco_bairro'],
    diretor: ['diretor', 'gestor', 'responsavel'],
  },
  turmas: {
    tabelas: ['turmas', 'turma', 'classes'],
    id: ['id', 'codigo', 'cod', 'uuid'],
    nome: ['nome', 'name', 'descricao'],
    escola: ['escola_id', 'escolaid', 'id_escola', 'school_id', 'escola'],
    ano: ['ano', 'serie', 'ano_escolar', 'ano_serie'],
    turno: ['turno', 'periodo', 'shift'],
  },
  alunos: {
    tabelas: ['alunos', 'aluno', 'estudantes', 'students', 'matriculas'],
    id: ['id', 'codigo', 'cod', 'uuid', 'matricula'],
    nome: ['nome', 'name', 'nome_completo'],
    turma: ['turma_id', 'turmaid', 'id_turma', 'class_id', 'turma'],
    numero: ['numero', 'num', 'numero_chamada', 'ordem'],
  },
};

const CORES = ['#2563eb', '#0e7490', '#6d4bd1', '#15935f', '#c2410c', '#be185d', '#4d7c0f', '#b45309'];

export const sagConfigurado = () => {
  const url = process.env.SAG_DATABASE_URL || '';
  return url.startsWith('postgres') && !url.includes('COLOQUE_A_SENHA');
};

const iniciaisDe = nome => String(nome || '?').trim().split(/\s+/).map(p => p[0]).filter(Boolean).slice(0, 2).join('').toUpperCase();
const siglaDe = nome => String(nome || '').split(/\s+/).map(p => p[0]).filter(c => /[a-zà-ú]/i.test(c)).join('').toUpperCase().slice(0, 4) || 'ESC';
const corDe = id => CORES[[...String(id)].reduce((s, c) => s + c.charCodeAt(0), 0) % CORES.length];
const anoDe = v => { const n = parseInt(String(v ?? '').replace(/\D+/g, ''), 10); return Number.isFinite(n) && n > 0 ? n : 1; };
const turnoDe = v => {
  const s = String(v || '').toLowerCase();
  if (s.startsWith('vesp') || s.includes('tarde')) return 'Vespertino';
  if (s.startsWith('not')) return 'Noturno';
  if (s.startsWith('int')) return 'Integral';
  return 'Matutino';
};

// resolve a tabela existente e os nomes reais das colunas da origem
async function resolver(cli, spec) {
  const { rows: tabelas } = await cli.query(
    "select table_name from information_schema.tables where table_schema = 'public'");
  const nomes = tabelas.map(t => t.table_name);
  const tabela = spec.tabelas.find(t => nomes.includes(t));
  if (!tabela) return { erro: `tabela não encontrada (candidatas: ${spec.tabelas.join(', ')}; existentes na origem: ${nomes.join(', ') || 'nenhuma'})` };
  const { rows: cols } = await cli.query(
    "select column_name from information_schema.columns where table_schema = 'public' and table_name = $1", [tabela]);
  const disponiveis = cols.map(c => c.column_name);
  const col = cands => (cands || []).find(c => disponiveis.includes(c)) || null;
  return { tabela, col };
}

let ultimo = null;   // relatório da última execução (para o /status)
let rodando = false; // trava: agendado e manual não rodam ao mesmo tempo
export const ultimoRelatorio = () => ultimo;

export async function sincronizarSag(prisma) {
  if (!sagConfigurado()) {
    return { ok: false, motivo: 'SAG_DATABASE_URL não configurada — insira a senha no backend/.env.' };
  }
  if (rodando) return { ok: false, motivo: 'Sincronização já em andamento — aguarde a conclusão.' };
  rodando = true;
  const inicio = Date.now();
  const rel = { ok: true, inicio: new Date().toISOString(), escolas: null, turmas: null, alunos: null, avisos: [] };
  const pool = new pg.Pool({ connectionString: process.env.SAG_DATABASE_URL, max: 2, connectionTimeoutMillis: 15000 });
  try {
    const cli = await pool.connect();
    try {
      /* ---------- escolas ---------- */
      const escolasVivas = [];
      const rE = await resolver(cli, MAPA.escolas);
      if (rE.erro) rel.avisos.push('escolas: ' + rE.erro);
      else {
        const { rows } = await cli.query(`select * from "${rE.tabela}"`);
        const atuais = new Map((await prisma.escola.findMany({ where: { id: { startsWith: PREFIXO } } })).map(x => [x.id, x]));
        const vistos = new Set();
        const aCriar = [];
        let novas = 0, atualizadas = 0;
        for (const r of rows) {
          const src = r[rE.col(MAPA.escolas.id)];
          const nome = r[rE.col(MAPA.escolas.nome)];
          if (src == null || !nome) continue;
          const id = PREFIXO + src;
          if (vistos.has(id)) continue; // origem com linhas repetidas
          vistos.add(id);
          escolasVivas.push(id);
          const data = {
            nome: String(nome).trim(),
            sigla: String(r[rE.col(MAPA.escolas.sigla)] || siglaDe(nome)).trim(),
            zona: String(r[rE.col(MAPA.escolas.zona)] || 'Urbana').trim(),
            bairro: String(r[rE.col(MAPA.escolas.bairro)] || '').trim(),
            diretor: String(r[rE.col(MAPA.escolas.diretor)] || '').trim(),
          };
          const atual = atuais.get(id);
          if (!atual) aCriar.push({ id, cor: corDe(id), ...data });
          else if (Object.keys(data).some(k => atual[k] !== data[k])) {
            await prisma.escola.update({ where: { id }, data });
            atualizadas++;
          }
        }
        for (let i = 0; i < aCriar.length; i += LOTE) {
          await prisma.escola.createMany({ data: aCriar.slice(i, i + LOTE), skipDuplicates: true });
        }
        novas = aCriar.length;
        rel.escolas = { origem: rE.tabela, lidas: rows.length, novas, atualizadas };
      }

      /* ---------- turmas ---------- */
      const turmasVivas = [];
      const rT = await resolver(cli, MAPA.turmas);
      if (rT.erro) rel.avisos.push('turmas: ' + rT.erro);
      else {
        const { rows } = await cli.query(`select * from "${rT.tabela}"`);
        const atuais = new Map((await prisma.turma.findMany({ where: { id: { startsWith: PREFIXO } } })).map(x => [x.id, x]));
        const escolasEspelho = new Set((await prisma.escola.findMany({ where: { id: { startsWith: PREFIXO } }, select: { id: true } })).map(x => x.id));
        const aCriar = [];
        let novas = 0, atualizadas = 0, semEscola = 0;
        for (const r of rows) {
          const src = r[rT.col(MAPA.turmas.id)];
          const nome = r[rT.col(MAPA.turmas.nome)];
          const escolaSrc = r[rT.col(MAPA.turmas.escola)];
          if (src == null || !nome) continue;
          const escolaId = PREFIXO + escolaSrc;
          if (escolaSrc == null || !escolasEspelho.has(escolaId)) { semEscola++; continue; }
          const id = PREFIXO + src;
          if (turmasVivas.includes(id)) continue; // origem com linhas repetidas
          turmasVivas.push(id);
          const data = {
            escolaId,
            nome: String(nome).trim(),
            ano: anoDe(r[rT.col(MAPA.turmas.ano)] ?? nome),
            turno: turnoDe(r[rT.col(MAPA.turmas.turno)]),
          };
          const atual = atuais.get(id);
          if (!atual) aCriar.push({ id, ...data });
          else if (Object.keys(data).some(k => atual[k] !== data[k])) {
            await prisma.turma.update({ where: { id }, data });
            atualizadas++;
          }
        }
        for (let i = 0; i < aCriar.length; i += LOTE) {
          await prisma.turma.createMany({ data: aCriar.slice(i, i + LOTE), skipDuplicates: true });
        }
        novas = aCriar.length;
        rel.turmas = { origem: rT.tabela, lidas: rows.length, novas, atualizadas, semEscola };
      }

      /* ---------- alunos ---------- */
      const alunosVivos = [];
      const rA = await resolver(cli, MAPA.alunos);
      if (rA.erro) rel.avisos.push('alunos: ' + rA.erro);
      else {
        const { rows } = await cli.query(`select * from "${rA.tabela}"`);
        const atuais = new Map((await prisma.aluno.findMany({ where: { id: { startsWith: PREFIXO } } })).map(x => [x.id, x]));
        const turmasEspelho = new Set((await prisma.turma.findMany({ where: { id: { startsWith: PREFIXO } }, select: { id: true } })).map(x => x.id));
        let novos = 0, atualizados = 0, semTurma = 0, repetidos = 0;
        const seqPorTurma = {};
        const vistos = new Set();
        const aCriar = [];
        for (const r of rows) {
          const src = r[rA.col(MAPA.alunos.id)];
          const nome = r[rA.col(MAPA.alunos.nome)];
          const turmaSrc = r[rA.col(MAPA.alunos.turma)];
          if (src == null || !nome) continue;
          const turmaId = PREFIXO + turmaSrc;
          if (turmaSrc == null || !turmasEspelho.has(turmaId)) { semTurma++; continue; }
          const id = PREFIXO + src;
          if (vistos.has(id)) { repetidos++; continue; } // origem com linhas repetidas (ex.: várias matrículas)
          vistos.add(id);
          alunosVivos.push(id);
          seqPorTurma[turmaId] = (seqPorTurma[turmaId] || 0) + 1;
          const numeroSrc = parseInt(r[rA.col(MAPA.alunos.numero)], 10);
          const data = {
            turmaId,
            nome: String(nome).trim(),
            numero: Number.isFinite(numeroSrc) && numeroSrc > 0 ? numeroSrc : seqPorTurma[turmaId],
            iniciais: iniciaisDe(nome),
          };
          const atual = atuais.get(id);
          // nivelLeitura só no create — é dado pedagógico local, não vem da origem
          if (!atual) aCriar.push({ id, nivelLeitura: 1, ...data });
          else if (Object.keys(data).some(k => atual[k] !== data[k])) {
            await prisma.aluno.update({ where: { id }, data });
            atualizados++;
          }
        }
        for (let i = 0; i < aCriar.length; i += LOTE) {
          await prisma.aluno.createMany({ data: aCriar.slice(i, i + LOTE), skipDuplicates: true });
        }
        novos = aCriar.length;
        rel.alunos = { origem: rA.tabela, lidos: rows.length, novos, atualizados, semTurma, repetidos };
      }

      /* ---------- remoção do que sumiu da origem (apenas ids sag-) ----------
         a diferença é calculada em JS e apagada em lotes — listas grandes
         estouram o limite de bind variables do PostgreSQL (32767). */
      const removerAusentes = async (model, vivos) => {
        const vivosSet = new Set(vivos);
        const existentes = await model.findMany({ where: { id: { startsWith: PREFIXO } }, select: { id: true } });
        const mortos = existentes.map(x => x.id).filter(id => !vivosSet.has(id));
        for (let i = 0; i < mortos.length; i += LOTE) {
          await model.deleteMany({ where: { id: { in: mortos.slice(i, i + LOTE) } } });
        }
        return mortos.length;
      };
      if (rel.alunos) rel.alunos.removidos = await removerAusentes(prisma.aluno, alunosVivos);
      if (rel.turmas) rel.turmas.removidas = await removerAusentes(prisma.turma, turmasVivas);
      if (rel.escolas) rel.escolas.removidas = await removerAusentes(prisma.escola, escolasVivas);
    } finally {
      cli.release();
    }
  } catch (err) {
    rel.ok = false;
    rel.erro = err.message;
  } finally {
    await pool.end().catch(() => {});
  }
  rel.duracaoMs = Date.now() - inicio;
  ultimo = rel;
  rodando = false;
  return rel;
}
