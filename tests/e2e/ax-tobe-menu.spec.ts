import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { navigateWorkspace } from "./navigation";
import { diagnosisFixture, taskFixture } from "../fixtures/ax";
import { dieselCase } from "../fixtures/diesel-case";
import { emptyAxState, type AxTask } from "../../src/lib/ax/types";
import { exportAxState } from "../../src/lib/ax/transfer";

async function seed(page: Page, value: unknown) {
  await page.evaluate(async record => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open("worklens-ax", 1);
      req.onupgradeneeded = () => req.result.createObjectStore("state");
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("state", "readwrite");
      tx.objectStore("state").put(record, "current");
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  }, value);
}

async function ax(page: Page) {
  await navigateWorkspace(page, "업무 자동화 진단");
  await expect(page.getByRole("tablist", { name: "진단 단계" })).toBeVisible();
}

function diagnosed(id: string, diagnosis: AxTask["diagnosis"]): AxTask {
  return taskFixture(id, structuredClone(diagnosis));
}

// dieselCase.diagnosis는 입력 타입이라 sourceNote가 타입에 없다. 런타임 픽스처 값과
// 같은 sourceNote를 명시해 AxDiagnosis로 완성한다.
function dieselDiagnosis() {
  return { ...structuredClone(dieselCase.diagnosis), sourceNote: "사용자 등록 정보 기반 진단" };
}

const menuButton = (page: Page) => page.getByRole("button", { name: "AI•AX 데이터 작업", exact: true });
const stepsBox = (page: Page) => page.locator(".ax-steps");

async function openMenu(page: Page) {
  await menuButton(page).click();
  await expect(page.getByRole("menuitem", { name: "데이터 내보내기", exact: true })).toBeVisible();
}

async function importViaMenu(page: Page, buffer: Buffer) {
  await menuButton(page).click();
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("menuitem", { name: "데이터 가져오기", exact: true }).click();
  await (await chooser).setFiles({ name: "restore.json", mimeType: "application/json", buffer });
}

test("TO-BE에 주황색 확인 필요 안내가 표시되지 않는다 (디젤 케이스: 변경 전 5단계 전건 표시)", async ({ page }) => {
  const task = diagnosed("diesel-1", dieselDiagnosis());
  await page.goto("/");
  await seed(page, { ...emptyAxState(), tasks: [task], selectedTaskId: task.id, step: 2 });
  await ax(page);
  const tobe = page.locator(".ax-tobe-card");
  await expect(tobe).toBeVisible();
  await expect(tobe).toContainText("TO-BE · 역할과 흐름 (목표 프로세스)");
  // 단계명·설명·담당·화살표는 그대로 유지된다.
  for (const step of ["가격 입력", "증감률 계산", "월평균 계산", "보고서 업데이트", "담당자 최종 검토"]) {
    await expect(tobe).toContainText(step);
  }
  await expect(tobe.locator(".ax-tobe-item")).toHaveCount(5);
  await expect(tobe.locator(".ax-tobe-arrow")).toHaveCount(4);
  await expect(tobe.locator(".ax-tobe-icon")).toHaveCount(5);
  // 안내 자체가 렌더링되지 않는다 (문구·아이콘·전용 클래스 전건 부재).
  await expect(tobe.locator(".ax-tobe-check")).toHaveCount(0);
  await expect(tobe).not.toContainText("확인 필요:");
  // "보고서 양식"은 원본 단계 설명("계산 결과를 보고서 양식에 입력 후보로 제안")에
  // 원래 있던 문구라 안내 부재 단언에서 제외한다. 미확인 주제 "전주 가격 데이터"는
  // 어떤 단계 설명에도 없어 안내로만 표시됐던 문구다.
  await expect(tobe).not.toContainText("전주 가격 데이터");
  // 제거 후 단계별 높이에 불필요한 빈 공간이 남지 않는다.
  const heights = await tobe.locator(".ax-tobe-item").evaluateAll(items => items.map(el => el.getBoundingClientRect().height));
  expect(heights).toHaveLength(5);
  for (const height of heights) expect(height).toBeGreaterThan(0);
  for (const height of heights) expect(height).toBeLessThan(200);
});

