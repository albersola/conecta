import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import type { ProjectConfig, ProjectSlot } from "./config.ts";
import {
  deploy,
  type DeployDependencies,
  type DeploymentDependencies,
  DeploymentError,
  parseDnsPropagationSeconds,
  rollout,
  rolloutProject,
} from "./deploy.ts";
import type { Logger } from "./logger.ts";
import type { ServiceEndpoint } from "./service_registry.ts";

function testProject(overrides: Partial<ProjectConfig> = {}): ProjectConfig {
  return {
    id: "api",
    name: "API",
    image: "ghcr.io/acme/api",
    tag: "stable",
    containerPort: 3000,
    healthPath: "/healthz",
    startupTimeoutSeconds: 60,
    ...overrides,
  };
}

function fakeDependencies(
  activeSlot: ProjectSlot | null,
  events: string[],
  options: {
    failReadiness?: boolean;
    failCleanup?: boolean;
    failReplace?: boolean;
    addresses?: string[];
    port?: number;
  } = {},
): DeploymentDependencies {
  let startedSlot: ProjectSlot | null = null;
  const addresses = options.addresses ??
    (activeSlot ? [addressFor(activeSlot)] : []);
  const registryEndpoint: ServiceEndpoint | null = activeSlot === null &&
      !options.addresses
    ? null
    : {
      addresses,
      port: options.port ?? 3000,
      protocol: "tcp",
    };

  return {
    network: "conecta-test",
    registry: {
      getProject: () => testProject(),
      getService: () => {
        events.push(`registry.get:${registryEndpoint ? "service" : "none"}`);
        return registryEndpoint;
      },
      replaceService: (project, endpoint) => {
        events.push(
          `registry.replace:${project.tag}:${endpoint.addresses[0]}`,
        );
        if (options.failReplace) {
          throw new Error("registry update failed");
        }
      },
    },
    docker: {
      ensureDockerNetwork: (network) => {
        events.push(`docker.network:${network}`);
        return Promise.resolve();
      },
      pullImage: (_project, image) => {
        events.push(`docker.pull:${image}`);
        return Promise.resolve();
      },
      removeContainer: (name) => {
        events.push(`docker.remove:${name}`);
        return Promise.resolve();
      },
      startContainer: (_project, slot, network, image) => {
        startedSlot = slot;
        events.push(`docker.start:${slot}:${network}:${image}`);
        return Promise.resolve(`project-api-${slot}`);
      },
      stopAndRemoveContainer: (name) => {
        events.push(`docker.stop:${name}`);
        if (options.failCleanup) {
          throw new Error("cleanup failed");
        }
        return Promise.resolve();
      },
      inspectContainerIp: (name) => {
        const slot = name.endsWith("-blue") ? "blue" : "green";
        events.push(`docker.inspect:${slot}`);
        if (slot === activeSlot || slot === startedSlot) {
          return Promise.resolve(addressFor(slot));
        }
        return Promise.resolve(null);
      },
      waitForHttpReady: (_project, slot) => {
        events.push(`docker.ready:${slot}`);
        if (options.failReadiness) {
          throw new Error("health check failed");
        }
        return Promise.resolve();
      },
    },
    dnsPropagationSeconds: 5,
    sleep: (milliseconds) => {
      events.push(`sleep:${milliseconds}`);
      return Promise.resolve();
    },
    logger: noopLogger,
  };
}

const noopLogger: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

Deno.test("rollout switches the registry before removing the old slot", async () => {
  const events: string[] = [];
  const result = await rolloutProject(
    testProject(),
    "sha-123",
    fakeDependencies("blue", events),
  );

  assertEquals(result, {
    project: "api",
    tag: "sha-123",
    slot: "green",
    container: "project-api-green",
  });
  assertEquals(events, [
    "registry.get:service",
    "docker.inspect:blue",
    "docker.inspect:green",
    "docker.network:conecta-test",
    "docker.remove:project-api-green",
    "docker.pull:ghcr.io/acme/api:sha-123",
    "docker.start:green:conecta-test:ghcr.io/acme/api:sha-123",
    "docker.inspect:green",
    "docker.ready:green",
    "registry.replace:sha-123:10.0.0.42",
    "sleep:5000",
    "docker.stop:project-api-blue",
  ]);
});

