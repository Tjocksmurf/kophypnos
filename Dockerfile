# One image for both Railway services; the start command picks web or worker.
#   web:    node dist/server.js
#   worker: node dist/worker.js
# The runtime stage is Playwright's image so Chromium is present for JS-rendered pages.
# Keep the playwright npm version in package.json pinned to the same version as this tag.

FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY client/package.json client/package-lock.json ./client/
RUN npm ci && npm --prefix client ci
COPY . .
RUN npm run build:server && npm --prefix client run build
RUN npm prune --omit=dev

FROM mcr.microsoft.com/playwright:v1.64.1-noble
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/drizzle ./drizzle
COPY --from=build /app/client/dist ./client/dist
EXPOSE 3000
USER pwuser
CMD ["node", "dist/server.js"]
