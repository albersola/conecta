export type LogFields = Record<string, unknown>;

export type Logger = {
  info: (event: string, fields?: LogFields) => void;
  warn: (event: string, fields?: LogFields) => void;
  error: (event: string, fields?: LogFields) => void;
};

export const logger: Logger = {
  info: (event, fields) => write("INFO", event, fields),
  warn: (event, fields) => write("WARN", event, fields),
  error: (event, fields) => write("ERROR", event, fields),
};

function write(level: string, event: string, fields: LogFields = {}) {
  const message = JSON.stringify({
    timestamp: new Date().toISOString(),
    ...fields,
    level,
    event,
  });

  if (level === "ERROR") {
    console.error(message);
    return;
  }

  if (level === "WARN") {
    console.warn(message);
    return;
  }

  console.info(message);
}
