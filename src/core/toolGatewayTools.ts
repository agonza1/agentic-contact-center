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

export interface AccMcpToolManifestEntry {
  name: AccToolName;
  description: string;
  annotations: AccToolAnnotations;
  inputSchema: {
    type: "object";
    additionalProperties: false;
    properties: Record<string, {
      type: "string" | "number";
      minimum?: number;
      maximum?: number;
    }>;
    required: string[];
  };
}

export type AccToolArgumentValidationReason =
  | "unknown_argument"
  | "missing_required_argument"
  | "invalid_argument_type"
  | "argument_out_of_bounds";

export interface AccToolArgumentValidationError {
  argumentName: string;
  reason: AccToolArgumentValidationReason;
}

export interface AccToolArgumentValidationResult {
  valid: boolean;
  normalizedArguments: Record<string, string | number>;
  errors: AccToolArgumentValidationError[];
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

export function listAccMcpToolsForPrincipal(principalType: ToolGatewayPrincipalType): AccMcpToolManifestEntry[] {
  return listAccToolsForPrincipal(principalType).map((definition) => ({
    name: definition.name,
    description: definition.purpose,
    annotations: definition.annotations,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: Object.fromEntries(definition.arguments.map((argument) => [
        argument.name,
        {
          type: argument.type,
          ...(argument.minimum === undefined ? {} : { minimum: argument.minimum }),
          ...(argument.maximum === undefined ? {} : { maximum: argument.maximum }),
        },
      ])),
      required: definition.arguments.filter((argument) => argument.required).map((argument) => argument.name),
    },
  }));
}

export function getAccToolDefinition(name: AccToolName): AccToolDefinition {
  const definition = accToolDefinitions.find((candidate) => candidate.name === name);
  if (!definition) throw new Error(`Unknown ACC tool definition: ${name}`);
  return definition;
}

export function isAccToolCallableByPrincipal(name: AccToolName, principalType: ToolGatewayPrincipalType): boolean {
  return getAccToolDefinition(name).principalTypes.includes(principalType);
}

export function validateAccToolArguments(
  name: AccToolName,
  inputArguments: Record<string, unknown>,
): AccToolArgumentValidationResult {
  const definition = getAccToolDefinition(name);
  const expectedArguments = new Map(definition.arguments.map((argument) => [argument.name, argument]));
  const normalizedArguments: Record<string, string | number> = {};
  const errors: AccToolArgumentValidationError[] = [];

  for (const argument of definition.arguments) {
    const value = inputArguments[argument.name];
    if (value === undefined || value === null) {
      if (argument.required) {
        errors.push({ argumentName: argument.name, reason: "missing_required_argument" });
      }
      continue;
    }

    if (argument.type === "string") {
      if (typeof value !== "string" || value.trim() === "") {
        errors.push({ argumentName: argument.name, reason: "invalid_argument_type" });
        continue;
      }
      normalizedArguments[argument.name] = value;
      continue;
    }

    if (typeof value !== "number" || !Number.isFinite(value)) {
      errors.push({ argumentName: argument.name, reason: "invalid_argument_type" });
      continue;
    }

    if (
      (argument.minimum !== undefined && value < argument.minimum)
      || (argument.maximum !== undefined && value > argument.maximum)
    ) {
      errors.push({ argumentName: argument.name, reason: "argument_out_of_bounds" });
      continue;
    }

    normalizedArguments[argument.name] = value;
  }

  for (const argumentName of Object.keys(inputArguments)) {
    if (!expectedArguments.has(argumentName)) {
      errors.push({ argumentName, reason: "unknown_argument" });
    }
  }

  return {
    valid: errors.length === 0,
    normalizedArguments,
    errors,
  };
}
