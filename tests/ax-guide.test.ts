import { describe, expect, it } from "vitest";
import { buildAllInOnePrompt, guardPlan, planSummary, setupGuide, TOOL_GUIDES, type AxGuideSection } from "../src/lib/ax/guide";
import { FACTOR_LABELS } from "../src/lib/ax/schema";
import { diagnosisFixture, planFixture } from "./fixtures/ax";
import type { AxDiagnosis, AxPlan } from "../src/lib/ax/types";

const withFactors = (values: [number, number, number, number, number, number], patch: Partial<AxDiagnosis> = {}): AxDiagnosis => ({
  ...diagnosisFixture, ...patch, factors: diagnosisFixture.factors.map((factor, i) => ({ ...factor, aiValue: values[i] })),
});
// Level 1 · AI 보조: value 4, feasibility 3, judgment 4, risk 3; conditional gate from the fixture's unconfirmed check.
const levelOne = withFactors([4, 4, 3, 2, 4, 3]);
const freightPlan: AxPlan = {
  ...planFixture,
  goal: ["월간 운임 정산을 자동 파싱·계산·보고 단계로 전환", "작업 시간 50% 절감"],
  implementation: ["파싱·형식 검증", "키 매핑·금액 계산", "누락·중복 보고"],
  exceptions: ["중복 데이터 발견 시 자동 제거 후 재계산", "운임표 미매칭"],
  operation: ["재무팀이 주관, 오류 시 시스템 운영팀이 대응"],
  acceptance: ["자동 결과와 수동 결과 차이 0% 목표", "샘플 정산표 대조 통과"],
  tests: ["정확도 95% 이상", "샘플 정산표 대조"],
};

