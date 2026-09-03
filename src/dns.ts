import { createServer, type DnsHandler, type DnsServer, Packet } from "dns2";
import { isIP } from "node:net";
import { type Logger, logger } from "./logger.ts";
import type { ServiceRegistry } from "./service_registry.ts";

export type DnsOptions = {
  hostname: string;
  port: number;
  zone: string;
  ttl: number;
};

export function createDnsServer(
  registry: ServiceRegistry,
  options: Pick<DnsOptions, "zone" | "ttl">,
  log: Logger = logger,
): DnsServer {
  const zone = normalizeZone(options.zone);
  const handler = createDnsHandler(registry, { zone, ttl: options.ttl }, log);
  const server = createServer({
    udp: true,
    tcp: true,
    maxConcurrent: 1_000,
    handle: handler,
  });

  server.on("requestError", (error) => {
    log.warn("dns_request_rejected", { error: readableError(error) });
  });
  server.on("error", (error, transport) => {
    log.error("dns_server_error", {
      transport,
      error: readableError(error),
    });
  });

  return server;
}

export function createDnsHandler(
  registry: ServiceRegistry,
  options: Pick<DnsOptions, "zone" | "ttl">,
  log: Logger = logger,
): DnsHandler {
  const zone = normalizeZone(options.zone);
  const ttl = parseDnsTtl(String(options.ttl));

  return async (request, send) => {
    const response = Packet.createResponseFromRequest(request);
    response.header.aa = 1;
    response.header.ra = 0;

    try {
      if (request.errors.length > 0 || request.questions.length !== 1) {
        response.header.rcode = Packet.RCODE.FORMERR;
        await send(response);
        return;
      }

      if (request.header.opcode !== 0) {
        response.header.rcode = Packet.RCODE.NOTIMP;
        await send(response);
        return;
      }

      const question = request.questions[0];
      const name = normalizeDnsName(question.name);
      if (
        question.class !== Packet.CLASS.IN &&
        question.class !== Packet.CLASS.ANY
      ) {
        response.header.rcode = Packet.RCODE.REFUSED;
        await send(response);
        return;
      }

      if (name === zone) {
        answerZoneQuestion(response, question, zone, ttl);
        await send(response);
        return;
      }

      if (!name.endsWith(`.${zone}`)) {
        response.header.aa = 0;
        response.header.rcode = Packet.RCODE.REFUSED;
        await send(response);
        return;
      }

      const query = parseServiceQuery(name, zone);
      if (!query) {
        addNegativeAnswer(response, zone, ttl, Packet.RCODE.NXDOMAIN);
        await send(response);
        return;
      }

      const service = await registry.getService(query.serviceId);
      if (!service) {
        addNegativeAnswer(response, zone, ttl, Packet.RCODE.NXDOMAIN);
        await send(response);
        return;
      }

      if (query.kind === "srv") {
        if (
          question.type === Packet.TYPE.SRV ||
          question.type === Packet.TYPE.ANY
        ) {
          response.answers.push(
            new Packet.Resource({
              name: question.name,
              type: Packet.TYPE.SRV,
              class: Packet.CLASS.IN,
              ttl,
              priority: 0,
              weight: 0,
              port: service.port,
              target: `${query.serviceId}.${zone}`,
            }),
          );
          addAddressRecords(
            response.additionals,
            `${query.serviceId}.${zone}`,
            service.addresses,
            ttl,
          );
        } else {
          addNegativeAnswer(response, zone, ttl, Packet.RCODE.NOERROR);
        }

        await send(response);
        return;
      }

      const matched = addAddressRecords(
        response.answers,
        question.name,
        service.addresses,
        ttl,
        question.type,
      );
      if (!matched) {
        addNegativeAnswer(response, zone, ttl, Packet.RCODE.NOERROR);
      }
      await send(response);
    } catch (error) {
      log.error("dns_request_failed", { error: readableError(error) });
      response.answers = [];
      response.authorities = [];
      response.additionals = [];
      response.header.rcode = Packet.RCODE.SERVFAIL;
      await send(response);
    }
  };
}

