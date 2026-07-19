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
COPY assets ./assets
RUN npm run build

FROM node:20-bookworm-slim AS runtime
WORKDIR /app

ENV PORT=8026

COPY --from=build /app/dist ./dist
COPY --from=build /app/config ./config
COPY --from=build /app/scripts ./scripts
COPY --from=build /app/assets ./assets

EXPOSE 8026
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 CMD node scripts/health-smoke.mjs --url http://127.0.0.1:${PORT:-8026}/health --timeout-ms 2500 --interval-ms 250 --expect-pipecat-ready true --expect-pipecat-prototype-mode pipecat_local_runtime --expect-pipecat-transport local_process --expect-pipecat-runtime-engine pipecat-ai --expect-pipecat-credentials-mode mocked --expect-pipecat-runtime-check-command "npm run pipecat:check" --expect-pipecat-runtime-check-live-telephony-required false --expect-production-ready false --expect-production-readiness-blocker live_telephony_not_enabled --expect-production-readiness-blocker provider_credentials_mocked --expect-production-readiness-blocker state_store_in_memory
CMD ["node", "dist/src/index.js"]

FROM runtime AS voice-runtime
USER root
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 python3-pip \
  && rm -rf /var/lib/apt/lists/*
COPY requirements-pipecat-voice.txt ./
RUN python3 -m pip install --break-system-packages --no-cache-dir --target .pipecat-runtime -r requirements-pipecat-voice.txt
EXPOSE 8766

FROM runtime AS assert-runtime
USER root
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*
EXPOSE 5174
