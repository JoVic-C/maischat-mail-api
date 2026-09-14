# Build: compila o TypeScript
FROM node:22-alpine AS build
WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Runtime: só dependências de produção
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist

# Criados com o dono certo antes da montagem: o volume nomeado herda a permissão.
# data/imports fica fora de uploads, que é servido sem autenticação.
RUN mkdir -p /app/uploads /app/data/imports && chown -R node:node /app

USER node

EXPOSE 3000
CMD ["node", "dist/server.js"]
