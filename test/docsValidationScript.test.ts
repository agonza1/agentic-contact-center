import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repoRoot = join(__dirname, "..", "..");

test("documentation validation catches Markdown drift against package scripts, Compose profiles, links, and routes", async () => {
  const result = await execFileAsync(process.execPath, ["scripts/validate-docs.mjs"], { cwd: repoRoot });

  assert.match(result.stdout, /Documentation validation passed:/);
  assert.match(result.stdout, /package scripts/);
  assert.match(result.stdout, /Compose profiles/);
  assert.match(result.stdout, /local Markdown links/);
  assert.match(result.stdout, /useful routes/);
  assert.match(result.stdout, /README diagrams/);
  assert.match(result.stdout, /documented ports/);
});
