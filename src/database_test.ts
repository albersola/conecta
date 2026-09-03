import { assertEquals, assertThrows } from "@std/assert";
import type { ProjectConfig } from "./config.ts";
import { ConectaDatabase } from "./database.ts";

const project: ProjectConfig = {
  id: "api",
  name: "Customer API",
  image: "ghcr.io/acme/api",
  tag: "sha-123",
  containerPort: 3000,
  healthPath: "/healthz",
  startupTimeoutSeconds: 60,
  envFile: "/data/env/api.env",
};

Deno.test("SQLite persists projects, services, and multiple addresses", () => {
  const database = new ConectaDatabase(":memory:");

  try {
    database.replaceService(project, {
      addresses: ["10.0.0.42", "fd00::42"],
      port: 3000,
      protocol: "tcp",
    });

    assertEquals(database.getProject("api"), project);
    assertEquals(database.getService("api"), {
      addresses: ["10.0.0.42", "fd00::42"],
      port: 3000,
      protocol: "tcp",
    });
  } finally {
    database.close();
  }
});

Deno.test("replacing a service atomically replaces its address set", () => {
  const database = new ConectaDatabase(":memory:");

  try {
    database.replaceService(project, {
      addresses: ["10.0.0.41", "10.0.0.42"],
      port: 3000,
      protocol: "tcp",
    });
    database.replaceService({ ...project, tag: "sha-456" }, {
      addresses: ["10.0.0.43"],
      port: 3000,
      protocol: "tcp",
    });

    assertEquals(database.getProject("api")?.tag, "sha-456");
    assertEquals(database.getService("api")?.addresses, ["10.0.0.43"]);
  } finally {
    database.close();
  }
});

Deno.test("the registry rejects invalid addresses", () => {
  const database = new ConectaDatabase(":memory:");

  try {
    assertThrows(
      () =>
        database.replaceService(project, {
          addresses: ["not-an-ip"],
          port: 3000,
          protocol: "tcp",
        }),
      Error,
      "valid IP addresses",
    );
  } finally {
    database.close();
  }
});
