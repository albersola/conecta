export type ProjectSlot = "blue" | "green";

export type ProjectConfig = {
  id: string;
  name: string;
  image: string;
  tag: string;
  containerPort: number;
  healthPath: string;
  startupTimeoutSeconds: number;
  envFile?: string;
  registryUsername?: string;
  registryPasswordEnv?: string;
};

const projectIdPattern = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const tagPattern = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;
const registryPasswordEnvironmentPattern = /^REGISTRY_[A-Za-z0-9_]+$/;

export function parseProjectConfig(
  document: unknown,
  id: string,
  sourceName = "project configuration",
) {
  if (!isRecord(document)) {
    throw new Error(`Project configuration must be a mapping: ${sourceName}`);
  }

  return parseProject(id, document);
}

export function validateTag(value: string) {
  const tag = value.trim();

  if (!tagPattern.test(tag)) {
    throw new Error("Enter a valid image tag.");
  }

  return tag;
}

export function validateProjectId(value: string) {
  if (!projectIdPattern.test(value)) {
    throw new Error(
      `Invalid project id "${value}". Use lowercase letters, numbers, and internal hyphens up to 63 characters.`,
    );
  }

  return value;
}

function parseProject(id: string, value: unknown): ProjectConfig {
  validateProjectId(id);

  if (!isRecord(value)) {
    throw new Error(`Project "${id}" must be a mapping.`);
  }

  const image = requiredString(value.image, `${id}.image`);
  const name = optionalString(value.name, `${id}.name`) ?? id;
  const tag = validateTag(optionalString(value.tag, `${id}.tag`) ?? "latest");
  const containerPort = boundedInteger(
    value.container_port,
    `${id}.container_port`,
    1,
    65535,
    3000,
  );
  const healthPath = optionalString(value.health_path, `${id}.health_path`) ??
    "/healthz";
  const startupTimeoutSeconds = boundedInteger(
    value.startup_timeout_seconds,
    `${id}.startup_timeout_seconds`,
    1,
    900,
    60,
  );
  if (Object.hasOwn(value, "drain_seconds")) {
    throw new Error(`${id}.drain_seconds is no longer supported.`);
  }
  if (Object.hasOwn(value, "proxy")) {
    throw new Error(`${id}.proxy is no longer supported.`);
  }
  if (!healthPath.startsWith("/") || /[\0\r\n]/.test(healthPath)) {
    throw new Error(`${id}.health_path must be a safe URL path.`);
  }

  const envFile = optionalString(value.env_file, `${id}.env_file`);
  if (value.registry !== undefined && !isRecord(value.registry)) {
    throw new Error(`${id}.registry must be a mapping.`);
  }

  const registry = isRecord(value.registry) ? value.registry : undefined;
  const registryUsername = registry
    ? optionalString(registry.username, `${id}.registry.username`)
    : undefined;
  const registryPasswordEnv = registry
    ? optionalString(registry.password_env, `${id}.registry.password_env`)
    : undefined;

  if (registryUsername && !registryPasswordEnv) {
    throw new Error(
      `${id}.registry.password_env is required when registry.username is set.`,
    );
  }

  if (
    registryPasswordEnv &&
    !registryPasswordEnvironmentPattern.test(registryPasswordEnv)
  ) {
    throw new Error(
      `${id}.registry.password_env must start with REGISTRY_ and contain only letters, numbers, and underscores.`,
    );
  }

  return {
    id,
    name,
    image,
    tag,
    containerPort,
    healthPath,
    startupTimeoutSeconds,
    envFile,
    registryUsername,
    registryPasswordEnv,
  };
}

function requiredString(value: unknown, field: string) {
  const parsed = optionalString(value, field);

  if (!parsed) {
    throw new Error(`${field} is required.`);
  }

  return parsed;
}

function optionalString(value: unknown, field: string) {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value !== "string" || !value.trim() || /[\0\r\n]/.test(value)) {
    throw new Error(`${field} must be a non-empty single-line string.`);
  }

  return value.trim();
}

function boundedInteger(
  value: unknown,
  field: string,
  minimum: number,
  maximum: number,
  fallback: number,
) {
  if (value === undefined || value === null) {
    return fallback;
  }

  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new Error(
      `${field} must be an integer from ${minimum} to ${maximum}.`,
    );
  }

  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
