import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");

const assertRepoUrl = process.env.ASSERT_REPO_URL || "https://github.com/responsibleai/ASSERT.git";
const assertViewerRoot = path.resolve(repoRoot, process.env.ASSERT_VIEWER_DIR || ".assert-viewer");
const assertViewerDir = path.join(assertViewerRoot, "viewer");
const artifactsRoot = path.resolve(repoRoot, process.env.ARTIFACTS_ROOT || "artifacts/results");
const installOnly = process.argv.includes("--install-only");

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: "inherit",
      shell: false,
      ...options,
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(" ")} exited with ${code}`));
    });
  });
}

async function ensureViewerCheckout() {
  if (existsSync(path.join(assertViewerRoot, ".git")) && existsSync(assertViewerDir)) return;
  await mkdir(path.dirname(assertViewerRoot), { recursive: true });
  await run("git", ["clone", "--depth", "1", assertRepoUrl, assertViewerRoot], { cwd: repoRoot });
}

async function ensureViewerInstall() {
  if (existsSync(path.join(assertViewerDir, "node_modules"))) return;
  await run("npm", ["install"], { cwd: assertViewerDir });
}

async function main() {
  await ensureViewerCheckout();
  await ensureViewerInstall();

  console.log(`ASSERT viewer checkout: ${path.relative(repoRoot, assertViewerDir)}`);
  console.log(`ASSERT artifacts root: ${path.relative(repoRoot, artifactsRoot)}`);

  if (installOnly) return;

  console.log("Starting upstream ASSERT viewer at http://127.0.0.1:5174");
  await run("npm", ["run", "dev", "--", "--host", "127.0.0.1", "--port", "5174"], {
    cwd: assertViewerDir,
    env: {
      ...process.env,
      ARTIFACTS_ROOT: artifactsRoot,
    },
  });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
