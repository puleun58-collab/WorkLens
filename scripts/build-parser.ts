import { cp, mkdir } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const output = path.join(root, ".worklens");
await mkdir(output, { recursive: true });

for (const [entrypoint, outfile] of [
  ["src/server/parsers/runner.ts", "parser-runner.mjs"],
  ["src/server/parsers/sandbox-probe.ts", "parser-sandbox-probe.mjs"],
] as const) {
  const result = await Bun.build({
    entrypoints: [path.join(root, entrypoint)],
    target: "node",
    format: "esm",
    outdir: output,
    naming: outfile,
  });
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    process.exit(1);
  }
}

await cp(
  path.join(root, "node_modules", "pdfjs-dist", "legacy", "build", "pdf.worker.mjs"),
  path.join(output, "pdf.worker.mjs"),
);
await cp(
  path.join(root, "node_modules", "pdfjs-dist", "standard_fonts"),
  path.join(output, "standard_fonts"),
  { recursive: true, force: true },
);
