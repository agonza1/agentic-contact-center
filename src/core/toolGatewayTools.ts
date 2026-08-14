export type ToolGatewayPrincipalType = "voice_agent" | "operator";

export type AccToolName =
  | "retention.lookup_options"
  | "operator.request_approval"
  | "retention.apply_offer";

export interface AccToolAnnotations {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

export interface AccToolArgument {
  name: string;
  type: "string" | "number";
  required: boolean;
  minimum?: number;
  maximum?: number;
}

export interface AccToolDefinition {
  name: AccToolName;
  purpose: string;
  principalTypes: ToolGatewayPrincipalType[];
  annotations: AccToolAnnotations;
  arguments: AccToolArgument[];
}

export const accToolDefinitions: readonly AccToolDefinition[] = [
  {
    name: "retention.lookup_options",
    purpose: "Return compact, pre-approved retention options for the current cancellation-rescue call.",
    principalTypes: ["voice_agent", "operator"],
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    arguments: [
      { name: "call_id", type: "string", required: true },
    ],
  },
  {
    name: "operator.request_approval",
    purpose: "Create or return an idempotent server-side operator approval request for a bounded retention offer.",
    principalTypes: ["voice_agent", "operator"],
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    arguments: [
      { name: "call_id", type: "string", required: true },
      { name: "offer_id", type: "string", required: true },
      { name: "discount_percent", type: "number", required: true, minimum: 0, maximum: 10 },
      { name: "idempotency_key", type: "string", required: true },
    ],
  },
  {
    name: "retention.apply_offer",
    purpose: "Apply a mocked, already-approved retention offer to ACC state.",
    principalTypes: ["operator"],
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
    arguments: [
      { name: "call_id", type: "string", required: true },
      { name: "offer_id", type: "string", required: true },
      { name: "discount_percent", type: "number", required: true, minimum: 0, maximum: 10 },
      { name: "approval_id", type: "string", required: true },
      { name: "idempotency_key", type: "string", required: true },
    ],
  },
];

export function listAccToolsForPrincipal(principalType: ToolGatewayPrincipalType): AccToolDefinition[] {
  return accToolDefinitions.filter((definition) => definition.principalTypes.includes(principalType));
}

export function getAccToolDefinition(name: AccToolName): AccToolDefinition {
  const definition = accToolDefinitions.find((candidate) => candidate.name === name);
  if (!definition) throw new Error(`Unknown ACC tool definition: ${name}`);
  return definition;
}

export function isAccToolCallableByPrincipal(name: AccToolName, principalType: ToolGatewayPrincipalType): boolean {
  return getAccToolDefinition(name).principalTypes.includes(principalType);
}
