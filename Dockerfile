FROM node:20-bookworm-slim AS deps
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

FROM deps AS build
COPY tsconfig.json ./
COPY src ./src
COPY test ./test
COPY scripts ./scripts
COPY config ./config
RUN npm run build

FROM node:20-bookworm-slim AS runtime
WORKDIR /app

ENV PORT=8026

COPY --from=build /app/dist ./dist
COPY --from=build /app/config ./config
COPY --from=build /app/scripts ./scripts

EXPOSE 8026
CMD ["node", "dist/src/index.js"]