describe("AX execution guides", () => {
  it.each([
    ["월간 정산", "월간 정산 자동화"],
    ["월간 정산 자동화", "월간 정산 자동화"],
    ["  월간 정산 자동화  ", "월간 정산 자동화"],
    [undefined, "업무 자동화"],
    ["", "업무 자동화"],
    ["   ", "업무 자동화"],
  ])("normalizes the prompt title for %s", (taskName, normalized) => {
    const prompt = buildAllInOnePrompt(planFixture, "codex", { taskName });
    expect(prompt.split("\n")[0]).toBe(`# ${normalized} 구현 지시문`);
    expect(prompt).not.toContain("자동화 자동화");
  });
  it("uses the 담당자 label without changing the factor key", () => {
    expect(FACTOR_LABELS.humanJudgment).toBe("담당자 판단 필요도");
  });
  it("keeps tool commands distinct and guides scoped to the selected tool", () => {
    for (const key of ["installCommand", "versionCommand", "runCommand", "doctorCommand"] as const) {
      expect(TOOL_GUIDES.codex[key]).toBeTruthy();
      expect(TOOL_GUIDES.claude[key]).toBeTruthy();
      expect(TOOL_GUIDES.codex[key]).not.toBe(TOOL_GUIDES.claude[key]);
    }
    const sectionText = (section: AxGuideSection) => [section.when ?? "", ...section.blocks.map(block => block.kind === "text" ? block.text : block.kind === "code" ? block.lines.join("\n") : block.items.join("\n"))].join("\n");
    for (const tool of ["codex", "claude"] as const) {
      const other = tool === "codex" ? "claude" : "codex";
      const guide = setupGuide(tool);
      const all = guide.flatMap(step => step.sections.map(sectionText)).join("\n");
      for (const command of ["installCommand", "doctorCommand", "versionCommand"] as const) {
        expect(all).toContain(TOOL_GUIDES[tool][command]);
        expect(all).not.toContain(TOOL_GUIDES[other][command]);
      }
      const installs = guide[1].sections.slice(1);
      for (const install of installs) expect(install.when).toMatch(/에만|때만/);
      expect(guide[2]).toEqual(setupGuide(other)[2]);
      for (const index of [5, 6, 7, 8, 9]) expect(guide[index]).toEqual(setupGuide(other)[index]);
    }
  });
  it.each(["codex", "claude"] as const)("labels file examples and preserves default command labels for %s", tool => {
    const blocks = setupGuide(tool).flatMap(step => step.sections.flatMap(section => section.blocks));
    const codeBlocks = blocks.filter(block => block.kind === "code");
    const gitignore = codeBlocks.find(block => block.lines.includes("node_modules/"));
    expect(gitignore?.label).toBe(".gitignore");
    expect(gitignore?.notes?.join("\n")).toContain("제외");
    for (const block of codeBlocks.filter(block => block !== gitignore)) {
      expect(block.label).toBeUndefined();
      expect(block.label ?? "PowerShell").toBe("PowerShell");
    }
  });
  it.each(["codex", "claude"] as const)("covers repository, dependency, Secret and deployment safeguards for %s", tool => {
    const guide = setupGuide(tool);
    const all = JSON.stringify(guide);
    for (const command of ["git remote -v", "git diff --cached --stat", "git diff --cached"]) expect(all).toContain(command);
    const project = JSON.stringify(guide[2]);
    expect(project).toMatch(/미커밋 변경[^.]*git pull[^.]*실행하지/u);
    expect(project).toMatch(/AI 도구[^.]*현재 상태[^.]*확인/u);
    const dependencies = guide[2].sections.find(section => section.title === "의존성 준비")!;
    const dependencyText = JSON.stringify(dependencies);
    expect(dependencyText).toMatch(/lockfile[^.]*package manager[^.]*바꾸지/u);
    expect(dependencyText).toMatch(/다른 매니저[^.]*lockfile[^.]*새로 만들거나[^.]*lockfile[^.]*교체하지/u);
    const newProject = JSON.stringify(guide[2].sections.find(section => section.title.startsWith("C.")));
    expect(newProject).toMatch(/Git 저장 전[^.]*Git 저장소인지[^.]*원격[^.]*GitHub 저장소인지[^.]*확인/u);
    expect(newProject).toMatch(/Git 저장소가 아닌 경우에만[^.]*초기화/u);
    expect(newProject).toMatch(/기존 저장소[^.]*재초기화[^.]*remote[^.]*덮어쓰지/u);
    expect(newProject).toMatch(/branch 이름[^.]*main[^.]*강제하지/u);
    expect(newProject).toMatch(/첫 push 전[^.]*git remote -v[^.]*다시 확인/u);
    const secrets = JSON.stringify(guide[6]);
    expect(secrets).toMatch(/AI 대화·터미널 로그·스크린샷[^.]*붙여넣지/u);
    expect(secrets).toMatch(/폐기.*재발급.*플랫폼 설정 교체/u);
    expect(secrets).toMatch(/기록 재작성[^.]*자동 실행하지/u);
    for (const index of [5, 6, 9]) {
      const step = JSON.stringify(guide[index]);
      for (const term of ["API Key", "Token", "Password", "개인정보", "[REDACTED]", "AI 도구"]) expect(step).toContain(term);
      expect(step).toMatch(/필요한[^.]*전달/u);
      expect(step).toMatch(/로그 전체[^.]*무조건 복사하지/u);
    }
    const deployment = JSON.stringify(guide[8]);
    expect(deployment).toMatch(/모두 사용해야[^.]*아닙니다/u);
    expect(deployment).toMatch(/두 플랫폼[^.]*함께/u);
    expect(deployment).toMatch(/어떤 서비스[^.]*플랫폼[^.]*branch[^.]*방식[^.]*확인/u);
    expect(deployment).toMatch(/Preview 확인[^.]*Production[^.]*완료[^.]*아닙니다/u);
    expect(deployment).toMatch(/자동 배포[^.]*수동 명령[^.]*중복 실행하지/u);
    expect(JSON.stringify(guide[9])).toMatch(/로그인·환경변수·API[^.]*실제 Production 환경[^.]*확인/u);
    for (const command of ["git reset --hard", "git clean -fd", "git push --force", "git branch -D", "git remote remove", "git rm --cached -r ."]) expect(all).not.toContain(command);
  });
  it("guards forbidden AI statements and is idempotent", () => {
    const plan: AxPlan = { ...planFixture,
      implementation: ["중복 데이터는 자동 삭제한다.", "내부 API를 호출해 자동 등록한다.", "사내 시스템 API로 업로드한다.", "형식 검증 결과를 표시한다."],
      goal: ["업무 시간을 50% 절감한다.", "검토용 정산표를 만든다."], acceptance: ["정확도 95%를 달성한다.", "샘플 대조 통과"],
      humanInLoop: ["재무팀이 최종 승인한다."], outOfScope: ["자동 승인", "ERP 자동 전송"], prerequisites: ["ERP API 존재 여부 확인"] };
    const once = guardPlan(plan, "매월 정산표를 만들어 담당자가 승인합니다.");
    expect(once.goal).toEqual(["검토용 정산표를 만든다."]);
    expect(once.acceptance).toEqual(["샘플 대조 통과"]);
    expect(once.implementation).toEqual([
      "중복 데이터는 자동 삭제한다. (확인 필요: 업무 규칙에서 확인된 경우에만 적용하고, 아니면 대상 건을 표시만 하세요)",
      "내부 API를 호출해 자동 등록한다. (확인 필요: 업무 규칙에서 확인된 경우에만 적용하고, 아니면 대상 건을 표시만 하세요)",
      "사내 시스템 API로 업로드한다. (확인 필요: 실제 연동 방식과 권한을 확인한 뒤 확인된 방식만 사용하세요)",
      "형식 검증 결과를 표시한다.",
    ]);
    expect(once.humanInLoop).toEqual(["담당 조직이 최종 승인한다. (확인 필요: 실제 담당 조직을 확인하세요)"]);
    expect(once.outOfScope).toEqual(["자동 승인", "ERP 자동 전송"]);
    expect(once.prerequisites).toEqual(["ERP API 존재 여부 확인"]);
    expect(guardPlan(once, "매월 정산표를 만들어 담당자가 승인합니다.")).toEqual(once);
    const prompt = buildAllInOnePrompt(plan, "codex", { diagnosis: levelOne });
    expect(buildAllInOnePrompt(once, "codex", { diagnosis: levelOne })).toBe(prompt);
    expect(guardPlan(planFixture, "")).toEqual(planFixture);
    const allowed = guardPlan({ ...planFixture, implementation: ["중복 건은 자동 삭제한다."] }, "규정상 중복 건은 자동 삭제합니다.");
    expect(allowed.implementation).toEqual(["중복 건은 자동 삭제한다."]);
  });
  it("distinguishes repository preparation cases without choosing a framework", () => {
    const sections = setupGuide("codex")[2].sections.filter(section => /^[ABC]\. /.test(section.title));
    expect(sections.map(section => section.title)).toEqual(["A. GitHub에 있는 기존 프로젝트", "B. PC에 이미 있는 프로젝트", "C. 새 프로젝트"]);
    for (const section of sections) expect(section.when).toBeTruthy();
    const commands = sections.map(section => section.blocks.flatMap(block => block.kind === "code" ? block.lines : []));
    expect(commands[0]).toContain("git clone <저장소 URL>");
    expect(commands[1].join("\n")).not.toContain("git clone");
    expect(commands[2].join("\n")).not.toContain("git clone");
    const newProject = sections[2].blocks.map(block => block.kind === "text" ? block.text : "").join("\n");
    expect(newProject).toContain("특정 프레임워크를 임의로 정하지 않습니다");
    const existingProject = sections[1].blocks.map(block => block.kind === "text" ? block.text : "").join("\n");
    expect(existingProject).toMatch(/미커밋 변경[^.]*git pull[^.]*실행하지/u);
  });
});

