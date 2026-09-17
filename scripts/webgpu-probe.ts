import { chromium } from "@playwright/test";

const flagSets = [
  [],
  ["--enable-unsafe-webgpu"],
];

for (const args of flagSets) {
  const browser = await chromium.launch({ args, headless: false });
  const page = await browser.newPage();
  await page.goto("http://127.0.0.1:3013/");
  const report = await page.evaluate(async () => {
    const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
    if (!gpu) return { gpu: false };
    try {
      const adapter = await gpu.requestAdapter() as { requestDevice(): Promise<unknown> } | null;
      if (!adapter) return { gpu: true, adapter: false };
      const device = await adapter.requestDevice();
      return { gpu: true, adapter: true, device: Boolean(device) };
    } catch (error) {
      return { gpu: true, adapter: false, error: String(error).slice(0, 120) };
    }
  });
  console.info(args.join(" "), JSON.stringify(report));
  await browser.close();
}