export function normalizeZone(value: string) {
  const zone = normalizeDnsName(value);
  const labels = zone.split(".");

  if (
    !zone ||
    zone.length > 253 ||
    labels.some((label) =>
      !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)
    )
  ) {
    throw new Error("CONECTA_DNS_ZONE must be a valid DNS name.");
  }

  return zone;
}

export function parseDnsTtl(value: string) {
  const ttl = Number(value);
  if (!/^\d+$/.test(value.trim()) || !Number.isSafeInteger(ttl) || ttl > 3600) {
    throw new Error(
      "CONECTA_DNS_TTL_SECONDS must be an integer from 0 to 3600.",
    );
  }
  return ttl;
}

function answerZoneQuestion(
  response: InstanceType<typeof Packet>,
  question: InstanceType<typeof Packet.Question>,
  zone: string,
  ttl: number,
) {
  if (
    question.type === Packet.TYPE.SOA || question.type === Packet.TYPE.ANY
  ) {
    response.answers.push(soaRecord(zone, ttl));
    return;
  }

  if (question.type === Packet.TYPE.NS) {
    response.answers.push(
      new Packet.Resource({
        name: question.name,
        type: Packet.TYPE.NS,
        class: Packet.CLASS.IN,
        ttl,
        ns: `ns.${zone}`,
      }),
    );
    return;
  }

  addNegativeAnswer(response, zone, ttl, Packet.RCODE.NOERROR);
}

function addAddressRecords(
  records: InstanceType<typeof Packet.Resource>[],
  name: string,
  addresses: string[],
  ttl: number,
  requestedType: number = Packet.TYPE.ANY,
) {
  let matched = false;

  for (const address of addresses) {
    const family = isIP(address);
    const type = family === 4
      ? Packet.TYPE.A
      : family === 6
      ? Packet.TYPE.AAAA
      : undefined;

    if (
      type === undefined ||
      (requestedType !== Packet.TYPE.ANY && requestedType !== type)
    ) {
      continue;
    }

    records.push(
      new Packet.Resource({
        name,
        type,
        class: Packet.CLASS.IN,
        ttl,
        address,
      }),
    );
    matched = true;
  }

  return matched;
}

function addNegativeAnswer(
  response: InstanceType<typeof Packet>,
  zone: string,
  ttl: number,
  rcode: number,
) {
  response.header.rcode = rcode;
  response.authorities.push(soaRecord(zone, ttl));
}

function soaRecord(zone: string, ttl: number) {
  return new Packet.Resource({
    name: zone,
    type: Packet.TYPE.SOA,
    class: Packet.CLASS.IN,
    ttl,
    primary: `ns.${zone}`,
    admin: `hostmaster.${zone}`,
    serial: Math.floor(Date.now() / 1_000),
    refresh: 60,
    retry: 30,
    expiration: 3_600,
    minimum: ttl,
  });
}

function parseServiceQuery(name: string, zone: string) {
  const relative = name.slice(0, -(zone.length + 1));
  const labels = relative.split(".");

  if (labels.length === 1 && isServiceId(labels[0])) {
    return { kind: "address" as const, serviceId: labels[0] };
  }

  if (
    labels.length === 3 &&
    labels[0] === "_http" &&
    labels[1] === "_tcp" &&
    isServiceId(labels[2])
  ) {
    return { kind: "srv" as const, serviceId: labels[2] };
  }

  return null;
}

function isServiceId(value: string) {
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(value);
}

function normalizeDnsName(value: string) {
  return value.trim().replace(/\.+$/, "").toLowerCase();
}

function readableError(error: unknown) {
  return error instanceof Error
    ? error.message.replace(/\s+/g, " ").trim().slice(0, 500)
    : "Unknown DNS error.";
}
