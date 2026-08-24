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

function stringArrayField(block, fieldName) {
  const match = block.match(new RegExp(`${fieldName}:\\s*\\[([\\s\\S]*?)\\]`));
  if (!match) return null;
  return unique([...match[1].matchAll(/"([^"]+)"/g)].map((item) => item[1]));
}

function extractReliabilityRunProfiles(source, sourceLabel) {
  const profiles = new Map();
  const functionStart = source.indexOf("function buildReliabilityRunProfiles()");
  const constStart = source.indexOf("const runProfiles = [");
  const startIndex = functionStart === -1 ? constStart : functionStart;
  if (startIndex === -1) return profiles;

  const functionEnd = source.indexOf("\nfunction ", startIndex + 1);
  const constEnd = source.indexOf("\n];", startIndex + 1);
  const endIndex = functionStart === -1 ? (constEnd === -1 ? source.length : constEnd) : (functionEnd === -1 ? source.length : functionEnd);
  const profileSource = source.slice(startIndex, endIndex);
  const matches = [...profileSource.matchAll(/\n\s*\{\n\s*id:\s*"([^"]+)",/g)];
  for (let index = 0; index < matches.length; index += 1) {
    const id = matches[index][1];
    const start = matches[index].index ?? 0;
    const end = matches[index + 1]?.index ?? profileSource.length;
    const block = profileSource.slice(start, end);
    const field = (fieldName) => block.match(new RegExp(`${fieldName}:\\s*"([^"]+)"`))?.[1] ?? null;
    const contract = {
      id,
      targetModes: stringArrayField(block, "targetModes"),
      envVars: stringArrayField(block, "envVars"),
      startCommand: field("startCommand"),
      validationCommand: field("validationCommand"),
      handoffCommand: field("handoffCommand"),
      evidence: stringArrayField(block, "evidence"),
    };
    if (Object.values(contract).some((value) => value === null)) {
      continue;
    }
    if (profiles.has(id)) {
      fail(`${sourceLabel} declares duplicate reliability run profile: ${id}`);
    }
    profiles.set(id, contract);
  }
  return profiles;
}

function constArraySource(source, constNames) {
  for (const constName of constNames) {
    const startIndex = source.indexOf(`const ${constName} = [`);
    if (startIndex === -1) continue;
    const endIndex = source.indexOf("\n];", startIndex + 1);
    return source.slice(startIndex, endIndex === -1 ? source.length : endIndex);
  }
  return "";
}

function extractReliabilityEvidenceInventory(source, sourceLabel) {
  const inventory = new Map();
  const inventorySource = constArraySource(source, ["reliabilityEvidenceInventory", "evidenceInventory"]);
  const matches = [...inventorySource.matchAll(/\n\s*\{\n\s*id:\s*"([^"]+)",/g)];
  for (let index = 0; index < matches.length; index += 1) {
    const id = matches[index][1];
    const start = matches[index].index ?? 0;
    const end = matches[index + 1]?.index ?? inventorySource.length;
    const block = inventorySource.slice(start, end);
    const field = (fieldName) => block.match(new RegExp(`${fieldName}:\\s*"([^"]+)"`))?.[1] ?? null;
    const contract = {
      id,
      requiredFor: stringArrayField(block, "requiredFor"),
      artifact: field("artifact"),
      producerCommand: field("producerCommand"),
      validates: stringArrayField(block, "validates"),
    };
    if (Object.values(contract).some((value) => value === null)) continue;
    if (inventory.has(id)) {
      fail(`${sourceLabel} declares duplicate reliability evidence inventory item: ${id}`);
    }
    inventory.set(id, contract);
  }
  return inventory;
}

function extractReliabilityHandoffChecklist(source, sourceLabel) {
  const checklist = new Map();
  const checklistSource = constArraySource(source, ["reliabilityHandoffChecklist", "handoffChecklist"]);
  const matches = [...checklistSource.matchAll(/\n\s*\{\n\s*id:\s*"([^"]+)",/g)];
  for (let index = 0; index < matches.length; index += 1) {
    const id = matches[index][1];
    const start = matches[index].index ?? 0;
    const end = matches[index + 1]?.index ?? checklistSource.length;
    const block = checklistSource.slice(start, end);
    const field = (fieldName) => block.match(new RegExp(`${fieldName}:\\s*"([^"]+)"`))?.[1] ?? null;
    const contract = {
      id,
      requiredFor: stringArrayField(block, "requiredFor"),
      command: field("command"),
      requiredEvidence: stringArrayField(block, "requiredEvidence"),
      passSignal: field("passSignal"),
    };
    if (Object.values(contract).some((value) => value === null)) continue;
    if (checklist.has(id)) {
      fail(`${sourceLabel} declares duplicate reliability handoff checklist item: ${id}`);
    }
    checklist.set(id, contract);
  }
  return checklist;
}

function compareReliabilityContracts(apiContracts, cliContracts, contractName, idField) {
  if (apiContracts.size === 0) {
    fail(`src/http/createServer.ts exposes no ${contractName}`);
  }
  if (cliContracts.size === 0) {
    fail(`scripts/reliability-lab-status.mjs exposes no ${contractName}`);
  }
  if (!sameValues([...apiContracts.keys()].sort(), [...cliContracts.keys()].sort())) {
    fail(`${contractName} names differ between API and status CLI`);
  }
  for (const [id, apiContract] of apiContracts) {
    const cliContract = cliContracts.get(id);
    if (!cliContract) continue;
    for (const fieldName of Object.keys(apiContract).filter((field) => field !== idField)) {
      const apiValue = apiContract[fieldName];
      const cliValue = cliContract[fieldName];
      const matches = Array.isArray(apiValue) && Array.isArray(cliValue)
        ? sameValues(apiValue, cliValue)
        : apiValue === cliValue;
      if (!matches) {
        fail(`${contractName} ${id} ${fieldName} differs between API and status CLI`);
      }
    }
  }
}

function validateTargetModeReferences(contracts, contractName, idField, fieldName, knownTargetModes) {
  for (const [id, contract] of contracts) {
    const references = contract[fieldName];
    if (!Array.isArray(references)) continue;
    for (const reference of references) {
      if (!knownTargetModes.has(reference)) {
        fail(`${contractName} ${idField}=${id} references unknown target mode: ${reference}`);
      }
    }
  }
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

function markdownTableRows(section) {
  return section
    .split("\n")
    .filter((line) => line.startsWith("|") && line.endsWith("|"))
    .map((line) => line.split("|").slice(1, -1).map((cell) => cell.trim()))
    .filter((cells) => cells.length > 0 && !cells.every((cell) => /^:?-{3,}:?$/.test(cell)));
}

function tokenizeShellFragment(command) {
  return [...command.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((match) =>
    (match[1] ?? match[2] ?? match[3]).replace(/^["']|["']$/g, ""),
  );
}

function composeServiceNames(composeSource) {
  const services = [];
  let inServices = false;
  for (const line of composeSource.split("\n")) {
    if (line === "services:") {
      inServices = true;
      continue;
    }
    if (!inServices) continue;
    if (/^[A-Za-z0-9_-]+:/.test(line)) break;
    const match = line.match(/^  ([A-Za-z0-9_-]+):\s*$/);
    if (match) services.push(match[1]);
  }
  return unique(services);
}

function packageDockerServiceReferences(scriptName, command) {
  const references = [];
  const dockerComposeCommands = [...command.matchAll(/docker compose\b([^;&]*)/g)].map((match) => match[0]);
  const optionsWithValue = new Set(["--profile", "-f", "--file", "--project-name", "-p", "--env-file", "--scale", "--timeout", "--pull"]);
  const optionsWithoutValue = new Set([
    "--build",
    "--detach",
    "-d",
    "--remove-orphans",
    "--no-deps",
    "--rm",
    "--force-recreate",
    "--no-recreate",
    "--renew-anon-volumes",
    "--wait",
  ]);

  for (const dockerComposeCommand of dockerComposeCommands) {
    const tokens = tokenizeShellFragment(dockerComposeCommand);
    const actionIndex = tokens.findIndex((token) => ["up", "run"].includes(token));
    if (actionIndex === -1) continue;
    const action = tokens[actionIndex];
    const serviceTokens = [];
    for (let index = actionIndex + 1; index < tokens.length; index += 1) {
      const token = tokens[index];
      if (optionsWithValue.has(token)) {
        index += 1;
        continue;
      }
      if (optionsWithoutValue.has(token) || token.startsWith("-")) {
        continue;
      }
      serviceTokens.push(token);
    }

    if (action === "run" && serviceTokens.length > 1) {
      serviceTokens.length = 1;
    }
    for (const service of serviceTokens) {
      references.push({ scriptName, service });
    }
  }

  return references;
}

function npmCommands(markdown) {
  return [...markdown.matchAll(/`([^`]*\bnpm\s+(?:run\s+)?[A-Za-z0-9:_-]+[^`]*)`/g)].flatMap((match) =>
    match[1]
      .split("&&")
      .map((command) => command.trim())
      .filter((command) => command.startsWith("npm ")),
  );
}

function npmScriptName(command) {
  const match = command.match(/^npm\s+(?:run\s+)?([A-Za-z0-9:_-]+)/);
  return match?.[1] ?? null;
}

function markdownCodeCellValue(cell) {
  return cell.trim().replace(/^`|`$/g, "");
}

function markdownCodeCellValues(cell) {
  return [...cell.matchAll(/`([^`]+)`/g)].map((match) => match[1]);
}

function usesVocabularyTermWithOptionalQualifier(value, vocabulary) {
  const trimmedValue = value.trim();
  const allowedQualifierStarts = [" before ", " for ", " ready for ", " when "];
  return vocabulary.some((term) =>
    trimmedValue === term || allowedQualifierStarts.some((qualifier) => trimmedValue.startsWith(`${term}${qualifier}`)),
  );
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
const builtinNpmCommands = new Set(["install"]);
const composeServices = composeServiceNames(compose);

for (const sourcePath of markdownSources()) {
  const source = readText(sourcePath);
  for (const scriptName of unique([...source.matchAll(/\bnpm run ([A-Za-z0-9:_-]+)/g)].map((match) => match[1]))) {
    if (!scripts[scriptName]) {
      fail(`${sourcePath} documents missing npm script: ${scriptName}`);
    }
  }
}

const runnableModesSection = readme.match(/## What can I run\?\n\n([\s\S]*?)(?:\n## |\n# |$)/)?.[1] ?? "";
const runnableModeRows = markdownTableRows(runnableModesSection);
const runnableModeHeader = runnableModeRows[0] ?? [];
const runnableModeCommandIndex = runnableModeHeader.indexOf("Command");
const documentedRunnableModeRows = runnableModeRows.slice(1);
if (runnableModeCommandIndex === -1) {
  fail("README What can I run? table is missing a Command column");
}
for (const row of documentedRunnableModeRows) {
  const mode = row[0] ?? "[unknown mode]";
  const commandCell = runnableModeCommandIndex === -1 ? "" : row[runnableModeCommandIndex] ?? "";
  const commands = npmCommands(commandCell);
  if (commands.length === 0) {
    fail(`README What can I run? mode "${mode}" has no npm command`);
    continue;
  }
  for (const command of commands) {
    const scriptName = npmScriptName(command);
    if (!scriptName) {
      fail(`README What can I run? mode "${mode}" has an unparsable npm command: ${command}`);
      continue;
    }
    if (!builtinNpmCommands.has(scriptName) && !scripts[scriptName]) {
      fail(`README What can I run? mode "${mode}" documents missing npm entry point: ${command}`);
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

const dockerProfilesSection = readme.match(/## Docker profiles\n\n([\s\S]*?)(?:\n## |\n# |$)/)?.[1] ?? "";
const documentedDockerProfiles = unique(
  [...dockerProfilesSection.matchAll(/^- `([A-Za-z0-9_-]+)`:/gm)].map((match) => match[1]),
);
if (!sameValues([...composeProfiles].sort(), documentedDockerProfiles)) {
  fail("README Docker profiles section differs from docker-compose.yml profiles");
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

const packageDockerServiceRefs = unique(
  Object.entries(scripts)
    .flatMap(([scriptName, command]) => packageDockerServiceReferences(scriptName, command))
    .map(({ scriptName, service }) => `${scriptName}\0${service}`),
);
for (const reference of packageDockerServiceRefs) {
  const [scriptName, service] = reference.split("\0");
  if (!composeServices.includes(service)) {
    fail(`package script ${scriptName} references missing Compose service: ${service}`);
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
const statusReadinessVocabulary = constStringArray(reliabilityLabStatusScript, "readinessVocabulary");
const apiReadinessVocabulary = constStringArray(server, "reliabilityReadinessVocabulary");
const statusEvidenceLevelVocabulary = constStringArray(reliabilityLabStatusScript, "evidenceLevelVocabulary");
const apiEvidenceLevelVocabulary = constStringArray(server, "reliabilityEvidenceLevelVocabulary");
const statusStackManifestKeys = constStringArray(reliabilityLabStatusScript, "requiredStackManifestKeys");
const apiStackManifestKeys = constStringArray(server, "reliabilityRequiredStackManifestKeys");
if (!statusEndpointEnvVars) {
  fail("scripts/reliability-lab-status.mjs is missing optionalEndpointEnvVars");
}
if (!apiEndpointEnvVars) {
  fail("src/http/createServer.ts is missing reliabilityOptionalEndpointEnvVars");
}
if (statusEndpointEnvVars && apiEndpointEnvVars && !sameValues(statusEndpointEnvVars, apiEndpointEnvVars)) {
  fail("reliability optional endpoint env vars differ between status CLI and API");
}
if (!statusReadinessVocabulary) {
  fail("scripts/reliability-lab-status.mjs is missing readinessVocabulary");
}
if (!apiReadinessVocabulary) {
  fail("src/http/createServer.ts is missing reliabilityReadinessVocabulary");
}
if (statusReadinessVocabulary && apiReadinessVocabulary && !sameValues(statusReadinessVocabulary, apiReadinessVocabulary)) {
  fail("reliability readiness vocabulary differs between status CLI and API");
}
if (!statusEvidenceLevelVocabulary) {
  fail("scripts/reliability-lab-status.mjs is missing evidenceLevelVocabulary");
}
if (!apiEvidenceLevelVocabulary) {
  fail("src/http/createServer.ts is missing reliabilityEvidenceLevelVocabulary");
}
if (
  statusEvidenceLevelVocabulary
  && apiEvidenceLevelVocabulary
  && !sameValues(statusEvidenceLevelVocabulary, apiEvidenceLevelVocabulary)
) {
  fail("reliability evidence-level vocabulary differs between status CLI and API");
}
if (!statusStackManifestKeys) {
  fail("scripts/reliability-lab-status.mjs is missing requiredStackManifestKeys");
}
if (!apiStackManifestKeys) {
  fail("src/http/createServer.ts is missing reliabilityRequiredStackManifestKeys");
}
if (statusStackManifestKeys && apiStackManifestKeys && !sameValues(statusStackManifestKeys, apiStackManifestKeys)) {
  fail("reliability stack manifest required keys differ between status CLI and API");
}

const endpointEnvSection =
  reliabilityLabDoc.match(/Environment variables recognized by the status command:\n\n([\s\S]*?)(?:\n\n|$)/)?.[1] ?? "";
const documentedEndpointEnvVars = unique([...endpointEnvSection.matchAll(/`([A-Z0-9_]+)`/g)].map((match) => match[1]));
if (statusEndpointEnvVars && !sameValues(statusEndpointEnvVars, documentedEndpointEnvVars)) {
  fail("docs/reliability-lab.md endpoint env var list differs from status CLI contract");
}
const readinessVocabularySection =
  reliabilityLabDoc.match(/Readiness vocabulary:\n\n([\s\S]*?)(?:\n\n|$)/)?.[1] ?? "";
const documentedReadinessVocabulary = unique([...readinessVocabularySection.matchAll(/`([a-z_]+)`/g)].map((match) => match[1]));
if (statusReadinessVocabulary && !sameValues(statusReadinessVocabulary, documentedReadinessVocabulary)) {
  fail("docs/reliability-lab.md readiness vocabulary differs from status CLI contract");
}
const runnableModeEvidenceIndex = runnableModeHeader.indexOf("Evidence level");
if (runnableModeEvidenceIndex === -1) {
  fail("README What can I run? table is missing an Evidence level column");
}
if (statusEvidenceLevelVocabulary && runnableModeEvidenceIndex !== -1) {
  for (const row of documentedRunnableModeRows) {
    const mode = row[0] ?? "[unknown mode]";
    const evidenceLevel = row[runnableModeEvidenceIndex] ?? "";
    if (!usesVocabularyTermWithOptionalQualifier(evidenceLevel, statusEvidenceLevelVocabulary)) {
      fail(`README What can I run? mode "${mode}" evidence level does not use the reliability evidence vocabulary`);
    }
  }
}

const reliabilityModesSection = reliabilityLabDoc.match(/## Modes\n\n([\s\S]*?)(?:\n## |\n# |$)/)?.[1] ?? "";
const reliabilityModeRows = markdownTableRows(reliabilityModesSection);
const reliabilityModeHeader = reliabilityModeRows[0] ?? [];
const targetModeIdIndex = reliabilityModeHeader.indexOf("Target mode id");
const targetModeStartCommandIndex = reliabilityModeHeader.indexOf("Start command");
const targetModeValidationCommandIndex = reliabilityModeHeader.indexOf("Validation command");
const targetModeEvidenceCommandIndex = reliabilityModeHeader.indexOf("Evidence command");
const targetModeCaeHandoffCommandIndex = reliabilityModeHeader.indexOf("CAE handoff command");
const documentedReliabilityTargetModes = targetModeIdIndex === -1
  ? []
  : unique(
      reliabilityModeRows
        .slice(1)
        .map((row) => row[targetModeIdIndex] ?? "")
        .flatMap((cell) => [...cell.matchAll(/`([a-z_]+)`/g)].map((match) => match[1])),
    );
const documentedReliabilityStartCommands = new Map();
const documentedReliabilityValidationCommands = new Map();
const documentedReliabilityEvidenceCommands = new Map();
const documentedReliabilityCaeHandoffCommands = new Map();
if (
  targetModeIdIndex !== -1
  && targetModeStartCommandIndex !== -1
  && targetModeValidationCommandIndex !== -1
  && targetModeEvidenceCommandIndex !== -1
  && targetModeCaeHandoffCommandIndex !== -1
) {
  for (const row of reliabilityModeRows.slice(1)) {
    const mode = [...(row[targetModeIdIndex] ?? "").matchAll(/`([a-z_]+)`/g)][0]?.[1] ?? null;
    const startCommand = markdownCodeCellValue(row[targetModeStartCommandIndex] ?? "");
    const validationCommand = markdownCodeCellValue(row[targetModeValidationCommandIndex] ?? "");
    const evidenceCommand = markdownCodeCellValue(row[targetModeEvidenceCommandIndex] ?? "");
    const caeHandoffCommand = markdownCodeCellValue(row[targetModeCaeHandoffCommandIndex] ?? "");
    if (mode && startCommand) {
      documentedReliabilityStartCommands.set(mode, startCommand);
      documentedReliabilityValidationCommands.set(mode, validationCommand);
      documentedReliabilityEvidenceCommands.set(mode, evidenceCommand);
      documentedReliabilityCaeHandoffCommands.set(mode, caeHandoffCommand);
    }
  }
}
if (targetModeIdIndex === -1) {
  fail("docs/reliability-lab.md Modes table is missing a Target mode id column");
}
if (targetModeStartCommandIndex === -1) {
  fail("docs/reliability-lab.md Modes table is missing a Start command column");
}
if (targetModeValidationCommandIndex === -1) {
  fail("docs/reliability-lab.md Modes table is missing a Validation command column");
}
if (targetModeEvidenceCommandIndex === -1) {
  fail("docs/reliability-lab.md Modes table is missing an Evidence command column");
}
if (targetModeCaeHandoffCommandIndex === -1) {
  fail("docs/reliability-lab.md Modes table is missing a CAE handoff command column");
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
if (!sameValues([...cliTargetModes.keys()].sort(), documentedReliabilityTargetModes)) {
  fail("docs/reliability-lab.md target mode ids differ from status CLI contract");
}
for (const [mode, contract] of cliTargetModes) {
  const documentedCommands = [
    ["startCommand", "start command", documentedReliabilityStartCommands.get(mode)],
    ["validationCommand", "validation command", documentedReliabilityValidationCommands.get(mode)],
    ["evidenceCommand", "evidence command", documentedReliabilityEvidenceCommands.get(mode)],
    ["caeHandoffCommand", "CAE handoff command", documentedReliabilityCaeHandoffCommands.get(mode)],
  ];
  for (const [fieldName, label, documentedCommand] of documentedCommands) {
    if (documentedCommand !== contract[fieldName]) {
      fail(`docs/reliability-lab.md ${label} for ${mode} differs from status CLI contract`);
    }
  }
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
const knownReliabilityTargetModes = new Set([...apiTargetModes.keys(), ...cliTargetModes.keys()]);

const apiRunProfiles = extractReliabilityRunProfiles(server, "src/http/createServer.ts");
const cliRunProfiles = extractReliabilityRunProfiles(reliabilityLabStatusScript, "scripts/reliability-lab-status.mjs");
if (apiRunProfiles.size === 0) {
  fail("src/http/createServer.ts exposes no reliability run profile contracts");
}
if (cliRunProfiles.size === 0) {
  fail("scripts/reliability-lab-status.mjs exposes no reliability run profile contracts");
}
if (!sameValues([...apiRunProfiles.keys()].sort(), [...cliRunProfiles.keys()].sort())) {
  fail("reliability run profile names differ between API and status CLI");
}
for (const [profile, apiContract] of apiRunProfiles) {
  const cliContract = cliRunProfiles.get(profile);
  if (!cliContract) continue;
  for (const fieldName of Object.keys(apiContract).filter((field) => field !== "id")) {
    const apiValue = apiContract[fieldName];
    const cliValue = cliContract[fieldName];
    const matches = Array.isArray(apiValue) && Array.isArray(cliValue)
      ? sameValues(apiValue, cliValue)
      : apiValue === cliValue;
    if (!matches) {
      fail(`reliability run profile ${profile} ${fieldName} differs between API and status CLI`);
    }
  }
}
validateTargetModeReferences(apiRunProfiles, "API reliability run profile", "id", "targetModes", knownReliabilityTargetModes);
validateTargetModeReferences(cliRunProfiles, "CLI reliability run profile", "id", "targetModes", knownReliabilityTargetModes);

const apiEvidenceInventory = extractReliabilityEvidenceInventory(server, "src/http/createServer.ts");
const cliEvidenceInventory = extractReliabilityEvidenceInventory(
  reliabilityLabStatusScript,
  "scripts/reliability-lab-status.mjs",
);
compareReliabilityContracts(
  apiEvidenceInventory,
  cliEvidenceInventory,
  "reliability evidence inventory contracts",
  "id",
);
validateTargetModeReferences(apiEvidenceInventory, "API reliability evidence inventory", "id", "requiredFor", knownReliabilityTargetModes);
validateTargetModeReferences(cliEvidenceInventory, "CLI reliability evidence inventory", "id", "requiredFor", knownReliabilityTargetModes);

const evidenceInventorySection = reliabilityLabDoc.match(/## Evidence inventory\n\n([\s\S]*?)(?:\n## |\n# |$)/)?.[1] ?? "";
const evidenceInventoryRows = markdownTableRows(evidenceInventorySection);
const evidenceInventoryHeader = evidenceInventoryRows[0] ?? [];
const evidenceIdIndex = evidenceInventoryHeader.indexOf("Evidence id");
const evidenceRequiredForIndex = evidenceInventoryHeader.indexOf("Required for");
const evidenceArtifactIndex = evidenceInventoryHeader.indexOf("Artifact");
const evidenceProducerCommandIndex = evidenceInventoryHeader.indexOf("Producer command");
if (evidenceIdIndex === -1) {
  fail("docs/reliability-lab.md Evidence inventory table is missing an Evidence id column");
}
if (evidenceRequiredForIndex === -1) {
  fail("docs/reliability-lab.md Evidence inventory table is missing a Required for column");
}
if (evidenceArtifactIndex === -1) {
  fail("docs/reliability-lab.md Evidence inventory table is missing an Artifact column");
}
if (evidenceProducerCommandIndex === -1) {
  fail("docs/reliability-lab.md Evidence inventory table is missing a Producer command column");
}
const documentedEvidenceInventory = new Map();
if (
  evidenceIdIndex !== -1
  && evidenceRequiredForIndex !== -1
  && evidenceArtifactIndex !== -1
  && evidenceProducerCommandIndex !== -1
) {
  for (const row of evidenceInventoryRows.slice(1)) {
    const id = markdownCodeCellValues(row[evidenceIdIndex] ?? "")[0] ?? null;
    if (!id) continue;
    documentedEvidenceInventory.set(id, {
      id,
      requiredFor: unique(markdownCodeCellValues(row[evidenceRequiredForIndex] ?? "")),
      artifact: markdownCodeCellValue(row[evidenceArtifactIndex] ?? ""),
      producerCommand: markdownCodeCellValue(row[evidenceProducerCommandIndex] ?? ""),
    });
  }
}
if (!sameValues([...cliEvidenceInventory.keys()].sort(), [...documentedEvidenceInventory.keys()].sort())) {
  fail("docs/reliability-lab.md evidence inventory ids differ from status CLI contract");
}
for (const [id, contract] of cliEvidenceInventory) {
  const documented = documentedEvidenceInventory.get(id);
  if (!documented) continue;
  if (!sameValues(contract.requiredFor, documented.requiredFor)) {
    fail(`docs/reliability-lab.md evidence inventory required modes for ${id} differ from status CLI contract`);
  }
  if (contract.artifact !== documented.artifact) {
    fail(`docs/reliability-lab.md evidence inventory artifact for ${id} differs from status CLI contract`);
  }
  if (contract.producerCommand !== documented.producerCommand) {
    fail(`docs/reliability-lab.md evidence inventory producer command for ${id} differs from status CLI contract`);
  }
}

const apiHandoffChecklist = extractReliabilityHandoffChecklist(server, "src/http/createServer.ts");
const cliHandoffChecklist = extractReliabilityHandoffChecklist(
  reliabilityLabStatusScript,
  "scripts/reliability-lab-status.mjs",
);
compareReliabilityContracts(apiHandoffChecklist, cliHandoffChecklist, "reliability handoff checklist contracts", "id");
validateTargetModeReferences(apiHandoffChecklist, "API reliability handoff checklist", "id", "requiredFor", knownReliabilityTargetModes);
validateTargetModeReferences(cliHandoffChecklist, "CLI reliability handoff checklist", "id", "requiredFor", knownReliabilityTargetModes);

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

const canonicalEcosystemTerms = [
  "ACC Reliability Lab",
  "rtc-asr",
  "ConversationAgentEvals",
  "ASSERT",
  "audio",
  "transcripts",
  "test scenarios",
  "proof bundle",
  "evaluation",
];
for (const phrase of canonicalEcosystemTerms) {
  if (!readme.includes(phrase)) {
    fail(`README canonical ecosystem model is missing: ${phrase}`);
  }
  if (!cluecon.includes(phrase)) {
    fail(`ClueCon canonical ecosystem model is missing: ${phrase}`);
  }
}

const canonicalEcosystemEdges = [
  {
    label: "ACC audio to rtc-asr",
    readme: 'ACC -->|"audio"| ASR',
    cluecon: "ACC --> audio --> rtc-asr",
  },
  {
    label: "rtc-asr transcripts to ACC",
    readme: 'ASR -->|"transcripts"| ACC',
    cluecon: "rtc-asr --> transcripts --> ACC",
  },
  {
    label: "ConversationAgentEvals scenarios to ACC",
    readme: 'CAE -->|"test scenarios"| ACC',
    cluecon: "ConversationAgentEvals --> test scenarios --> ACC",
  },
  {
    label: "ACC proof bundle to ConversationAgentEvals",
    readme: 'ACC -->|"proof bundle"| CAE',
    cluecon: "ACC --> proof bundle --> ConversationAgentEvals",
  },
  {
    label: "ConversationAgentEvals evaluation to ASSERT",
    readme: 'CAE -->|"evaluation"| ASSERT',
    cluecon: "ConversationAgentEvals --> evaluation --> ASSERT",
  },
];
for (const edge of canonicalEcosystemEdges) {
  if (!readme.includes(edge.readme)) {
    fail(`README canonical ecosystem edge is missing or drifted: ${edge.label}`);
  }
  if (!cluecon.includes(edge.cluecon)) {
    fail(`ClueCon canonical ecosystem edge is missing or drifted: ${edge.label}`);
  }
}

const requiredGoldenComparisonRows = [
  ["Cancellation intent", "detected", "detected"],
  ["Policy hold", "missing", "present"],
  ["Unapproved offer", "emitted", "absent"],
  ["Tool/runtime failure", "autonomous continuation", "fail-closed handoff"],
  ["Final disposition", "ambiguous", "recorded"],
  ["Overall release gate", "block", "candidate passes"],
];
const goldenLoopSection = readme.match(/## The golden reliability loop\n\n([\s\S]*?)(?:\n## |\n# |$)/)?.[1] ?? "";
const goldenLoopRows = markdownTableRows(goldenLoopSection).slice(1);
for (const requiredRow of requiredGoldenComparisonRows) {
  const hasRow = goldenLoopRows.some((row) => sameValues(row.slice(0, 3), requiredRow));
  if (!hasRow) {
    fail(`README golden reliability loop is missing comparison row: ${requiredRow.join(" | ")}`);
  }
}

for (const key of statusStackManifestKeys ?? []) {
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
  `Documentation validation passed: ${Object.keys(scripts).length} package scripts, ${runtimeScriptCommands.length} runtime command references, ${documentedRunnableModeRows.length} runnable mode rows, ${composeProfiles.size} Compose profiles, ${documentedDockerProfiles.length} documented Docker profiles, ${documentedComposeProfileReferences.length} documented Compose profile references, ${composeServices.length} Compose services, ${packageDockerServiceRefs.length} package Docker service references, ${checkedLocalLinks.length} local Markdown links, ${documentedRoutes.length} useful routes, ${documentedAccUrls.length} ACC URL routes, ${reliabilityReadinessRoutes.length} reliability readiness routes, ${apiTargetModes.size} reliability target mode contracts, ${documentedReliabilityTargetModes.length} documented reliability target modes, ${knownReliabilityTargetModes.size} reliability target mode reference set, ${documentedReliabilityStartCommands.size} documented reliability start commands, ${documentedReliabilityValidationCommands.size} documented reliability validation commands, ${documentedReliabilityEvidenceCommands.size} documented reliability evidence commands, ${documentedReliabilityCaeHandoffCommands.size} documented reliability CAE handoff commands, ${apiRunProfiles.size} reliability run profile contracts, ${apiEvidenceInventory.size} reliability evidence inventory contracts, ${documentedEvidenceInventory.size} documented evidence inventory rows, ${apiHandoffChecklist.size} reliability handoff checklist contracts, ${documentedReadinessVocabulary.length} readiness vocabulary terms, ${statusEvidenceLevelVocabulary?.length ?? 0} evidence-level vocabulary terms, ${statusStackManifestKeys?.length ?? 0} stack manifest keys, ${mermaidDiagramCount} README diagrams, ${readmePorts.length} documented ports, ${canonicalEcosystemTerms.length} canonical ecosystem terms, ${canonicalEcosystemEdges.length} canonical ecosystem edges, ${requiredGoldenComparisonRows.length} golden comparison rows.`,
);
