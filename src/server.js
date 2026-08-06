/* ============================================================
   Entry point — carrega .env e sobe o servidor.
   ============================================================ */
import 'dotenv/config';
import { buildApp } from './app.js';
import { sincronizarSag, sagConfigurado } from './lib/sagsync.js';

const PORT = Number(process.env.PORT || 3333);

const app = await buildApp();

try {
  await app.listen({ port: PORT, host: '0.0.0.0' });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

// Espelho do SAG (escolas/turmas/alunos): sincroniza na subida e em intervalos.
if (sagConfigurado()) {
  const intervaloMin = Number(process.env.SAG_SYNC_INTERVALO_MIN || 30);
  const rodar = async () => {
    const rel = await sincronizarSag(app.prisma).catch(err => ({ ok: false, erro: err.message }));
    if (rel.ok) app.log.info({ sag: rel }, 'espelho do SAG sincronizado');
    else app.log.error({ sag: rel }, 'falha ao sincronizar o espelho do SAG');
  };
  rodar();
  setInterval(rodar, intervaloMin * 60 * 1000).unref();
} else {
  app.log.info('espelho do SAG desativado — defina a senha em SAG_DATABASE_URL no backend/.env');
}
