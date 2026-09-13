import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("deployment boundary", () => {
  it("refuses the single-process temp adapter in production without explicit opt-in", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("WORKLENS_ALLOW_LOCAL_EPHEMERAL", "");
    vi.stubEnv("WORKLENS_TEMP_DIR", `${process.cwd()}/.production-boundary-test`);
    vi.resetModules();
    const { createWorkspace } = await import("@/server/workspace-store");
    await expect(createWorkspace("a".repeat(64))).rejects.toMatchObject({
      code: "LOCAL_ADAPTER_DISABLED",
      status: 503,
    });
  });

  it("allows the explicitly selected local reference profile", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("WORKLENS_ALLOW_LOCAL_EPHEMERAL", "true");
    vi.stubEnv("WORKLENS_TEMP_DIR", `${process.cwd()}/.production-boundary-test`);
    vi.resetModules();
    const { createWorkspace, deleteWorkspace } = await import("@/server/workspace-store");
    await expect(createWorkspace("b".repeat(64))).resolves.toMatchObject({ principalKey: "b".repeat(64) });
    await deleteWorkspace("b".repeat(64));
  });
});
