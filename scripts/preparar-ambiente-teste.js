/* ============================================================
   Ambiente de TESTE da equipe (testes reais na plataforma).

   Contas:
   - 1 Secretário(a) de Educação (perfil 'secretaria', rede toda);
   - 3 gestores escolares (perfil 'gestor'), cada um vinculado a
     UMA escola — vê só os dados dela e valida o planejamento dos
     professores dela;
   - 4 professores, cada um numa escola e num componente diferente.
     Os 3 primeiros ficam nas escolas dos gestores (para o fluxo de
     validação do planejamento); o 4º numa escola sem gestor teste.

   Catálogo: cadastra o componente curricular 'his' (História),
   habilidades de História da BNCC do 6º e 7º ano (turmas do
   professor de História) e de Ciências ('cnc', já existente) do 4º
   e 5º ano (turmas do professor de Ciências) — só as que ainda não
   existem; habilidades
   já cadastradas nunca são alteradas (podem ter sido editadas na
   plataforma). As demais habilidades do catálogo não são tocadas.

   Idempotente: upsert por id. Na CRIAÇÃO de cada conta gera uma
   senha forte aleatória e a imprime UMA vez (não fica no
   repositório; no banco só o hash bcrypt, custo 10 como em
   POST /admin/usuarios). Numa re-execução os dados de perfil,
   escola e turmas são reaplicados e a senha é MANTIDA — use
   --redefinir-senhas para gerar e imprimir senhas novas.

   Pré-requisito: a migração gestor → supervisor já ter rodado
   (mesmo motivo de criar-gestor-escolar-demo.js: sem ela, uma
   execução posterior converteria estes gestores em supervisores).

   Uso (de dentro de backend/):
     node scripts/preparar-ambiente-teste.js [--redefinir-senhas]
   ============================================================ */
import 'dotenv/config';
import { randomInt } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';
import { MARCADOR_MIGRACAO } from './migrar-gestor-supervisor.js';

const BCRYPT_CUSTO = 10; // igual a routes/admin.js
const DOMINIO = 'maximizaedu.com';

export const COMPONENTE_NOVO = Object.freeze({ id: 'his', nome: 'História' });

// Textos oficiais da BNCC (Ensino Fundamental — História). Matriz 'BNCC',
// código BNCC como chave (mesmo padrão de EF01LP01 etc. já no catálogo).
export const HABILIDADES_HISTORIA = Object.freeze([
  // 6º ano
  { cod: 'EF06HI01', desc: 'Identificar diferentes formas de compreensão da noção de tempo e de periodização dos processos históricos (continuidades e rupturas).' },
  { cod: 'EF06HI02', desc: 'Identificar a gênese da produção do saber histórico e analisar o significado das fontes que originaram determinadas formas de registro em sociedades e épocas distintas.' },
  { cod: 'EF06HI03', desc: 'Identificar as hipóteses científicas sobre o surgimento da espécie humana e sua historicidade e analisar os significados dos mitos de fundação.' },
  { cod: 'EF06HI05', desc: 'Descrever modificações da natureza e da paisagem realizadas por diferentes tipos de sociedade, com destaque para os povos indígenas originários e povos africanos, e discutir a natureza e a lógica das transformações ocorridas.' },
  { cod: 'EF06HI07', desc: 'Identificar aspectos e formas de registro das sociedades antigas na África, no Oriente Médio e nas Américas, distinguindo alguns significados presentes na cultura material e na tradição oral dessas sociedades.' },
  // 7º ano
  { cod: 'EF07HI01', desc: 'Explicar o significado de “modernidade” e suas lógicas de inclusão e exclusão, com base em uma concepção europeia.' },
  { cod: 'EF07HI02', desc: 'Identificar conexões e interações entre as sociedades do Novo Mundo, da Europa, da África e da Ásia no contexto das navegações e indicar a complexidade e as interações que ocorrem nos Oceanos Atlântico, Índico e Pacífico.' },
  { cod: 'EF07HI03', desc: 'Identificar aspectos e processos específicos das sociedades africanas e americanas antes da chegada dos europeus, com destaque para as formas de organização social e o desenvolvimento de saberes e técnicas.' },
  { cod: 'EF07HI04', desc: 'Identificar as principais características dos Humanismos e dos Renascimentos e analisar seus significados.' },
  { cod: 'EF07HI06', desc: 'Comparar as navegações no Atlântico e no Pacífico entre os séculos XIV e XVI.' },
].map(h => Object.freeze({ ...h, matrizId: 'BNCC', compId: COMPONENTE_NOVO.id })));

const COMPONENTE_CIENCIAS = 'cnc'; // já cadastrado (Ciências)

