import { env as platformEnv } from "cloudflare:workers";

/**
 * Worker bindings access. Under Node the specifier is aliased to a stub that
 * exposes process env only, so every binding read must tolerate `undefined`.
 */
export interface D1Row {
  [column: string]: unknown;
}

export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = D1Row>(): Promise<T | null>;
  all<T = D1Row>(): Promise<{ results: T[] }>;
  run(): Promise<{ meta: { last_row_id?: number; changes?: number } }>;
}

export interface D1DatabaseLike {
  prepare(query: string): D1PreparedStatement;
}

export interface WorkerEnv {
  WORKLENS_CONFIG_DB?: D1DatabaseLike;
  WORKLENS_ADMIN_PASSWORD?: string;
  WORKLENS_ADMIN_SESSION_SECRET?: string;
  GROQ_API_KEY?: string;
}

export function workerEnv(): WorkerEnv {
  const source: Record<string, unknown> = platformEnv ?? {};
  const database = source.WORKLENS_CONFIG_DB;
  const password = source.WORKLENS_ADMIN_PASSWORD;
  const secret = source.WORKLENS_ADMIN_SESSION_SECRET;
  const groqApiKey = source.GROQ_API_KEY;
  return {
    ...(database && typeof database === "object" ? { WORKLENS_CONFIG_DB: database as D1DatabaseLike } : {}),
    ...(typeof password === "string" ? { WORKLENS_ADMIN_PASSWORD: password } : {}),
    ...(typeof secret === "string" ? { WORKLENS_ADMIN_SESSION_SECRET: secret } : {}),
    ...(typeof groqApiKey === "string" ? { GROQ_API_KEY: groqApiKey } : {}),
  };
}

export function configDatabase(): D1DatabaseLike | null {
  return workerEnv().WORKLENS_CONFIG_DB ?? null;
}
