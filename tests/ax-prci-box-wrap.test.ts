import { describe, expect, it } from "vitest";
import { guideCodeDisplayText, guideProseDisplayText, setupGuide, type AxGuideBlock } from "../src/lib/ax/guide";

type CodeBlock = Extract<AxGuideBlock, { kind: "code" }>;

function codeBlocks(stepIndex: number, sectionTitle: string): CodeBlock[] {
  const step = setupGuide("codex")[stepIndex];
  const section = step.sections.find(item => item.title === sectionTitle);
  expect(section).toBeDefined();
  return section!.blocks.filter((block): block is CodeBlock => block.kind === "code");
}

function allCodeBlocks(tool: "codex" | "claude"): { step: string; section: string; block: CodeBlock }[] {
  const out: { step: string; section: string; block: CodeBlock }[] = [];
  for (const step of setupGuide(tool)) {
    for (const section of step.sections) {
      for (const block of section.blocks) {
        if (block.kind === "code") out.push({ step: step.title, section: section.title, block });
      }
    }
  }
  return out;
}

describe("guide prose display text", () => {
  it("joins sentences with a single space and drops blank lines", () => {
    expect(guideProseDisplayText(["첫 문장.", "", "둘째 문장.", "", "", "셋째 문장."])).toBe(
      "첫 문장. 둘째 문장. 셋째 문장.",
    );
    expect(guideProseDisplayText(["  앞 문장.  ", "뒷 문장."])).toBe("앞 문장. 뒷 문장.");
    expect(guideProseDisplayText([])).toBe("");
    expect(guideProseDisplayText(["", "   "])).toBe("");
  });

  it("marks only the STEP 07 PR·CI request block as prose", () => {
    for (const tool of ["codex", "claude"] as const) {
      const prose = allCodeBlocks(tool).filter(entry => entry.block.prose);
      expect(prose).toHaveLength(1);
      expect(prose[0].step).toContain("STEP 07");
      expect(prose[0].section).toBe("PR·CI 및 배포 확인");
    }
  });

  it("displays the STEP 07 PR·CI request continuously with no forced line breaks", () => {
    const [block] = codeBlocks(7, "PR·CI 및 배포 확인");
    expect(block.prose).toBe(true);
    const display = guideProseDisplayText(block.lines);
    expect(display).not.toContain("\n");
    // Every sentence boundary is a space join, never a line break.
    for (const boundary of [
      "먼저 확인해 줘. Vercel 또는",
      "우선 유지해 줘. GitHub 연동",
      "검증해 줘. CLI 직접",
      "하지 마. 배포 전",
      "요청해 줘. 기존 데이터와",
      "진행해 줘. 완료 후",
      "보고해 줘. 배포가 실행되지",
    ]) expect(display).toContain(boundary);
    // No sentence is lost or reordered by the display transform.
    expect(display).toBe(block.lines.filter(line => line.trim() !== "").join(" "));
  });

  it("keeps the STEP 07 PR·CI copy text exactly equal to the original lines", () => {
    const [block] = codeBlocks(7, "PR·CI 및 배포 확인");
    expect(block.lines).toHaveLength(15);
    expect(block.lines.filter(line => line === "")).toHaveLength(7);
    // The renderer copies lines.join("\n") unchanged; the display transform must not feed back into it.
    expect(block.lines.join("\n")).toContain("\n\n");
    expect(block.lines.join("\n")).toContain("현재 프로젝트의 구조, GitHub 연결 상태, 배포 서비스 및 기존 배포 설정을 먼저 확인해 줘.");
    expect(block.lines.join("\n")).toContain("배포가 실행되지 않았거나 실제 반영 여부를 확인하지 못했다면 완료로 표시하지 마.");
  });

  it("keeps every command block out of the prose transform, with line breaks preserved", () => {
    // STEP 07's own executable list: each command stays on its own line.
    const [saveBlock] = codeBlocks(7, "안전하게 Git에 저장");
    expect(saveBlock.prose).toBeFalsy();
    expect(guideCodeDisplayText(saveBlock.lines)).toBe(
      ["git status", "git add .", "git diff --cached", 'git commit -m "변경 사항 반영"', "git push"].join("\n"),
    );
    // No non-prose block anywhere in the guide is joined by the prose transform.
    for (const tool of ["codex", "claude"] as const) {
      for (const { block } of allCodeBlocks(tool)) {
        if (!block.prose) expect(guideCodeDisplayText(block.lines)).toBe(block.lines.join("\n").replace(/\n{2,}/gu, "\n"));
      }
    }
  });

  it("leaves the STEP 08 verification request unchanged", () => {
    const [block] = codeBlocks(8, "AI 코딩 에이전트에게 기능 검증 요청");
    expect(block.prose).toBeFalsy();
    expect(block.lines).toHaveLength(1);
    expect(guideCodeDisplayText(block.lines)).toBe(block.lines[0]);
    expect(guideProseDisplayText(block.lines)).toBe(block.lines[0]);
  });
});
