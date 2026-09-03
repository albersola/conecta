import type { ProjectConfig, ProjectSlot } from "./config.ts";

const decoder = new TextDecoder();
const defaultTimeoutMs = 30_000;

export function containerName(project: ProjectConfig, slot: ProjectSlot) {
  return `project-${project.id}-${slot}`;
}

/**
 * Return the container's private IPv4 address on the application network.
 * Container names are intentionally not used for service discovery: Docker's
 * embedded DNS may retain stale answers while a blue/green slot is replaced.
 */
export async function inspectContainerIp(name: string, network: string) {
  try {
    const output = await runDocker(["inspect", "--format", "{{json .}}", name]);
    return parseContainerInspectOutput(output, name, network);
  } catch (error) {
    if (isMissingContainerError(error)) {
      return null;
    }

    throw error;
  }
}

export async function ensureDockerNetwork(network: string) {
  try {
    await runDocker(["network", "inspect", network]);
  } catch {
    try {
      await runDocker(["network", "create", network]);
    } catch (error) {
      if (!readableError(error).toLowerCase().includes("already exists")) {
        throw error;
      }
    }
  }
}

export async function pullImage(
  project: ProjectConfig,
  imageReference: string,
) {
  if (!project.registryUsername) {
    await runDocker(["pull", imageReference], 5 * 60_000);
    return;
  }

  const password = project.registryPasswordEnv
    ? Deno.env.get(project.registryPasswordEnv)
    : undefined;

  if (!password) {
    throw new Error(
      `Environment variable ${project.registryPasswordEnv} is not set for registry authentication.`,
    );
  }

  const dockerConfig = await Deno.makeTempDir({
    prefix: "conecta-docker-config-",
  });

  try {
    await runDockerWithInput(
      [
        "--config",
        dockerConfig,
        "login",
        registryFromImage(project.image),
        "--username",
        project.registryUsername,
        "--password-stdin",
      ],
      password,
    );
    await runDocker(
      ["--config", dockerConfig, "pull", imageReference],
      5 * 60_000,
    );
  } finally {
    await Deno.remove(dockerConfig, { recursive: true }).catch(() => undefined);
  }
}

export async function removeContainer(name: string) {
  try {
    await runDocker(["rm", "--force", name]);
  } catch (error) {
    if (!readableError(error).toLowerCase().includes("no such container")) {
      throw error;
    }
  }
}

export async function startContainer(
  project: ProjectConfig,
  slot: ProjectSlot,
  network: string,
  imageReference: string,
) {
  const name = containerName(project, slot);
  const args = [
    "run",
    "--detach",
    "--name",
    name,
    "--restart",
    "unless-stopped",
    "--network",
    network,
    "--label",
    "conecta.managed=true",
    "--label",
    `conecta.project=${project.id}`,
    "--label",
    `conecta.slot=${slot}`,
    "--label",
    `conecta.image=${imageReference}`,
    "--expose",
    String(project.containerPort),
  ];

  if (project.envFile) {
    args.push("--env-file", project.envFile);
  }

  args.push(imageReference);
  await runDocker(args);
  return name;
}

export async function stopAndRemoveContainer(name: string) {
  try {
    await runDocker(["stop", "--time", "30", name]);
  } catch (error) {
    if (!readableError(error).toLowerCase().includes("no such container")) {
      await removeContainer(name);
      return;
    }
  }

  await removeContainer(name);
}

export async function waitForHttpReady(
  project: ProjectConfig,
  slot: ProjectSlot,
  network: string,
  address?: string,
) {
  const ip = address ?? await inspectContainerIp(
    containerName(project, slot),
    network,
  );

  if (!ip) {
    throw new Error(
      `Container ${
        containerName(project, slot)
      } has no IPv4 address on Docker network ${network}.`,
    );
  }

  const url = containerHealthUrl(project, ip);
  const deadline = Date.now() + project.startupTimeoutSeconds * 1000;
  let lastError = "No response from the container.";

  while (Date.now() < deadline) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2_000);

    try {
      const response = await fetch(url, { signal: controller.signal });

      if (response.ok) {
        return;
      }

      lastError = `Health check returned HTTP ${response.status}.`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    } finally {
      clearTimeout(timer);
    }

    await delay(1_000);
  }

  throw new Error(
    `Container ${
      containerName(project, slot)
    } did not become ready within ${project.startupTimeoutSeconds} seconds: ${lastError}`,
  );
}

export function containerHealthUrl(project: ProjectConfig, ip: string) {
  return `http://${ip}:${project.containerPort}${project.healthPath}`;
}

export function parseContainerInspectOutput(
  output: string,
  name: string,
  network: string,
) {
  let payload: unknown;
  try {
    payload = JSON.parse(output);
  } catch {
    throw new Error(`Docker returned invalid inspection data for ${name}.`);
  }

  const container = Array.isArray(payload) ? payload[0] : payload;
  const address = networkAddress(container, network);

  if (!address) {
    throw new Error(
      `Container ${name} is not connected to Docker network ${network}.`,
    );
  }

  if (!ipv4Pattern.test(address)) {
    throw new Error(
      `Container ${name} has no valid IPv4 address on Docker network ${network}.`,
    );
  }

  return address;
}

async function runDocker(args: string[], timeoutMs = defaultTimeoutMs) {
  const command = new Deno.Command("docker", {
    args,
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const timer = setTimeout(() => {
    try {
      command.kill("SIGKILL");
    } catch {
      // The process may have already exited.
    }
  }, timeoutMs);

  try {
    const output = await command.output();
    const stdout = decoder.decode(output.stdout).trim();
    const stderr = decoder.decode(output.stderr).trim();

    if (!output.success) {
      throw new Error(
        stderr || stdout || `Docker exited with code ${output.code}.`,
      );
    }

    return stdout;
  } finally {
    clearTimeout(timer);
  }
}

async function runDockerWithInput(
  args: string[],
  input: string,
  timeoutMs = defaultTimeoutMs,
) {
  const command = new Deno.Command("docker", {
    args,
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const writer = command.stdin.getWriter();
  const timer = setTimeout(() => {
    try {
      command.kill("SIGKILL");
    } catch {
      // The process may have already exited.
    }
  }, timeoutMs);

  try {
    await writer.write(new TextEncoder().encode(`${input}\n`));
    await writer.close();
    const output = await command.output();
    const stderr = decoder.decode(output.stderr).trim();

    if (!output.success) {
      throw new Error(stderr || `Docker exited with code ${output.code}.`);
    }
  } finally {
    clearTimeout(timer);
  }
}

function registryFromImage(image: string) {
  const registry = image.split("/", 1)[0];

  if (
    registry.includes(".") ||
    registry.includes(":") ||
    registry === "localhost"
  ) {
    return registry;
  }

  return "docker.io";
}

const ipv4Pattern =
  /^(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;

function networkAddress(value: unknown, network: string) {
  if (!isRecord(value) || !isRecord(value.NetworkSettings)) {
    return undefined;
  }

  const networks = value.NetworkSettings.Networks;
  if (!isRecord(networks)) {
    return undefined;
  }

  const connection = networks[network];
  if (!isRecord(connection) || typeof connection.IPAddress !== "string") {
    return undefined;
  }

  return connection.IPAddress.trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readableError(error: unknown) {
  return error instanceof Error
    ? error.message.replace(/\s+/g, " ").trim()
    : String(error);
}

function isMissingContainerError(error: unknown) {
  const message = readableError(error).toLowerCase();
  return message.includes("no such container") ||
    message.includes("no such object") ||
    message.includes("container not found");
}

function delay(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
