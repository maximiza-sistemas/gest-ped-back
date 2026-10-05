/* ============================================================
   Migração ÚNICA de perfis: 'gestor' (antigo gestor de polo) →
   'supervisor' (visualização e análise, sem intervenção direta).

   A partir desta mudança a chave 'gestor' passa a significar
   GESTOR ESCOLAR (valida o planejamento docente). Por isso a
   conversão roda uma única vez: o marcador na tabela Config
   (chave 'migracaoGestorSupervisor') registra a execução e, se
   já existir, nada é alterado — gestores escolares criados
   depois da migração NUNCA são convertidos.

   Não apaga nada; só altera Usuario.perfil. O marcador guarda os
   ids migrados (auditoria / eventual reversão manual).

   Segundo passo (idempotente, roda sempre): os usuários migrados
   cujo cargo ainda é o PADRÃO do antigo perfil ("Gestora Escolar /
   Coordenadora") passam a "Supervisora" — "Gestor Escolar" agora
   nomeia o outro perfil. Cargo digitado à mão é preservado. Cada
   ajuste é registrado no marcador (campo `cargos`).

   Uso (de dentro de backend/):
     node scripts/migrar-gestor-supervisor.js
   ============================================================ */
import 'dotenv/config';
import { pathToFileURL } from 'node:url';
import { PrismaClient } from '@prisma/client';

export const MARCADOR_MIGRACAO = 'migracaoGestorSupervisor';

/** Cargo padrão do antigo perfil (seed/demo) → cargo equivalente de supervisor. */
export const CARGOS_PADRAO_ANTIGOS = {
  'Gestora Escolar / Coordenadora': 'Supervisora',
  'Gestor Escolar / Coordenador': 'Supervisor',
};

const parseJSON = (s, fb) => { try { return JSON.parse(s); } catch { return fb; } };

/**
 * Converte os usuários 'gestor' em 'supervisor', uma única vez.
 * @param {import('@prisma/client').PrismaClient} prisma
 * @returns {Promise<{ executada: boolean, migrados: number, ids: string[] }>}
 */
export async function migrarGestorSupervisor(prisma) {
  return prisma.$transaction(async tx => {
    const marcador = await tx.config.findUnique({ where: { chave: MARCADOR_MIGRACAO } });
    if (marcador) return { executada: false, migrados: 0, ids: [] };

    const alvos = await tx.usuario.findMany({ where: { perfil: 'gestor' }, select: { id: true } });
    const ids = alvos.map(u => u.id);
    const { count } = await tx.usuario.updateMany({
      where: { id: { in: ids }, perfil: 'gestor' },
      data: { perfil: 'supervisor' },
    });
    // o create falha (chave duplicada) se outra execução concorrente gravou o
    // marcador primeiro — a transação inteira é desfeita nesse caso
    await tx.config.create({
      data: {
        chave: MARCADOR_MIGRACAO,
        valor: JSON.stringify({ em: new Date().toISOString(), migrados: count, ids }),
      },
    });
    return { executada: true, migrados: count, ids };
  });
}

/**
 * Troca o cargo padrão do antigo perfil pelo de supervisor, só nos usuários
 * que a migração converteu (ids do marcador) e que continuam supervisores.
 * Idempotente: quando nenhum cargo casa com o padrão antigo, nada é gravado.
 * @param {import('@prisma/client').PrismaClient} prisma
 * @returns {Promise<{ ajustados: number, ids: string[] }>}
 */
export async function ajustarCargosMigrados(prisma) {
  return prisma.$transaction(async tx => {
    const marcador = await tx.config.findUnique({ where: { chave: MARCADOR_MIGRACAO } });
    if (!marcador) return { ajustados: 0, ids: [] }; // migração ainda não rodou
    const info = parseJSON(marcador.valor, {}) || {};
    const migrados = Array.isArray(info.ids) ? info.ids : [];
    if (!migrados.length) return { ajustados: 0, ids: [] };

    const alvos = await tx.usuario.findMany({
      where: { id: { in: migrados }, perfil: 'supervisor', cargo: { in: Object.keys(CARGOS_PADRAO_ANTIGOS) } },
      select: { id: true, cargo: true },
    });
    const ajustes = [];
    for (const u of alvos) {
      const para = CARGOS_PADRAO_ANTIGOS[u.cargo];
      // o where com o cargo antigo evita sobrescrever uma edição concorrente
      const { count } = await tx.usuario.updateMany({ where: { id: u.id, cargo: u.cargo }, data: { cargo: para } });
      if (count) ajustes.push({ id: u.id, de: u.cargo, para });
    }
    if (ajustes.length) {
      const cargos = Array.isArray(info.cargos) ? info.cargos : [];
      await tx.config.update({
        where: { chave: MARCADOR_MIGRACAO },
        data: { valor: JSON.stringify({ ...info, cargos: [...cargos, { em: new Date().toISOString(), ajustes }] }) },
      });
    }
    return { ajustados: ajustes.length, ids: ajustes.map(a => a.id) };
  });
}

async function main() {
  const prisma = new PrismaClient();
  try {
    const r = await migrarGestorSupervisor(prisma);
    if (!r.executada) {
      console.log(`[migração] marcador '${MARCADOR_MIGRACAO}' já existe — nada a fazer (0 usuários alterados).`);
    } else {
      console.log(`[migração] ${r.migrados} usuário(s) migrado(s) de 'gestor' para 'supervisor'${r.ids.length ? ': ' + r.ids.join(', ') : ''}.`);
    }
    const c = await ajustarCargosMigrados(prisma);
    console.log(`[migração] cargo padrão antigo ajustado para supervisor em ${c.ajustados} usuário(s)${c.ids.length ? ': ' + c.ids.join(', ') : ''}.`);
  } finally {
    await prisma.$disconnect();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(err => {
    console.error('[migração] falhou:', err.message);
    process.exitCode = 1;
  });
}
