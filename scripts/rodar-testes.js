/* ============================================================
   Executor da suíte de testes do backend (`npm test`).

   Roda todos os test/*.test.js com --test-concurrency=1, EXCETO o
   legado test/api.test.js — ele grava no banco real e tem falhas
   antigas; só roda de propósito, com `npm run test:legado`.
   (`node --test` sem lista de arquivos inclui tudo o que está em
   test/, por isso a lista explícita.)

   Uso (de dentro de backend/):
     npm test
     npm test -- test/escopo-gestor.test.js   (só os arquivos dados)
   ============================================================ */
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const LEGADOS = new Set(['api.test.js']);

const pedidos = process.argv.slice(2);
const arquivos = pedidos.length
  ? pedidos
  : readdirSync('test')
    .filter(f => f.endsWith('.test.js') && !LEGADOS.has(f))
    .sort()
    .map(f => join('test', f));

const r = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...arquivos], { stdio: 'inherit' });
process.exitCode = r.status ?? 1;
