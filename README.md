# Plataforma de Gestão Pedagógica — Backend (API)

API REST (Fastify + Prisma + PostgreSQL) da Plataforma de Gestão Pedagógica (maXXimiza).
O frontend fica em um repositório separado: **gestao-pedago-frontend**.

## Requisitos
- Node.js 18+
- PostgreSQL

## Configuração
```bash
npm install
cp .env.example .env   # ajuste DATABASE_URL e JWT_SECRET
```

## Banco de dados (Prisma)
```bash
npm run db:push    # aplica o schema no banco
npm run seed       # popula dados demo
# ou tudo de uma vez:
npm run db:reset   # db:push + seed
npm run studio     # abre o Prisma Studio
```

## Execução
```bash
npm run dev    # desenvolvimento (node --watch), porta 3334
npm start      # produção
```

## Testes
```bash
npm test             # suíte completa (node:test), exceto o legado test/api.test.js
npm test -- test/escopo-gestor.test.js   # só os arquivos indicados
npm run test:legado  # o legado — grava no banco real; só rode de propósito
```
Os testes usam o banco do `DATABASE_URL` e só criam registros descartáveis `QA*`, removidos
no fim de cada arquivo.

## Endpoints
- `GET /health` → `{ ok: true }`
- `/api/*` → rotas da aplicação (auth, meta, planejamentos, validações, avaliações,
  alunos, turmas, escolas, grupos, rede, relatórios, evolução, dashboard, timeline,
  componentes, habilidades, professores, admin).

CORS: por padrão libera todas as origens (dev). Em produção, defina `CORS_ORIGIN`
com o domínio do frontend (lista separada por vírgula).

## Login demo (após o seed)
Senha `demo123` para todos — domínio `@rededeensino.edu.br`:
- `beatriz@` — Secretaria de Educação
- `camila@` — Supervisor (somente visualização e análise)
- `paulo@` — Gestor Escolar (valida o planejamento docente) — `npm run demo:gestor-escolar`
- `helena@` — Professor
- `sergio@` — Administrador

## Contas de teste da equipe (`@maximizaedu.com`)
`npm run teste:preparar` cria (idempotente) 1 Secretário de Educação (`secretaria@`),
3 gestores escolares (`gestor1@`..`gestor3@`, um por escola) e 4 professores
(`professor1@`..`professor4@`, escolas e componentes diferentes: Língua Portuguesa,
Matemática, Ciências e História), além do componente História e de 20 habilidades da BNCC
(História 6º/7º ano e Ciências 4º/5º ano) que ainda não existam. Cada conta recebe uma
senha forte aleatória, impressa **uma única vez** na criação (não fica no repositório);
reexecutar mantém as senhas — `npm run teste:preparar -- --redefinir-senhas` gera novas.

## Implantação em produção — região do SAG, registros excluídos e limpeza do demo

> O banco de produção tem **dados reais**: nunca rode `db:reset` nem `seed`. Os scripts
> abaixo ficam em `scripts/`, são idempotentes e gravam **backup em JSON** antes de
> qualquer alteração (`--backup-dir <pasta>`; um backup existente nunca é sobrescrito).

A escola é localizada pela **região do SAG** (`Escola.regiao`) e pelo **grupo de escolas**
da plataforma (sem zona nem nível de leitura); turno e série vêm do SAG sem valores
inventados; registros excluídos no SAG (`deleted=true`) ficam **ocultos sem apagar**
(`excluidoNoSag`, filtro único em `src/lib/ativos.js`). O servidor sincroniza o SAG **na
subida** e a cada `SAG_SYNC_INTERVALO_MIN`, por isso os backups "antes" vêm antes do deploy:

1. **Schema (antes do deploy)**, de um checkout da versão nova com o `DATABASE_URL` de
   produção: `npm run db:push` — só aditivo, com defaults (`Escola.regiao`; `excluidoNoSag`
   em `Escola`, `Turma` e `Aluno`; índices). O código antigo continua funcionando.
2. **Backups "antes" (antes do deploy)**:
   ```bash
   npm run sag:regiao -- --backup-dir <pasta> --so-backup
   npm run sag:excluidos -- --backup-dir <pasta> --so-backup
   ```
3. **Deploy** do backend e do frontend.
4. **Pós-deploy**, nesta ordem:
   ```bash
   npm run sag:regiao -- --backup-dir <pasta>       # catálogo de séries + relatório
   npm run sag:excluidos -- --backup-dir <pasta>    # relatório visíveis × ocultos
   npm run migrar:perfis                            # só se ainda não rodou neste banco
   npm run limpar:demo-seed -- --dry-run
   npm run limpar:demo-seed -- --backup-dir <pasta> # professores e eventos fictícios do seed
   npm run helena:turmas-ativas -- --dry-run        # só se a conta helena@ existir
   npm run helena:turmas-ativas -- --backup-dir <pasta>
   npm run teste:preparar                           # opcional: contas de teste da equipe
   ```
5. **Conferência**: escolas, turmas e alunos do dashboard batem com os registros ativos do
   SAG; nenhuma tela mostra zona ou nível de leitura; os CSV saem em "Relatório da rede" e
   "Relatório da escola".
