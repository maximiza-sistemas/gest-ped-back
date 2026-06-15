/* ============================================================
   Entry point — carrega .env e sobe o servidor.
   ============================================================ */
import 'dotenv/config';
import { buildApp } from './app.js';

const PORT = Number(process.env.PORT || 3333);

const app = await buildApp();

try {
  await app.listen({ port: PORT, host: '0.0.0.0' });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
