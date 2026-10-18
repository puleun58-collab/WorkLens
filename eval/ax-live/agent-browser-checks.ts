import { createServer } from "node:http";
import type { Server } from "node:http";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { chromium, type Page } from "@playwright/test";

export interface BrowserCheck { command: string; pass: boolean; observed: string }
const readJson = async (page: Page, selector: string) => {
  const text = (await page.locator(selector).textContent())?.trim() ?? "";
  try { return JSON.parse(text) as unknown; }
  catch { return text; }
};
const compare = isDeepStrictEqual;
const inspected = (value: unknown) => JSON.stringify(value)?.slice(0, 220) ?? "undefined";

async function freePort() {
  const listener = createServer();
  const { promise, resolve, reject } = Promise.withResolvers<number>();
  listener.once("error", reject);
  listener.listen(0, "127.0.0.1", () => {
    const address = listener.address();
    if (!address || typeof address === "string") reject(new Error("No TCP port"));
    else listener.close(() => resolve(address.port));
  });
  return promise;
}

async function startApp(dir: string, env: Record<string, string>, port: number) {
  const proc = Bun.spawn(["node", "server.mjs"], { cwd: dir, env: { ...env, PORT: String(port) }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  for (let attempt = 0; attempt < 60; attempt++) {
    if (proc.exitCode !== null) throw new Error(`Web app exited before ready (${proc.exitCode})`);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(300) });
      if (res.ok) return proc;
    } catch { /* wait until server binds */ }
    await Bun.sleep(100);
  }
  proc.kill();
  throw new Error("Web app did not serve HTTP 200 in 6 seconds");
}

