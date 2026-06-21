import { buildHttpServer } from "./http/createServer";
import { loadPocConfig, resolvePocConfigPath } from "./config/loadPocConfig";

const DEFAULT_PORT = 8026;

function resolvePort(): number {
  const rawPort = process.env.PORT;

  if (!rawPort) {
    return DEFAULT_PORT;
  }

  const parsed = Number.parseInt(rawPort, 10);
  return Number.isNaN(parsed) ? DEFAULT_PORT : parsed;
}

async function main(): Promise<void> {
  const config = loadPocConfig(resolvePocConfigPath());
  const port = resolvePort();
  const server = buildHttpServer(config);

  await new Promise<void>((resolve) => {
    server.listen(port, () => {
      console.log(`agentic-contact-center listening on http://localhost:${port}`);
      resolve();
    });
  });
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
