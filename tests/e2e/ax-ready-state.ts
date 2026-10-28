import { expect, type Locator } from "@playwright/test";

type LayoutSnapshot = { rect: string; panelScroll: number; pageY: number };

/**
 * 진단 항목 상세 펼침(Accordion 높이 전환, 200ms) 뒤 레이아웃이 준비됐음을
 * 관측 가능한 조건으로 확인한다.
 *
 * 확인 조건 (세 번 연속 동일 관측):
 * - 보정 버튼의 bounding box가 변하지 않는다 (높이 전환 완료).
 * - 진단 상세 AccordionPanel의 scrollTop이 0이다 (패널 내부 스크롤 정착).
 * - 페이지 scrollTop이 변하지 않는다 (부드러운 페이지 스크롤 진행 중이 아님).
 *
 * aria-expanded만으로는 200ms 높이 전환 완료가 보장되지 않으므로 그것만으로
 * 대기하지 않는다. 임의 sleep·timeout 확대·재시도 추가·reducedMotion은 쓰지
 * 않으며, Playwright expect.poll의 관측으로 대기한다.
 *
 * reset 버튼은 보정 클릭 뒤 새로 마운트되므로 이 대기에서 직접 관측하지
 * 않는다. 대신 보정 버튼이 속한 Factor 행 레이아웃이 최종 상태임을 확인해
 * reset이 최종 위치에 마운트되도록 한다.
 */
export async function waitForFactorControlReady(button: Locator): Promise<void> {
  await expect(button).toBeVisible();
  const snapshots: LayoutSnapshot[] = [];
  await expect.poll(async () => {
    const snapshot = await button.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      const panel = element.closest('[data-slot="accordion-panel"]');
      return {
        rect: [Math.round(rect.x), Math.round(rect.y), Math.round(rect.width), Math.round(rect.height)].join(","),
        panelScroll: panel ? Math.round((panel as HTMLElement).scrollTop) : 0,
        pageY: Math.round(window.scrollY),
      };
    });
    snapshots.push(snapshot);
    if (snapshots.length > 3) snapshots.shift();
    if (snapshots.length < 3) return false;
    const [a, b, c] = snapshots;
    const stable = a.rect === b.rect && b.rect === c.rect
      && a.panelScroll === b.panelScroll && b.panelScroll === c.panelScroll
      && a.pageY === b.pageY && b.pageY === c.pageY;
    return stable && c.panelScroll === 0;
  }).toBe(true);
}
