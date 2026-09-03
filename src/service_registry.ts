import type { ProjectConfig } from "./config.ts";

export type ServiceEndpoint = {
  addresses: string[];
  port: number;
  protocol: "tcp";
};

type Awaitable<T> = T | Promise<T>;

export interface ServiceRegistry {
  getProject(projectId: string): Awaitable<ProjectConfig | null>;
  getService(serviceId: string): Awaitable<ServiceEndpoint | null>;
  replaceService(
    project: ProjectConfig,
    endpoint: ServiceEndpoint,
  ): Awaitable<void>;
}
