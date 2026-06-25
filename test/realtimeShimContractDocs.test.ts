import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(__dirname, "..", "..");

test("Realtime shim contract documents the Local STT v1 lifecycle mapping", () => {
  const readme = readFileSync(join(repoRoot, "README.md"), "utf8");
  const backlog = readFileSync(join(repoRoot, "BACKLOG.md"), "utf8");
  const contract = readFileSync(join(repoRoot, "docs", "realtime-shim-contract.md"), "utf8");

  assert.match(readme, /docs\/realtime-shim-contract\.md/);
  assert.match(backlog, /CUE-008 Realtime shim adapter contract/);

  for (const requiredPhrase of [
    "input_audio_buffer.append",
    "input_audio_buffer.commit",
    "input_audio_buffer.clear",
    "response.cancel",
    "Local STT v1",
    "binary PCM16",
    "finalize",
    "cancel",
    "error",
    "closed",
    "rtc-asr` issue `#203`",
  ]) {
    assert.ok(contract.includes(requiredPhrase), `missing contract phrase: ${requiredPhrase}`);
  }
});
