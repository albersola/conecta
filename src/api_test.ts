import { assertEquals } from "@std/assert";
import { type ApiDependencies, createHandler } from "./api.ts";
import type { ProjectConfig } from "./config.ts";
import type { DeploymentResult } from "./deploy.ts";
import type { LogFields, Logger } from "./logger.ts";

Deno.test("the deploy endpoint accepts a full config and emits correlated logs", async () => {
  const logEvents: Array<{ level: string; event: string; fields?: LogFields }> =
    [];
  let receivedProject = "";
  let receivedConfig: ProjectConfig | undefined;
  let receivedContext: LogFields = {};
  const handler = createHandler(testDependencies({
    logger: memoryLogger(logEvents),
    deployer: (project, config, context) => {
      receivedProject = project;
      receivedConfig = config;
      receivedContext = context;
      return Promise.resolve(successfulDeployment(config.tag));
    },
  }));
  const response = await handler(
    deployRequest({ config: projectConfig(), tag: "sha-123" }),
  );

  assertEquals(response.status, 200);
  assertEquals(receivedProject, "api");
  assertEquals(receivedConfig?.tag, "sha-123");
  assertEquals(receivedConfig?.containerPort, 3000);
  assertEquals(typeof receivedContext.request_id, "string");
  assertEquals(
    response.headers.get("x-request-id"),
    receivedContext.request_id,
  );
  assertEquals(
    logEvents.map(({ event }) => event),
    ["webhook_received", "deployment_succeeded"],
  );
});

Deno.test("the deploy endpoint requires a top-level tag and rejects a config tag", async () => {
  const handler = createHandler(testDependencies());

  const missingTag = await handler(
    deployRequest({ config: projectConfig() }),
  );
  assertEquals(missingTag.status, 400);

  const configTag = await handler(
    deployRequest({
      config: { ...projectConfig(), tag: "sha-123" },
      tag: "sha-456",
    }),
  );
  assertEquals(configTag.status, 400);
});

Deno.test("the deploy endpoint rejects service variables as registry passwords", async () => {
  let deployerCalled = false;
  const handler = createHandler(testDependencies({
    deployer: (_project, config) => {
      deployerCalled = true;
      return Promise.resolve(successfulDeployment(config.tag));
    },
  }));
  const response = await handler(
    deployRequest({
      config: {
        ...projectConfig(),
        registry: {
          username: "attacker",
          password_env: "CONECTA_API_KEY",
        },
      },
      tag: "sha-123",
    }),
  );

  assertEquals(response.status, 400);
  assertEquals(deployerCalled, false);
  assertEquals(
    (await response.json()).error,
    "api.registry.password_env must start with REGISTRY_ and contain only letters, numbers, and underscores.",
  );
});

Deno.test("the rollout endpoint uses the project path and does not require a config body", async () => {
  let receivedProject = "";
  const handler = createHandler(testDependencies({
    rollouter: (project) => {
      receivedProject = project;
      return Promise.resolve(successfulDeployment("sha-123"));
    },
  }));

  const response = await handler(
    new Request("http://localhost/rollout/api", {
      method: "POST",
      headers: { authorization: "Bearer test-key" },
    }),
  );

  assertEquals(response.status, 200);
  assertEquals(receivedProject, "api");
});

Deno.test("the old deploy endpoint is not accepted", async () => {
  const handler = createHandler(testDependencies());
  const response = await handler(
    new Request("http://localhost/deploy", { method: "POST" }),
  );

  assertEquals(response.status, 404);
});

Deno.test("deployment paths use valid project IDs", async () => {
  const handler = createHandler(testDependencies());
  const response = await handler(
    deployRequest(
      { config: projectConfig(), tag: "sha-123" },
      "test-key",
      "/deploy/Api_Name",
    ),
  );

  assertEquals(response.status, 400);
  assertEquals(
    (await response.json()).error,
    'Invalid project id "Api_Name". Use lowercase letters, numbers, and internal hyphens up to 63 characters.',
  );
});

Deno.test("unauthorized requests are logged without exposing the API key", async () => {
  const logEvents: Array<{ level: string; event: string; fields?: LogFields }> =
    [];
  const handler = createHandler(testDependencies({
    apiKey: "secret-test-key",
    logger: memoryLogger(logEvents),
  }));
  const response = await handler(
    deployRequest({ config: projectConfig(), tag: "sha-123" }, "wrong-key"),
  );

  assertEquals(response.status, 401);
  assertEquals(
    logEvents.map(({ event }) => event),
    ["webhook_received", "webhook_rejected"],
  );
  assertEquals(JSON.stringify(logEvents).includes("secret-test-key"), false);
  assertEquals(JSON.stringify(logEvents).includes("wrong-key"), false);
});

function deployRequest(
  body: unknown,
  apiKey = "test-key",
  path = "/deploy/api",
) {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

function projectConfig() {
  return {
    name: "Customer API",
    image: "ghcr.io/acme/api",
    container_port: 3000,
    health_path: "/healthz",
    startup_timeout_seconds: 60,
  };
}

function successfulDeployment(tag: string): DeploymentResult {
  return {
    project: "api",
    tag,
    slot: "blue",
    container: "project-api-blue",
  };
}

function testDependencies(
  overrides: Partial<ApiDependencies> = {},
): ApiDependencies {
  return {
    apiKey: "test-key",
    deployer: (_project, config) =>
      Promise.resolve(successfulDeployment(config.tag)),
    rollouter: () => Promise.resolve(successfulDeployment("stable")),
    ...overrides,
  };
}

function memoryLogger(
  events: Array<{ level: string; event: string; fields?: LogFields }>,
): Logger {
  return {
    info: (event, fields) => events.push({ level: "INFO", event, fields }),
    warn: (event, fields) => events.push({ level: "WARN", event, fields }),
    error: (event, fields) => events.push({ level: "ERROR", event, fields }),
  };
}
