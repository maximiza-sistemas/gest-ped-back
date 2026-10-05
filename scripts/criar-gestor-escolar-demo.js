/* ============================================================
   Usuário demo de GESTOR ESCOLAR (perfil 'gestor').

   Idempotente: upsert por e-mail. Na criação a senha é 'demo123'
   com o mesmo hash usado por POST /admin/usuarios (bcryptjs,
   custo 10). Numa re-execução os dados de perfil/escolas são
   reaplicados, mas a senha NÃO é sobrescrita (preserva uma troca
   feita depois).

   Pré-requisito: a migração gestor → supervisor já ter rodado
   (marcador em Config). Sem ela, uma execução posterior da
   migração converteria este gestor escolar em supervisor — por
   isso o script recusa rodar antes.

   Uso (de dentro de backend/):
     node scripts/migrar-gestor-supervisor.js   (uma vez)
     node scripts/criar-gestor-escolar-demo.js
   ============================================================ */
import 'dotenv/config';
import { pathToFileURL } from 'node:url';
import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';
import { MARCADOR_MIGRACAO } from './migrar-gestor-supervisor.js';

const SENHA_DEMO = 'demo123';
const BCRYPT_CUSTO = 10; // igual a routes/admin.js

export const GESTOR_ESCOLAR_DEMO = Object.freeze({
  id: 'u-gestor-escolar',
  nome: 'Paulo Mendes',
  email: 'paulo@rededeensino.edu.br',
  perfil: 'gestor',
  cargo: 'Gestor Escolar',
  iniciais: 'PM',
  cor: '#0e7490',
  escolaIds: Object.freeze(['sag-18']),
});

/**
 * Cria (ou reaplica) o gestor escolar demo.
 * @param {import('@prisma/client').PrismaClient} prisma
 * @returns {Promise<{ criado: boolean, id: string }>}
 */
export async function criarGestorEscolarDemo(prisma) {
  const g = GESTOR_ESCOLAR_DEMO;

  const marcador = await prisma.config.findUnique({ where: { chave: MARCADOR_MIGRACAO } });
  if (!marcador) {
    throw new Error(`rode antes scripts/migrar-gestor-supervisor.js (marcador '${MARCADOR_MIGRACAO}' ausente).`);
  }

  const escolas = await prisma.escola.findMany({ where: { id: { in: [...g.escolaIds] } }, select: { id: true } });
  if (escolas.length !== g.escolaIds.length) {
    throw new Error(`escola(s) inexistente(s): ${g.escolaIds.filter(id => !escolas.some(e => e.id === id)).join(', ')}.`);
  }

  const existente = await prisma.usuario.findUnique({ where: { email: g.email } });
  if (existente && existente.id !== g.id) {
    throw new Error(`o e-mail ${g.email} já pertence a outro usuário (${existente.id}); nada foi alterado.`);
  }

  const dados = {
    nome: g.nome, perfil: g.perfil, cargo: g.cargo, iniciais: g.iniciais, cor: g.cor,
    ativo: true, escolaIds: JSON.stringify(g.escolaIds),
  };
  await prisma.usuario.upsert({
    where: { email: g.email },
    create: { id: g.id, email: g.email, senhaHash: bcrypt.hashSync(SENHA_DEMO, BCRYPT_CUSTO), ...dados },
    update: dados,
  });
  return { criado: !existente, id: g.id };
}

async function main() {
  const prisma = new PrismaClient();
  try {
    const r = await criarGestorEscolarDemo(prisma);
    console.log(`[gestor escolar demo] ${r.criado ? 'criado' : 'já existia — dados reaplicados (senha mantida)'}: ${GESTOR_ESCOLAR_DEMO.email} (${r.id}).`);
  } finally {
    await prisma.$disconnect();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(err => {
    console.error('[gestor escolar demo] falhou:', err.message);
    process.exitCode = 1;
  });
}
