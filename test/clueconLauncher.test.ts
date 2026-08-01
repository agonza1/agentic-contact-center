import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(__dirname, "..", "..");

test("ClueCon launcher makes rtc-asr readiness part of presentation startup", () => {
  const launcher = readFileSync(join(repoRoot, "scripts", "start-cluecon.mjs"), "utf8");
  const readme = readFileSync(join(repoRoot, "README.md"), "utf8");
  const packageJson = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
    scripts?: Record<string, string>;
  };

  assert.equal(packageJson.scripts?.cluecon, "npm run build && node scripts/start-cluecon.mjs");
  assert.match(readme, /npm run cluecon/);
  assert.match(launcher, /http:\/\/127\.0\.0\.1:8080/);
  assert.match(launcher, /\["compose", "up", "-d", "--build", "asr-service"\]/);
  assert.match(launcher, /RTC_ASR_BASE_URL: rtcAsrBaseUrl/);
  assert.match(launcher, /RTC_ASR_WS_URL: `\$\{rtcAsrBaseUrl\.replace\(\/\^http\/i, "ws"\)\}\/v1\/stt\/stream`/);
});
