/* ============================================================
   Seed — porta os dados determinísticos do protótipo
   (src/data.js + src/network.js) para o banco.
   Reprodutível: mesmo RNG seedado gera os MESMOS alunos.
   ============================================================ */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

/* ---------- util: 'dd/mm/yyyy' -> Date (meio-dia UTC) ---------- */
const parseBR = s => {
  const [d, m, y] = s.split('/').map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12));
};

/* ============================================================
   Catálogos (copiados de src/data.js)
   ============================================================ */
const NIVEIS = [
  { id: 1, nome: 'Não leitor',                   curto: 'Não leitor',  cor: 'var(--lv1)', desc: 'Ainda não realiza leitura convencional.' },
  { id: 2, nome: 'Leitor de sílabas',            curto: 'Sílabas',     cor: 'var(--lv2)', desc: 'Lê sílabas isoladas.' },
  { id: 3, nome: 'Leitor de palavras',           curto: 'Palavras',    cor: 'var(--lv3)', desc: 'Lê palavras isoladas.' },
  { id: 4, nome: 'Leitor de frases',             curto: 'Frases',      cor: 'var(--lv4)', desc: 'Lê frases curtas.' },
  { id: 5, nome: 'Leitor de texto sem fluência', curto: 'Texto s/fl.', cor: 'var(--lv5)', desc: 'Lê textos, mas ainda sem fluência.' },
  { id: 6, nome: 'Leitor de texto com fluência', curto: 'Texto c/fl.', cor: 'var(--lv6)', desc: 'Lê textos com fluência e compreensão.' },
];

const COMPONENTES = [
  { id: 'lp', nome: 'Língua Portuguesa' },
  { id: 'mat', nome: 'Matemática' },
];

// Períodos = meses do ano letivo. "atual" = mês corrente (Junho/2026).
const MESES_NOME = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];
const ULTIMO_DIA = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const MES_ATUAL = 6; // Junho
const PERIODOS = MESES_NOME.map((nome, i) => {
  const mm = String(i + 1).padStart(2, '0');
  return { id: 'm' + mm, nome, inicio: `01/${mm}/2026`, fim: `${ULTIMO_DIA[i]}/${mm}/2026`, atual: i + 1 === MES_ATUAL };
});

const MATRIZES = [
  { id: 'BNCC',    nome: 'BNCC',     desc: 'Base Nacional Comum Curricular',                              badge: 'badge-blue',   cor: '#2563eb' },
  { id: 'SAEB',    nome: 'SAEB',     desc: 'Sistema de Avaliação da Educação Básica',                      badge: 'badge-violet', cor: '#6d4bd1' },
  { id: 'SEAMA',   nome: 'SEAMA',    desc: 'Sist. Estadual de Avaliação e Monitoramento da Aprendizagem',  badge: 'badge-cyan',   cor: '#0e8aa8' },
  { id: 'CNCA',    nome: 'CNCA',     desc: 'Matriz de referência CNCA',                                    badge: 'badge-amber',  cor: '#c77a07' },
  { id: 'LEITORA', nome: 'Leitoras', desc: 'Habilidades Leitoras',                                         badge: 'badge-green',  cor: '#15935f' },
];

