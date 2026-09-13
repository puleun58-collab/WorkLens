import "./runner";
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { Socket } from "node:net";
import dgram from "node:dgram";

const probe = process.argv[2];
try {
  if (probe === "fs-write") writeFileSync(".worklens/forbidden.txt", "forbidden");
  else if (probe === "fs-read-repository") readFileSync("package.json", "utf8");
  else if (probe === "child-process") spawnSync(process.execPath, ["--version"]);
  else if (probe === "tcp") new Socket().connect(9, "127.0.0.1");
  else if (probe === "udp") dgram.createSocket("udp4").send(Buffer.from("x"), 9, "127.0.0.1");
  else if (probe === "fetch") await fetch("http://127.0.0.1:9");
  else throw new Error("UNKNOWN_PROBE");
  process.stdout.write("UNEXPECTED_SUCCESS");
  process.exitCode = 2;
} catch (error) {
  process.stdout.write(error instanceof Error ? `${error.name}:${error.message}` : "DENIED");
  process.exitCode = 1;
}