Deno.test("a readiness failure leaves the registry unchanged", async () => {
  const events: string[] = [];

  await assertRejects(
    () =>
      rolloutProject(
        testProject(),
        "stable",
        fakeDependencies("blue", events, { failReadiness: true }),
      ),
    DeploymentError,
    "Deployment for api failed: health check failed",
  );

  assertEquals(events.includes("registry.replace:stable:10.0.0.42"), false);
  assertEquals(events.at(-1), "docker.remove:project-api-green");
});

Deno.test("the first rollout uses blue when no service exists", async () => {
  const events: string[] = [];
  const result = await rolloutProject(
    testProject(),
    "stable",
    fakeDependencies(null, events),
  );

  assertEquals(result.slot, "blue");
  assertEquals(events.includes("registry.replace:stable:10.0.0.41"), true);
});

Deno.test("an ambiguous active service is rejected before Docker mutation", async () => {
  const events: string[] = [];

  await assertRejects(
    () =>
      rolloutProject(
        testProject(),
        "stable",
        fakeDependencies("blue", events, {
          addresses: ["10.0.0.41", "10.0.0.42"],
        }),
      ),
    Error,
    "exactly one active address",
  );
  assertEquals(events, [
    "registry.get:service",
    "docker.inspect:blue",
    "docker.inspect:green",
  ]);
});

Deno.test("a registry replacement failure cleans up the new slot", async () => {
  const events: string[] = [];

  await assertRejects(
    () =>
      rolloutProject(
        testProject(),
        "stable",
        fakeDependencies("blue", events, { failReplace: true }),
      ),
    DeploymentError,
    "registry update failed",
  );
  assertEquals(events.at(-1), "docker.remove:project-api-green");
});

Deno.test("cleanup errors after switching become a warning", async () => {
  const result = await rolloutProject(
    testProject(),
    "stable",
    fakeDependencies("blue", [], { failCleanup: true }),
  );

  assertEquals(
    result.warning,
    "Traffic switched successfully, but the old container could not be removed: cleanup failed",
  );
});

Deno.test("rollout uses the project stored in SQLite", async () => {
  const events: string[] = [];
  const result = await rollout(
    "api",
    fakeDeployDependencies(events),
    { request_id: "request-1" },
  );

  assertEquals(result.tag, "stable");
  assertEquals(events, ["project.get:api", "rollout:stable"]);
});

Deno.test("deploy forwards the received project to the transactional rollout", async () => {
  const events: string[] = [];
  const result = await deploy(
    "api",
    testProject({ tag: "sha-123" }),
    fakeDeployDependencies(events),
    { request_id: "request-2" },
  );

  assertEquals(result.tag, "sha-123");
  assertEquals(events, ["rollout:sha-123"]);
});

Deno.test("the project lock is held through the registry switch", async () => {
  const events: string[] = [];
  const rolloutStarted = Promise.withResolvers<void>();
  const releaseRollout = Promise.withResolvers<void>();
  const dependencies = fakeDeployDependencies(events);
  dependencies.rollout = async (_project, tag) => {
    rolloutStarted.resolve();
    await releaseRollout.promise;
    return successfulDeployment(tag);
  };

  const firstDeployment = deploy(
    "api",
    testProject({ tag: "sha-123" }),
    dependencies,
  );
  await rolloutStarted.promise;

  await assertRejects(
    () =>
      deploy(
        "api",
        testProject({ tag: "sha-456" }),
        dependencies,
      ),
    DeploymentError,
    "A deployment is already in progress",
  );

  releaseRollout.resolve();
  await firstDeployment;
});

Deno.test("DNS propagation accepts only non-negative integers", () => {
  assertEquals(parseDnsPropagationSeconds("0"), 0);
  assertEquals(parseDnsPropagationSeconds("10"), 10);
  assertThrows(
    () => parseDnsPropagationSeconds("-1"),
    Error,
    "non-negative integer",
  );
  assertThrows(
    () => parseDnsPropagationSeconds("1.5"),
    Error,
    "non-negative integer",
  );
});

function addressFor(slot: ProjectSlot) {
  return slot === "blue" ? "10.0.0.41" : "10.0.0.42";
}

function fakeDeployDependencies(events: string[]): DeployDependencies {
  const project = testProject();

  return {
    registry: {
      getProject: (projectId) => {
        events.push(`project.get:${projectId}`);
        return project;
      },
    },
    rollout: (_project, tag) => {
      events.push(`rollout:${tag}`);
      return Promise.resolve(successfulDeployment(tag));
    },
    logger: noopLogger,
  };
}

function successfulDeployment(tag: string) {
  return {
    project: "api",
    tag,
    slot: "blue" as const,
    container: "project-api-blue",
  };
}
