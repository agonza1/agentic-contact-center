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
  assert.match(dockerfile, /HEALTHCHECK[\s\S]*fetch\('http:\/\/127\.0\.0\.1:' \+ \(process\.env\.PORT \|\| '8026'\) \+ '\/health'\)/);
  assert.match(dockerfile, /payload\.ok !== true/);
  assert.match(dockerfile, /CMD \["node", "dist\/src\/index\.js"\]/);

  assert.match(compose, /app:\n[\s\S]*target: runtime/);
  assert.match(compose, /app:\n[\s\S]*ports:\n[\s\S]*- "8026:8026"/);
  assert.match(compose, /app:\n[\s\S]*healthcheck:/);
  assert.match(compose, /app:\n[\s\S]*payload\.ok!==true/);
  assert.match(compose, /proof:\n[\s\S]*profiles: \["proof"\]/);
  assert.match(compose, /proof:\n[\s\S]*scripts\/demo-proof\.mjs/);
  assert.match(compose, /proof:\n[\s\S]*artifacts\/demo-proof-docker\.json/);
  assert.match(compose, /proof:\n[\s\S]*\.\/artifacts:\/app\/artifacts/);

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
  assert.match(readme, /npm run docker:app/);
  assert.match(readme, /npm run docker:smoke/);
  assert.match(readme, /npm run health:smoke/);
  assert.match(readme, /npm run docker:proof/);
});
