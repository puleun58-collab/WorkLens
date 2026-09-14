/**
 * ExcelJS ships a UMD browser bundle that touches `window` at module scope.
 * Workers only expose `self`, so the alias is installed before any parser or
 * export module is evaluated. Imported first by the document worker.
 */
const scope: Record<string, unknown> = globalThis as unknown as Record<string, unknown>;
scope.window ??= globalThis;

export {};
