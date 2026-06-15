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

## Endpoints
- `GET /health` → `{ ok: true }`
- `/api/*` → rotas da aplicação (auth, meta, planejamentos, orientações, avaliações,
  leitura, alunos, turmas, escolas, grupos, rede, dashboard, timeline, admin).

CORS: por padrão libera todas as origens (dev). Em produção, defina `CORS_ORIGIN`
com o domínio do frontend (lista separada por vírgula).

## Login demo (após o seed)
Senha `demo123` para todos — domínio `@rededeensino.edu.br`:
- `beatriz@` — Secretaria de Educação
- `camila@` — Gestor Escolar/Coordenador
- `helena@` — Professor
- `sergio@` — Administrador
