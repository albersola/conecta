import { isIP } from "node:net";
import { dirname } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import {
  type ProjectConfig,
  validateProjectId,
  validateTag,
} from "./config.ts";
import {
  type ServiceEndpoint,
  type ServiceRegistry,
} from "./service_registry.ts";

const schemaVersion = 1;

type ProjectRow = {
  id: string;
  name: string;
  image: string;
  tag: string;
  container_port: number;
  health_path: string;
  startup_timeout_seconds: number;
  env_file: string | null;
  registry_username: string | null;
  registry_password_env: string | null;
};

type ServiceRow = {
  port: number;
  protocol: string;
};

type AddressRow = {
  address: string;
};

export class ConectaDatabase implements ServiceRegistry {
  private readonly database: DatabaseSync;
  private readonly getProjectQuery: StatementSync;
  private readonly getServiceQuery: StatementSync;
  private readonly getServiceAddressesQuery: StatementSync;
  private readonly upsertProjectQuery: StatementSync;
  private readonly upsertServiceQuery: StatementSync;
  private readonly deleteServiceAddressesQuery: StatementSync;
  private readonly insertServiceAddressQuery: StatementSync;

  constructor(path: string) {
    const normalizedPath = path.trim();
    if (!normalizedPath) {
      throw new Error("CONECTA_DB_PATH must not be empty.");
    }

    if (normalizedPath !== ":memory:") {
      Deno.mkdirSync(dirname(normalizedPath), { recursive: true });
    }

    this.database = new DatabaseSync(normalizedPath, {
      allowExtension: false,
      enableDoubleQuotedStringLiterals: false,
      enableForeignKeyConstraints: true,
    });
    this.database.exec("PRAGMA journal_mode = WAL");
    this.database.exec("PRAGMA busy_timeout = 5000");
    migrate(this.database);

    this.getProjectQuery = this.database.prepare(`
      SELECT
        id,
        name,
        image,
        tag,
        container_port,
        health_path,
        startup_timeout_seconds,
        env_file,
        registry_username,
        registry_password_env
      FROM projects
      WHERE id = ?
    `);
    this.getServiceQuery = this.database.prepare(`
      SELECT port, protocol
      FROM services
      WHERE id = ?
    `);
    this.getServiceAddressesQuery = this.database.prepare(`
      SELECT address
      FROM service_addresses
      WHERE service_id = ?
      ORDER BY family, address
    `);
    this.upsertProjectQuery = this.database.prepare(`
      INSERT INTO projects (
        id,
        name,
        image,
        tag,
        container_port,
        health_path,
        startup_timeout_seconds,
        env_file,
        registry_username,
        registry_password_env,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        image = excluded.image,
        tag = excluded.tag,
        container_port = excluded.container_port,
        health_path = excluded.health_path,
        startup_timeout_seconds = excluded.startup_timeout_seconds,
        env_file = excluded.env_file,
        registry_username = excluded.registry_username,
        registry_password_env = excluded.registry_password_env,
        updated_at = excluded.updated_at
    `);
    this.upsertServiceQuery = this.database.prepare(`
      INSERT INTO services (id, port, protocol, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        port = excluded.port,
        protocol = excluded.protocol,
        updated_at = excluded.updated_at
    `);
    this.deleteServiceAddressesQuery = this.database.prepare(`
      DELETE FROM service_addresses
      WHERE service_id = ?
    `);
    this.insertServiceAddressQuery = this.database.prepare(`
      INSERT INTO service_addresses (service_id, address, family)
      VALUES (?, ?, ?)
    `);
  }

  getProject(projectId: string): ProjectConfig | null {
    validateProjectId(projectId);
    const row = this.getProjectQuery.get(projectId) as
      | ProjectRow
      | undefined;

    if (!row) {
      return null;
    }

    return {
      id: row.id,
      name: row.name,
      image: row.image,
      tag: row.tag,
      containerPort: row.container_port,
      healthPath: row.health_path,
      startupTimeoutSeconds: row.startup_timeout_seconds,
      ...(row.env_file ? { envFile: row.env_file } : {}),
      ...(row.registry_username
        ? { registryUsername: row.registry_username }
        : {}),
      ...(row.registry_password_env
        ? { registryPasswordEnv: row.registry_password_env }
        : {}),
    };
  }

