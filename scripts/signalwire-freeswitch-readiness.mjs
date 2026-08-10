#!/usr/bin/env node
import { execFile } from "node:child_process";
import { lookup } from "node:dns/promises";
import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { BlockList, isIP } from "node:net";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repoRoot = process.cwd();
const args = process.argv.slice(2);
const specialUseIpv6 = new BlockList();
for (const [address, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["::ffff:0.0.0.0", 96],
  ["64:ff9b::", 96],
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["2001::", 23],
  ["2001:2::", 48],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["3fff::", 20],
  ["5f00::", 16],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
]) {
  specialUseIpv6.addSubnet(address, prefix, "ipv6");
}

const COMMON_REQUIRED_ENV = [
  "SIGNALWIRE_FROM_NUMBER",
  "FREESWITCH_PUBLIC_SIP_HOST",
];
const REGISTRATION_REQUIRED_ENV = [
  "SIGNALWIRE_SPACE_URL",
  "SIGNALWIRE_SIP_USERNAME",
  "SIGNALWIRE_SIP_PASSWORD",
];
const ALL_ENV = [...COMMON_REQUIRED_ENV, ...REGISTRATION_REQUIRED_ENV];
const DEFAULT_SIGNALWIRE_SOURCE_ACL_NAME = "signalwire_trunk";
const EXTERNAL_REACHABILITY_PROOF_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const EXTERNAL_REACHABILITY_PROOF_CLOCK_SKEW_MS = 5 * 60 * 1000;
const EXPECTED_SIGNALWIRE_SIP_TRANSPORT = "udp";
const SOURCE_ACL_REJECT_PROBE_CANDIDATES = [
  "8.8.8.8",
  "1.1.1.1",
  "9.9.9.9",
  "208.67.222.222",
  "2606:4700:4700::1111",
];

function hasFlag(name) {
  return args.includes(name);
}

function argValue(name, fallback) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
}

function clean(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeSpaceHost(value) {
  const raw = clean(value);
  if (!raw) return "";
  try {
    return new URL(raw.includes("://") ? raw : `https://${raw}`).host;
  } catch {
    return raw.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  }
}

function signalwireSipHostFromSpaceUrl(value) {
  const host = normalizeSpaceHost(value).toLowerCase();
  if (!host) return "";
  if (host.endsWith(".sip.signalwire.com")) return host;
  if (host.endsWith(".signalwire.com")) {
    return `${host.slice(0, -".signalwire.com".length)}.sip.signalwire.com`;
  }
  return host;
}

function redact(value) {
  const text = clean(value);
  if (!text) return "";
  if (text.length <= 6) return "[redacted]";
  return `${text.slice(0, 2)}...[redacted]...${text.slice(-2)}`;
}

function redactIpLiterals(text) {
  return text
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, "[redacted-address]")
    .replace(/\[[0-9a-f:.]+\]/gi, "[redacted-address]")
    .replace(
      /(^|[^0-9a-f:])([0-9a-f]{0,4}:(?=[0-9a-f:.]*:)[0-9a-f:.]+)(?=$|[^0-9a-f:])/gi,
      (match, prefix, candidate) => {
        const suffixMatch = candidate.match(/([,;)>\]]+)$/);
        const suffix = suffixMatch ? suffixMatch[1] : "";
        const address = suffix ? candidate.slice(0, -suffix.length) : candidate;
        return isIP(address) === 6 ? `${prefix}[redacted-address]${suffix}` : match;
      },
    );
}

function buildRedactor(values) {
  const secrets = [...new Set(values
    .flatMap(redactionVariants)
    .filter(Boolean))]
    .sort((a, b) => b.length - a.length);
  return (text) => {
    let redacted = text;
    for (const secret of secrets) {
      redacted = redacted.replace(new RegExp(regexpEscape(secret), "gi"), "[redacted]");
    }
    redacted = redacted
      .replace(
        /^(\s*(?:ext-)?(?:sip|rtp)-ip(?:\s*[:=]\s*|\s+))\S+/gim,
        "$1[redacted-address]",
      );
    return redactIpLiterals(redacted);
  };
}

function redactionVariants(value) {
  const text = clean(value);
  if (!text) return [];
  const variants = [text];
  const endpointHost = normalizeSipEndpointHost(text);
  if (endpointHost) {
    variants.push(endpointHost, endpointHost.toLowerCase());
  }
  const spaceHost = signalwireSipHostFromSpaceUrl(text);
  if (spaceHost) {
    variants.push(spaceHost, spaceHost.toLowerCase());
  }
  return variants;
}

