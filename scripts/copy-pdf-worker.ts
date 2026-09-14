import { cp, mkdir } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const destination = path.join(root, "public");
await mkdir(destination, { recursive: true });
await cp(
  path.join(root, "node_modules", "pdfjs-dist", "legacy", "build", "pdf.worker.mjs"),
  path.join(destination, "pdf.worker.mjs"),
);
