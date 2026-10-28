import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { setupGuide } from "../src/lib/ax/guide";

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");

describe("UI wording fixes", () => {
  it.each(["codex", "claude"] as const)("setup guide (%s) has no install-error section", (tool) => {
    const guide = setupGuide(tool);
    const titles = guide.flatMap((step) => step.sections.map((section) => section.title));
    expect(titles).not.toContain("설치 오류 확인");
    expect(JSON.stringify(guide)).not.toContain("설치 오류 확인");
    expect(guide[1].sections.map((section) => section.title)).toEqual([
      "설치 순서 안내",
      "Git 설치",
      "Git 사용자 정보 설정",
      "Node.js LTS 설치",
      `${tool === "codex" ? "Codex" : "Claude Code"} 설치`,
    ]);
  });

  it.each(["codex", "claude"] as const)("STEP 06 wording (%s) uses the natural phrasing", (tool) => {
    const guide = setupGuide(tool);
    const step06 = guide.find((step) => step.title === "STEP 06 · 데이터 저장 방식");
    expect(step06?.purpose).toBe("기존 데이터는 유지하고, 필요한 저장 방식만 선택해 연결하세요.");
    expect(step06?.sections.map((section) => section.title)).toContain("필요한 저장 방식만 선택하세요");
    expect(JSON.stringify(guide)).not.toContain("필요한 저장만 선택");
    expect(JSON.stringify(guide)).not.toContain("기존 데이터를 보호하고 꼭 필요한 서비스만 선택·연결");
  });

  it("learn mistakes card drops the prefix and uses the natural lead-in", () => {
    const src = read("../src/components/learn/LearnLesson.tsx");
    expect(src).toContain("<strong>이렇게 이해하세요:</strong>");
    expect(src).not.toContain("실수: {m.mistake}");
    expect(src).not.toContain("올바른 방법:");
    expect(src).toContain("learn-card-danger");
    expect(src).toContain("learn-mistake-grid");
  });

  it("learn mistakes section uses calm amber tones, not the old light red", () => {
    const css = read("../src/components/learn/learn.css");
    expect(css).toContain(".learn-card-danger { background: #fff0d9; border-color: #e8cfab; }");
    expect(css).toContain(".learn-card-danger .learn-card-title svg { color: #b45309; }");
    expect(css).toContain(".learn-mistake-title { font-weight: 700; color: #78350f; }");
    expect(css).not.toContain("#fdedf0");
    expect(css).not.toContain("#f3d9de");
    expect(css).not.toContain("#7f1d1d");
    expect(css).not.toContain("#dc2626");
  });

  it("diagnosis next action is a COSS outline button, not an underlined link", () => {
    const view = read("../src/components/ax/AxDiagnosisView.tsx");
    const css = read("../src/components/ax/ax.css");
    expect(view).toContain('<Button type="button" variant="outline" size="sm" onClick={() => scrollToSummaryTarget(action.target!)}>');
    expect(view).not.toContain("ax-summary-action");
    expect(css).not.toContain("ax-summary-action");
  });
});