function xmlEscape(value) {
  return clean(value)
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function regexpEscape(value) {
  return clean(value).replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}

function signalwireDidDigits(value) {
  const raw = clean(value);
  if (!/^\+?[\d\s().-]+$/.test(raw)) return "";
  const digits = raw.replace(/\D/g, "");
  return digits.length >= 10 && digits.length <= 15 ? digits : "";
}

function didPattern(value) {
  const digits = signalwireDidDigits(value);
  if (!digits) return "NO_SIGNALWIRE_DID_CONFIGURED";
  const withOptionalPlus = `\\+?${regexpEscape(digits)}`;
  const withoutCountry = digits.length === 11 && digits.startsWith("1") ? regexpEscape(digits.slice(1)) : "";
  return [withOptionalPlus, withoutCountry].filter(Boolean).join("|");
}

function isExternalProfileRunning(entry) {
  if (!entry) return false;
  const output = `${entry.stdout ?? ""}\n${entry.stderr ?? ""}`;
  if (/invalid\s+profile|not\s+running/i.test(output)) return false;
  const profileStateLines = output
    .split(/\r?\n/)
    .map(clean)
    .filter((line) => /(?:\bprofile\b|\bstate\b|\bstatus\b)/i.test(line));
  if (profileStateLines.some((line) => /\b(?:DOWN|FAILED|STOPPED)\b/i.test(line))) return false;
  return /\bRUNNING\b/i.test(output);
}

function regexpLiteral(value) {
  return clean(value).replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}

function isInboundDialplanActive(entry, expectedDidPattern, sourceAclName) {
  if (!entry) return false;
  const output = `${entry.stdout ?? ""}\n${entry.stderr ?? ""}`;
  if (/can't\s+find|not\s+found|invalid/i.test(output)) return false;
  const root = parseXmlTree(output);
  const extension = findDescendant(root, (node) => (
    node.name === "extension"
    && clean(node.attributes.name).toLowerCase() === "agentic_contact_center_signalwire_pstn"
  ));
  if (!extension) return false;
  const didCondition = findDescendant(extension, (node) => (
    node.name === "condition"
    && clean(node.attributes.field).toLowerCase() === "destination_number"
    && clean(node.attributes.expression).includes(expectedDidPattern)
  ));
  if (!didCondition) return false;
  const aclCondition = findDescendant(didCondition, (node) => isSignalWireAclCondition(node, sourceAclName));
  if (!aclCondition) return false;
  return guardedSignalWireBridgeReady(aclCondition);
}

function parseXmlTree(value) {
  const root = { name: "#root", attributes: {}, children: [] };
  const stack = [root];
  const withoutComments = clean(value).replace(/<!--[\s\S]*?-->/g, "");
  for (const match of withoutComments.matchAll(/<\s*(\/)?\s*([A-Za-z0-9_.:-]+)\b([^<>]*?)(\/?)\s*>/g)) {
    const [, closing, rawName, rawAttributes = "", selfClosing] = match;
    const name = rawName.toLowerCase();
    if (closing) {
      const index = stack.findLastIndex((node) => node.name === name);
      if (index > 0) stack.length = index;
      continue;
    }
    const node = {
      name,
      attributes: parseXmlAttributes(rawAttributes),
      children: [],
    };
    stack.at(-1).children.push(node);
    if (!selfClosing) stack.push(node);
  }
  return root;
}

function findDescendant(node, predicate) {
  for (const child of node.children ?? []) {
    if (predicate(child)) return child;
    const nested = findDescendant(child, predicate);
    if (nested) return nested;
  }
  return null;
}

function descendants(node, predicate) {
  const results = [];
  for (const child of node.children ?? []) {
    if (predicate(child)) results.push(child);
    results.push(...descendants(child, predicate));
  }
  return results;
}

function isSignalWireAclCondition(node, sourceAclName) {
  if (node.name !== "condition") return false;
  const field = clean(node.attributes.field);
  const expression = clean(node.attributes.expression).toLowerCase();
  const aclPattern = new RegExp(`acl\\(\\$\\{network_addr\\}\\s+${regexpLiteral(sourceAclName)}\\)`, "i");
  return aclPattern.test(field) && /^\^?true\$?$/.test(expression);
}

function guardedSignalWireBridgeReady(aclCondition) {
  const actions = descendants(aclCondition, (node) => node.name === "action")
    .map((node) => ({
      application: clean(node.attributes.application).toLowerCase(),
      data: clean(node.attributes.data),
    }));
  const hasActionData = (application, pattern) => actions.some((action) => (
    action.application === application && pattern.test(action.data)
  ));
  return hasActionData("set", /(?:^|[,;{])acc_route=signalwire_live(?:[,;} ]|$)/i)
    && hasActionData("set", /(?:^|[,;{])acc_destination_number=8600(?:[,;} ]|$)/i)
    && hasActionData("set", /(?:^|[,;{])acc_conversation_mode=openai_llm(?:[,;} ]|$)/i)
    && hasActionData("set", /(?:^|[,;{])acc_media_bridge=pipecat_verto_agent_leg(?:[,;} ]|$)/i)
    && hasActionData("export", /(?:sip_h_X-ACC-Telephony-Mode|X-ACC-Telephony-Mode)=signalwire_live/i)
    && hasActionData("export", /(?:sip_h_X-ACC-Destination|X-ACC-Destination)=8600/i)
    && hasActionData("export", /(?:sip_h_X-ACC-Conversation-Mode|X-ACC-Conversation-Mode)=openai_llm/i)
    && hasActionData("bridge", /absolute_codec_string=PCMU/i)
    && hasActionData("bridge", /verto_contact\(\s*acc-pipecat@/i);
}

function expectedVertoAgentContactsFromDialplan(entry) {
  if (!entry) return [];
  const output = `${entry.stdout ?? ""}\n${entry.stderr ?? ""}`;
  return [...output.matchAll(/verto_contact\(\s*acc-pipecat@([^)'"<>\s]+)\s*\)/gi)]
    .map((match) => `acc-pipecat@${clean(match[1]).toLowerCase()}`)
    .filter((contact, index, contacts) => contact && contacts.indexOf(contact) === index);
}

function isSignalWireSourceAclProven(entry) {
  if (!entry) return false;
  const output = `${entry.stdout ?? ""}\n${entry.stderr ?? ""}`;
  if (/\b(?:false|deny|denied|reject|rejected|not\s+found|invalid|error)\b/i.test(output)) return false;
  return /\b(?:true|allow|allowed|pass|passed|ok)\b/i.test(output);
}

function isSignalWireSourceAclRejected(entry) {
  if (!entry) return false;
  const output = `${entry.stdout ?? ""}\n${entry.stderr ?? ""}`;
  if (/\b(?:true|allow|allowed|pass|passed|ok)\b/i.test(output)) return false;
  return /\b(?:false|deny|denied|reject|rejected|not\s+found)\b/i.test(output);
}

function ipv4ToNumber(address) {
  const parts = clean(address).split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null;
  return parts.reduce((value, part) => ((value << 8) | part) >>> 0, 0);
}

function ipv6ToBigInt(address) {
  const canonical = canonicalizeIpAddress(address);
  if (!canonical) return null;
  return canonical.split(":").reduce((value, group) => (value << 16n) + BigInt(Number.parseInt(group, 16)), 0n);
}

function parseProviderIngressCidrs(value) {
  return clean(value)
    .split(/[\s,]+/)
    .map(clean)
    .filter(Boolean);
}

function cidrContainsIp(cidr, address) {
  const [cidrAddress, prefixText] = clean(cidr).split("/");
  const addressVersion = isIP(address);
  const cidrVersion = isIP(cidrAddress);
  if (!addressVersion || !cidrVersion || addressVersion !== cidrVersion) return false;
  const maxPrefix = addressVersion === 4 ? 32 : 128;
  const prefix = prefixText === undefined ? maxPrefix : Number(prefixText);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > maxPrefix) return false;
  if (addressVersion === 4) {
    const probe = ipv4ToNumber(address);
    const base = ipv4ToNumber(cidrAddress);
    if (probe === null || base === null) return false;
    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
    return (probe & mask) === (base & mask);
  }
  const probe = ipv6ToBigInt(address);
  const base = ipv6ToBigInt(cidrAddress);
  if (probe === null || base === null) return false;
  const mask = prefix === 0 ? 0n : ((1n << BigInt(prefix)) - 1n) << BigInt(128 - prefix);
  return (probe & mask) === (base & mask);
}

function cidrRange(cidr) {
  const [cidrAddress, prefixText] = clean(cidr).split("/");
  const version = isIP(cidrAddress);
  if (!version) return null;
  const maxPrefix = version === 4 ? 32 : 128;
  const prefix = prefixText === undefined ? maxPrefix : Number(prefixText);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > maxPrefix) return null;
  if (version === 4) {
    const base = ipv4ToNumber(cidrAddress);
    if (base === null) return null;
    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
    const start = BigInt(base & mask);
    const size = 1n << BigInt(32 - prefix);
    return { version, start, end: start + size - 1n };
  }
  const base = ipv6ToBigInt(cidrAddress);
  if (base === null) return null;
  const mask = prefix === 0 ? 0n : ((1n << BigInt(prefix)) - 1n) << BigInt(128 - prefix);
  const start = base & mask;
  const size = 1n << BigInt(128 - prefix);
  return { version, start, end: start + size - 1n };
}

function cidrIsSubsetOf(childCidr, parentCidr) {
  const child = cidrRange(childCidr);
  const parent = cidrRange(parentCidr);
  return Boolean(
    child
    && parent
    && child.version === parent.version
    && child.start >= parent.start
    && child.end <= parent.end,
  );
}

function parseXmlAttributes(value) {
  const attributes = {};
  for (const match of value.matchAll(/([A-Za-z0-9_.:-]+)\s*=\s*(["'])(.*?)\2/g)) {
    attributes[match[1].toLowerCase()] = clean(match[3]);
  }
  return attributes;
}

function activeAclAllowSet(entry, aclName) {
  const output = `${entry?.stdout ?? ""}\n${entry?.stderr ?? ""}`;
  const escapedName = regexpLiteral(aclName);
  const networkListPattern = new RegExp(
    `<(?:network-)?list\\b(?=[^>]*\\bname\\s*=\\s*["']${escapedName}["'])[^>]*>[\\s\\S]*?<\\/(?:network-)?list>`,
    "i",
  );
  const networkList = output.match(networkListPattern)?.[0] ?? output;
  const listOpenTag = networkList.match(/<(?:network-)?list\b[^>]*>/i)?.[0] ?? "";
  const listAttributes = parseXmlAttributes(listOpenTag);
  const allowNodes = [...networkList.matchAll(/<node\b[^>]*>/gi)]
    .map((match) => parseXmlAttributes(match[0]))
    .filter((attributes) => clean(attributes.type).toLowerCase() === "allow");
  const allowCidrs = allowNodes.map((attributes) => clean(attributes.cidr)).filter(Boolean);
  return {
    found: Boolean(networkList.match(/<(?:network-)?list\b/i)),
    defaultPolicy: clean(listAttributes.default).toLowerCase(),
    allowNodeCount: allowNodes.length,
    allowCidrs,
  };
}

function activeAclAllowsOnlyProviderCidrs(entry, aclName, providerCidrs) {
  const allowSet = activeAclAllowSet(entry, aclName);
  if (
    !allowSet.found
    || allowSet.defaultPolicy === "allow"
    || allowSet.allowCidrs.length === 0
    || allowSet.allowCidrs.length !== allowSet.allowNodeCount
  ) {
    return false;
  }
  return allowSet.allowCidrs.every((allowCidr) => (
    cidrRange(allowCidr)
    && providerCidrs.some((providerCidr) => cidrIsSubsetOf(allowCidr, providerCidr))
  ));
}

function isSignalWireProviderIngressProbe(address, providerCidrs) {
  return providerCidrs.some((cidr) => cidrContainsIp(cidr, address));
}

function nonProviderSourceAclRejectProbe(providerCidrs, approvedProbe) {
  return SOURCE_ACL_REJECT_PROBE_CANDIDATES.find((candidate) => (
    candidate !== approvedProbe
    && isPublicIpAddress(candidate)
    && !isSignalWireProviderIngressProbe(candidate, providerCidrs)
  )) ?? "";
}

function fieldAliasesPattern(aliases) {
  return aliases.map((alias) => alias.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")).join("|");
}

function gatewayFieldValues(output, aliases) {
  const pattern = new RegExp(`^\\s*(?:${fieldAliasesPattern(aliases)})(?:\\s*(?::|=)\\s*|\\s+)(.+?)\\s*$`, "gim");
  return [...output.matchAll(pattern)].map((match) => clean(match[1]).replace(/^"|"$/g, ""));
}

function outputHasGatewayHost(output, aliases, expectedHost) {
  const expected = normalizeSipEndpointHost(expectedHost).toLowerCase();
  if (!expected) return false;
  return gatewayFieldValues(output, aliases)
    .map((value) => normalizeSipEndpointHost(value).toLowerCase())
    .includes(expected);
}

function outputHasGatewayUser(output, expectedUser) {
  const expected = clean(expectedUser);
  if (!expected) return false;
  return gatewayFieldValues(output, ["username", "user", "auth-username", "auth username", "from-user", "from user", "extension"])
    .includes(expected);
}

function signalWireGatewayIdentity(entry, expected) {
  const output = `${entry?.stdout ?? ""}\n${entry?.stderr ?? ""}`;
  return {
    registered: /\bREGED\b/i.test(output),
    realmMatches: outputHasGatewayHost(output, ["realm", "sip realm", "register-realm", "register realm"], expected.realm),
    proxyMatches: outputHasGatewayHost(output, ["proxy", "sip proxy", "register-proxy", "register proxy"], expected.proxy),
    usernameMatches: outputHasGatewayUser(output, expected.username),
  };
}

function isPublicIpAddress(address) {
  if (isIP(address) === 4) {
    const [a, b, c] = address.split(".").map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 0 && (c === 0 || c === 2))
      || (a === 192 && b === 168)
      || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100)))
      || (a === 203 && b === 0 && c === 113)
      || a === 255);
  }
  if (isIP(address) === 6) {
    const normalized = address.toLowerCase();
    const mappedIpv4 = normalized.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
    if (mappedIpv4) return isPublicIpAddress(mappedIpv4[1]);
    return !specialUseIpv6.check(normalized, "ipv6");
  }
  return false;
}

function canonicalizeIpAddress(address) {
  const raw = clean(address).toLowerCase();
  const ipVersion = isIP(raw);
  if (ipVersion === 4) return raw;
  if (ipVersion !== 6) return "";

  const ipv4Suffix = raw.match(/^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/);
  let ipv6 = raw;
  let suffixGroups = [];
  if (ipv4Suffix) {
    const octets = ipv4Suffix[2].split(".").map(Number);
    if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return "";
    ipv6 = ipv4Suffix[1];
    suffixGroups = [
      ((octets[0] << 8) | octets[1]).toString(16),
      ((octets[2] << 8) | octets[3]).toString(16),
    ];
  }

  const [head = "", tail = ""] = ipv6.split("::");
  const headGroups = head.split(":").filter(Boolean);
  const tailGroups = tail.split(":").filter(Boolean);
  const missingGroups = 8 - headGroups.length - tailGroups.length - suffixGroups.length;
  if (missingGroups < 0 || (!ipv6.includes("::") && missingGroups !== 0)) return "";
  const groups = [
    ...headGroups,
    ...Array(missingGroups).fill("0"),
    ...tailGroups,
    ...suffixGroups,
  ];
  if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) return "";
  return groups.map((group) => Number.parseInt(group, 16).toString(16).padStart(4, "0")).join(":");
}

function normalizeSipEndpointHost(value) {
  const raw = clean(value);
  if (!raw) return "";
  try {
    return new URL(raw.includes("://") ? raw : `sip://${raw}`).hostname.replace(/^\[|\]$/g, "");
  } catch {
    return removeEndpointPort(raw);
  }
}

function normalizeSipEndpointPort(value) {
  const raw = clean(value);
  if (!raw) return 5060;
  try {
    const parsed = new URL(raw.includes("://") ? raw : `sip://${raw}`);
    return parsed.port ? Number(parsed.port) : 5060;
  } catch {
    const bracketed = raw.match(/^\[[^\]]+\]:(\d+)$/);
    if (bracketed) return Number(bracketed[1]);
    const singlePort = raw.match(/^[^:]+:(\d+)$/);
    return singlePort ? Number(singlePort[1]) : 5060;
  }
}

async function resolvePublicEndpointAddresses(value) {
  const host = normalizeSipEndpointHost(value);
  if (!host) return [];
  if (isIP(host)) return isPublicIpAddress(host) ? [canonicalizeIpAddress(host)] : [];
  try {
    const addresses = (await lookup(host, { all: true })).map((entry) => entry.address);
    return addresses.filter(isPublicIpAddress).map(canonicalizeIpAddress);
  } catch {
    return [];
  }
}

function isPathInside(parent, child) {
  const relative = path.relative(parent, child);
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

async function hasSymlinkedAncestor(parent, child) {
  if (!isPathInside(parent, child)) return true;
  try {
    if ((await lstat(parent)).isSymbolicLink()) return true;
  } catch (error) {
    if (!(error && error.code === "ENOENT")) throw error;
  }
  const relativeParts = path.relative(parent, child).split(path.sep).filter(Boolean);
  let current = parent;
  for (const part of relativeParts) {
    current = path.join(current, part);
    try {
      if ((await lstat(current)).isSymbolicLink()) return true;
    } catch (error) {
      if (error && error.code === "ENOENT") return false;
      throw error;
    }
  }
  return false;
}

async function hasSymlinkedDirectoryAncestor(outputPath) {
  const absolute = path.resolve(outputPath);
  let current = path.parse(absolute).root;
  for (const part of path.dirname(absolute).slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try {
      if ((await lstat(current)).isSymbolicLink()) return true;
    } catch (error) {
      if (error && error.code === "ENOENT") return false;
      throw error;
    }
  }
  return false;
}

function removeEndpointPort(value) {
  const raw = clean(value);
  if (!raw) return "";
  const bracketed = raw.match(/^\[([^\]]+)\](?::\d+)?$/);
  if (bracketed) return bracketed[1];
  const colonCount = (raw.match(/:/g) ?? []).length;
  if (colonCount === 1) return raw.replace(/:\d+$/, "");
  return raw;
}

function isPublicEndpointAdvertised(entry, expectedAddresses) {
  if (!entry || expectedAddresses.length === 0) return false;
  const output = `${entry.stdout ?? ""}\n${entry.stderr ?? ""}`;
  const advertised = [...output.matchAll(/^\s*(?:ext-)?sip-ip(?:\s*[:=]\s*|\s+)(\S+)/gim)]
    .map((match) => canonicalizeIpAddress(removeEndpointPort(match[1])))
    .filter(Boolean);
  return expectedAddresses.some((address) => advertised.includes(address));
}

async function externalSipReachabilityProof(proofPath, expectedEndpoint, now, expectedTransport) {
  const expectedHost = normalizeSipEndpointHost(expectedEndpoint).toLowerCase();
  const expectedPort = normalizeSipEndpointPort(expectedEndpoint);
  const requiredTransport = clean(expectedTransport).toLowerCase();
  const empty = {
    proven: false,
    missing: !proofPath,
    blocker: "freeswitch_external_sip_reachability_not_proven",
    proofPath: proofPath ? path.resolve(repoRoot, proofPath) : "",
    source: null,
    checkedAt: null,
    transport: null,
    sipResponseCode: null,
  };
  if (!proofPath) return empty;

  const resolvedPath = path.resolve(repoRoot, proofPath);
  try {
    if (await hasSymlinkedDirectoryAncestor(resolvedPath)) {
      return { ...empty, missing: false, blocker: "unsafe_freeswitch_external_sip_reachability_proof_path" };
    }
    if (!(await lstat(resolvedPath)).isFile()) {
      return { ...empty, missing: false, blocker: "invalid_freeswitch_external_sip_reachability_proof" };
    }
    const proof = JSON.parse(await readFile(resolvedPath, "utf8"));
    const source = clean(proof.source);
    const proofHost = normalizeSipEndpointHost(proof.targetHost ?? proof.host ?? proof.endpoint?.host).toLowerCase();
    const proofPort = Number(proof.targetPort ?? proof.port ?? proof.endpoint?.port ?? 5060);
    const checkedAt = clean(proof.checkedAt);
    const checkedAtMs = Date.parse(checkedAt);
    const transport = clean(proof.transport || "udp").toLowerCase();
    const sipResponseCode = Number(proof.sipResponseCode ?? proof.responseCode);
    const sourceIsExternal = /(?:signalwire|provider|external)/i.test(source);
    const targetMatches = proofHost === expectedHost && proofPort === expectedPort;
    const futureDated = Number.isFinite(checkedAtMs)
      && checkedAtMs - now > EXTERNAL_REACHABILITY_PROOF_CLOCK_SKEW_MS;
    const fresh = Number.isFinite(checkedAtMs)
      && !futureDated
      && now - checkedAtMs <= EXTERNAL_REACHABILITY_PROOF_MAX_AGE_MS;
    const sipResponseProvesReachability = Number.isInteger(sipResponseCode)
      && sipResponseCode >= 100
      && sipResponseCode <= 699;
    const transportMatches = transport === requiredTransport;
    const proven = proof.reachable === true
      && sourceIsExternal
      && targetMatches
      && fresh
      && transportMatches
      && sipResponseProvesReachability;
    return {
      proven,
      missing: false,
      blocker: futureDated
        ? "future_dated_freeswitch_external_sip_reachability_proof"
        : fresh
          ? "invalid_freeswitch_external_sip_reachability_proof"
          : "stale_freeswitch_external_sip_reachability_proof",
      proofPath: resolvedPath,
      source: source || null,
      checkedAt: checkedAt || null,
      transport: transport || null,
      sipResponseCode: Number.isInteger(sipResponseCode) ? sipResponseCode : null,
    };
  } catch {
    return { ...empty, missing: false, blocker: "invalid_freeswitch_external_sip_reachability_proof" };
  }
}

function isVertoAgentContactRegistered(entry, expectedContacts) {
  if (!entry) return false;
  const output = `${entry.stdout ?? ""}\n${entry.stderr ?? ""}`;
  if (/\b0\s+total\s+registrations\b/i.test(output)) return false;
  const registeredContacts = [...output.matchAll(/\bacc-pipecat@([^\s;,'"<>]+)/gi)]
    .map((match) => `acc-pipecat@${clean(match[1]).toLowerCase().replace(/[);]+$/g, "")}`)
    .filter(Boolean);
  return expectedContacts.some((contact) => registeredContacts.includes(contact));
}

async function renderTemplate(templatePath, outputPath, replacements) {
  let text = await readFile(templatePath, "utf8");
  for (const [key, value] of Object.entries(replacements)) {
    text = text.replaceAll(`__${key}__`, value);
  }
  await writeAtomicPrivateFile(outputPath, text);
  return outputPath;
}

async function writeAtomicPrivateFile(outputPath, text) {
  await mkdir(path.dirname(outputPath), { recursive: true });
  const tempPath = path.join(
    path.dirname(outputPath),
    `.${path.basename(outputPath)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
  );
  try {
    await writeFile(tempPath, text, { mode: 0o600, flag: "wx" });
    await chmod(tempPath, 0o600);
    await rename(tempPath, outputPath);
    await chmod(outputPath, 0o600);
  } catch (error) {
    await rm(tempPath, { force: true });
    throw error;
  }
}

async function safeArtifactOutputPath(outputPath) {
  return isPathInside(artifactsRoot, outputPath)
    && !(await hasSymlinkedAncestor(artifactsRoot, outputPath));
}

async function isMultiplyLinkedDestination(outputPath) {
  try {
    return (await lstat(outputPath)).nlink > 1;
  } catch (error) {
    if (error && error.code === "ENOENT") return false;
    throw error;
  }
}

async function runFsCli(command, redactor) {
  const explicitFsCliBin = args.includes("--fs-cli-bin") || Boolean(clean(process.env.FS_CLI_BIN));
  const fsCliBin = argValue("--fs-cli-bin", process.env.FS_CLI_BIN || "fs_cli");
  const options = {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: Number(argValue("--fs-cli-timeout-ms", "5000")),
    maxBuffer: 1024 * 1024,
  };
  let stdout;
  let stderr;
  let proofCommand = `fs_cli -x '${command}'`;
  try {
    ({ stdout, stderr } = await execFileAsync(fsCliBin, ["-x", command], options));
  } catch (error) {
    if (explicitFsCliBin || !(error && error.code === "ENOENT")) throw error;
    ({ stdout, stderr } = await execFileAsync("docker", ["compose", "exec", "-T", "freeswitch", "fs_cli", "-x", command], options));
    proofCommand = `docker compose exec -T freeswitch fs_cli -x '${command}'`;
  }
  return {
    proof: {
      command: redactor(proofCommand),
      stdout: redactor(stdout.trim()),
      stderr: redactor(stderr.trim()),
    },
    raw: {
      stdout: stdout.trim(),
      stderr: stderr.trim(),
    },
  };
}

const trunkMode = clean(process.env.SIGNALWIRE_TRUNK_MODE || "registration").toLowerCase().replace(/-/g, "_");
const requiredEnv = trunkMode === "registration"
  ? [...COMMON_REQUIRED_ENV, ...REGISTRATION_REQUIRED_ENV]
  : COMMON_REQUIRED_ENV;
const env = Object.fromEntries(ALL_ENV.map((name) => [name, clean(process.env[name])]));
const missing = requiredEnv.filter((name) => !env[name]);
const signalwireRealm = clean(process.env.SIGNALWIRE_SIP_REALM) || signalwireSipHostFromSpaceUrl(env.SIGNALWIRE_SPACE_URL);
const signalwireProxy = clean(process.env.SIGNALWIRE_SIP_PROXY) || signalwireRealm;
const signalwireDid = signalwireDidDigits(env.SIGNALWIRE_FROM_NUMBER);
const signalwireSourceAclName = clean(process.env.SIGNALWIRE_SOURCE_ACL_NAME) || DEFAULT_SIGNALWIRE_SOURCE_ACL_NAME;
const signalwireSourceIpProbe = clean(process.env.SIGNALWIRE_SOURCE_IP_PROBE);
const signalwireProviderIngressCidrs = parseProviderIngressCidrs(process.env.SIGNALWIRE_PROVIDER_INGRESS_CIDRS);
const signalwireSourceRejectProbe = nonProviderSourceAclRejectProbe(signalwireProviderIngressCidrs, signalwireSourceIpProbe);
const externalSipReachabilityProofPath = clean(process.env.SIGNALWIRE_EXTERNAL_SIP_REACHABILITY_PROOF_PATH);
const signalwireSourceAclConfigCommand = `xml_locate configuration list name ${signalwireSourceAclName}`;
const signalwireDidNational = signalwireDid.length === 11 && signalwireDid.startsWith("1")
  ? signalwireDid.slice(1)
  : "";
const signalwireDidPattern = didPattern(env.SIGNALWIRE_FROM_NUMBER);
const outputDir = path.resolve(repoRoot, argValue("--out-dir", "artifacts/freeswitch-signalwire/conf"));
const manifestPath = path.resolve(repoRoot, argValue("--manifest", "artifacts/freeswitch-signalwire/readiness.json"));
const artifactsRoot = path.resolve(repoRoot, "artifacts");
const outputDirIsArtifact = isPathInside(artifactsRoot, outputDir)
  && !(await hasSymlinkedAncestor(artifactsRoot, outputDir));
const manifestPathHasSymlinkedAncestor = await hasSymlinkedDirectoryAncestor(manifestPath);
const redactor = buildRedactor([
  ...Object.values(env),
  signalwireRealm,
  signalwireProxy,
  signalwireDidPattern,
  signalwireDid,
  signalwireDidNational,
  process.env.SIGNALWIRE_PROJECT_ID,
  process.env.SIGNALWIRE_TOKEN,
  process.env.SIGNALWIRE_SIP_REALM,
  process.env.SIGNALWIRE_SIP_PROXY,
  signalwireSourceIpProbe,
  signalwireSourceRejectProbe,
  ...signalwireProviderIngressCidrs,
]);

const summary = {
  ok: false,
  status: "blocked",
  manualCallReady: false,
  telephonyMode: "signalwire_live",
  trunkMode,
  requiredEnv,
  missingEnv: missing,
  endpoint: {
    signalwireRealm: signalwireRealm ? redact(signalwireRealm) : null,
    signalwireProxy: signalwireProxy ? redact(signalwireProxy) : null,
    sipUsername: env.SIGNALWIRE_SIP_USERNAME ? redact(env.SIGNALWIRE_SIP_USERNAME) : null,
    fromNumber: env.SIGNALWIRE_FROM_NUMBER ? redact(env.SIGNALWIRE_FROM_NUMBER) : null,
    freeswitchPublicSipHost: env.FREESWITCH_PUBLIC_SIP_HOST ? redact(env.FREESWITCH_PUBLIC_SIP_HOST) : null,
    externalSipReachability: {
      proven: false,
      proofPath: externalSipReachabilityProofPath ? path.relative(repoRoot, path.resolve(repoRoot, externalSipReachabilityProofPath)) : null,
      source: null,
      checkedAt: null,
      transport: null,
      sipResponseCode: null,
    },
  },
  sourceRestriction: {
    type: "freeswitch_acl",
    aclName: signalwireSourceAclName,
    probeIp: signalwireSourceIpProbe ? redactor(signalwireSourceIpProbe) : null,
    rejectProbeIp: signalwireSourceRejectProbe ? redactor(signalwireSourceRejectProbe) : null,
    providerIngressCidrs: signalwireProviderIngressCidrs.map(redactor),
    providerOwnedProbe: false,
    activeAclProven: false,
    activeAclRejectsNonProvider: false,
    activeAclAllowSetProviderOnly: false,
  },
  gatewayRegistration: trunkMode === "registration"
    ? {
      registered: false,
      realmMatches: false,
      proxyMatches: false,
      usernameMatches: false,
    }
    : null,
  vertoRegistration: {
    expectedContacts: [],
    registered: false,
  },
  generatedConfig: null,
  freeswitchCli: [],
  blockers: [],
};

if (!["registration", "ip_auth"].includes(trunkMode)) {
  summary.blockers.push("invalid_signalwire_trunk_mode");
} else if (missing.length) {
  summary.blockers.push("missing_signalwire_or_freeswitch_env");
} else if (!signalwireDid) {
  summary.blockers.push("invalid_signalwire_from_number");
} else if (trunkMode === "registration" && (!signalwireRealm || !signalwireProxy)) {
  summary.missingEnv.push("SIGNALWIRE_SIP_REALM_OR_PROXY");
  summary.blockers.push("missing_signalwire_sip_realm_or_proxy");
}
if (!/^[A-Za-z0-9_.:-]+$/.test(signalwireSourceAclName)) {
  summary.blockers.push("invalid_signalwire_source_acl_name");
}
if (summary.blockers.length === 0 && !hasFlag("--skip-fs-cli")) {
  if (!signalwireSourceIpProbe) {
    summary.missingEnv.push("SIGNALWIRE_SOURCE_IP_PROBE");
    summary.blockers.push("signalwire_source_acl_probe_missing");
  } else if (!isIP(signalwireSourceIpProbe)) {
    summary.blockers.push("invalid_signalwire_source_ip_probe");
  } else if (!isPublicIpAddress(signalwireSourceIpProbe)) {
    summary.blockers.push("invalid_signalwire_source_ip_probe");
  } else if (signalwireProviderIngressCidrs.length === 0) {
    summary.missingEnv.push("SIGNALWIRE_PROVIDER_INGRESS_CIDRS");
    summary.blockers.push("signalwire_provider_ingress_cidrs_missing");
  } else if (!isSignalWireProviderIngressProbe(signalwireSourceIpProbe, signalwireProviderIngressCidrs)) {
    summary.blockers.push("signalwire_source_probe_not_provider_owned");
  } else if (!signalwireSourceRejectProbe) {
    summary.blockers.push("signalwire_source_acl_reject_probe_unavailable");
  } else {
    summary.sourceRestriction.providerOwnedProbe = true;
  }
}

if (hasFlag("--render") && !outputDirIsArtifact) {
  summary.blockers.push("unsafe_freeswitch_output_dir");
}
if (manifestPathHasSymlinkedAncestor) {
  summary.blockers.push("unsafe_freeswitch_manifest_path");
}

const replacements = {
  SIGNALWIRE_SIP_USERNAME: xmlEscape(env.SIGNALWIRE_SIP_USERNAME),
  SIGNALWIRE_SIP_PASSWORD: xmlEscape(env.SIGNALWIRE_SIP_PASSWORD),
  SIGNALWIRE_SIP_REALM: xmlEscape(signalwireRealm),
  SIGNALWIRE_SIP_PROXY: xmlEscape(signalwireProxy),
  SIGNALWIRE_TO_NUMBER_PATTERN: signalwireDidPattern,
  SIGNALWIRE_FROM_NUMBER_SAFE: xmlEscape(env.SIGNALWIRE_FROM_NUMBER),
  FREESWITCH_PUBLIC_SIP_HOST_SAFE: xmlEscape(env.FREESWITCH_PUBLIC_SIP_HOST),
  SIGNALWIRE_SOURCE_ACL_NAME: xmlEscape(signalwireSourceAclName),
};

if (hasFlag("--render") && summary.blockers.length === 0) {
  const gatewayOutputPath = path.join(outputDir, "sip_profiles/external/signalwire.xml");
  const dialplanOutputPath = path.join(outputDir, "dialplan/public/signalwire_inbound.xml");
  for (const destinationPath of [gatewayOutputPath, dialplanOutputPath]) {
    if (!(await safeArtifactOutputPath(destinationPath))) {
      summary.blockers.push("unsafe_freeswitch_output_dir");
      break;
    }
    if (await isMultiplyLinkedDestination(destinationPath)) {
      summary.blockers.push("unsafe_freeswitch_output_link");
      break;
    }
  }
}

if (hasFlag("--render") && summary.blockers.length === 0) {
  const gatewayOutputPath = path.join(outputDir, "sip_profiles/external/signalwire.xml");
  const dialplanOutputPath = path.join(outputDir, "dialplan/public/signalwire_inbound.xml");
  const gatewayPath = trunkMode === "registration"
    ? await renderTemplate(
      path.join(repoRoot, "freeswitch/templates/signalwire-gateway.xml.template"),
      gatewayOutputPath,
      replacements,
    )
    : null;
  if (trunkMode === "ip_auth") {
    await rm(gatewayOutputPath, { force: true });
  }
  const dialplanPath = await renderTemplate(
    path.join(repoRoot, "freeswitch/templates/signalwire_inbound.xml.template"),
    dialplanOutputPath,
    replacements,
  );
  summary.generatedConfig = {
    gatewayPath: gatewayPath ? path.relative(repoRoot, gatewayPath) : null,
    dialplanPath: path.relative(repoRoot, dialplanPath),
    gitignored: outputDirIsArtifact,
  };
}

const fsCliSkipped = hasFlag("--skip-fs-cli");
const rawFsCli = new Map();

if (summary.blockers.length === 0 && !fsCliSkipped) {
  const dialplanCommand = "xml_locate dialplan extension name agentic_contact_center_signalwire_pstn";
  const aclCommand = `acl ${signalwireSourceIpProbe} ${signalwireSourceAclName}`;
  const aclRejectCommand = `acl ${signalwireSourceRejectProbe} ${signalwireSourceAclName}`;
  const commands = trunkMode === "ip_auth"
    ? ["sofia status profile external", signalwireSourceAclConfigCommand, aclCommand, aclRejectCommand, "show registrations", dialplanCommand]
    : ["sofia status profile external", "sofia status gateway signalwire", signalwireSourceAclConfigCommand, aclCommand, aclRejectCommand, "show registrations", dialplanCommand];
  for (const command of commands) {
    try {
      const result = await runFsCli(command, redactor);
      summary.freeswitchCli.push(result.proof);
      rawFsCli.set(command, result.raw);
    } catch (error) {
      summary.blockers.push(
        trunkMode === "ip_auth"
          ? "freeswitch_cli_unavailable_or_external_profile_unready"
          : "freeswitch_cli_unavailable_or_gateway_unregistered",
      );
      summary.freeswitchCli.push({
        command: redactor(`fs_cli -x '${command}'`),
        error: redactor(error instanceof Error ? error.message : String(error)),
      });
      break;
    }
  }
}

if (summary.blockers.length === 0 && !fsCliSkipped) {
  const externalProfile = rawFsCli.get("sofia status profile external");
  if (!isExternalProfileRunning(externalProfile)) {
    summary.blockers.push("freeswitch_external_profile_not_running");
  }
}

if (summary.blockers.length === 0 && !fsCliSkipped) {
  const publicAddresses = await resolvePublicEndpointAddresses(env.FREESWITCH_PUBLIC_SIP_HOST);
  const externalProfile = rawFsCli.get("sofia status profile external");
  if (!isPublicEndpointAdvertised(externalProfile, publicAddresses)) {
    summary.blockers.push("freeswitch_public_sip_endpoint_not_proven");
  }
}

if (summary.blockers.length === 0 && !fsCliSkipped) {
  const gateway = rawFsCli.get("sofia status gateway signalwire");
  if (trunkMode === "registration") {
    const gatewayIdentity = signalWireGatewayIdentity(gateway, {
      realm: signalwireRealm,
      proxy: signalwireProxy,
      username: env.SIGNALWIRE_SIP_USERNAME,
    });
    summary.gatewayRegistration = gatewayIdentity;
    if (!gatewayIdentity.registered) {
      summary.blockers.push("signalwire_gateway_status_not_proven");
    } else if (!gatewayIdentity.realmMatches || !gatewayIdentity.proxyMatches || !gatewayIdentity.usernameMatches) {
      summary.blockers.push("signalwire_gateway_identity_mismatch");
    }
  }
}

if (summary.blockers.length === 0 && !fsCliSkipped) {
  const acl = rawFsCli.get(`acl ${signalwireSourceIpProbe} ${signalwireSourceAclName}`);
  const rejectAcl = rawFsCli.get(`acl ${signalwireSourceRejectProbe} ${signalwireSourceAclName}`);
  const aclConfig = rawFsCli.get(signalwireSourceAclConfigCommand);
  if (!isSignalWireSourceAclProven(acl)) {
    summary.blockers.push("signalwire_source_acl_not_proven");
  } else if (!isSignalWireSourceAclRejected(rejectAcl)) {
    summary.blockers.push("signalwire_source_acl_too_permissive");
  } else if (!activeAclAllowsOnlyProviderCidrs(aclConfig, signalwireSourceAclName, signalwireProviderIngressCidrs)) {
    summary.blockers.push("signalwire_source_acl_too_permissive");
  } else {
    summary.sourceRestriction.activeAclProven = true;
    summary.sourceRestriction.activeAclRejectsNonProvider = true;
    summary.sourceRestriction.activeAclAllowSetProviderOnly = true;
  }
}

if (summary.blockers.length === 0 && !fsCliSkipped) {
  const dialplan = rawFsCli.get("xml_locate dialplan extension name agentic_contact_center_signalwire_pstn");
  if (!isInboundDialplanActive(dialplan, signalwireDidPattern, signalwireSourceAclName)) {
    summary.blockers.push("signalwire_inbound_dialplan_not_proven");
  } else {
    summary.vertoRegistration.expectedContacts = expectedVertoAgentContactsFromDialplan(dialplan).map(redactor);
    if (summary.vertoRegistration.expectedContacts.length === 0) {
      summary.blockers.push("verto_agent_contact_not_proven");
    }
  }
}

if (summary.blockers.length === 0 && !fsCliSkipped) {
  const registrations = rawFsCli.get("show registrations");
  const dialplan = rawFsCli.get("xml_locate dialplan extension name agentic_contact_center_signalwire_pstn");
  const expectedContacts = expectedVertoAgentContactsFromDialplan(dialplan);
  summary.vertoRegistration.registered = isVertoAgentContactRegistered(registrations, expectedContacts);
  if (!summary.vertoRegistration.registered) {
    summary.blockers.push("verto_agent_contact_not_proven");
  }
}

if (summary.blockers.length === 0 && !fsCliSkipped) {
  const reachability = await externalSipReachabilityProof(
    externalSipReachabilityProofPath,
    env.FREESWITCH_PUBLIC_SIP_HOST,
    Date.now(),
    EXPECTED_SIGNALWIRE_SIP_TRANSPORT,
  );
  summary.endpoint.externalSipReachability = {
    proven: reachability.proven,
    proofPath: reachability.proofPath ? path.relative(repoRoot, reachability.proofPath) : summary.endpoint.externalSipReachability.proofPath,
    source: reachability.source,
    checkedAt: reachability.checkedAt,
    transport: reachability.transport,
    sipResponseCode: reachability.sipResponseCode,
  };
  if (reachability.missing) {
    summary.missingEnv.push("SIGNALWIRE_EXTERNAL_SIP_REACHABILITY_PROOF_PATH");
    summary.blockers.push("freeswitch_external_sip_reachability_not_proven");
  } else if (!reachability.proven) {
    summary.blockers.push(reachability.blocker);
  }
}

summary.ok = summary.blockers.length === 0;
summary.manualCallReady = summary.ok && !fsCliSkipped;
summary.status = summary.manualCallReady
  ? "ready_for_manual_pstn_call"
  : summary.ok && summary.generatedConfig
    ? "config_rendered_pending_freeswitch_cli"
    : summary.ok
      ? "config_validated_pending_render_or_freeswitch_cli"
      : "blocked";

if (!manifestPathHasSymlinkedAncestor) {
  await writeAtomicPrivateFile(manifestPath, `${JSON.stringify(summary, null, 2)}\n`);
}

console.log(JSON.stringify(summary, null, 2));
process.exit(summary.ok ? 0 : 2);
