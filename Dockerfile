# API Fastify + Prisma
FROM node:20-alpine
WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
# gera o Prisma Client (sem isso: "@prisma/client did not initialize")
RUN npx prisma generate

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

# O schema é aplicado ao banco com `npx prisma db push` (rode uma vez no
# console do serviço). NÃO use db:reset/seed em produção real.
CMD ["node", "src/server.js"]
