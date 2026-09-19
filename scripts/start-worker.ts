import path from "node:path";

const child = Bun.spawn([
  "bunx",
  "wrangler",
  "dev",
  "--config",
  path.join("dist", "server", "wrangler.json"),
  "--env-file",
  path.resolve(".dev.vars"),
], {
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
});

process.exitCode = await child.exited;
