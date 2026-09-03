import { assertEquals, assertThrows } from "@std/assert";
import { type DnsHandler, Packet } from "dns2";
import { createDnsHandler, normalizeZone, parseDnsTtl } from "./dns.ts";
import type { ServiceRegistry } from "./service_registry.ts";

const registry: ServiceRegistry = {
  getProject: () => null,
  getService: (serviceId) =>
    serviceId === "api"
      ? {
        addresses: ["10.0.0.42", "fd00::42"],
        port: 3000,
        protocol: "tcp",
      }
      : null,
  replaceService: () => undefined,
};

Deno.test("DNS answers A and AAAA records from service_addresses", async () => {
  const handler = createDnsHandler(registry, {
    zone: "svc.internal",
    ttl: 5,
  });

  const ipv4 = await query(handler, "api.svc.internal", Packet.TYPE.A);
  const ipv6 = await query(handler, "api.svc.internal", Packet.TYPE.AAAA);

  assertEquals(ipv4.header.rcode, Packet.RCODE.NOERROR);
  assertEquals(ipv4.header.aa, 1);
  assertEquals(ipv4.answers.map(({ address }) => address), ["10.0.0.42"]);
  assertEquals(ipv6.answers.map(({ address }) => address), ["fd00::42"]);
});

Deno.test("DNS answers SRV records with address additionals", async () => {
  const handler = createDnsHandler(registry, {
    zone: "svc.internal",
    ttl: 5,
  });
  const response = await query(
    handler,
    "_http._tcp.api.svc.internal",
    Packet.TYPE.SRV,
  );

  assertEquals(response.answers[0].port, 3000);
  assertEquals(response.answers[0].target, "api.svc.internal");
  assertEquals(response.additionals.length, 2);
});

Deno.test("DNS distinguishes unknown and out-of-zone names", async () => {
  const handler = createDnsHandler(registry, {
    zone: "svc.internal",
    ttl: 5,
  });

  const unknown = await query(handler, "missing.svc.internal", Packet.TYPE.A);
  const external = await query(handler, "example.com", Packet.TYPE.A);

  assertEquals(unknown.header.rcode, Packet.RCODE.NXDOMAIN);
  assertEquals(unknown.authorities[0].type, Packet.TYPE.SOA);
  assertEquals(external.header.rcode, Packet.RCODE.REFUSED);
});

Deno.test("DNS settings are normalized and bounded", () => {
  assertEquals(normalizeZone("Svc.Internal."), "svc.internal");
  assertEquals(parseDnsTtl("5"), 5);
  assertThrows(() => normalizeZone("bad_name"), Error, "valid DNS name");
  assertThrows(() => parseDnsTtl("3601"), Error, "0 to 3600");
});

async function query(handler: DnsHandler, name: string, type: number) {
  const request = new Packet();
  request.header = new Packet.Header({
    id: 1,
    opcode: 0,
    qr: 0,
    rd: 1,
  });
  request.questions.push(new Packet.Question(name, type, Packet.CLASS.IN));

  let sent: Packet | undefined;
  await handler(
    request,
    (response) => {
      if (!(response instanceof Packet)) {
        throw new Error("Expected a DNS packet response.");
      }
      sent = response;
      return Promise.resolve(response.toBuffer());
    },
    {} as never,
  );

  if (!sent) {
    throw new Error("DNS handler did not send a response.");
  }
  return sent;
}
