import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(__dirname, "..", "..");

test("Docker runtime assets keep the documented health and proof contract", () => {
  const dockerfile = readFileSync(join(repoRoot, "Dockerfile"), "utf8");
  const compose = readFileSync(join(repoRoot, "docker-compose.yml"), "utf8");
  const readme = readFileSync(join(repoRoot, "README.md"), "utf8");
  const packageJson = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
    scripts?: Record<string, string>;
  };

  assert.match(dockerfile, /FROM node:20-bookworm-slim AS runtime/);
  assert.match(dockerfile, /ENV PORT=8026/);
  assert.match(dockerfile, /EXPOSE 8026/);
  assert.match(dockerfile, /HEALTHCHECK[\s\S]*scripts\/health-smoke\.mjs/);
  assert.match(dockerfile, /--expect-pipecat-prototype-mode pipecat_local_runtime/);
  assert.match(dockerfile, /--expect-pipecat-runtime-check-command "npm run pipecat:check"/);
  assert.match(dockerfile, /--expect-production-ready false/);
  assert.match(dockerfile, /--expect-production-readiness-blocker provider_credentials_mocked/);
  assert.match(dockerfile, /CMD \["node", "dist\/src\/index\.js"\]/);

  assert.match(compose, /app:\n[\s\S]*target: runtime/);
  assert.match(compose, /app:\n[\s\S]*ports:\n[\s\S]*- "8026:8026"/);
  assert.match(compose, /app:\n[\s\S]*healthcheck:/);
  assert.match(compose, /app:\n[\s\S]*scripts\/health-smoke\.mjs/);
  assert.match(compose, /app:\n[\s\S]*--expect-pipecat-prototype-mode/);
  assert.match(compose, /app:\n[\s\S]*npm run pipecat:check/);
  assert.match(compose, /app:\n[\s\S]*--expect-production-ready/);
  assert.match(compose, /app:\n[\s\S]*provider_credentials_mocked/);
  assert.match(compose, /proof:\n[\s\S]*profiles: \["proof"\]/);
  assert.match(compose, /proof:\n[\s\S]*scripts\/demo-proof\.mjs/);
  assert.match(compose, /proof:\n[\s\S]*artifacts\/demo-proof-docker\.json/);
  assert.match(compose, /proof:\n[\s\S]*\.\/artifacts:\/app\/artifacts/);
  assert.match(compose, /rtc-asr:\n[\s\S]*profiles: \["voice", "browser-webrtc", "sip", "sip-verto", "full"\]/);
  assert.match(compose, /rtc-asr:\n[\s\S]*ASR_VAD_FILTER: \${ASR_VAD_FILTER:-false}/);
  assert.match(compose, /kokoro:\n[\s\S]*profiles: \["voice", "browser-webrtc", "sip", "sip-verto", "full"\]/);
  assert.match(compose, /browser-webrtc-bridge:\n[\s\S]*target: voice-runtime/);
  assert.match(compose, /browser-webrtc-bridge:\n[\s\S]*RTC_ASR_WS_URL: ws:\/\/rtc-asr:8080\/v1\/stt\/stream/);
  assert.match(compose, /freeswitch:\n[\s\S]*profiles: \["freeswitch", "sip", "sip-verto", "full"\]/);
  assert.match(compose, /freeswitch:\n[\s\S]*"127\.0\.0\.1:8081:8081\/tcp"/);
  assert.match(compose, /freeswitch:\n[\s\S]*acc-pipecat\.xml/);
  assert.match(compose, /freeswitch:\n[\s\S]*verto\.conf\.xml/);
  assert.match(compose, /freeswitch-bridge:\n[\s\S]*scripts\/freeswitch-acc-bridge\.mjs/);
  assert.match(compose, /pipecat-verto-bridge:\n[\s\S]*target: voice-runtime/);
  assert.match(compose, /pipecat-verto-bridge:\n[\s\S]*scripts\/pipecat-verto-agent-bridge\.py/);
  assert.match(compose, /assert-viewer:\n[\s\S]*target: assert-runtime/);
  assert.match(compose, /assert-viewer:\n[\s\S]*scripts\/assert-viewer\.mjs/);

  assert.equal(packageJson.scripts?.["docker:app"], "docker compose up --build app");
  assert.equal(packageJson.scripts?.["health:smoke"], "node scripts/health-smoke.mjs --url http://127.0.0.1:8026/health");
  assert.equal(
    packageJson.scripts?.["docker:smoke"],
    "sh -c 'cleanup(){ docker compose down --remove-orphans; }; trap cleanup EXIT; docker compose up --build -d app && node scripts/health-smoke.mjs --url http://127.0.0.1:8026/health'",
  );
  assert.equal(
    packageJson.scripts?.["docker:proof"],
    "sh -c 'LOCAL_UID=${LOCAL_UID:-$(id -u)} LOCAL_GID=${LOCAL_GID:-$(id -g)} docker compose run --rm proof'",
  );
  assert.equal(packageJson.scripts?.["docker:voice"], "docker compose --profile voice up --build app rtc-asr kokoro");
  assert.equal(
    packageJson.scripts?.["docker:browser-webrtc"],
    "docker compose --profile browser-webrtc up --build app rtc-asr kokoro browser-webrtc-bridge",
  );
  assert.equal(
    packageJson.scripts?.["docker:sip-verto"],
    "docker compose --profile sip-verto up --build app freeswitch rtc-asr kokoro pipecat-verto-bridge",
  );
  assert.equal(packageJson.scripts?.["pipecat:verto:live-proof"], "node scripts/verto-sip-live-proof.mjs");
  assert.equal(packageJson.scripts?.["docker:sip"], "docker compose --profile sip up --build app freeswitch rtc-asr kokoro freeswitch-bridge");
  assert.equal(packageJson.scripts?.["docker:assert"], "docker compose --profile eval up --build assert-viewer");
  assert.equal(packageJson.scripts?.["docker:full"], "docker compose --profile full up --build");
  assert.equal(packageJson.scripts?.["docker:freeswitch:only"], "docker compose --profile freeswitch up -d freeswitch --no-deps");
  assert.match(readme, /npm run docker:app/);
  assert.match(readme, /npm run docker:smoke/);
  assert.match(readme, /npm run health:smoke/);
  assert.match(readme, /npm run docker:proof/);
  assert.match(readme, /npm run docker:voice/);
  assert.match(readme, /npm run docker:browser-webrtc/);
  assert.match(readme, /npm run docker:sip-verto/);
  assert.match(readme, /npm run docker:sip/);
  assert.match(readme, /npm run docker:assert/);
  assert.match(readme, /npm run docker:full/);
  assert.match(readme, /npm run docker:freeswitch:only/);
});
