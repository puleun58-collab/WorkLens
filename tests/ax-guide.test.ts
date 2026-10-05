import { describe, expect, it } from "vitest";
import { buildAllInOnePrompt, environmentGuide, installGuide, projectPrepGuide, resolveDeploymentGuide, TOOL_GUIDES } from "../src/lib/ax/guide";
import { planFixture } from "./fixtures/ax";

describe("AX execution guides", () => {
  it("keeps tool commands distinct and guides scoped to the selected tool", () => {
    for (const key of ["installCommand", "versionCommand", "runCommand", "doctorCommand"] as const) {
      expect(TOOL_GUIDES.codex[key]).toBeTruthy();
      expect(TOOL_GUIDES.claude[key]).toBeTruthy();
      expect(TOOL_GUIDES.codex[key]).not.toBe(TOOL_GUIDES.claude[key]);
    }
    for (const tool of ["codex", "claude"] as const) {
      const other = tool === "codex" ? "claude" : "codex";
      expect(environmentGuide(tool).join("\n")).not.toContain(TOOL_GUIDES[other].installCommand);
      expect(installGuide(tool).join("\n")).toContain(TOOL_GUIDES[tool].installCommand);
      expect(environmentGuide(tool).join("\n")).toContain(TOOL_GUIDES[tool].versionCommand);
    }
  });
  it("builds deterministic, complete AI instructions and deduplicates prerequisites", () => {
    const options = { taskName: "월간 취합", prerequisites: [planFixture.prerequisites[0], "권한 확인", "권한 확인"] };
    const prompt = buildAllInOnePrompt(planFixture, "codex", options);
    for (const title of ["작업 목표", "현재 상태 (AS-IS)", "목표 상태 (TO-BE)", "작업 범위", "제외 범위", "구현 전 확인사항", "승인·검토 필요 단계", "사전 검증(PoC)", "구현 순서", "데이터 흐름", "외부 연동", "예외 처리", "문제 발생 시 대응", "운영·수동 처리 전환", "보안", "테스트", "완료 조건", "Repository-first 원칙", "작업 진행·완료 절차"]) {
      expect(prompt).toContain(`## ${title}\n`);
    }
    expect(prompt).toContain("검토용 표 생성");
    expect(prompt.match(/^- 실제 저장소와 API 확인$/gm)).toHaveLength(1);
    expect(prompt.match(/^- 권한 확인$/gm)).toHaveLength(1);
    expect(prompt.indexOf("- 실제 저장소와 API 확인")).toBeLessThan(prompt.indexOf("- 권한 확인"));
    expect(prompt).toContain("git status"); expect(prompt).toContain("git diff");
    expect(prompt).not.toContain("git push --force");
    expect(prompt).toContain("force push, 확인 없는 main 직접 push, 전체 파일 일괄 add는 금지");
    expect(prompt).toContain("vercel.json·wrangler 설정");
    expect(prompt).toContain("임의로 플랫폼을 고르지 말고 확인 필요로 보고");
    expect(prompt).toContain("다음 지시를 현재 프로젝트 저장소에서 수행하세요.");
    expect(prompt).toBe(buildAllInOnePrompt(planFixture, "codex", options));
    expect(buildAllInOnePrompt(planFixture, "claude")).toContain("# 업무 자동화 구현 지시문 (Claude Code용)");
  });
  it("omits empty list sections and preserves fixed completion rules", () => {
    const prompt = buildAllInOnePrompt({ ...planFixture, integrations: [], exceptions: [], prerequisites: [] }, "codex");
    expect(prompt).not.toContain("## 외부 연동"); expect(prompt).not.toContain("## 예외 처리");
    expect(prompt).not.toContain("## 구현 전 확인사항"); expect(prompt).not.toContain("해당 없음");
    expect(prompt).toContain("## Repository-first 원칙"); expect(prompt).toContain("## 작업 진행·완료 절차");
  });
  it.each([
    [{ ci: true, vercel: true, cloudflare: true, manualScript: true }, "ci"],
    [{ vercel: true, cloudflare: true }, "vercel"], [{ cloudflare: true, manualScript: true }, "cloudflare"],
    [{ manualScript: true }, "manual"], [{}, "unknown"], [{ webDeploy: false, vercel: true }, "none"],
  ] as const)("resolves verified deployment signals %j to %s", (signals, kind) => {
    const result = resolveDeploymentGuide(signals);
    expect(result.kind).toBe(kind);
    expect(result.steps.join("\n")).toContain("확인된 방식만");
    expect(result.steps.join("\n")).toContain("CLI를 임의로 설치하지 않습니다");
    if (kind === "unknown") expect(result.steps).toContain("배포 방식 확인 필요");
  });
  it("distinguishes repository preparation cases without choosing a framework", () => {
    const { cases } = projectPrepGuide();
    expect(cases.map(c => c.id)).toEqual(["github", "local", "new"]);
    expect(cases[0].steps.join("\n")).toContain("git clone");
    expect(cases[1].steps.join("\n")).not.toContain("git clone");
    expect(cases[2].steps.join("\n")).not.toContain("Next.js로 생성");
    expect(cases[2].steps.join("\n")).toContain("특정 프레임워크를 임의로 정하지 않습니다");
    for (const item of cases) expect(item.steps.join("\n")).toContain("Get-Location");
  });
});
