import { DeploymentError, type DeploymentResult } from "./deploy.ts";
import {
  parseProjectConfig,
  type ProjectConfig,
  validateProjectId,
} from "./config.ts";
import { type LogFields, type Logger, logger } from "./logger.ts";

type Deployer = (
  project: string,
  config: ProjectConfig,
  context: LogFields,
) => Promise<DeploymentResult>;

type Rollouter = (
  project: string,
  context: LogFields,
) => Promise<DeploymentResult>;

export type ApiDependencies = {
  apiKey: string;
  deployer: Deployer;
  rollouter: Rollouter;
  logger?: Logger;
};

export function createHandler(dependencies: ApiDependencies) {
  const deployer = dependencies.deployer;
  const rollouter = dependencies.rollouter;
  const log = dependencies.logger ?? logger;

  return async (request: Request) => {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/healthz") {
      return json({ status: "ok" });
    }

    if (request.method === "GET" && url.pathname === "/") {
      return json({ service: "conecta", status: "ok" });
    }

    if (request.method !== "POST") {
      return json({ error: "Not found." }, 404);
    }

    const deployProject = projectIdFromPath(url.pathname, "/deploy");
    const rolloutProject = projectIdFromPath(url.pathname, "/rollout");

    if (!deployProject && !rolloutProject) {
      return json({ error: "Not found." }, 404);
    }

    const project = (deployProject ?? rolloutProject)!;
    const operation = deployProject ? "deploy" : "rollout";

    const requestId = crypto.randomUUID();
    const startedAt = performance.now();
    const requestContext = { request_id: requestId };
    log.info("webhook_received", {
      ...requestContext,
      method: request.method,
      path: url.pathname,
      operation,
      project,
    });

    const reject = (message: string, status: number) => {
      log.info("webhook_rejected", {
        ...requestContext,
        status,
        reason: message,
        duration_ms: elapsedMilliseconds(startedAt),
      });
      return json({ error: message }, status, requestId);
    };

    if (!hasApiKey(request, dependencies.apiKey)) {
      return reject("Missing or invalid API key.", 401);
    }

    try {
      validateProjectId(project);
    } catch (error) {
      return reject(readableError(error), 400);
    }

    let config: ProjectConfig | undefined;

    if (deployProject) {
      const contentType = request.headers.get("content-type") ?? "";

      if (!contentType.toLowerCase().startsWith("application/json")) {
        return reject("Content-Type must be application/json.", 415);
      }

      let body: unknown;

      try {
        const bodyText = await request.text();

        if (bodyText.length > 16_384) {
          return reject("Request body is too large.", 413);
        }

        body = JSON.parse(bodyText);
      } catch {
        return reject("Request body is not valid JSON.", 400);
      }

      if (!isRecord(body) || !isRecord(body.config)) {
        return reject(
          "The JSON body must contain a config object.",
          400,
        );
      }

      if (Object.hasOwn(body.config, "tag")) {
        return reject(
          "The config must not contain tag; send it as a top-level field.",
          400,
        );
      }

      if (typeof body.tag !== "string") {
        return reject("The tag must be a required string.", 400);
      }

      try {
        config = parseProjectConfig(
          { ...body.config, tag: body.tag },
          deployProject,
          "request body config",
        );
      } catch (error) {
        return reject(readableError(error), 400);
      }
    }

    try {
      const result = deployProject
        ? await deployer(deployProject, config!, requestContext)
        : await rollouter(rolloutProject!, requestContext);
      log.info("deployment_succeeded", {
        ...requestContext,
        ...result,
        operation,
        duration_ms: elapsedMilliseconds(startedAt),
      });
      return json(result, 200, requestId);
    } catch (error) {
      const status = error instanceof DeploymentError ? error.status : 500;
      const message = error instanceof Error
        ? error.message
        : "Deployment failed.";
      log.error("deployment_failed", {
        ...requestContext,
        project,
        operation,
        status,
        error: message,
        duration_ms: elapsedMilliseconds(startedAt),
      });
      return json({ error: message }, status, requestId);
    }
  };
}

function hasApiKey(request: Request, expected: string) {
  const authorization = request.headers.get("authorization");
  const bearer = authorization?.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length)
    : undefined;

  return bearer ? constantTimeEqual(bearer, expected) : false;
}

function projectIdFromPath(path: string, prefix: string) {
  const marker = `${prefix}/`;

  if (!path.startsWith(marker)) {
    return undefined;
  }

  const encodedProject = path.slice(marker.length);

  if (!encodedProject || encodedProject.includes("/")) {
    return undefined;
  }

  try {
    const project = decodeURIComponent(encodedProject);
    return project || undefined;
  } catch {
    return undefined;
  }
}

function constantTimeEqual(first: string, second: string) {
  const firstBytes = new TextEncoder().encode(first);
  const secondBytes = new TextEncoder().encode(second);
  let result = firstBytes.length ^ secondBytes.length;
  const length = Math.max(firstBytes.length, secondBytes.length);

  for (let index = 0; index < length; index += 1) {
    result |= (firstBytes[index] ?? 0) ^ (secondBytes[index] ?? 0);
  }

  return result === 0;
}

function json(body: unknown, status = 200, requestId?: string) {
  const headers = requestId ? { "x-request-id": requestId } : undefined;
  return Response.json(body, { status, headers });
}

function elapsedMilliseconds(startedAt: number) {
  return Math.round(performance.now() - startedAt);
}

function readableError(error: unknown) {
  return error instanceof Error
    ? error.message.replace(/\s+/g, " ").trim().slice(0, 500)
    : "Invalid project configuration.";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
