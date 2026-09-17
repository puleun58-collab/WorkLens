import { chromium } from "@playwright/test";

const target = process.env.TARGET ?? "http://127.0.0.1:3013";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
page.on("console", (message) => console.info(`[console:${message.type()}]`, message.text().slice(0, 300)));
page.on("pageerror", (error) => console.info("[pageerror]", error.message.slice(0, 300)));
page.on("requestfailed", (request) => console.info("[requestfailed]", request.url().slice(-80), request.failure()?.errorText));
page.on("worker", (worker) => {
  console.info("[worker:start]", worker.url().slice(-70));
  worker.on("close", () => console.info("[worker:close]", worker.url().slice(-70)));
});

// Surface the worker's own load error: our client turns it into one message.
await page.addInitScript(() => {
  const Native = window.Worker;
  class Traced extends Native {
    constructor(url: string | URL, options?: WorkerOptions) {
      super(url, options);
      this.addEventListener("error", (event) => {
        const detail = event as ErrorEvent;
        console.info(`[worker:error] ${String(url)} :: ${detail.message} @ ${detail.filename}:${detail.lineno}`);
      });
      this.addEventListener("messageerror", () => console.info(`[worker:messageerror] ${String(url)}`));
    }
  }
  window.Worker = Traced as unknown as typeof Worker;
});

// Pretend the device has WebGPU so the flow reaches worker creation, which is
// the step the user's browser fails at.
await page.addInitScript(() => {
  Object.defineProperty(navigator, "gpu", {
    configurable: true,
    value: { requestAdapter: async () => ({ requestDevice: async () => ({}) }) },
  });
});

await page.goto(target);
await page.locator('input[type="file"]').setInputFiles("artifacts/fixtures/최종검수.pptx");
await page.locator(".file-row").first().waitFor();
await page.getByLabel("최종검수.pptx 선택").check();
await page.getByRole("button", { name: "Ask", exact: true }).click();
await page.waitForTimeout(1_000);
console.info("panel after probe", (await page.locator(".ai-status").innerText().catch(() => "none")).replaceAll("\n", " | "));

const start = page.getByRole("button", { name: "사용 시작" });
if (await start.count()) await start.click();
await page.getByPlaceholder("선택한 문서에서 확인할 내용을 입력하세요").fill("문서의 기준일은 언제인가요?");
await page.getByRole("button", { name: "Ask 실행" }).click();
await page.waitForTimeout(8_000);
console.info("panel after run", (await page.locator(".ai-status").innerText().catch(() => "none")).replaceAll("\n", " | "));
console.info("notice", (await page.locator(".notice").innerText().catch(() => "none")).replaceAll("\n", " | "));
await browser.close();
