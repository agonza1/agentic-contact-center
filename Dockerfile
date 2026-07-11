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
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 CMD node scripts/health-smoke.mjs --url http://127.0.0.1:${PORT:-8026}/health --timeout-ms 2500 --interval-ms 250 --expect-pipecat-ready true --expect-pipecat-prototype-mode pipecat_local_runtime --expect-pipecat-transport local_process --expect-pipecat-runtime-engine pipecat-ai --expect-pipecat-credentials-mode mocked --expect-pipecat-runtime-check-command "npm run pipecat:check" --expect-pipecat-runtime-check-live-telephony-required false --expect-production-ready false --expect-production-readiness-blocker live_telephony_not_enabled --expect-production-readiness-blocker provider_credentials_mocked --expect-production-readiness-blocker state_store_in_memory --expect-speech-enhancement-runtime-enabled false --expect-speech-enhancement-runtime-status disabled --expect-speech-enhancement-issue-close-ready false --expect-speech-enhancement-close-gate-status blocked_before_real_capture --expect-speech-enhancement-live-demo-gate blocked_until_real_capture --expect-speech-enhancement-recommended-latency-ms 12.5 --expect-speech-enhancement-runtime-latency-ms 12.5 --expect-speech-enhancement-runtime-bypass-reason feature_flag_disabled --expect-speech-enhancement-missing-evidence real_noisy_local_sip_capture_baseline_vs_enhanced_replay
CMD ["node", "dist/src/index.js"]
