import { type ProjectConfig, type ProjectSlot, validateTag } from "./config.ts";
import { type LogFields, type Logger, logger } from "./logger.ts";
import type { ServiceEndpoint, ServiceRegistry } from "./service_registry.ts";
import {
  containerName,
  ensureDockerNetwork,
  inspectContainerIp,
  pullImage,
  removeContainer,
  startContainer,
  stopAndRemoveContainer,
  waitForHttpReady,
} from "./docker.ts";

const deploymentsInProgress = new Set<string>();

export type DockerOperations = {
  ensureDockerNetwork: typeof ensureDockerNetwork;
  pullImage: typeof pullImage;
  removeContainer: typeof removeContainer;
  startContainer: typeof startContainer;
  stopAndRemoveContainer: typeof stopAndRemoveContainer;
  waitForHttpReady: typeof waitForHttpReady;
  inspectContainerIp: typeof inspectContainerIp;
};

export type DeploymentDependencies = {
  network: string;
  registry: ServiceRegistry;
  docker: DockerOperations;
  dnsPropagationSeconds: number;
  sleep: (milliseconds: number) => Promise<void>;
  logger: Logger;
};

export type DeployDependencies = {
  registry: Pick<ServiceRegistry, "getProject">;
  rollout: (
    project: ProjectConfig,
    tag: string,
    context: LogFields,
  ) => Promise<DeploymentResult>;
  logger: Logger;
};

export type DeploymentResult = {
  project: string;
  tag: string;
  slot: ProjectSlot;
  container: string;
  warning?: string;
};

export class DeploymentError extends Error {
  constructor(
    message: string,
    readonly status = 500,
  ) {
    super(message);
  }
}

export function deploy(
  projectId: string,
  project: ProjectConfig,
  dependencies: DeployDependencies,
  context: LogFields = {},
): Promise<DeploymentResult> {
  if (project.id !== projectId) {
    throw new DeploymentError(
      `Project configuration ID "${project.id}" does not match "${projectId}".`,
      400,
    );
  }

  return deployProject(project, true, context, dependencies);
}

export async function rollout(
  projectId: string,
  dependencies: DeployDependencies,
  context: LogFields = {},
): Promise<DeploymentResult> {
  dependencies.logger.info("project_config_loading", {
    ...context,
    project: projectId,
  });
  const project = await dependencies.registry.getProject(projectId);

  if (!project) {
    throw new DeploymentError(`Project "${projectId}" was not found.`, 404);
  }

  return deployProject(project, false, context, dependencies);
}

async function deployProject(
  project: ProjectConfig,
  fromWebhook: boolean,
  context: LogFields,
  dependencies: DeployDependencies,
): Promise<DeploymentResult> {
  if (deploymentsInProgress.has(project.id)) {
    throw new DeploymentError(
      `A deployment is already in progress for project "${project.id}".`,
      409,
    );
  }

  let tag: string;

  try {
    tag = validateTag(project.tag);
  } catch (error) {
    throw new DeploymentError(readableError(error), 400);
  }

  const deploymentContext = {
    ...context,
    project: project.id,
    tag,
    tag_source: fromWebhook ? "webhook" : "database",
  };
  dependencies.logger.info("deployment_started", deploymentContext);
  deploymentsInProgress.add(project.id);

  try {
    return await dependencies.rollout(project, tag, deploymentContext);
  } finally {
    deploymentsInProgress.delete(project.id);
  }
}

