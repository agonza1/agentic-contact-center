import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadPocConfig } from "../dist/src/config/loadPocConfig.js";
import { buildClueConHtml, defaultClueConBrainBlocks } from "../dist/src/http/cluecon.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const outDir = path.resolve(repoRoot, "site", "cluecon-pages");

function pagesHtml(mode) {
  const html = buildClueConHtml(loadPocConfig(), mode, defaultClueConBrainBlocks());
  return html
    .replace(
      "</style>",
      `.pages-notice { margin: 0; padding: 10px 22px; border-bottom: 1px solid var(--line); background: #fff8e8; color: #553504; font-size: 13px; font-weight: 700; }\n  </style>`,
    )
    .replace(
      "<main>",
      '<div class="pages-notice">Static GitHub Pages snapshot. Live proof buttons and operator actions are available from the local runtime server.</div><main>',
    )
    .replaceAll('href="/cluecon/present"', 'href="./present/"')
    .replaceAll('href="/cluecon"', 'href="./"')
    .replaceAll(
      'href="/operator/console"',
      'href="https://github.com/agonza1/agentic-contact-center#readme"',
    )
    .replaceAll(
      'href="/assert"',
      'href="https://github.com/agonza1/agentic-contact-center#readme"',
    );
}

await rm(outDir, { recursive: true, force: true });
await mkdir(path.join(outDir, "present"), { recursive: true });
await writeFile(path.join(outDir, "index.html"), pagesHtml("scroll"));
await writeFile(path.join(outDir, "present", "index.html"), pagesHtml("present"));
await writeFile(path.join(outDir, ".nojekyll"), "");

console.log(`Exported ClueCon GitHub Pages site to ${path.relative(repoRoot, outDir)}`);