test("TO-BE 확인 안내 부재는 다른 진단 유형에도 동일하다 (대표 픽스처)", async ({ page }) => {
  const task = diagnosed("fixture-1", diagnosisFixture);
  await page.goto("/");
  await seed(page, { ...emptyAxState(), tasks: [task], selectedTaskId: task.id, step: 2 });
  await ax(page);
  const tobe = page.locator(".ax-tobe-card");
  await expect(tobe.locator(".ax-tobe-item")).toHaveCount(2);
  await expect(tobe.locator(".ax-tobe-check")).toHaveCount(0);
  await expect(tobe).not.toContainText("확인 필요:");
  await expect(tobe).toContainText("검토용 표 생성");
  await expect(tobe).toContainText("승인");
});

test("관리 메뉴가 단계 박스 내부 우측 끝에 있고 외부 중복이 없다 (데스크톱 1440×900)", async ({ page }) => {
  await page.goto("/");
  await seed(page, { ...emptyAxState(), step: 1 });
  await ax(page);
  await expect(menuButton(page)).toHaveCount(1);
  const inSteps = stepsBox(page).getByRole("button", { name: "AI•AX 데이터 작업", exact: true });
  await expect(inSteps).toBeVisible();
  const boxes = await page.evaluate(() => {
    const menu = document.querySelector('[aria-label="AI•AX 데이터 작업"]')!.getBoundingClientRect();
    const steps = document.querySelector(".ax-steps")!.getBoundingClientRect();
    return { menu, steps, tabs: [...document.querySelectorAll(".ax-steps [role=tab]")].map(el => el.textContent?.trim()) };
  });
  expect(boxes.tabs).toEqual(["업무 등록", "업무 진단", "자동화 매트릭스", "결과·로드맵"]);
  expect(boxes.menu.top).toBeGreaterThanOrEqual(boxes.steps.top);
  expect(boxes.menu.bottom).toBeLessThanOrEqual(boxes.steps.bottom);
  expect(boxes.menu.left).toBeGreaterThanOrEqual(boxes.steps.left);
  expect(boxes.menu.right).toBeLessThanOrEqual(boxes.steps.right);
  // 박스 내부 우측 끝: 마지막 탭 바로 뒤, 박스 오른쪽 여백(5px) 이내.
  expect(boxes.steps.right - boxes.menu.right).toBeLessThanOrEqual(8);
  // 단계 박스 전체 높이가 버튼 때문에 불필요하게 커지지 않는다.
  expect(boxes.steps.height).toBeLessThanOrEqual(70);
  expect(boxes.menu.height).toBeLessThanOrEqual(boxes.steps.height);
  // 단계 선택·이동이 그대로 동작한다.
  await page.getByRole("tab", { name: "업무 진단", exact: true }).click();
  await expect(page.getByText("진단할 업무를 먼저 등록하세요")).toBeVisible();
  await page.getByRole("tab", { name: "업무 등록", exact: true }).click();
  await expect(page.getByRole("heading", { name: "업무 등록", exact: true })).toBeVisible();
  // 메뉴 열림·닫힘, 팝업 잘림 없음.
  await openMenu(page);
  const popup = page.locator('[data-slot="menu-popup"]');
  await expect(popup).toBeVisible();
  const popupBox = (await popup.boundingBox())!;
  expect(popupBox.x).toBeGreaterThanOrEqual(0);
  expect(popupBox.x + popupBox.width).toBeLessThanOrEqual(1440);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menuitem", { name: "데이터 내보내기", exact: true })).toHaveCount(0);
  // 키보드로도 메뉴를 열 수 있다.
  await menuButton(page).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("menuitem", { name: "데이터 가져오기", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  // 가로 넘침 없음.
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
  expect(overflow).toBe(true);
});

test("관리 메뉴 내보내기·가져오기(확인·취소·오류)가 실제 동작한다", async ({ page }) => {
  const original = diagnosed("diesel-1", dieselDiagnosis());
  await page.goto("/");
  await seed(page, { ...emptyAxState(), tasks: [original], selectedTaskId: original.id, step: 1 });
  await ax(page);
  // 내보내기: 실제 다운로드 파일에 원본 업무가 들어 있다.
  const download = page.waitForEvent("download");
  await openMenu(page);
  await page.getByRole("menuitem", { name: "데이터 내보내기", exact: true }).click();
  const exportedPath = await (await download).path();
  const exported = JSON.parse(await readFile(exportedPath!, "utf8"));
  expect(exported.data.tasks.map((t: { name: string }) => t.name)).toEqual([original.name]);
  // 가져오기 취소: 원본이 그대로 남는다.
  const replacement = taskFixture("imported-1");
  await importViaMenu(page, Buffer.from(exportAxState({ ...emptyAxState(), tasks: [replacement], selectedTaskId: replacement.id })));
  await expect(page.getByRole("alertdialog")).toBeVisible();
  await page.getByRole("alertdialog").getByRole("button", { name: "취소", exact: true }).click();
  await expect(page.getByLabel("등록 업무 목록")).toContainText(original.name);
  await expect(page.getByLabel("등록 업무 목록")).not.toContainText(replacement.name);
  // 가져오기 확인: 교체된다.
  await importViaMenu(page, Buffer.from(exportAxState({ ...emptyAxState(), tasks: [replacement], selectedTaskId: replacement.id })));
  await page.getByRole("alertdialog").getByRole("button", { name: "덮어쓰기", exact: true }).click();
  await expect(page.getByLabel("등록 업무 목록")).toContainText(replacement.name);
  await expect(page.getByLabel("등록 업무 목록")).not.toContainText(original.name);
  // 가져오기 오류: 형식이 잘못된 파일은 오류 메시지만 남기고 데이터를 바꾸지 않는다.
  await importViaMenu(page, Buffer.from("{ not json"));
  await expect(page.locator(".ax-utility-message")).toHaveText(/.+/);
  await expect(page.getByLabel("등록 업무 목록")).toContainText(replacement.name);
});

test("관리 메뉴 버튼·팝업 디자인이 학습센터 ··· 메뉴와 일치한다", async ({ page }) => {
  await page.goto("/");
  await seed(page, { ...emptyAxState(), step: 1 });
  await ax(page);
  const axStyle = await menuButton(page).evaluate(el => {
    const style = getComputedStyle(el);
    return { width: el.getBoundingClientRect().width, height: el.getBoundingClientRect().height, borderWidth: style.borderWidth, borderStyle: style.borderStyle, backgroundColor: style.backgroundColor, borderRadius: style.borderRadius };
  });
  await navigateWorkspace(page, "학습센터");
  const learnButton = page.getByRole("button", { name: "학습 기록 작업", exact: true });
  await expect(learnButton).toBeVisible();
  const learnStyle = await learnButton.evaluate(el => {
    const style = getComputedStyle(el);
    return { width: el.getBoundingClientRect().width, height: el.getBoundingClientRect().height, borderWidth: style.borderWidth, borderStyle: style.borderStyle, backgroundColor: style.backgroundColor, borderRadius: style.borderRadius };
  });
  expect(axStyle).toEqual(learnStyle);
});

test("모바일 390×844: 관리 버튼이 박스 우측 끝에 보이고 TO-BE 안내가 없다", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const task = diagnosed("diesel-1", dieselDiagnosis());
  await page.goto("/");
  await seed(page, { ...emptyAxState(), tasks: [task], selectedTaskId: task.id, step: 2 });
  await ax(page);
  // 가로 스크롤 내비게이션에서도 관리 버튼은 박스 우측 끝에 보인다.
  const menuBox = await menuButton(page).boundingBox();
  expect(menuBox).not.toBeNull();
  expect(menuBox!.x).toBeGreaterThanOrEqual(0);
  expect(menuBox!.x + menuBox!.width).toBeLessThanOrEqual(390);
  const stepsBoxEl = stepsBox(page);
  await stepsBoxEl.evaluate(el => { el.scrollLeft = el.scrollWidth; });
  const menuBoxAfterScroll = await menuButton(page).boundingBox();
  expect(menuBoxAfterScroll!.x).toBeGreaterThanOrEqual(0);
  expect(menuBoxAfterScroll!.x + menuBoxAfterScroll!.width).toBeLessThanOrEqual(390);
  // 메뉴를 터치하듯 클릭해 열 수 있고 팝업이 화면 안에 들어간다.
  await menuButton(page).click();
  await expect(page.getByRole("menuitem", { name: "데이터 내보내기", exact: true })).toBeVisible();
  const popupBox = (await page.locator('[data-slot="menu-popup"]').boundingBox())!;
  expect(popupBox.x).toBeGreaterThanOrEqual(0);
  expect(popupBox.x + popupBox.width).toBeLessThanOrEqual(390);
  await page.keyboard.press("Escape");
  // TO-BE 안내 부재 + 페이지 가로 넘침 없음.
  const tobe = page.locator(".ax-tobe-card");
  await expect(tobe.locator(".ax-tobe-check")).toHaveCount(0);
  await expect(tobe).not.toContainText("확인 필요:");
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
  expect(overflow).toBe(true);
  // 기존 데이터는 그대로 복원된다 (새로고침 후 업무 목록).
  await page.reload();
  await ax(page);
  await expect(page.getByLabel("등록 업무 목록")).toContainText(task.name);
});