// Textos oficiais da BNCC (Ensino Fundamental — Ciências).
export const HABILIDADES_CIENCIAS = Object.freeze([
  // 4º ano
  { cod: 'EF04CI01', desc: 'Identificar misturas na vida diária, com base em suas propriedades físicas observáveis, reconhecendo sua composição.' },
  { cod: 'EF04CI02', desc: 'Testar e relatar transformações nos materiais do dia a dia quando expostos a diferentes condições (aquecimento, resfriamento, luz e umidade).' },
  { cod: 'EF04CI03', desc: 'Concluir que algumas mudanças causadas por aquecimento ou resfriamento são reversíveis (como as mudanças de estado físico da água) e outras não (como o cozimento do ovo, a queima do papel etc.).' },
  { cod: 'EF04CI04', desc: 'Analisar e construir cadeias alimentares simples, reconhecendo a posição ocupada pelos seres vivos nessas cadeias e o papel do Sol como fonte primária de energia na produção de alimentos.' },
  { cod: 'EF04CI06', desc: 'Relacionar a participação de fungos e bactérias no processo de decomposição, reconhecendo a importância ambiental desse processo.' },
  // 5º ano
  { cod: 'EF05CI01', desc: 'Explorar fenômenos da vida cotidiana que evidenciem propriedades físicas dos materiais – como densidade, condutibilidade térmica e elétrica, respostas a forças magnéticas, solubilidade, respostas a forças mecânicas (dureza, elasticidade etc.), entre outras.' },
  { cod: 'EF05CI02', desc: 'Aplicar os conhecimentos sobre as mudanças de estado físico da água para explicar o ciclo hidrológico e analisar suas implicações na agricultura, no clima, na geração de energia elétrica, no provimento de água potável e no equilíbrio dos ecossistemas regionais (ou locais).' },
  { cod: 'EF05CI03', desc: 'Selecionar argumentos que justifiquem a importância da cobertura vegetal para a manutenção do ciclo da água, a conservação dos solos, dos cursos de água e da qualidade do ar atmosférico.' },
  { cod: 'EF05CI06', desc: 'Selecionar argumentos que justifiquem por que os sistemas digestório e respiratório são considerados corresponsáveis pelo processo de nutrição do organismo, com base na identificação das funções desses sistemas.' },
  { cod: 'EF05CI08', desc: 'Organizar um cardápio equilibrado com base nas características dos grupos alimentares (nutrientes e calorias) e nas necessidades individuais (atividades realizadas, idade, sexo etc.) para a manutenção da saúde do organismo.' },
].map(h => Object.freeze({ ...h, matrizId: 'BNCC', compId: COMPONENTE_CIENCIAS })));

/** Todas as habilidades que o ambiente de teste garante no catálogo. */
export const HABILIDADES_TESTE = Object.freeze([...HABILIDADES_HISTORIA, ...HABILIDADES_CIENCIAS]);

export const CONTAS_TESTE = Object.freeze([
  {
    id: 'u-teste-secretaria', email: `secretaria@${DOMINIO}`, perfil: 'secretaria',
    nome: 'Secretário de Educação (Teste)', cargo: 'Secretário de Educação', iniciais: 'SE', cor: '#7c3aed',
  },
  {
    id: 'u-teste-gestor-1', email: `gestor1@${DOMINIO}`, perfil: 'gestor',
    nome: 'Gestor Teste 1', cargo: 'Gestor Escolar', iniciais: 'G1', cor: '#0e7490',
    escolaIds: ['sag-204'], // COMPLEXO EDUCACIONAL CURIAR BILINGUE
  },
  {
    id: 'u-teste-gestor-2', email: `gestor2@${DOMINIO}`, perfil: 'gestor',
    nome: 'Gestor Teste 2', cargo: 'Gestor Escolar', iniciais: 'G2', cor: '#0f766e',
    escolaIds: ['sag-208'], // EM ALTO DO TURU
  },
  {
    id: 'u-teste-gestor-3', email: `gestor3@${DOMINIO}`, perfil: 'gestor',
    nome: 'Gestor Teste 3', cargo: 'Gestor Escolar', iniciais: 'G3', cor: '#15803d',
    escolaIds: ['sag-262'], // EM PROF. LÊDA CHAVES TAJRA
  },
  {
    id: 'u-teste-professor-1', email: `professor1@${DOMINIO}`, perfil: 'professor',
    nome: 'Professor Teste 1', cargo: 'Professor de Língua Portuguesa', iniciais: 'P1', cor: '#b45309',
    prof: { id: 'p-teste-1', compId: 'lp', escolaId: 'sag-204', turmaIds: ['sag-1325', 'sag-1328'] }, // 3º A, 4º A
  },
  {
    id: 'u-teste-professor-2', email: `professor2@${DOMINIO}`, perfil: 'professor',
    nome: 'Professor Teste 2', cargo: 'Professor de Matemática', iniciais: 'P2', cor: '#be123c',
    prof: { id: 'p-teste-2', compId: 'mat', escolaId: 'sag-208', turmaIds: ['sag-1373', 'sag-1382'] }, // 3º A, 5º A
  },
  {
    id: 'u-teste-professor-3', email: `professor3@${DOMINIO}`, perfil: 'professor',
    nome: 'Professor Teste 3', cargo: 'Professor de Ciências', iniciais: 'P3', cor: '#1d4ed8',
    prof: { id: 'p-teste-3', compId: 'cnc', escolaId: 'sag-262', turmaIds: ['sag-2122', 'sag-2123'] }, // 4º A, 5º A
  },
  {
    id: 'u-teste-professor-4', email: `professor4@${DOMINIO}`, perfil: 'professor',
    nome: 'Professor Teste 4', cargo: 'Professor de História', iniciais: 'P4', cor: '#a21caf',
    prof: { id: 'p-teste-4', compId: COMPONENTE_NOVO.id, escolaId: 'sag-226', turmaIds: ['sag-1569', 'sag-1572'] }, // 6º A, 7º A
  },
]);

