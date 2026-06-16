import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(__dirname, "..", "..");

test("Docker runtime assets keep the documented health and proof contract", () => {
  const dockerfile = readFileSync(join(repoRoot, "Dockerfile"), "utf8");
  const compose = readFileSync(join(repoRoot, "docker-compose.yml"), "utf8");

  assert.match(dockerfile, /FROM node:20-bookworm-slim AS runtime/);
  assert.match(dockerfile, /ENV PORT=8026/);
  assert.match(dockerfile, /EXPOSE 8026/);
  assert.match(dockerfile, /HEALTHCHECK[\s\S]*fetch\('http:\/\/127\.0\.0\.1:' \+ \(process\.env\.PORT \|\| '8026'\) \+ '\/health'\)/);
  assert.match(dockerfile, /CMD \["node", "dist\/src\/index\.js"\]/);

  assert.match(compose, /app:\n[\s\S]*target: runtime/);
  assert.match(compose, /app:\n[\s\S]*ports:\n[\s\S]*- "8026:8026"/);
  assert.match(compose, /app:\n[\s\S]*healthcheck:/);
  assert.match(compose, /proof:\n[\s\S]*profiles: \["proof"\]/);
  assert.match(compose, /proof:\n[\s\S]*scripts\/demo-proof\.mjs/);
  assert.match(compose, /proof:\n[\s\S]*artifacts\/demo-proof-docker\.json/);
  assert.match(compose, /proof:\n[\s\S]*\.\/artifacts:\/app\/artifacts/);
});
