import { describe, expect, it } from "vitest";
import { readReviewPreferences, resetReviewPreferences, resolveReviewPreferences, REVIEW_PREFERENCES_KEY, saveReviewPreferences } from "@/client/review-preferences";

function storage(initial?: string) {
  const values = new Map<string, string>(initial === undefined ? [] : [[REVIEW_PREFERENCES_KEY, initial]]);
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
}

describe("검토 설정 기본값과 이번 실행 설정", () => {
  it("저장한 기본값은 재진입에 복원하고 실행 변경은 저장하지 않는다", () => {
    const browser = storage();
    saveReviewPreferences({ documentSource: "text", expandSources: true }, browser);
    const saved = readReviewPreferences(browser).preferences;
    const run = resolveReviewPreferences(saved, { documentSource: "file", expandSources: false });
    expect(run).toEqual({ documentSource: "file", expandSources: false });
    run.expandSources = true;
    expect(readReviewPreferences(browser).preferences).toEqual({ documentSource: "text", expandSources: true });
    expect(resolveReviewPreferences(readReviewPreferences(browser).preferences)).toEqual({ documentSource: "text", expandSources: true });
  });
  it("초기화하면 다음 검토는 시스템 기본값을 사용한다", () => {
    const browser = storage();
    saveReviewPreferences({ documentSource: "text", expandSources: true }, browser);
    expect(resetReviewPreferences(browser).ok).toBe(true);
    expect(resolveReviewPreferences(readReviewPreferences(browser).preferences)).toEqual({ documentSource: "file", expandSources: false });
  });
  it.each([
    "not-json",
    JSON.stringify({ version: 0, preferences: { documentSource: "text", expandSources: true } }),
    JSON.stringify({ version: 1, preferences: { documentSource: "deprecated", expandSources: true } }),
    JSON.stringify({ version: 1, preferences: { documentSource: "text", expandSources: "false" } }),
  ])("폐기되거나 손상된 설정은 실행 옵션으로 사용하지 않고 오류를 알린다 (%s)", (raw) => {
    const loaded = readReviewPreferences(storage(raw));
    expect(loaded.preferences).toBeNull();
    expect(loaded.error).not.toBeNull();
    expect(resolveReviewPreferences(loaded.preferences)).toEqual({ documentSource: "file", expandSources: false });
  });
  it("저장과 초기화 실패를 알리고 이전 기본값은 유지한다", () => {
    const browser = storage();
    saveReviewPreferences({ documentSource: "text", expandSources: true }, browser);
    const blocked = { ...browser, setItem() { throw new Error("quota"); }, removeItem() { throw new Error("blocked"); } };
    expect(saveReviewPreferences({ documentSource: "file", expandSources: false }, blocked)).toMatchObject({ ok: false });
    expect(resetReviewPreferences(blocked)).toMatchObject({ ok: false });
    expect(readReviewPreferences(browser).preferences).toEqual({ documentSource: "text", expandSources: true });
  });
  it("브라우저 저장소 접근 실패에도 시스템 기본값으로 검토할 수 있다", () => {
    const loaded = readReviewPreferences({ getItem() { throw new Error("blocked"); }, setItem() {}, removeItem() {} });
    expect(loaded).toMatchObject({ preferences: null });
    expect(loaded.error).not.toBeNull();
    expect(resolveReviewPreferences(loaded.preferences, { documentSource: "text" })).toEqual({ documentSource: "text", expandSources: false });
  });
  it("문서 등 추가 속성을 전달해도 허용된 표시 설정만 저장한다", () => {
    const browser = storage();
    const input = { documentSource: "text" as const, expandSources: true, text: "민감한 문서", question: "질문", findings: ["근거"] };
    saveReviewPreferences(input, browser);
    expect(JSON.parse(browser.getItem(REVIEW_PREFERENCES_KEY)!)).toEqual({ version: 1, preferences: { documentSource: "text", expandSources: true } });
  });
});