const HABILIDADES = [
  // BNCC — Língua Portuguesa
  { cod: 'EF01LP01', matriz: 'BNCC', comp: 'lp', desc: 'Reconhecer que textos são lidos e escritos da esquerda para a direita e de cima para baixo da página.' },
  { cod: 'EF01LP02', matriz: 'BNCC', comp: 'lp', desc: 'Escrever, espontaneamente ou por ditado, palavras e frases de forma alfabética.' },
  { cod: 'EF01LP04', matriz: 'BNCC', comp: 'lp', desc: 'Distinguir as letras do alfabeto de outros sinais gráficos.' },
  { cod: 'EF01LP07', matriz: 'BNCC', comp: 'lp', desc: 'Identificar fonemas e sua representação por letras.' },
  { cod: 'EF12LP01', matriz: 'BNCC', comp: 'lp', desc: 'Ler palavras novas com precisão na decodificação, no caso de palavras de uso frequente.' },
  { cod: 'EF01LP08', matriz: 'BNCC', comp: 'lp', desc: 'Relacionar elementos sonoros das palavras com sua representação escrita.' },
  // BNCC — Matemática
  { cod: 'EF01MA01', matriz: 'BNCC', comp: 'mat', desc: 'Utilizar números naturais como indicador de quantidade ou de ordem em diferentes situações.' },
  { cod: 'EF01MA02', matriz: 'BNCC', comp: 'mat', desc: 'Contar de maneira exata ou aproximada, utilizando diferentes estratégias.' },
  { cod: 'EF01MA08', matriz: 'BNCC', comp: 'mat', desc: 'Resolver e elaborar problemas de adição e subtração com números até 20.' },
  { cod: 'EF01MA05', matriz: 'BNCC', comp: 'mat', desc: 'Comparar números naturais de até duas ordens em situações cotidianas.' },
  // SAEB — Língua Portuguesa
  { cod: 'saeb-lp-d1', rotulo: 'D1', matriz: 'SAEB', comp: 'lp', desc: 'Ler palavras isoladas com correspondência grafofonêmica (decodificação).' },
  { cod: 'saeb-lp-d2', rotulo: 'D2', matriz: 'SAEB', comp: 'lp', desc: 'Ler frases curtas localizando informações explícitas.' },
  { cod: 'saeb-lp-d3', rotulo: 'D3', matriz: 'SAEB', comp: 'lp', desc: 'Localizar informação explícita em textos de curta extensão.' },
  { cod: 'saeb-lp-d4', rotulo: 'D4', matriz: 'SAEB', comp: 'lp', desc: 'Reconhecer a finalidade de textos de diferentes gêneros.' },
  // SAEB — Matemática
  { cod: 'saeb-mat-d1', rotulo: 'D1', matriz: 'SAEB', comp: 'mat', desc: 'Associar a contagem de coleções de objetos à sua representação numérica.' },
  { cod: 'saeb-mat-d2', rotulo: 'D2', matriz: 'SAEB', comp: 'mat', desc: 'Resolver problemas envolvendo adição e subtração com números naturais.' },
  // SEAMA
  { cod: 'seama-lp-h1', rotulo: 'H1', matriz: 'SEAMA', comp: 'lp', desc: 'Identificar as letras do alfabeto em diferentes contextos.' },
  { cod: 'seama-lp-h2', rotulo: 'H2', matriz: 'SEAMA', comp: 'lp', desc: 'Estabelecer relação entre fonemas e grafemas na leitura e na escrita.' },
  { cod: 'seama-lp-h3', rotulo: 'H3', matriz: 'SEAMA', comp: 'lp', desc: 'Ler palavras formadas por sílabas canônicas e não canônicas.' },
  { cod: 'seama-lp-h4', rotulo: 'H4', matriz: 'SEAMA', comp: 'lp', desc: 'Ler e compreender frases e pequenos textos.' },
  { cod: 'seama-mat-h1', rotulo: 'H1', matriz: 'SEAMA', comp: 'mat', desc: 'Reconhecer e utilizar números naturais em situações do cotidiano.' },
  // Habilidades Leitoras
  { cod: 'hl01', rotulo: 'HL01', matriz: 'LEITORA', comp: 'lp', desc: 'Desenvolver a consciência fonológica (rimas, sílabas e fonemas).' },
  { cod: 'hl02', rotulo: 'HL02', matriz: 'LEITORA', comp: 'lp', desc: 'Decodificar palavras com precisão e automaticidade.' },
  { cod: 'hl03', rotulo: 'HL03', matriz: 'LEITORA', comp: 'lp', desc: 'Ler em voz alta com fluência, ritmo e entonação adequados.' },
  { cod: 'hl04', rotulo: 'HL04', matriz: 'LEITORA', comp: 'lp', desc: 'Compreender e interpretar o que lê (compreensão leitora).' },
  { cod: 'hl05', rotulo: 'HL05', matriz: 'LEITORA', comp: 'lp', desc: 'Ler textos de diferentes gêneros com autonomia.' },
  // CNCA (placeholders — ajustar conforme a matriz oficial)
  { cod: 'cnca-lp-01', rotulo: 'CNCA01', matriz: 'CNCA', comp: 'lp',  desc: 'Apropriar-se do sistema de escrita alfabética em situações de uso social.' },
  { cod: 'cnca-lp-02', rotulo: 'CNCA02', matriz: 'CNCA', comp: 'lp',  desc: 'Ler e produzir textos de diferentes gêneros com finalidade comunicativa.' },
  { cod: 'cnca-mat-01', rotulo: 'CNCA01', matriz: 'CNCA', comp: 'mat', desc: 'Mobilizar o conceito de número em situações-problema do cotidiano.' },
  { cod: 'cnca-mat-02', rotulo: 'CNCA02', matriz: 'CNCA', comp: 'mat', desc: 'Resolver problemas do campo aditivo com diferentes estratégias.' },
];