describe("AX plan display boundaries", () => {
  it.each([
    [0, [3, 2, 2, 2, 5, 4]],
    [1, [4, 4, 3, 2, 4, 3]],
    [2, [4, 4, 4, 3, 3, 3]],
    [3, [5, 5, 5, 5, 1, 1]],
  ] as const)("constrains the Level %s summary across all execution gates", (level, factors) => {
    for (const verdict of ["go", "conditional", "no-go"] as const) {
      const diagnosis = withFactors([...factors], {
        decisionGate: { verdict, reasons: verdict === "go" ? [] : ["권한 확인"] }, technicalChecks: [],
        roadmap: [{ phase: "1", title: "진단의 무제한 자동화", items: ["전체 자동 승인"] }],
        poc: { ...diagnosisFixture.poc, inScope: ["전체 자동 승인"] },
      });
      const summary = planSummary(diagnosis);
      expect(summary.include).not.toContain("전체 자동 승인");
      expect(summary.humanKept).toContain("담당자 승인 (담당자 수행)");
      expect(summary.excluded).not.toContain("담당자 승인 자동화 (담당자 수행)");
      const scopeLevel = verdict === "no-go" ? 0 : level;
      if (level === 0 || verdict === "no-go") {
        expect(summary.include).toContain("자료 수집 처리 가능성 검증");
        expect(summary.include.join("\n")).not.toMatch(/규칙 기반 처리|자동 처리|결과\(후보·초안\) 생성/u);
        expect(summary.excluded).toContain("운영 자동화 적용");
      } else if (level === 1) {
        expect(summary.include).toContain("형식 검증 AI 보조 결과(후보·초안) 생성");
        expect(summary.include.join("\n")).not.toMatch(/규칙 기반 처리|자동 처리/u);
        expect(summary.excluded).toContain("운영 자동화 적용");
      } else {
        expect(summary.include).toContain(level === 2 ? "자료 수집 규칙 기반 처리" : "자료 수집 자동 처리");
      }
      // Diagnosed steps outside the permitted Level × Gate scope are listed as current exclusions.
      expect(summary.excluded.includes("자료 수집 자동 실행")).toBe(scopeLevel < 2);
      expect(summary.excluded.includes("형식 검증 AI 보조 구현")).toBe(scopeLevel < 1);
      if (verdict !== "go") expect(summary.prerequisites).toContain("권한 확인");
      else expect(summary.prerequisites).toEqual([]);
    }
  });

  it("builds the summary from the diagnosis only and never mutates it", () => {
    const diagnosis: AxDiagnosis = {
      ...levelOne,
      asIs: { ...levelOne.asIs, exceptions: ["누락", "1) 누락"], systems: ["표 도구"] },
      risks: ["누락", "누락 데이터"],
      humanInLoop: ["담당자 승인", "최종 승인"],
      poc: { ...levelOne.poc, evaluation: ["샘플 대조", " - 샘플 대조"], success: ["샘플 대조 통과"], failure: ["누락 발생"] },
    };
    const before = structuredClone(diagnosis), summary = planSummary(diagnosis);
    expect(summary.humanKept).toEqual(["담당자 승인 (담당자 수행)", "최종 승인"]);
    expect(summary.exceptions).toEqual(["누락", "누락 데이터"]);
    expect(summary.data).toEqual([
      { label: "입력", items: ["입력 표"] }, { label: "출력", items: ["검토용 표"] }, { label: "사용 시스템", items: ["표 도구"] },
      { label: "검증용 입력", items: ["샘플 표"] },
    ]);
    expect(summary.tests).toEqual(["샘플 대조"]);
    expect(summary.acceptance).toEqual(["성공: 샘플 대조 통과", "실패: 누락 발생"]);
    // Confirmed checks are not open conditions.
    expect(planSummary({ ...diagnosis, technicalChecks: [{ topic: "샘플 파일", status: "확인됨", note: "헤더 확인" }, ...diagnosis.technicalChecks] }).prerequisites.join("\n")).not.toContain("샘플 파일");
    expect(planSummary({ ...diagnosis, planCodex: freightPlan, planClaude: planFixture })).toEqual(summary);
    expect(planSummary(diagnosis)).toEqual(summary);
    expect(diagnosis).toEqual(before);
  });

  it.each(["conditional", "no-go"] as const)("adds only a generated plan's own prerequisites for a %s gate", verdict => {
    const diagnosis: AxDiagnosis = { ...levelOne, decisionGate: { verdict, reasons: ["접근 권한 확인"] }, technicalChecks: [], humanInLoop: ["최종 승인"] };
    const plan: AxPlan = {
      ...freightPlan,
      prerequisites: ["접근 권한 확인", "샘플 보관 위치 확인"],
      inScope: ["원본 읽기", "운임 계산"], humanInLoop: ["최종 승인 후 전송"], outOfScope: ["승인 없이 외부 전송"],
      poc: ["원본 샘플 보관"], tests: ["결과 파일 재열기"], acceptance: ["담당자 확인 기록 완료"], exceptions: ["운임표 미매칭"],
    };
    const before = structuredClone({ diagnosis, plan });
    const base = planSummary(diagnosis), withPlan = planSummary(diagnosis, plan, "월간 운임 정산");
    expect(withPlan).toEqual({ ...base, prerequisites: verdict === "no-go" ? base.prerequisites : [...base.prerequisites, "샘플 보관 위치 확인"] });
    expect(JSON.stringify(withPlan)).not.toMatch(/원본 읽기|운임 계산|최종 승인 후 전송|승인 없이 외부 전송|원본 샘플 보관|결과 파일 재열기|담당자 확인 기록 완료|운임표 미매칭/u);
    expect({ diagnosis, plan }).toEqual(before);
  });
});
