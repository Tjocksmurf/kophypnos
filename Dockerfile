# One image for both Railway services; the start command picks web or worker.
#   web:    node dist/server.js
#   worker: node dist/worker.js

FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY client/package.json client/package-lock.json ./client/
RUN npm ci && npm --prefix client ci
COPY . .
RUN npm run build:server && npm --prefix client run build
RUN npm prune --omit=dev

FROM node:22-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/drizzle ./drizzle
COPY --from=build /app/client/dist ./client/dist
EXPOSE 3000
USER node
CMD ["node", "dist/server.js"]