const PROFESSORES = [
  { id: 'p1', nome: 'Helena Martins',  comp: 'lp',  cor: '#2563eb', iniciais: 'HM', turmaIds: ['t1', 't2'] },
  { id: 'p2', nome: 'Rafael Souza',    comp: 'mat', cor: '#6d4bd1', iniciais: 'RS', turmaIds: ['t1'] },
  { id: 'p3', nome: 'Beatriz Almeida', comp: 'lp',  cor: '#0e8aa8', iniciais: 'BA', turmaIds: ['t2'] },
];

const USUARIOS = [
  { id: 'u-sec',    nome: 'Beatriz Nogueira', email: 'beatriz@rededeensino.edu.br', perfil: 'secretaria', cargo: 'Secretária de Educação',           iniciais: 'BN', cor: '#0e7490', profId: null, escolaIds: [] },
  { id: 'u-gestor', nome: 'Camila Ferreira',  email: 'camila@rededeensino.edu.br',  perfil: 'gestor',     cargo: 'Gestora Escolar / Coordenadora',   iniciais: 'CF', cor: '#1d4ed8', profId: null, escolaIds: ['e1', 'e2'] },
  { id: 'u-prof',   nome: 'Helena Martins',   email: 'helena@rededeensino.edu.br',  perfil: 'professor',  cargo: 'Professora — Língua Portuguesa',   iniciais: 'HM', cor: '#2563eb', profId: 'p1', escolaIds: [] },
  { id: 'u-admin',  nome: 'Sérgio Antunes',   email: 'sergio@rededeensino.edu.br',  perfil: 'admin',      cargo: 'Administrador do Sistema',         iniciais: 'SA', cor: '#475569', profId: null, escolaIds: [] },
];

/* ============================================================
   Turma 1A real (copiada de src/data.js)
   ============================================================ */
const TURMAS_E1 = [
  { id: 't1', nome: '1º Ano A', turno: 'Matutino',   ano: 1 },
  { id: 't2', nome: '1º Ano B', turno: 'Vespertino', ano: 1 },
  { id: 't3', nome: '2º Ano A', turno: 'Matutino',   ano: 2 },
];

const nomes1A = [
  'Ana Clara Ribeiro','Bernardo Lima','Cecília Nunes','Davi Carvalho','Elisa Moreira',
  'Felipe Andrade','Gabriela Pinto','Heitor Barbosa','Isabela Cardoso','João Pedro Dias',
  'Laura Teixeira','Miguel Fernandes','Núbia Santos','Otávio Rocha','Pietra Gomes',
  'Rafael Mendes','Sophia Vieira','Théo Azevedo','Valentina Costa','Yuri Macedo',
  'Alice Figueiredo','Bruno Tavares','Clarice Lopes','Enzo Ramos',
];
const nivelDist = [3,2,4,1,3, 5,4,2,6,2, 4,3,1,2,5, 3,6,2,4,1, 5,2,3,4];

/* ============================================================
   Gerador determinístico (copiado de src/network.js)
   ============================================================ */
