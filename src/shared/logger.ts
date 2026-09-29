/**
 * The logging surface every service depends on.
 *
 * Structured first argument, human sentence second — the same `console` call
 * shape the service has always used, so `console` itself satisfies it. Each
 * method is optional so a test can pass `{}` to silence a service entirely.
 */
export interface Logger {
  log?(obj: unknown, msg?: string): void;
  warn?(obj: unknown, msg?: string): void;
  error?(obj: unknown, msg?: string): void;
}
