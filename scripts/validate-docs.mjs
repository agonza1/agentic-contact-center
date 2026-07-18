#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
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

const readme = readText("README.md");
const packageJson = JSON.parse(readText("package.json"));
const compose = readText("docker-compose.yml");
const server = readText("src/http/createServer.ts");
const scripts = packageJson.scripts ?? {};

for (const scriptName of unique([...readme.matchAll(/\bnpm run ([A-Za-z0-9:_-]+)/g)].map((match) => match[1]))) {
  if (!scripts[scriptName]) {
    fail(`README documents missing npm script: ${scriptName}`);
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

const localLinks = unique([...readme.matchAll(/\[[^\]]+\]\((?!https?:\/\/|#)([^)#]+)(?:#[^)]+)?\)/g)].map((match) => match[1].trim()));
for (const link of localLinks) {
  if (!existsSync(path.join(repoRoot, link))) {
    fail(`README links to missing local path: ${link}`);
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

if (failures.length > 0) {
  console.error("Documentation validation failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(
  `Documentation validation passed: ${Object.keys(scripts).length} package scripts, ${composeProfiles.size} Compose profiles, ${localLinks.length} local links, ${documentedRoutes.length} useful routes.`,
);