function hashStr(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
function mulberry32(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
const pick = (r, arr) => arr[Math.floor(r() * arr.length)];

const FIRST = ['Ana', 'João', 'Maria', 'Pedro', 'Lucas', 'Júlia', 'Gabriel', 'Larissa', 'Mateus', 'Beatriz',
  'Rafael', 'Sophia', 'Enzo', 'Helena', 'Davi', 'Manuela', 'Arthur', 'Valentina', 'Bernardo', 'Lívia',
  'Heitor', 'Laura', 'Théo', 'Alice', 'Miguel', 'Cecília', 'Gustavo', 'Isabela', 'Felipe', 'Clara',
  'Vinícius', 'Yasmin', 'Otávio', 'Núbia', 'Caio', 'Eduarda', 'Bruno', 'Melissa', 'Igor', 'Pietra'];
const LAST = ['Silva', 'Santos', 'Oliveira', 'Souza', 'Lima', 'Pereira', 'Carvalho', 'Ribeiro', 'Almeida', 'Gomes',
  'Costa', 'Martins', 'Araújo', 'Fernandes', 'Rocha', 'Dias', 'Nunes', 'Moreira', 'Cardoso', 'Teixeira',
  'Barbosa', 'Mendes', 'Azevedo', 'Vieira', 'Ramos', 'Tavares', 'Pinto', 'Macedo', 'Andrade', 'Figueiredo'];

const WEIGHTS = {
  1: [26, 24, 22, 15, 9, 4],
  2: [10, 18, 24, 22, 16, 10],
  3: [4, 10, 18, 26, 24, 18],
  4: [2, 6, 11, 21, 30, 30],
  5: [1, 3, 7, 15, 30, 44],
};

function genNivel(r, ano) {
  const W = WEIGHTS[ano] || WEIGHTS[3];
  const tot = W.reduce((a, b) => a + b, 0);
  let x = r() * tot;
  for (let k = 0; k < 6; k++) { if (x < W[k]) return k + 1; x -= W[k]; }
  return 6;
}

function genHistFrom(nivelAtual, seed) {
  const r = mulberry32(seed);
  const start = Math.max(1, nivelAtual - (1 + Math.floor(r() * 3)));
  const datas = ['08/02', '24/02', '14/03', '02/04'];
  let cur = start; const hist = [];
  for (let d = 0; d < datas.length; d++) {
    hist.push({ data: datas[d] + '/2026', nivel: cur });
    if (cur < nivelAtual && (r() < 0.6 || d >= datas.length - 2)) cur++;
    cur = Math.min(cur, nivelAtual);
  }
  hist[hist.length - 1].nivel = nivelAtual;
  return hist;
}

function genAlunos(turmaId, count, ano) {
  const r = mulberry32(hashStr(turmaId));
  const used = new Set();
  const arr = [];
  for (let i = 0; i < count; i++) {
    let nome, guard = 0;
    do { nome = pick(r, FIRST) + ' ' + pick(r, LAST); guard++; } while (used.has(nome) && guard < 12);
    used.add(nome);
    const partes = nome.split(' ');
    const nivel = genNivel(r, ano);
    arr.push({
      id: turmaId + '-a' + (i + 1),
      nome, numero: i + 1,
      iniciais: (partes[0][0] + partes[1][0]).toUpperCase(),
      nivelLeitura: nivel,
      ano,
    });
  }
  return arr;
}

const ESCOLAS = [
  { id: 'e1', nome: 'EMEF Anísio Teixeira',  sigla: 'EAT', zona: 'Urbana', bairro: 'Centro',            diretor: 'Camila Ferreira', cor: '#2563eb', professores: 6 },
  { id: 'e2', nome: 'EMEF Paulo Freire',      sigla: 'EPF', zona: 'Urbana', bairro: 'Jardim das Flores', diretor: 'Marcos Tavares',  cor: '#6d4bd1', professores: 20, turmasPorAno: { 1: 3, 2: 3, 3: 2, 4: 2, 5: 2 } },
  { id: 'e3', nome: 'EMEF Cora Coralina',     sigla: 'ECC', zona: 'Urbana', bairro: 'Vila Nova',         diretor: 'Patrícia Lopes',  cor: '#0e8aa8', professores: 18, turmasPorAno: { 1: 2, 2: 2, 3: 2, 4: 2, 5: 2 } },
  { id: 'e4', nome: 'EMEF Monteiro Lobato',   sigla: 'EML', zona: 'Rural',  bairro: 'Zona Rural Norte',  diretor: 'Antônio Ramos',   cor: '#15935f', professores: 8,  turmasPorAno: { 1: 1, 2: 1, 3: 1, 4: 1, 5: 1 } },
  { id: 'e5', nome: 'EMEF Cecília Meireles',  sigla: 'ECM', zona: 'Urbana', bairro: 'Bela Vista',        diretor: 'Renata Coelho',   cor: '#c77a07', professores: 24, turmasPorAno: { 1: 3, 2: 3, 3: 3, 4: 3, 5: 2 } },
  { id: 'e6', nome: 'EMEF Castro Alves',      sigla: 'ECA', zona: 'Rural',  bairro: 'Zona Rural Sul',    diretor: 'Joana Prado',     cor: '#d3433a', professores: 6,  turmasPorAno: { 1: 1, 2: 1, 3: 1, 4: 1 } },
];

// Grupos de escolas (polos) — camada organizacional. e5 fica sem grupo (demo do bucket "Sem grupo").
const GRUPOS = [
  { id: 'g-centro', nome: 'Polo Urbano Centro', cor: '#2563eb', escolas: ['e1', 'e2', 'e3'] },
  { id: 'g-rural',  nome: 'Polo Rural',         cor: '#15935f', escolas: ['e4', 'e6'] },
];
const grupoDe = Object.fromEntries(GRUPOS.flatMap(g => g.escolas.map(eid => [eid, g.id])));

/* ============================================================
   Planejamentos + trabalho (copiados de src/data.js)
   ============================================================ */
const PLANEJAMENTOS = [
  {
    id: 'pl1', periodo: 'm06', anos: [1], grupo: 'g-centro', comp: 'lp', turma: 't1', prof: 'p1',
    titulo: 'Alfabetização — Leitura e escrita inicial',
    objetivo: 'Desenvolver a consciência fonológica e o reconhecimento do sistema de escrita alfabética, consolidando a relação entre fonemas e grafemas.',
    criadoEm: '28/01/2026', status: 'ativo',
    habilidades: ['EF01LP01','EF01LP02','EF01LP04','EF01LP07','EF12LP01','EF01LP08','saeb-lp-d1','saeb-lp-d2','seama-lp-h2','seama-lp-h3','hl02','hl03','hl04'],
  },
  {
    id: 'pl2', periodo: 'm06', anos: [1], grupo: 'g-centro', comp: 'mat', turma: 't1', prof: 'p2',
    titulo: 'Números e operações até 20',
    objetivo: 'Construir o conceito de número natural como quantidade e ordem, resolvendo problemas de adição e subtração no campo aditivo.',
    criadoEm: '28/01/2026', status: 'ativo',
    habilidades: ['EF01MA01','EF01MA02','EF01MA05','EF01MA08','saeb-mat-d1','saeb-mat-d2','seama-mat-h1'],
  },
  {
    id: 'pl3', periodo: 'm05', anos: [2], grupo: 'g-rural', comp: 'lp', turma: 't2', prof: 'p3',
    titulo: 'Alfabetização — Turma B',
    objetivo: 'Reconhecimento das letras do alfabeto e leitura de palavras de uso frequente.',
    criadoEm: '29/01/2026', status: 'ativo',
    habilidades: ['EF01LP01','EF01LP04','EF12LP01'],
  },
];

const TRABALHO_PL1 = {
  'EF01LP01': { status: 'trabalhada', proxima: null, atividades: ['Roda de leitura compartilhada','Leitura de rótulos e embalagens'], recursos: 'Livros de literatura infantil, cartazes', ultima: '08/04/2026' },
  'EF01LP02': { status: 'andamento',  proxima: 'Ditado de palavras (15/04)', atividades: ['Ditado mudo com figuras'], recursos: 'Alfabeto móvel, fichas', ultima: '02/04/2026' },
  'EF01LP04': { status: 'trabalhada', proxima: null, atividades: ['Caça-letras','Bingo do alfabeto'], recursos: 'Cartelas, alfabeto móvel', ultima: '07/04/2026' },
  'EF01LP07': { status: 'andamento',  proxima: 'Jogo de sons iniciais (16/04)', atividades: ['Jogo dos sons iniciais'], recursos: 'Cartões fonêmicos', ultima: '31/03/2026' },
  'EF12LP01': { status: 'pendente',   proxima: 'Leitura de palavras-chave (22/04)', atividades: [], recursos: '', ultima: null },
  'EF01LP08': { status: 'pendente',   proxima: null, atividades: [], recursos: '', ultima: null },
  'saeb-lp-d1': { status: 'trabalhada', proxima: null, atividades: ['Leitura de palavras (decodificação)'], recursos: 'Fichas de palavras', ultima: '07/04/2026' },
  'saeb-lp-d2': { status: 'andamento',  proxima: 'Leitura de frases (18/04)', atividades: ['Leitura de frases curtas'], recursos: 'Cartelas de frases', ultima: '03/04/2026' },
  'seama-lp-h2': { status: 'andamento', proxima: 'Atividade fonema-grafema (17/04)', atividades: ['Relação fonema–grafema'], recursos: 'Cartões fonêmicos', ultima: '31/03/2026' },
  'seama-lp-h3': { status: 'pendente',  proxima: null, atividades: [], recursos: '', ultima: null },
  'hl02': { status: 'trabalhada', proxima: null, atividades: ['Jogo de leitura de palavras'], recursos: 'Baralho de palavras', ultima: '05/04/2026' },
  'hl03': { status: 'andamento',  proxima: 'Leitura cronometrada (21/04)', atividades: ['Leitura em voz alta'], recursos: 'Textos de fluência', ultima: '02/04/2026' },
  'hl04': { status: 'pendente',   proxima: 'Roda de interpretação (24/04)', atividades: [], recursos: '', ultima: null },
};

// Sequências didáticas semanais preenchidas pelo professor p1 para o planejamento pl1.
const SEMANAS_PL1 = [
  {
    semana: 1,
    habilidades: ['EF01LP01', 'EF01LP04'],
    sequenciaDidatica: 'Roda de leitura compartilhada e exploração de rótulos e embalagens; identificação da direção da leitura e escrita.',
    recursosDidaticos: 'Livros de literatura infantil, cartazes, rótulos e embalagens.',
    verificacaoAprendizagem: 'Observação registrada da participação na roda e leitura de palavras conhecidas.',
    referencias: 'BRASIL. Base Nacional Comum Curricular (BNCC). MEC, 2018.',
  },
  {
    semana: 2,
    habilidades: ['EF01LP02', 'EF01LP07'],
    sequenciaDidatica: 'Trabalho com o alfabeto móvel: formação de palavras e relação fonema–grafema; ditado mudo com figuras.',
    recursosDidaticos: 'Alfabeto móvel, fichas de palavras, cartões fonêmicos.',
    verificacaoAprendizagem: 'Ditado de palavras simples; análise das hipóteses de escrita.',
    referencias: 'FERREIRO, E.; TEBEROSKY, A. Psicogênese da língua escrita. Artmed.',
  },
];

const TIMELINE = [
  { data: '08/04/2026', tipo: 'avaliacao', hab: 'EF01LP01', texto: 'Verificação contínua — 24 alunos avaliados em leitura compartilhada.' },
  { data: '07/04/2026', tipo: 'atividade', hab: 'EF01LP04', texto: 'Atividade aplicada: Bingo do alfabeto.' },
  { data: '04/04/2026', tipo: 'leitura',   hab: null,       texto: 'Atualização de níveis de leitura — 6 alunos avançaram de nível.' },
  { data: '02/04/2026', tipo: 'avaliacao', hab: 'EF01LP02', texto: 'Verificação contínua — escrita de palavras (ditado mudo).' },
  { data: '31/03/2026', tipo: 'avaliacao', hab: 'EF01LP07', texto: 'Verificação contínua — jogo dos sons iniciais.' },
  { data: '20/03/2026', tipo: 'atividade', hab: 'EF01LP04', texto: 'Atividade aplicada: Caça-letras em duplas.' },
  { data: '14/03/2026', tipo: 'leitura',   hab: null,       texto: 'Atualização de níveis de leitura — 2º registro do bimestre.' },
  { data: '06/03/2026', tipo: 'avaliacao', hab: 'EF01LP01', texto: 'Verificação contínua — direção da leitura e escrita.' },
];

/* ============================================================
   Execução
   ============================================================ */
async function main() {
  // 🔒 Trava de produção: este seed é DESTRUTIVO — apaga TODAS as tabelas (deleteMany abaixo)
  // e recria o demo. Em produção só roda com ALLOW_SEED=1 explícito, para nunca apagar dados reais.
  if (process.env.NODE_ENV === 'production' && process.env.ALLOW_SEED !== '1') {
    console.error('\n⛔  Seed BLOQUEADO: NODE_ENV=production.');
    console.error('   Este seed apaga TODOS os dados e recria o demo (pl1/pl2/pl3, alunos fictícios, etc.).');
    console.error('   Se realmente precisar semear ESTE banco, rode com ALLOW_SEED=1.\n');
    process.exit(1);
  }
  console.log('Limpando banco...');
  // ordem inversa de FK
  await prisma.timelineEvent.deleteMany();
  await prisma.avaliacao.deleteMany();
  await prisma.trabalhoHabilidade.deleteMany();
  await prisma.planejamentoSemana.deleteMany();
  await prisma.planejamentoHabilidade.deleteMany();
  await prisma.planejamento.deleteMany();
  await prisma.leituraRegistro.deleteMany();
  await prisma.aluno.deleteMany();
  await prisma.turma.deleteMany();
  await prisma.escola.deleteMany();
  await prisma.grupoEscola.deleteMany();
  await prisma.usuario.deleteMany();
  await prisma.professor.deleteMany();
  await prisma.habilidade.deleteMany();
  await prisma.matriz.deleteMany();
  await prisma.periodo.deleteMany();
  await prisma.componente.deleteMany();
  await prisma.nivel.deleteMany();
  await prisma.config.deleteMany();

  console.log('Catálogos...');
  await prisma.nivel.createMany({ data: NIVEIS });
  await prisma.componente.createMany({ data: COMPONENTES });
  await prisma.periodo.createMany({
    data: PERIODOS.map(x => ({ id: x.id, nome: x.nome, inicio: parseBR(x.inicio), fim: parseBR(x.fim), atual: x.atual })),
  });
  await prisma.matriz.createMany({ data: MATRIZES });
  await prisma.habilidade.createMany({
    data: HABILIDADES.map(h => ({ cod: h.cod, rotulo: h.rotulo || null, matrizId: h.matriz, compId: h.comp, desc: h.desc })),
  });
  await prisma.professor.createMany({
    data: PROFESSORES.map(x => ({ id: x.id, nome: x.nome, compId: x.comp, cor: x.cor, iniciais: x.iniciais, turmaIds: JSON.stringify(x.turmaIds || []) })),
  });

  console.log('Usuários (senha demo123)...');
  const senhaHash = bcrypt.hashSync('demo123', 10);
  await prisma.usuario.createMany({
    data: USUARIOS.map(u => ({
      id: u.id, nome: u.nome, email: u.email, senhaHash, perfil: u.perfil,
      cargo: u.cargo, iniciais: u.iniciais, cor: u.cor, profId: u.profId,
      escolaIds: JSON.stringify(u.escolaIds || []),
    })),
  });

  console.log('Grupos de escolas...');
  await prisma.grupoEscola.createMany({
    data: GRUPOS.map(g => ({ id: g.id, nome: g.nome, cor: g.cor, criadoPorId: 'u-sec' })),
  });

  console.log('Escolas, turmas e alunos...');
  let totAlunos = 0;
  for (const esc of ESCOLAS) {
    await prisma.escola.create({
      data: {
        id: esc.id, nome: esc.nome, sigla: esc.sigla, zona: esc.zona,
        bairro: esc.bairro, diretor: esc.diretor, cor: esc.cor, qtdProfessores: esc.professores,
        grupoId: grupoDe[esc.id] || null,
      },
    });

    // monta turmas como em network.js buildEscola()
    let turmas = [];
    if (esc.id === 'e1') {
      const extra = { t2: 26, t3: 25 };
      turmas = TURMAS_E1.map(t => {
        let alunos;
        if (t.id === 't1') {
          alunos = nomes1A.map((nome, i) => {
            const partes = nome.split(' ');
            return {
              id: 'a' + (i + 1), nome, numero: i + 1,
              iniciais: (partes[0][0] + partes[partes.length - 1][0]).toUpperCase(),
              nivelLeitura: nivelDist[i], ano: t.ano,
            };
          });
        } else {
          alunos = genAlunos(t.id, extra[t.id] || 25, t.ano);
        }
        return { id: t.id, ano: t.ano, nome: t.nome, turno: t.turno, alunos };
      });
    } else {
      Object.entries(esc.turmasPorAno).forEach(([anoStr, n]) => {
        const ano = +anoStr;
        for (let i = 0; i < n; i++) {
          const letra = String.fromCharCode(65 + i);
          const id = esc.id + '-' + ano + letra;
          const count = 22 + Math.floor(mulberry32(hashStr(id + 'c'))() * 8);
          turmas.push({ id, ano, nome: ano + 'º Ano ' + letra, turno: i % 2 ? 'Vespertino' : 'Matutino', alunos: genAlunos(id, count, ano) });
        }
      });
    }

    for (const t of turmas) {
      await prisma.turma.create({ data: { id: t.id, escolaId: esc.id, ano: t.ano, nome: t.nome, turno: t.turno } });
      await prisma.aluno.createMany({
        data: t.alunos.map(a => ({
          id: a.id, turmaId: t.id, nome: a.nome, numero: a.numero,
          iniciais: a.iniciais, nivelLeitura: a.nivelLeitura,
        })),
      });
      // histórico de leitura determinístico (genHistFrom para todos)
      const registros = [];
      for (const a of t.alunos) {
        for (const h of genHistFrom(a.nivelLeitura, hashStr(a.id))) {
          registros.push({ alunoId: a.id, data: parseBR(h.data), nivel: h.nivel });
        }
      }
      await prisma.leituraRegistro.createMany({ data: registros });
      totAlunos += t.alunos.length;
    }
  }
  console.log(`  ${totAlunos} alunos criados.`);

  console.log('Planejamentos (direcionados pela secretaria, por mês)...');
  for (const pl of PLANEJAMENTOS) {
    await prisma.planejamento.create({
      data: {
        id: pl.id, titulo: pl.titulo, objetivo: pl.objetivo,
        periodoId: pl.periodo, anos: JSON.stringify(pl.anos || []), grupoId: pl.grupo || null,
        compId: null, turmaId: null, profId: null,
        criadoPorId: 'u-sec',
        status: pl.status, criadoEm: parseBR(pl.criadoEm),
        habilidades: { create: pl.habilidades.map((cod, i) => ({ habCod: cod, ordem: i })) },
        trabalhos: {
          create: pl.habilidades.map(cod => {
            const t = pl.id === 'pl1' ? TRABALHO_PL1[cod] : null;
            return t ? {
              habCod: cod, status: t.status, atividades: JSON.stringify(t.atividades),
              recursos: t.recursos, proxima: t.proxima,
              ultima: t.ultima ? parseBR(t.ultima) : null,
            } : { habCod: cod };
          }),
        },
        ...(pl.id === 'pl1' ? { semanas: { create: SEMANAS_PL1.map(s => ({
          profId: 'p1', semana: s.semana, habilidades: JSON.stringify(s.habilidades || []),
          sequenciaDidatica: s.sequenciaDidatica, recursosDidaticos: s.recursosDidaticos,
          verificacaoAprendizagem: s.verificacaoAprendizagem, referencias: s.referencias,
        })) } } : {}),
      },
    });
  }

  console.log('Avaliações (verificação contínua, turma 1A)...');
  // porta genAval() de data.js — resultado correlacionado ao nível do aluno
  const habsAval = ['EF01LP01', 'EF01LP02', 'EF01LP04', 'EF01LP07', 'hl02', 'hl03'];
  const datasPorHab = {
    'EF01LP01': ['12/02/2026', '06/03/2026', '03/04/2026'],
    'EF01LP02': ['20/02/2026', '27/03/2026'],
    'EF01LP04': ['14/02/2026', '28/02/2026', '20/03/2026', '07/04/2026'],
    'EF01LP07': ['31/03/2026'],
    // habilidades leitoras (LEITORA) — alimentam o gráfico de acompanhamento
    'hl02': ['18/02/2026', '20/03/2026', '10/04/2026'],
    'hl03': ['12/03/2026', '08/04/2026'],
  };
  const avalRows = [];
  nomes1A.forEach((_, i) => {
    const alunoId = 'a' + (i + 1);
    const nivel = nivelDist[i];
    habsAval.forEach(h => {
      const datas = datasPorHab[h];
      datas.forEach((d, di) => {
        const ultima = di >= datas.length - 1;
        const atingiu = nivel >= 4 || (ultima && nivel >= 3);
        avalRows.push({ alunoId, habCod: h, planejamentoId: 'pl1', data: parseBR(d), resultado: atingiu ? 2 : 1 });
      });
    });
  });
  await prisma.avaliacao.createMany({ data: avalRows });
  console.log(`  ${avalRows.length} avaliações criadas.`);

  console.log('Timeline...');
  await prisma.timelineEvent.createMany({
    data: TIMELINE.map(e => ({
      data: parseBR(e.data), tipo: e.tipo, habCod: e.hab, texto: e.texto,
      profId: 'p1', turmaId: 't1',
    })),
  });

  console.log('Config...');
  await prisma.config.createMany({
    data: [
      { chave: 'anoLetivo', valor: '2026' },
      { chave: 'municipio', valor: 'Município de Serra Verde' },
      { chave: 'secretaria', valor: 'Secretaria Municipal de Educação' },
      { chave: 'uf', valor: 'MG' },
      { chave: 'redeNome', valor: 'Rede Municipal de Ensino' },
      { chave: 'escolaNome', valor: 'EMEF Anísio Teixeira' },
      { chave: 'escolaPadrao', valor: 'e1' },
    ],
  });

  // resumo
  const [nEscolas, nTurmas, nAlunos, nHabs, nPlanos, nAval, nLeituras] = await Promise.all([
    prisma.escola.count(), prisma.turma.count(), prisma.aluno.count(),
    prisma.habilidade.count(), prisma.planejamento.count(),
    prisma.avaliacao.count(), prisma.leituraRegistro.count(),
  ]);
  console.log('--- Seed concluído ---');
  console.log(`Escolas: ${nEscolas} | Turmas: ${nTurmas} | Alunos: ${nAlunos}`);
  console.log(`Habilidades: ${nHabs} | Planejamentos: ${nPlanos} | Avaliações: ${nAval} | Registros de leitura: ${nLeituras}`);
  console.log('Login demo: beatriz@ | camila@ | helena@ | sergio@rededeensino.edu.br — senha: demo123');
}

main()
  .catch(e => { console.error(e); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); });
