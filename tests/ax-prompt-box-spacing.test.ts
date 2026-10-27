import { describe, expect, it } from "vitest";
import { guideCodeDisplayText, setupGuide, type AxGuideBlock } from "../src/lib/ax/guide";

function codeBlocks(stepIndex: number, sectionTitle: string): Extract<AxGuideBlock, { kind: "code" }>[] {
  const step = setupGuide("codex")[stepIndex];
  const section = step.sections.find(item => item.title === sectionTitle);
  expect(section).toBeDefined();
  return section!.blocks.filter((block): block is Extract<AxGuideBlock, { kind: "code" }> => block.kind === "code");
}

describe("guide code display text", () => {
  it("collapses repeated blank lines to a single line break", () => {
    expect(guideCodeDisplayText(["첫 문장.", "", "둘째 문장.", "", "", "셋째 문장."])).toBe(
      "첫 문장.\n둘째 문장.\n셋째 문장.",
    );
  });

  it("keeps single line breaks and content words unchanged", () => {
    expect(guideCodeDisplayText(["git status", "git add .", "git push"])).toBe("git status\ngit add .\ngit push");
    expect(guideCodeDisplayText(["단일 문단 요청문."])).toBe("단일 문단 요청문.");
    expect(guideCodeDisplayText([])).toBe("");
  });

  it("keeps the STEP 07 PR·CI request lines unchanged for copy while display has no blank lines", () => {
    const [block] = codeBlocks(7, "PR·CI 및 배포 확인");
    expect(block.lines).toHaveLength(15);
    expect(block.lines.filter(line => line === "")).toHaveLength(7);
    const display = guideCodeDisplayText(block.lines);
    expect(display).not.toContain("\n\n");
    expect(display.split("\n")).toHaveLength(8);
    expect(display).toContain("현재 프로젝트의 구조, GitHub 연결 상태, 배포 서비스 및 기존 배포 설정을 먼저 확인해 줘.");
    expect(display).toContain("배포가 실행되지 않았거나 실제 반영 여부를 확인하지 못했다면 완료로 표시하지 마.");
    // Copy text is the original join, blank separators included.
    expect(block.lines.join("\n")).toContain("\n\n");
  });

  it("keeps the STEP 08 verification request as a single dense paragraph", () => {
    const [block] = codeBlocks(8, "AI 코딩 에이전트에게 기능 검증 요청");
    expect(block.lines).toHaveLength(1);
    expect(guideCodeDisplayText(block.lines)).toBe(block.lines[0]);
    expect(guideCodeDisplayText(block.lines)).not.toContain("\n\n");
  });

  it("never shows a repeated blank line in any guide code block", () => {
    for (const tool of ["codex", "claude"] as const) {
      for (const step of setupGuide(tool)) {
        for (const section of step.sections) {
          for (const block of section.blocks) {
            if (block.kind === "code") expect(guideCodeDisplayText(block.lines)).not.toContain("\n\n");
          }
        }
      }
    }
  });
});