  getService(serviceId: string): ServiceEndpoint | null {
    validateProjectId(serviceId);
    const service = this.getServiceQuery.get(serviceId) as
      | ServiceRow
      | undefined;

    if (!service) {
      return null;
    }

    if (service.protocol !== "tcp") {
      throw new Error(`Service ${serviceId} has an unsupported protocol.`);
    }

    const addresses =
      (this.getServiceAddressesQuery.all(serviceId) as AddressRow[])
        .map(({ address }) => address);

    return {
      addresses,
      port: service.port,
      protocol: "tcp",
    };
  }

  replaceService(project: ProjectConfig, endpoint: ServiceEndpoint): void {
    validateProjectId(project.id);
    validateTag(project.tag);
    validateEndpoint(project.id, endpoint);

    const addresses = [...new Set(endpoint.addresses)];
    const updatedAt = Date.now();

    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.upsertProjectQuery.run(
        project.id,
        project.name,
        project.image,
        project.tag,
        project.containerPort,
        project.healthPath,
        project.startupTimeoutSeconds,
        project.envFile ?? null,
        project.registryUsername ?? null,
        project.registryPasswordEnv ?? null,
        updatedAt,
      );
      this.upsertServiceQuery.run(
        project.id,
        endpoint.port,
        endpoint.protocol,
        updatedAt,
      );
      this.deleteServiceAddressesQuery.run(project.id);

      for (const address of addresses) {
        this.insertServiceAddressQuery.run(
          project.id,
          address,
          isIP(address),
        );
      }

      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  close(): void {
    this.database.close();
  }
}

function migrate(database: DatabaseSync) {
  const row = database.prepare("PRAGMA user_version").get() as {
    user_version: number;
  };

  if (row.user_version > schemaVersion) {
    throw new Error(
      `Database schema version ${row.user_version} is newer than supported version ${schemaVersion}.`,
    );
  }

  if (row.user_version === schemaVersion) {
    return;
  }

  database.exec("BEGIN IMMEDIATE");
  try {
    database.exec(`
      CREATE TABLE projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        image TEXT NOT NULL,
        tag TEXT NOT NULL,
        container_port INTEGER NOT NULL CHECK(container_port BETWEEN 1 AND 65535),
        health_path TEXT NOT NULL,
        startup_timeout_seconds INTEGER NOT NULL CHECK(startup_timeout_seconds BETWEEN 1 AND 900),
        env_file TEXT,
        registry_username TEXT,
        registry_password_env TEXT,
        updated_at INTEGER NOT NULL,
        CHECK(registry_username IS NULL OR registry_password_env IS NOT NULL)
      ) STRICT;

      CREATE TABLE services (
        id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
        port INTEGER NOT NULL CHECK(port BETWEEN 1 AND 65535),
        protocol TEXT NOT NULL CHECK(protocol = 'tcp'),
        updated_at INTEGER NOT NULL
      ) STRICT;

      CREATE TABLE service_addresses (
        service_id TEXT NOT NULL REFERENCES services(id) ON DELETE CASCADE,
        address TEXT NOT NULL,
        family INTEGER NOT NULL CHECK(family IN (4, 6)),
        PRIMARY KEY(service_id, address)
      ) STRICT, WITHOUT ROWID;

      PRAGMA user_version = ${schemaVersion};
    `);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function validateEndpoint(serviceId: string, endpoint: ServiceEndpoint) {
  if (
    !Array.isArray(endpoint.addresses) ||
    endpoint.addresses.length === 0 ||
    endpoint.addresses.some((address) => isIP(address) === 0)
  ) {
    throw new Error(`Service ${serviceId} must contain valid IP addresses.`);
  }

  if (
    !Number.isInteger(endpoint.port) ||
    endpoint.port < 1 ||
    endpoint.port > 65535
  ) {
    throw new Error(`Service ${serviceId} must contain a valid port.`);
  }

  if (endpoint.protocol !== "tcp") {
    throw new Error(`Service ${serviceId} must use the tcp protocol.`);
  }
}
