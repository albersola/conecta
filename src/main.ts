import { createHandler } from "./api.ts";
import { ConectaDatabase } from "./database.ts";
import {
  createDeployDependencies,
  deploy,
  parseDnsPropagationSeconds,
  rollout,
} from "./deploy.ts";
import { createDnsServer, normalizeZone, parseDnsTtl } from "./dns.ts";
import { logger } from "./logger.ts";

const httpPort = parsePort(Deno.env.get("PORT") ?? "3000", "PORT");
const httpHostname = Deno.env.get("HOSTNAME")?.trim() || "0.0.0.0";
const dnsPort = parsePort(
  Deno.env.get("CONECTA_DNS_PORT") ?? "5353",
  "CONECTA_DNS_PORT",
);
const dnsHostname = Deno.env.get("CONECTA_DNS_HOSTNAME")?.trim() ||
  "0.0.0.0";
const dnsZone = normalizeZone(
  Deno.env.get("CONECTA_DNS_ZONE") ?? "svc.internal",
);
const dnsTtl = parseDnsTtl(
  Deno.env.get("CONECTA_DNS_TTL_SECONDS") ?? "5",
);
const apiKey = Deno.env.get("CONECTA_API_KEY")?.trim();

if (!apiKey) {
  throw new Error("CONECTA_API_KEY must be configured.");
}

parseDnsPropagationSeconds(
  Deno.env.get("CONECTA_DNS_PROPAGATION_SECONDS") ?? "10",
);

const database = new ConectaDatabase(
  Deno.env.get("CONECTA_DB_PATH") ?? "/data/conecta.sqlite",
);
const deploymentDependencies = createDeployDependencies(database);
const dnsServer = createDnsServer(database, {
  zone: dnsZone,
  ttl: dnsTtl,
});

await dnsServer.listen({
  udp: { address: dnsHostname, port: dnsPort },
  tcp: { address: dnsHostname, port: dnsPort },
});
logger.info("dns_service_listening", {
  hostname: dnsHostname,
  port: dnsPort,
  zone: dnsZone,
  ttl_seconds: dnsTtl,
});

const httpServer = Deno.serve(
  {
    hostname: httpHostname,
    port: httpPort,
    onListen: () => undefined,
  },
  createHandler({
    apiKey,
    deployer: (projectId, project, context) =>
      deploy(projectId, project, deploymentDependencies, context),
    rollouter: (projectId, context) =>
      rollout(projectId, deploymentDependencies, context),
  }),
);
logger.info("http_service_listening", {
  hostname: httpHostname,
  port: httpPort,
});

let shutdownPromise: Promise<void> | undefined;
const shutdown = () => {
  if (shutdownPromise) {
    return shutdownPromise;
  }

  logger.info("service_shutdown_started");
  shutdownPromise = (async () => {
    await Promise.allSettled([
      httpServer.shutdown(),
      dnsServer.close(),
    ]);
    database.close();
    logger.info("service_shutdown_completed");
  })();
  return shutdownPromise;
};

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  Deno.addSignalListener(signal, () => {
    void shutdown();
  });
}

function parsePort(value: string, field: string) {
  const port = Number(value);

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${field} must be an integer from 1 to 65535.`);
  }

  return port;
}
