import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { runtimeSeams } from "../core/seams";
import type { PocConfig } from "../core/types";

function writeJson(response: ServerResponse, statusCode: number, payload: object): void {
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(JSON.stringify(payload, null, 2));
}

function routeRequest(
  request: IncomingMessage,
  response: ServerResponse,
  config: PocConfig,
): void {
  const url = request.url ?? "/";

  if (request.method === "GET" && url === "/health") {
    writeJson(response, 200, {
      ok: true,
      demoName: config.demoName,
      mode: config.mode,
      provider: config.provider.name,
      operatorChannel: config.operator.channel,
      runtimeSeams,
    });
    return;
  }

  writeJson(response, 404, {
    ok: false,
    error: "not_found",
  });
}

export function buildHttpServer(config: PocConfig) {
  return createServer((request, response) => routeRequest(request, response, config));
}
