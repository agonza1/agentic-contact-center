#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const repoRoot = process.cwd();
const failures = [];

function readText(relativePath) {
  return readFileSync(path.join(repoRoot, relativePath), "utf8");
}

function fail(message) {
  failures.push(message);
}

function unique(values) {
  return [...new Set(values)].sort();
}

function markdownSources() {
  const docsDir = path.join(repoRoot, "docs");
  const docs = existsSync(docsDir)
    ? readdirSync(docsDir)
        .filter((entry) => entry.endsWith(".md"))
        .map((entry) => path.join("docs", entry))
    : [];
  return ["README.md", ...docs];
}

function localMarkdownLinks(sourcePath, text) {
  return [...text.matchAll(/\[[^\]]+\]\((?!https?:\/\/|#)([^)#]+)(?:#[^)]+)?\)/g)].map((match) => ({
    sourcePath,
    href: match[1].trim(),
  }));
}

const readme = readText("README.md");
const packageJson = JSON.parse(readText("package.json"));
const compose = readText("docker-compose.yml");
const server = readText("src/http/createServer.ts");
const cluecon = readText("src/http/cluecon.ts");
const scripts = packageJson.scripts ?? {};

for (const sourcePath of markdownSources()) {
  const source = readText(sourcePath);
  for (const scriptName of unique([...source.matchAll(/\bnpm run ([A-Za-z0-9:_-]+)/g)].map((match) => match[1]))) {
    if (!scripts[scriptName]) {
      fail(`${sourcePath} documents missing npm script: ${scriptName}`);
    }
  }
}

const composeProfiles = new Set();
for (const match of compose.matchAll(/profiles:\s*\[([^\]]+)\]/g)) {
  for (const profile of match[1].split(",")) {
    const normalized = profile.trim().replace(/^["']|["']$/g, "");
    if (normalized) composeProfiles.add(normalized);
  }
}

const documentedProfiles = unique([...readme.matchAll(/`([A-Za-z0-9_-]+)`(?=[:\s-])/g)].map((match) => match[1])).filter((value) =>
  ["voice", "browser-webrtc", "sip-verto", "sip", "eval", "full", "freeswitch"].includes(value),
);
for (const profile of documentedProfiles) {
  if (!composeProfiles.has(profile)) {
    fail(`README documents missing Compose profile: ${profile}`);
  }
}

for (const [scriptName, command] of Object.entries(scripts)) {
  for (const profile of command.matchAll(/docker compose --profile ([A-Za-z0-9_-]+)/g)) {
    if (!composeProfiles.has(profile[1])) {
      fail(`package script ${scriptName} uses missing Compose profile: ${profile[1]}`);
    }
  }
}

const localLinks = markdownSources().flatMap((sourcePath) => localMarkdownLinks(sourcePath, readText(sourcePath)));
const checkedLocalLinks = unique(localLinks.map((link) => `${link.sourcePath}:${link.href}`));
for (const link of localLinks) {
  const target = path.normalize(path.join(repoRoot, path.dirname(link.sourcePath), link.href));
  const relativeTarget = path.relative(repoRoot, target);
  if (relativeTarget.startsWith("..") || path.isAbsolute(relativeTarget) || !existsSync(target)) {
    fail(`${link.sourcePath} links to missing local path: ${link.href}`);
  }
}

const usefulRoutesSection = readme.match(/## Useful Routes\n\n([\s\S]*?)(?:\n## |\n# |$)/)?.[1] ?? "";
const documentedRoutes = unique([...usefulRoutesSection.matchAll(/^- `([^`]+)`:/gm)].map((match) => match[1]));
for (const route of documentedRoutes) {
  const pathname = route.split("/:")[0];
  if (!server.includes(`"${pathname}"`) && !server.includes(`\`${pathname}`) && !server.includes(`'${pathname}'`)) {
    fail(`README documents route not registered in createServer.ts: ${route}`);
  }
}

const mermaidDiagramCount = [...readme.matchAll(/```mermaid/g)].length;
if (mermaidDiagramCount > 3) {
  fail(`README contains ${mermaidDiagramCount} primary Mermaid diagrams; #307 allows at most 3`);
}

const requiredReadmePhrases = [
  "A Voice Agent Reliability Reference Stack by",
  "reference implementation and demo-ready lab, not production-ready",
  "ACC Reliability Lab",
  "ConversationAgentEvals",
  "rtc-asr",
  "ASSERT",
  "Reliability lab status",
  "legacy ACC-local eval spec surface; CAE owns generic spec editing",
];
for (const phrase of requiredReadmePhrases) {
  if (!readme.includes(phrase)) {
    fail(`README is missing required #307 phrase: ${phrase}`);
  }
}

const staleOrOverclaimingReadmePhrases = [
  "runnable ClueCon 2026 proof of concept",
  "SIP caller-audible playback proof is not complete",
  "FlowManager should own",
  "current demo proves contracts, not the finished shared-media architecture",
];
for (const phrase of staleOrOverclaimingReadmePhrases) {
  if (readme.includes(phrase)) {
    fail(`README still contains stale or overclaiming wording: ${phrase}`);
  }
}

const requiredClueConPhrases = [
  "Voice Agent Reliability Reference Stack",
  "ACC integrates the demo and proof surface without owning ConversationAgentEvals, rtc-asr, or ASSERT",
  "strict local SIP/Verto proof is accepted",
];
for (const phrase of requiredClueConPhrases) {
  if (!cluecon.includes(phrase)) {
    fail(`ClueCon payload is missing current ecosystem wording: ${phrase}`);
  }
}

const readmePorts = unique([...readme.matchAll(/\b(?:127\.0\.0\.1|localhost):(\d{2,5})\b/g)].map((match) => match[1]));
for (const port of readmePorts) {
  if (!compose.includes(`:${port}`) && !server.includes(port) && !readme.includes(`port ${port}`) && !readme.includes(`on \`${port}\``)) {
    fail(`README documents port ${port} without matching Compose/server/reference evidence`);
  }
}

if (failures.length > 0) {
  console.error("Documentation validation failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(
  `Documentation validation passed: ${Object.keys(scripts).length} package scripts, ${composeProfiles.size} Compose profiles, ${checkedLocalLinks.length} local Markdown links, ${documentedRoutes.length} useful routes, ${mermaidDiagramCount} README diagrams, ${readmePorts.length} documented ports.`,
);
