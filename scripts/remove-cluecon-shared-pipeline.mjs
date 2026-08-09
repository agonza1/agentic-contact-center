import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const outDir = path.resolve(repoRoot, "site", "cluecon-pages");
const outputFiles = ["index.html", "present/index.html", "404.html"];
const sharedPipelinePattern = /\n\s*<div class="shared-pipeline" aria-label="Shared streaming Pipecat voice-agent pipeline">[\s\S]*?<\/div>\n\s*<div class="integration-truths">/;

for (const relativePath of outputFiles) {
  const filePath = path.join(outDir, relativePath);
  const html = await readFile(filePath, "utf8");
  if (!sharedPipelinePattern.test(html)) {
    throw new Error(`Shared Pipecat pipeline block not found in ${relativePath}`);
  }
  const updated = html.replace(sharedPipelinePattern, '\n        <div class="integration-truths">');
  await writeFile(filePath, updated);
}

console.log("Removed shared Pipecat pipeline cards from ClueCon Pages output");
