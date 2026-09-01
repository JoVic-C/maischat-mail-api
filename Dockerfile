# ─── Estágio 1: build (compila TypeScript → dist/) ───
FROM node:22-alpine AS build
WORKDIR /app

# Instala TODAS as dependências (inclui devDeps p/ compilar)
COPY package*.json ./
RUN npm ci

# Compila
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ─── Estágio 2: runtime (imagem enxuta, só o necessário) ───
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production

# Só dependências de produção
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Artefato compilado + package.json (server.js lê a versão dele)
COPY --from=build /app/dist ./dist

# Diretórios de dados criados com dono certo ANTES dos volumes serem montados —
# o Docker herda esta permissão ao criar o volume nomeado.
# /app/data/imports guarda os CSVs de importação. Fica FORA de /app/uploads de
# propósito: uploads é servido como estático sem autenticação, e um CSV desses é a
# base de contatos de um cliente.
RUN mkdir -p /app/uploads /app/data/imports && chown -R node:node /app

# Não roda como root: se a aplicação for comprometida, o atacante fica sem
# privilégio para escrever fora de /app.
USER node

EXPOSE 3000
CMD ["node", "dist/server.js"]
