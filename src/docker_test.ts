import { assertEquals, assertThrows } from "@std/assert";
import {
  containerHealthUrl,
  containerName,
  parseContainerInspectOutput,
} from "./docker.ts";
import type { ProjectConfig } from "./config.ts";

const project: ProjectConfig = {
  id: "api",
  name: "API",
  image: "example/api",
  tag: "latest",
  containerPort: 3000,
  healthPath: "/healthz",
  startupTimeoutSeconds: 60,
};

Deno.test("Docker inspection resolves the IPv4 on the configured network", () => {
  const inspected = JSON.stringify([{
    NetworkSettings: {
      Networks: {
        conecta: { IPAddress: "172.30.0.42" },
        other: { IPAddress: "172.31.0.42" },
      },
    },
  }]);

  assertEquals(
    parseContainerInspectOutput(inspected, "project-api-green", "conecta"),
    "172.30.0.42",
  );
  assertEquals(containerName(project, "green"), "project-api-green");
  assertEquals(
    containerHealthUrl(project, "172.30.0.42"),
    "http://172.30.0.42:3000/healthz",
  );
});

Deno.test("Docker inspection rejects missing or non-IPv4 network addresses", () => {
  assertThrows(
    () =>
      parseContainerInspectOutput(
        JSON.stringify([{ NetworkSettings: { Networks: {} } }]),
        "project-api-blue",
        "conecta",
      ),
    Error,
    "not connected",
  );
  assertThrows(
    () =>
      parseContainerInspectOutput(
        JSON.stringify([{
          NetworkSettings: {
            Networks: { conecta: { IPAddress: "fd00::42" } },
          },
        }]),
        "project-api-blue",
        "conecta",
      ),
    Error,
    "valid IPv4",
  );
});