// sem caracteres ambíguos (0/O, 1/l/I)
const MAIUSCULAS = 'ABCDEFGHJKMNPQRSTUVWXYZ';
const MINUSCULAS = 'abcdefghjkmnpqrstuvwxyz';
const DIGITOS = '23456789';
const SIMBOLOS = '@#$%&*';
const TAMANHO_SENHA = 12;

const sorteia = alfabeto => alfabeto[randomInt(alfabeto.length)];

/** Senha forte aleatória com ao menos uma letra maiúscula, minúscula, dígito e símbolo. */
export function gerarSenha() {
  const todos = MAIUSCULAS + MINUSCULAS + DIGITOS + SIMBOLOS;
  const chars = [sorteia(MAIUSCULAS), sorteia(MINUSCULAS), sorteia(DIGITOS), sorteia(SIMBOLOS)];
  while (chars.length < TAMANHO_SENHA) chars.push(sorteia(todos));
  // embaralha (Fisher–Yates) para os obrigatórios não ficarem sempre no início
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}

/** Confere escolas, turmas (da escola certa) e e-mails antes de gravar qualquer coisa. */
async function validar(prisma) {
  const marcador = await prisma.config.findUnique({ where: { chave: MARCADOR_MIGRACAO } });
  if (!marcador) {
    throw new Error(`rode antes scripts/migrar-gestor-supervisor.js (marcador '${MARCADOR_MIGRACAO}' ausente).`);
  }

  const escolaIds = [...new Set(CONTAS_TESTE.flatMap(c => [...(c.escolaIds || []), ...(c.prof ? [c.prof.escolaId] : [])]))];
  // só escolas e turmas ATIVAS no SAG (as excluídas lá ficam ocultas na plataforma)
  const escolas = await prisma.escola.findMany({ where: { id: { in: escolaIds }, excluidoNoSag: false }, select: { id: true } });
  const faltando = escolaIds.filter(id => !escolas.some(e => e.id === id));
  if (faltando.length) throw new Error(`escola(s) inexistente(s) ou excluída(s) no SAG: ${faltando.join(', ')}.`);

  for (const c of CONTAS_TESTE.filter(x => x.prof)) {
    const turmas = await prisma.turma.findMany({
      where: { id: { in: c.prof.turmaIds }, excluidoNoSag: false },
      select: { id: true, escolaId: true },
    });
    const invalidas = c.prof.turmaIds.filter(id => !turmas.some(t => t.id === id && t.escolaId === c.prof.escolaId));
    if (invalidas.length) {
      throw new Error(`${c.email}: turma(s) inexistente(s), excluída(s) no SAG ou de outra escola: ${invalidas.join(', ')}.`);
    }
  }

  for (const c of CONTAS_TESTE) {
    const existente = await prisma.usuario.findUnique({ where: { email: c.email }, select: { id: true } });
    if (existente && existente.id !== c.id) {
      throw new Error(`o e-mail ${c.email} já pertence a outro usuário (${existente.id}); nada foi alterado.`);
    }
  }
}

/**
 * Cadastra as habilidades de teste que ainda não existem. Uma habilidade
 * já cadastrada não é alterada; se o código existir em outro componente,
 * aborta (não sobrescreve o catálogo).
 * @returns {Promise<number>} quantas foram criadas
 */