export async function runBrowserChecks(kind: string, dir: string, env: Record<string, string>, fixture?: Server): Promise<BrowserCheck[]> {
  const checks: BrowserCheck[] = [];
  const port = await freePort();
  let proc = await startApp(dir, env, port);
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const url = `http://127.0.0.1:${port}/`;
  const check = (command: string, actual: unknown, expected: unknown) => checks.push({ command, pass: compare(actual, expected), observed: inspected(actual) });
  const awaitJson = async (selector: string, expected: unknown) => {
    await page.waitForFunction(({ selector, expected }) => {
      const stable = (value: unknown): unknown => Array.isArray(value) ? value.map(stable) : value && typeof value === "object"
        ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stable(item)])) : value;
      try {
        const value = JSON.parse(document.querySelector(selector)?.textContent ?? "");
        return JSON.stringify(stable(value)) === JSON.stringify(stable(expected));
      } catch { return false; }
    }, { selector, expected }, { timeout: 4_000 }).catch(() => undefined);
    return readJson(page, selector);
  };
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 12_000 });
    if (kind === "csv") {
      for (const [file, expected] of [
        ["input-a.csv", { rows: [{ order_id: "A", total: 36 }, { order_id: "B", total: 14 }], grandTotal: 50 }],
        ["input-b.csv", { rows: [{ order_id: "C", total: 18 }, { order_id: "D", total: 20 }], grandTotal: 38 }],
      ] as const) {
        await page.locator("#csv-file").setInputFiles(join(dir, file));
        await page.locator("#run-csv").click();
        check(`browser upload ${file} → #report`, await awaitJson("#report", expected), expected);
      }
      await page.locator("#csv-file").setInputFiles(join(dir, "input-bad.csv"));
      await page.locator("#run-csv").click();
      await page.locator("#error").waitFor({ state: "visible", timeout: 4_000 });
      const error = await page.locator("#error").textContent();
      const stale = await readJson(page, "#report");
      checks.push({ command: "browser upload invalid CSV → #error, clear stale report", pass: !!error?.trim() && !compare(stale, { rows: [{ order_id: "C", total: 18 }, { order_id: "D", total: 20 }], grandTotal: 38 }), observed: `error=${error?.slice(0, 100)} report=${inspected(stale)}` });
    } else if (kind === "crud") {
      check("browser initial list is empty", await awaitJson("#items", []), []);
      const act = async (button: string, id: string, title: string, expected: unknown) => {
        await page.locator("#item-id").fill(id);
        await page.locator("#item-title").fill(title);
        await page.locator(button).click();
        check(`browser ${button} ${id} ${title}`, await awaitJson("#items", expected), expected);
      };
      await act("#create", "K", "First", [{ id: "K", title: "First" }]);
      await act("#create", "M", "Second", [{ id: "K", title: "First" }, { id: "M", title: "Second" }]);
      await act("#update", "K", "Changed", [{ id: "K", title: "Changed" }, { id: "M", title: "Second" }]);
      await page.locator("#item-id").fill("K");
      await page.locator("#item-title").fill("Duplicate");
      await page.locator("#create").click();
      check("browser duplicate id preserves list", await awaitJson("#items", [{ id: "K", title: "Changed" }, { id: "M", title: "Second" }]), [{ id: "K", title: "Changed" }, { id: "M", title: "Second" }]);
      await page.waitForFunction(() => !!document.querySelector("#error")?.textContent?.trim(), null, { timeout: 4_000 }).catch(() => undefined);
      checks.push({ command: "browser duplicate id displays error", pass: !!(await page.locator("#error").textContent())?.trim(), observed: inspected(await page.locator("#error").textContent()) });
      await page.reload();
      check("browser refresh persisted CRUD", await awaitJson("#items", [{ id: "K", title: "Changed" }, { id: "M", title: "Second" }]), [{ id: "K", title: "Changed" }, { id: "M", title: "Second" }]);
      proc.kill();
      await proc.exited;
      proc = await startApp(dir, env, port);
      await page.goto(url);
      check("browser server restart persisted CRUD", await awaitJson("#items", [{ id: "K", title: "Changed" }, { id: "M", title: "Second" }]), [{ id: "K", title: "Changed" }, { id: "M", title: "Second" }]);
      await act("#delete", "K", "", [{ id: "M", title: "Second" }]);
      await page.locator("#item-id").fill("absent");
      await page.locator("#item-title").fill("No");
      await page.locator("#update").click();
      check("browser missing id preserves list", await awaitJson("#items", [{ id: "M", title: "Second" }]), [{ id: "M", title: "Second" }]);
      await page.waitForFunction(() => !!document.querySelector("#error")?.textContent?.trim(), null, { timeout: 4_000 }).catch(() => undefined);
      checks.push({ command: "browser missing id displays error", pass: !!(await page.locator("#error").textContent())?.trim(), observed: inspected(await page.locator("#error").textContent()) });
    } else if (kind === "api") {
      const address = fixture?.address();
      if (!address || typeof address === "string") throw new Error("Independent fixture missing");
      for (const [path, expected] of [
        ["records", [{ id: "R1", price: 12.5 }, { id: "R2", price: 0.99 }]],
        ["other", [{ id: "R3", price: 30.75 }]],
      ] as const) {
        await page.locator("#api-url").fill(`http://127.0.0.1:${address.port}/${path}`);
        await page.locator("#load-api").click();
        check(`browser GET independent fixture /${path} → #records`, await awaitJson("#records", expected), expected);
      }
      for (const path of ["invalid", "fail"]) {
        await page.locator("#api-url").fill(`http://127.0.0.1:${address.port}/${path}`);
        await page.locator("#load-api").click();
        await page.waitForFunction(() => !!document.querySelector("#error")?.textContent?.trim(), null, { timeout: 4_000 }).catch(() => undefined);
        const error = await page.locator("#error").textContent();
        const stale = await readJson(page, "#records");
        checks.push({ command: `browser GET independent fixture /${path} → error`, pass: !!error?.trim() && !compare(stale, [{ id: "R3", price: 30.75 }]), observed: `error=${error?.slice(0, 100)} records=${inspected(stale)}` });
      }
    }
  } finally { await browser.close(); proc.kill(); await proc.exited; }
  return checks;
}
