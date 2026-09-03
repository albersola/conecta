import { assertEquals, assertThrows } from "@std/assert";
import {
  parseProjectConfig,
  validateProjectId,
  validateTag,
} from "./config.ts";

Deno.test("project configuration parses into a deployable project", () => {
  const project = parseProjectConfig({
    name: "Customer API",
    image: "ghcr.io/acme/api",
    tag: "stable",
    container_port: 3000,
    health_path: "/healthz",
    startup_timeout_seconds: 60,
    env_file: "/data/env/api.env",
    registry: {
      username: "acme",
      password_env: "REGISTRY_ACME_TOKEN",
    },
  }, "api");

  assertEquals(project, {
    id: "api",
    name: "Customer API",
    image: "ghcr.io/acme/api",
    tag: "stable",
    containerPort: 3000,
    healthPath: "/healthz",
    startupTimeoutSeconds: 60,
    envFile: "/data/env/api.env",
    registryUsername: "acme",
    registryPasswordEnv: "REGISTRY_ACME_TOKEN",
  });
});

Deno.test("project configuration applies defaults", () => {
  assertEquals(parseProjectConfig({ image: "example/api" }, "api"), {
    id: "api",
    name: "api",
    image: "example/api",
    tag: "latest",
    containerPort: 3000,
    healthPath: "/healthz",
    startupTimeoutSeconds: 60,
    envFile: undefined,
    registryUsername: undefined,
    registryPasswordEnv: undefined,
  });
});

Deno.test("invalid project settings fail validation", () => {
  assertThrows(
    () =>
      parseProjectConfig({ image: "example/api", registry: "invalid" }, "api"),
    Error,
    "api.registry must be a mapping.",
  );
  assertThrows(
    () =>
      parseProjectConfig(
        { image: "example/api", container_port: 70_000 },
        "api",
      ),
    Error,
    "api.container_port must be an integer from 1 to 65535.",
  );
  assertThrows(
    () =>
      parseProjectConfig({ image: "example/api", drain_seconds: 10 }, "api"),
    Error,
    "api.drain_seconds is no longer supported.",
  );
  assertThrows(
    () => parseProjectConfig({ image: "example/api", proxy: {} }, "api"),
    Error,
    "api.proxy is no longer supported.",
  );
});

Deno.test("registry password variables use the REGISTRY_ namespace", () => {
  const valid = parseProjectConfig({
    image: "example/api",
    registry: {
      username: "acme",
      password_env: "REGISTRY_ACME_TOKEN",
    },
  }, "api");

  assertEquals(valid.registryPasswordEnv, "REGISTRY_ACME_TOKEN");

  for (
    const passwordEnv of [
      "CONECTA_API_KEY",
      "ACME_REGISTRY_TOKEN",
      "REGISTRY_",
      "registry_ACME_TOKEN",
      "REGISTRY_ACME-TOKEN",
    ]
  ) {
    assertThrows(
      () =>
        parseProjectConfig({
          image: "example/api",
          registry: {
            username: "acme",
            password_env: passwordEnv,
          },
        }, "api"),
      Error,
      "must start with REGISTRY_",
    );
  }
});

Deno.test("project IDs are valid DNS labels", () => {
  for (const id of ["Api", "api_name", "api.", `a${"a".repeat(63)}`]) {
    assertThrows(
      () => validateProjectId(id),
      Error,
      "lowercase letters, numbers, and internal hyphens",
    );
  }
});

Deno.test("image tags use the Docker tag character set", () => {
  assertEquals(validateTag("sha-123"), "sha-123");
  assertThrows(() => validateTag("bad tag"), Error, "valid image tag");
});
