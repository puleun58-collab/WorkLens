import { describe, expect, it } from "vitest";
import { buildAllInOnePrompt, environmentGuide, installGuide, projectPrepGuide, TOOL_GUIDES } from "../src/lib/ax/guide";
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
  it("builds numbered professional instructions in order with task-specific requirements", () => {
    const prompt = buildAllInOnePrompt(planFixture, "codex", { taskName: "월간 취합" });
    expect(prompt).toMatch(/^# 월간 취합 자동화 구현 지시문\n/);
    expect(prompt.match(/^## \d+\. .+$/gm)).toEqual([
      "## 1. 작업 목표", "## 2. 작업 전 현재 프로젝트 확인", "## 3. 현재 업무 상태 (AS-IS)",
      "## 4. 목표 상태 (TO-BE)", "## 5. 작업 범위", "## 6. 구현 전 확인사항", "## 7. 구현 원칙",
      "## 8. 세부 구현 요구사항", "## 9. 데이터 흐름", "## 10. 외부 시스템·연동",
      "## 11. 승인·검토가 필요한 단계", "## 12. 예외 처리", "## 13. 문제 발생 시 대응",
      "## 14. 보안", "## 15. 테스트 및 검증", "## 16. GitHub 반영", "## 17. 배포",
      "## 18. 배포 후 검증", "## 19. 완료 조건", "## 20. 작업 완료 보고",
    ]);
    const section = (number: number) => prompt.split(`## ${number}. `)[1].split(/\n## \d+\. /)[0];
    for (const [number, items] of [
      [1, planFixture.goal], [3, planFixture.asIs], [4, planFixture.toBe], [6, planFixture.prerequisites],
      [9, planFixture.dataFlow], [10, planFixture.integrations], [11, planFixture.humanInLoop],
      [12, planFixture.exceptions], [14, planFixture.security], [19, planFixture.acceptance],
    ] as const) {
      for (const item of items) expect(section(number)).toContain(`- ${item}`);
    }
    expect(section(1)).not.toContain(planFixture.toBe[0]);
    expect(section(5)).toContain("### 포함\n\n- 취합");
    expect(section(5)).toContain("### 제외\n\n- 자동 승인");
    expect(section(5)).toContain("제외 범위의 기능은 요청 없이 확장하지 마세요.");
    expect(section(7)).toContain(`- ${planFixture.repositoryFirst}\n- 현재 프로젝트 구조를 먼저 확인하세요.`);
    expect(section(8)).toContain("1. 저장소 확인\n2. 샘플 실험\n3. 검증 후 구현");
    expect(section(13)).toContain("### 자동화 실패 시\n\n- 수동 취합");
    expect(section(13)).toContain("### 운영·수동 처리\n\n- 담당자 지정");
    expect(section(13)).toContain("자동화가 실패하면 기존 수동 업무 방식으로 안전하게 처리할 수 있어야 합니다.");
    expect(section(15)).toContain("### 정상 케이스\n\n- 샘플 대조");
    expect(section(15)).toContain("### 예외 케이스\n\n12번 예외 처리의 각 상황을 재현해 정상적으로 처리되는지 확인하세요.");
    expect(section(15)).toContain("### 사전 검증\n\n- 샘플 대조");
    expect(section(19).indexOf("- 대조 통과")).toBeLessThan(section(19).indexOf("- 요청한 기능이 정상 작동합니다."));
    expect(section(20)).toContain("13. 미실행 항목");
  });
  it("includes repository, security, validation and safe GitHub/deployment rules", () => {
    const prompt = buildAllInOnePrompt(planFixture, "codex");
    for (const text of [
      "작업을 시작하기 전에 현재 저장소를 먼저 확인하세요.",
      "확인되지 않은 파일명·함수명·API를 추측하지 마세요.",
      "기존 구현을 우선 재사용하세요. 기존 컴포넌트·함수가 있으면 새로 만들기 전에 재사용을 검토하세요.",
      "현재 저장소에 실제로 존재하는 테스트 명령을 확인한 뒤 실행하세요. 존재하지 않는 test script를 추측하지 마세요.",
      "실제로 수행하지 않은 작업을 완료했다고 보고하지 마세요.",
      "확인되지 않은 API나 권한이 있다고 가정해 구현하지 마세요.",
      "secret을 코드에 하드코딩하지 마세요. 기존 환경변수 등 저장소의 secret 관리 방식을 사용하세요.",
      "민감한 데이터를 불필요하게 로그에 남기지 마세요.",
      "기존 접근 권한 정책을 유지하세요.",
      "도구가 있으면 기존 흐름으로 주요 화면을 Desktop과 Mobile에서 확인하세요.",
      "도구가 없으면 새로 설치하지 말고 그 사실을 보고하세요.",
      "### 회귀 검증\n\n이 작업과 관련된 기존 기능이 이전과 동일하게 동작하는지 확인하세요.",
      "필요한 파일만 골라 `git add <파일>`로 stage하세요.",
      "`git add .`로 전체 파일을 한 번에 추가하지 마세요.",
      "확인 없이 main branch에 직접 push하지 마세요.",
      "force push를 사용하지 마세요.",
      "저장소 정책을 확인하지 않고 branch를 삭제하지 마세요.",
      "`git reset --hard` 같은 파괴적인 명령을 기본 흐름에 넣지 마세요.",
      "Vercel과 Cloudflare 중 하나를 임의로 선택하거나 새 배포 도구를 설치하지 마세요.",
      "배포 방식을 확인할 수 없으면 임의로 진행하지 말고 '배포 방식 확인 필요'로 보고하세요.",
      "wrangler.toml·wrangler.json·wrangler.jsonc",
      "웹 배포가 필요 없는 자동화(CLI, 스크립트, Excel 자동화, 로컬 실행형 등)이면 배포 대신 실행 환경 구성 또는 운영 적용으로 처리하세요.",
      "문제가 발견되면 수정 → 재배포 → 동일 시나리오 재검증 순서로 진행하세요.",
      "실행하지 않은 검증은 완료로 보고하지 말고 미실행으로 명시합니다.",
    ]) expect(prompt).toContain(text);
  });
  it("deduplicates plan and diagnostic prerequisites while preserving their order", () => {
    const options = { taskName: "월간 취합", prerequisites: [planFixture.prerequisites[0], "권한 확인", "권한 확인", "승인자 확인"] };
    const prompt = buildAllInOnePrompt(planFixture, "codex", options);
    expect(prompt.match(/^- 실제 저장소와 API 확인$/gm)).toHaveLength(1);
    expect(prompt.match(/^- 권한 확인$/gm)).toHaveLength(1);
    expect(prompt).toContain("- 실제 저장소와 API 확인\n- 권한 확인\n- 승인자 확인");
    const onlyDiagnostic = buildAllInOnePrompt({ ...planFixture, prerequisites: [] }, "codex", { prerequisites: ["진단 조건 확인"] });
    expect(onlyDiagnostic).toContain("## 6. 구현 전 확인사항\n\n- 진단 조건 확인");
  });
  it("is deterministic and varies only the tool name between Codex and Claude Code", () => {
    const options = { taskName: "월간 취합", prerequisites: ["권한 확인"] };
    const codex = buildAllInOnePrompt(planFixture, "codex", options);
    expect(codex).toBe(buildAllInOnePrompt(planFixture, "codex", options));
    const claude = buildAllInOnePrompt(planFixture, "claude", options);
    expect(claude).toContain("현재 프로젝트 저장소에서 Claude Code으로 수행하세요.");
    expect(claude.replace("Claude Code", "Codex")).toBe(codex);
    expect(buildAllInOnePrompt(planFixture, "codex")).toMatch(/^# 업무 자동화 자동화 구현 지시문\n/);
  });
  it("omits every empty task-specific section without renumbering common sections", () => {
    const prompt = buildAllInOnePrompt({
      repositoryFirst: planFixture.repositoryFirst, goal: [], asIs: [], toBe: [], inScope: [], outOfScope: [], prerequisites: [],
      humanInLoop: [], poc: [], implementation: [], dataFlow: [], integrations: [], exceptions: [],
      fallback: [], security: [], operation: [], tests: [], acceptance: [],
    }, "codex");
    expect(prompt.match(/^## \d+\. .+$/gm)).toEqual([
      "## 2. 작업 전 현재 프로젝트 확인", "## 7. 구현 원칙", "## 15. 테스트 및 검증",
      "## 16. GitHub 반영", "## 17. 배포", "## 18. 배포 후 검증", "## 19. 완료 조건", "## 20. 작업 완료 보고",
    ]);
    for (const text of ["## 10.", "해당 없음", "### 정상 케이스", "### 예외 케이스", "### 사전 검증"]) expect(prompt).not.toContain(text);
    expect(prompt).toContain(`## 7. 구현 원칙\n\n- ${planFixture.repositoryFirst}\n- 현재 프로젝트 구조를 먼저 확인하세요.`);
    expect(prompt).toContain("### 회귀 검증");
    expect(prompt).toContain("## 19. 완료 조건\n\n- 요청한 기능이 정상 작동합니다.");
  });
  it.each(["inScope", "outOfScope"] as const)("keeps scope with only %s populated", key => {
    const prompt = buildAllInOnePrompt({ ...planFixture, inScope: [], outOfScope: [], [key]: ["범위 항목"] }, "codex");
    expect(prompt).toContain("## 5. 작업 범위");
    expect(prompt).toContain(`### ${key === "inScope" ? "포함" : "제외"}\n\n- 범위 항목`);
    expect(prompt).not.toContain(`### ${key === "inScope" ? "제외" : "포함"}`);
  });
  it.each(["fallback", "operation"] as const)("keeps recovery with only %s populated", key => {
    const prompt = buildAllInOnePrompt({ ...planFixture, fallback: [], operation: [], [key]: ["복구 항목"] }, "codex");
    expect(prompt).toContain("## 13. 문제 발생 시 대응");
    expect(prompt).toContain(`### ${key === "fallback" ? "자동화 실패 시" : "운영·수동 처리"}\n\n- 복구 항목`);
    expect(prompt).not.toContain(`### ${key === "fallback" ? "운영·수동 처리" : "자동화 실패 시"}`);
    expect(prompt).toContain("자동화가 실패하면 기존 수동 업무 방식으로 안전하게 처리할 수 있어야 합니다.");
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
