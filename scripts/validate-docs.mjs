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

function constStringArray(source, constName) {
  const escapedName = constName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = source.match(new RegExp(`const\\s+${escapedName}\\s*=\\s*\\[([\\s\\S]*?)\\];`));
  if (!match) return null;
  return unique([...match[1].matchAll(/"([^"]+)"/g)].map((item) => item[1]));
}

function sameValues(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function extractReliabilityTargetModes(source, sourceLabel) {
  const modes = new Map();
  const matches = [...source.matchAll(/\n\s*\{\n\s*mode:\s*"([^"]+)",/g)];
  for (let index = 0; index < matches.length; index += 1) {
    const mode = matches[index][1];
    const start = matches[index].index ?? 0;
    const end = matches[index + 1]?.index ?? source.length;
    const block = source.slice(start, end);
    const field = (fieldName) => block.match(new RegExp(`${fieldName}:\\s*"([^"]+)"`))?.[1] ?? null;
    const contract = {
      mode,
      startCommand: field("startCommand"),
      validationCommand: field("validationCommand"),
      evidenceCommand: field("evidenceCommand"),
      readinessRoute: field("readinessRoute"),
      caeHandoffCommand: field("caeHandoffCommand"),
    };
    if (Object.values(contract).some((value) => value === null)) {
      continue;
    }
    if (modes.has(mode)) {
      fail(`${sourceLabel} declares duplicate reliability target mode: ${mode}`);
    }
    modes.set(mode, contract);
  }
  return modes;
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
const reliabilityLabStatusScript = readText("scripts/reliability-lab-status.mjs");
const stackManifest = readText("stack/versions.env");
const reliabilityLabDoc = readText("docs/reliability-lab.md");
const scripts = packageJson.scripts ?? {};

for (const sourcePath of markdownSources()) {
  const source = readText(sourcePath);
  for (const scriptName of unique([...source.matchAll(/\bnpm run ([A-Za-z0-9:_-]+)/g)].map((match) => match[1]))) {
    if (!scripts[scriptName]) {
      fail(`${sourcePath} documents missing npm script: ${scriptName}`);
    }
  }
}

const runtimeCommandSources = [
  ["src/http/createServer.ts", server],
  ["src/http/cluecon.ts", cluecon],
  ["scripts/reliability-lab-status.mjs", reliabilityLabStatusScript],
];
const runtimeScriptCommands = unique(
  runtimeCommandSources.flatMap(([sourcePath, source]) =>
    [...source.matchAll(/\bnpm run ([A-Za-z0-9:_-]+)/g)].map((match) => `${sourcePath}\0${match[1]}`),
  ),
);
for (const command of runtimeScriptCommands) {
  const [sourcePath, scriptName] = command.split("\0");
  if (!scripts[scriptName]) {
    fail(`${sourcePath} exposes missing npm script: ${scriptName}`);
  }
}

const composeProfiles = new Set();
for (const match of compose.matchAll(/profiles:\s*\[([^\]]+)\]/g)) {
  for (const profile of match[1].split(",")) {
    const normalized = profile.trim().replace(/^["']|["']$/g, "");
    if (normalized) composeProfiles.add(normalized);
  }
}

const documentedComposeProfileReferences = unique(
  markdownSources().flatMap((sourcePath) =>
    [...readText(sourcePath).matchAll(/docker compose\b[^\n`]*?--profile\s+([A-Za-z0-9_-]+)/g)].map(
      (match) => `${sourcePath}\0${match[1]}`,
    ),
  ),
);
for (const reference of documentedComposeProfileReferences) {
  const [sourcePath, profile] = reference.split("\0");
  if (!composeProfiles.has(profile)) {
    fail(`${sourcePath} documents missing Compose profile: ${profile}`);
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

const documentedAccUrls = unique(
  markdownSources().flatMap((sourcePath) =>
    [...readText(sourcePath).matchAll(/\bhttps?:\/\/(?:127\.0\.0\.1|localhost):8026(\/[A-Za-z0-9/_:.-]*)/g)].map(
      (match) => `${sourcePath}\0${match[1]}`,
    ),
  ),
);
for (const reference of documentedAccUrls) {
  const [sourcePath, route] = reference.split("\0");
  const pathname = route.split("/:")[0];
  if (!server.includes(`"${pathname}"`) && !server.includes(`\`${pathname}`) && !server.includes(`'${pathname}'`)) {
    fail(`${sourcePath} documents ACC URL route not registered in createServer.ts: ${route}`);
  }
}

const reliabilityReadinessRoutes = unique(
  [...reliabilityLabStatusScript.matchAll(/readinessRoute:\s*"([^"]+)"/g)].map((match) => match[1]),
);
for (const route of reliabilityReadinessRoutes) {
  const pathname = route.split("/:")[0];
  if (!server.includes(`"${pathname}"`) && !server.includes(`\`${pathname}`) && !server.includes(`'${pathname}'`)) {
    fail(`scripts/reliability-lab-status.mjs references readiness route not registered in createServer.ts: ${route}`);
  }
}

const statusEndpointEnvVars = constStringArray(reliabilityLabStatusScript, "optionalEndpointEnvVars");
const apiEndpointEnvVars = constStringArray(server, "reliabilityOptionalEndpointEnvVars");
if (!statusEndpointEnvVars) {
  fail("scripts/reliability-lab-status.mjs is missing optionalEndpointEnvVars");
}
if (!apiEndpointEnvVars) {
  fail("src/http/createServer.ts is missing reliabilityOptionalEndpointEnvVars");
}
if (statusEndpointEnvVars && apiEndpointEnvVars && !sameValues(statusEndpointEnvVars, apiEndpointEnvVars)) {
  fail("reliability optional endpoint env vars differ between status CLI and API");
}

const endpointEnvSection =
  reliabilityLabDoc.match(/Environment variables recognized by the status command:\n\n([\s\S]*?)(?:\n\n|$)/)?.[1] ?? "";
const documentedEndpointEnvVars = unique([...endpointEnvSection.matchAll(/`([A-Z0-9_]+)`/g)].map((match) => match[1]));
if (statusEndpointEnvVars && !sameValues(statusEndpointEnvVars, documentedEndpointEnvVars)) {
  fail("docs/reliability-lab.md endpoint env var list differs from status CLI contract");
}

const apiTargetModes = extractReliabilityTargetModes(server, "src/http/createServer.ts");
const cliTargetModes = extractReliabilityTargetModes(reliabilityLabStatusScript, "scripts/reliability-lab-status.mjs");
if (apiTargetModes.size === 0) {
  fail("src/http/createServer.ts exposes no reliability target mode contracts");
}
if (cliTargetModes.size === 0) {
  fail("scripts/reliability-lab-status.mjs exposes no reliability target mode contracts");
}
if (!sameValues([...apiTargetModes.keys()].sort(), [...cliTargetModes.keys()].sort())) {
  fail("reliability target mode names differ between API and status CLI");
}
for (const [mode, apiContract] of apiTargetModes) {
  const cliContract = cliTargetModes.get(mode);
  if (!cliContract) continue;
  for (const fieldName of Object.keys(apiContract).filter((field) => field !== "mode")) {
    if (apiContract[fieldName] !== cliContract[fieldName]) {
      fail(`reliability target mode ${mode} ${fieldName} differs between API and status CLI`);
    }
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
  "stack/versions.env",
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
  "From SIP to Tokens: Deterministic Telephony Meets Real-Time Voice AI",
  "FreeSWITCH keeps SIP dialogs and RTP media bounded",
  "strict local SIP/Verto proof is accepted",
];
for (const phrase of requiredClueConPhrases) {
  if (!cluecon.includes(phrase)) {
    fail(`ClueCon payload is missing current ecosystem wording: ${phrase}`);
  }
}

const requiredStackManifestKeys = [
  "ACC_APP_IMAGE",
  "ACC_APP_URL",
  "RTC_ASR_IMAGE",
  "RTC_ASR_BASE_URL",
  "KOKORO_IMAGE",
  "KOKORO_BASE_URL",
  "PIPECAT_BROWSER_BRIDGE_URL",
  "FREESWITCH_IMAGE",
  "FREESWITCH_VERTO_URL",
  "CAE_API_URL",
  "CAE_WEB_URL",
  "ASSERT_VIEWER_URL",
];
for (const key of requiredStackManifestKeys) {
  if (!stackManifest.match(new RegExp(`^${key}=`, "m"))) {
    fail(`stack/versions.env is missing required key: ${key}`);
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
  `Documentation validation passed: ${Object.keys(scripts).length} package scripts, ${runtimeScriptCommands.length} runtime command references, ${composeProfiles.size} Compose profiles, ${documentedComposeProfileReferences.length} documented Compose profile references, ${checkedLocalLinks.length} local Markdown links, ${documentedRoutes.length} useful routes, ${documentedAccUrls.length} ACC URL routes, ${reliabilityReadinessRoutes.length} reliability readiness routes, ${apiTargetModes.size} reliability target mode contracts, ${mermaidDiagramCount} README diagrams, ${readmePorts.length} documented ports.`,
);