async function cadastrarHabilidadesTeste(prisma) {
  const ciencias = await prisma.componente.findUnique({ where: { id: COMPONENTE_CIENCIAS }, select: { id: true } });
  if (!ciencias) throw new Error(`componente curricular '${COMPONENTE_CIENCIAS}' (Ciências) inexistente.`);

  const codigos = HABILIDADES_TESTE.map(h => h.cod);
  const existentes = await prisma.habilidade.findMany({ where: { cod: { in: codigos } }, select: { cod: true, compId: true } });
  const conflito = existentes.find(e => HABILIDADES_TESTE.some(h => h.cod === e.cod && h.compId !== e.compId));
  if (conflito) throw new Error(`a habilidade ${conflito.cod} já existe em outro componente (${conflito.compId}).`);
  const novas = HABILIDADES_TESTE.filter(h => !existentes.some(e => e.cod === h.cod));
  if (novas.length) await prisma.habilidade.createMany({ data: novas.map(h => ({ ...h })) });
  return novas.length;
}

/**
 * Cria (ou reaplica) o componente novo, as habilidades de teste e as contas de teste.
 * @param {import('@prisma/client').PrismaClient} prisma
 * @param {{ redefinirSenhas?: boolean }} [opcoes]
 * @returns {Promise<{ componenteCriado: boolean, habilidadesCriadas: number, contas: Array<{ email: string, perfil: string, criado: boolean, senha: string | null }> }>}
 */
export async function prepararAmbienteTeste(prisma, { redefinirSenhas = false } = {}) {
  await validar(prisma);
  const matriz = await prisma.matriz.findUnique({ where: { id: 'BNCC' }, select: { id: true } });
  if (!matriz) throw new Error("matriz de referência 'BNCC' inexistente.");

  const componenteExistente = await prisma.componente.findUnique({ where: { id: COMPONENTE_NOVO.id } });
  if (!componenteExistente) await prisma.componente.create({ data: { ...COMPONENTE_NOVO } });
  const habilidadesCriadas = await cadastrarHabilidadesTeste(prisma);

  const contas = [];
  for (const c of CONTAS_TESTE) {
    if (c.prof) {
      const dadosProf = {
        nome: c.nome, compId: c.prof.compId, cor: c.cor, iniciais: c.iniciais,
        turmaIds: JSON.stringify(c.prof.turmaIds),
      };
      await prisma.professor.upsert({ where: { id: c.prof.id }, create: { id: c.prof.id, ...dadosProf }, update: dadosProf });
    }

    const existente = await prisma.usuario.findUnique({ where: { id: c.id }, select: { id: true } });
    const senha = !existente || redefinirSenhas ? gerarSenha() : null;
    const dados = {
      nome: c.nome, email: c.email, perfil: c.perfil, cargo: c.cargo, iniciais: c.iniciais, cor: c.cor,
      ativo: true, escolaIds: JSON.stringify(c.escolaIds || []), profId: c.prof ? c.prof.id : null,
      ...(senha ? { senhaHash: bcrypt.hashSync(senha, BCRYPT_CUSTO) } : {}),
    };
    if (existente) await prisma.usuario.update({ where: { id: c.id }, data: dados });
    else await prisma.usuario.create({ data: { id: c.id, ...dados } });
    contas.push({ email: c.email, perfil: c.perfil, criado: !existente, senha });
  }
  return { componenteCriado: !componenteExistente, habilidadesCriadas, contas };
}

async function main() {
  const prisma = new PrismaClient();
  try {
    const redefinirSenhas = process.argv.includes('--redefinir-senhas');
    const r = await prepararAmbienteTeste(prisma, { redefinirSenhas });
    console.log(`[ambiente teste] componente '${COMPONENTE_NOVO.id}' (${COMPONENTE_NOVO.nome}): ${r.componenteCriado ? 'criado' : 'já existia'}.`);
    console.log(`[ambiente teste] habilidades (História e Ciências): ${r.habilidadesCriadas} criada(s) de ${HABILIDADES_TESTE.length}.`);
    for (const c of r.contas) {
      const estado = c.criado ? 'criado' : 'já existia — dados reaplicados';
      const senha = c.senha ? `senha: ${c.senha}` : 'senha mantida';
      console.log(`[ambiente teste] ${c.perfil.padEnd(10)} ${c.email.padEnd(28)} ${estado}; ${senha}`);
    }
    if (r.contas.some(c => c.senha)) {
      console.log('[ambiente teste] Guarde as senhas acima: elas não são exibidas de novo (só com --redefinir-senhas).');
    }
  } finally {
    await prisma.$disconnect();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(err => {
    console.error('[ambiente teste] falhou:', err.message);
    process.exitCode = 1;
  });
}