export async function rolloutProject(
  project: ProjectConfig,
  tag: string,
  dependencies: DeploymentDependencies,
  context: LogFields = {},
) {
  const normalizedTag = validateTag(tag);
  const { network, registry, docker, dnsPropagationSeconds, sleep, logger } =
    dependencies;
  const logContext = { ...context, project: project.id, tag: normalizedTag };

  // A multi-address service cannot identify one blue/green slot safely yet,
  // even though the database is ready to store multiple addresses.
  const published = await registry.getService(project.id);
  const slotIps = await inspectSlots(project, network, docker);
  const activeSlot = activeSlotFor(project, published, slotIps);
  const nextSlot = inactiveSlot(activeSlot);
  const nextContainer = containerName(project, nextSlot);
  const oldContainer = activeSlot
    ? containerName(project, activeSlot)
    : undefined;
  const imageReference = `${project.image}:${normalizedTag}`;
  let switched = false;

  logger.info("deployment_slots_selected", {
    ...logContext,
    active_slot: activeSlot,
    next_slot: nextSlot,
    active_address: activeSlot ? slotIps[activeSlot] : undefined,
  });

  try {
    await docker.ensureDockerNetwork(network);
    logger.info("docker_network_ready", { ...logContext, network });
    await docker.removeContainer(nextContainer);
    logger.info("inactive_container_removed", {
      ...logContext,
      container: nextContainer,
    });
    await docker.pullImage(project, imageReference);
    logger.info("docker_image_pulled", {
      ...logContext,
      image: imageReference,
    });
    await docker.startContainer(project, nextSlot, network, imageReference);
    logger.info("container_started", {
      ...logContext,
      container: nextContainer,
      slot: nextSlot,
    });

    const nextIp = await inspectSlotIp(docker, nextContainer, network);
    await docker.waitForHttpReady(project, nextSlot, network, nextIp);
    logger.info("container_ready", {
      ...logContext,
      container: nextContainer,
      slot: nextSlot,
      address: nextIp,
    });

    const endpoint: ServiceEndpoint = {
      addresses: [nextIp],
      port: project.containerPort,
      protocol: "tcp",
    };
    await registry.replaceService(
      { ...project, tag: normalizedTag },
      endpoint,
    );
    switched = true;
    logger.info("registry_service_replaced", {
      ...logContext,
      container: nextContainer,
      slot: nextSlot,
      address: nextIp,
    });

    let warning: string | undefined;

    logger.info("dns_propagation_wait_started", {
      ...logContext,
      dns_propagation_seconds: dnsPropagationSeconds,
    });
    await sleep(dnsPropagationSeconds * 1000);

    if (oldContainer) {
      try {
        await docker.stopAndRemoveContainer(oldContainer);
        logger.info("old_container_removed", {
          ...logContext,
          container: oldContainer,
        });
      } catch (error) {
        warning =
          `Traffic switched successfully, but the old container could not be removed: ${
            readableError(error)
          }`;
        logger.warn("old_container_removal_failed", {
          ...logContext,
          container: oldContainer,
          error: readableError(error),
        });
      }
    }

    return {
      project: project.id,
      tag: normalizedTag,
      slot: nextSlot,
      container: nextContainer,
      ...(warning ? { warning } : {}),
    };
  } catch (error) {
    // Before the transaction commits, the registry still points at the old
    // endpoint. Afterwards, the new slot must be retained.
    if (!switched) {
      await docker.removeContainer(nextContainer).catch(() => undefined);
      logger.info("failed_deployment_container_removed", {
        ...logContext,
        container: nextContainer,
      });
    }

    logger.error("deployment_rollout_failed", {
      ...logContext,
      error: readableError(error),
      registry_updated: switched,
    });
    if (error instanceof DeploymentError) {
      throw error;
    }
    throw new DeploymentError(
      `Deployment for ${project.id} failed: ${readableError(error)}`,
    );
  }
}

export function createRuntimeDependencies(
  registry: ServiceRegistry,
): DeploymentDependencies {
  return {
    network: Deno.env.get("CONECTA_DOCKER_NETWORK") ?? "conecta",
    registry,
    docker: {
      ensureDockerNetwork,
      pullImage,
      removeContainer,
      startContainer,
      stopAndRemoveContainer,
      waitForHttpReady,
      inspectContainerIp,
    },
    dnsPropagationSeconds: parseDnsPropagationSeconds(
      Deno.env.get("CONECTA_DNS_PROPAGATION_SECONDS") ?? "10",
    ),
    sleep: delay,
    logger,
  };
}

export function parseDnsPropagationSeconds(value: string) {
  const normalized = value.trim();
  const seconds = Number(normalized);

  if (!/^\d+$/.test(normalized) || !Number.isSafeInteger(seconds)) {
    throw new Error(
      "CONECTA_DNS_PROPAGATION_SECONDS must be a non-negative integer.",
    );
  }

  return seconds;
}

export function createDeployDependencies(
  registry: ServiceRegistry,
): DeployDependencies {
  return {
    registry,
    rollout: (project, tag, context) =>
      rolloutProject(
        project,
        tag,
        createRuntimeDependencies(registry),
        context,
      ),
    logger,
  };
}

async function inspectSlots(
  project: ProjectConfig,
  network: string,
  docker: DockerOperations,
): Promise<Record<ProjectSlot, string | null>> {
  const [blue, green] = await Promise.all([
    docker.inspectContainerIp(containerName(project, "blue"), network),
    docker.inspectContainerIp(containerName(project, "green"), network),
  ]);
  return { blue, green };
}

async function inspectSlotIp(
  docker: DockerOperations,
  container: string,
  network: string,
) {
  const address = await docker.inspectContainerIp(container, network);
  if (!address) {
    throw new Error(
      `Container ${container} has no IPv4 address on Docker network ${network}.`,
    );
  }
  return address;
}

function inactiveSlot(activeSlot: ProjectSlot | null): ProjectSlot {
  return activeSlot === "blue" ? "green" : "blue";
}

function activeSlotFor(
  project: ProjectConfig,
  endpoint: ServiceEndpoint | null,
  slotIps: Record<ProjectSlot, string | null>,
): ProjectSlot | null {
  if (!endpoint) {
    return null;
  }

  if (endpoint.addresses.length !== 1) {
    throw new Error(
      `Service ${project.id} must contain exactly one active address.`,
    );
  }
  if (endpoint.protocol !== "tcp") {
    throw new Error(
      `Service ${project.id} must use the tcp protocol.`,
    );
  }
  if (endpoint.port !== project.containerPort) {
    throw new Error(
      `Service ${project.id} uses port ${endpoint.port}, expected ${project.containerPort}.`,
    );
  }

  const matchingSlots = (Object.keys(slotIps) as ProjectSlot[]).filter(
    (slot) => slotIps[slot] === endpoint.addresses[0],
  );
  if (matchingSlots.length !== 1) {
    throw new Error(
      `Service ${project.id} does not correspond to exactly one blue/green container.`,
    );
  }

  return matchingSlots[0];
}

function readableError(error: unknown) {
  return error instanceof Error
    ? error.message.replace(/\s+/g, " ").trim().slice(0, 500)
    : "Unknown deployment error.";
}

function delay(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}
