import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repoRoot = join(__dirname, "..", "..");

test("documentation validation catches Markdown drift against documented package scripts, Compose profiles, links, and routes", async () => {
  const result = await execFileAsync(process.execPath, ["scripts/validate-docs.mjs"], { cwd: repoRoot });

  assert.match(result.stdout, /Documentation validation passed:/);
  assert.match(result.stdout, /package scripts/);
  assert.match(result.stdout, /runtime command references/);
  assert.match(result.stdout, /runnable mode rows/);
  assert.match(result.stdout, /Compose profiles/);
  assert.match(result.stdout, /documented Docker profiles/);
  assert.match(result.stdout, /documented Compose profile references/);
  assert.match(result.stdout, /Compose services/);
  assert.match(result.stdout, /package Docker service references/);
  assert.match(result.stdout, /local Markdown links/);
  assert.match(result.stdout, /useful routes/);
  assert.match(result.stdout, /ACC URL routes/);
  assert.match(result.stdout, /reliability readiness routes/);
  assert.match(result.stdout, /reliability target mode contracts/);
  assert.match(result.stdout, /documented reliability target modes/);
  assert.match(result.stdout, /reliability target mode reference set/);
  assert.match(result.stdout, /documented reliability start commands/);
  assert.match(result.stdout, /reliability run profile contracts/);
  assert.match(result.stdout, /reliability evidence inventory contracts/);
  assert.match(result.stdout, /reliability handoff checklist contracts/);
  assert.match(result.stdout, /evidence-level vocabulary terms/);
  assert.match(result.stdout, /stack manifest keys/);
  assert.match(result.stdout, /README diagrams/);
  assert.match(result.stdout, /documented ports/);
  assert.match(result.stdout, /canonical ecosystem terms/);
  assert.match(result.stdout, /canonical ecosystem edges/);
  assert.match(result.stdout, /golden comparison rows/);
});

test("documentation validation rejects evidence levels that only contain vocabulary terms incidentally", async () => {
  const tempDir = await mkdtemp(join(os.tmpdir(), "agentic-contact-center-docs-validation-"));
  try {
    for (const entry of ["docs", "freeswitch", "scripts", "src", "stack"]) {
      await cp(join(repoRoot, entry), join(tempDir, entry), { recursive: true });
    }
    for (const file of ["docker-compose.yml", "package.json", "README.md"]) {
      await cp(join(repoRoot, file), join(tempDir, file));
    }

    const readmePath = join(tempDir, "README.md");
    const readme = await readFile(readmePath, "utf8");
    await writeFile(
      readmePath,
      readme.replace(
        "Caller-audible live proof when `pipecat:verto:live-proof` passes",
        "No Caller-audible live proof",
      ),
      "utf8",
    );

    await assert.rejects(
      execFileAsync(process.execPath, [join(repoRoot, "scripts/validate-docs.mjs")], { cwd: tempDir }),
      (error: unknown) => {
        const output = `${String((error as { stdout?: string }).stdout)}\n${String((error as { stderr?: string }).stderr)}`;
        assert.match(output, /mode "SIP\/Verto" evidence level/);
        return true;
      },
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
