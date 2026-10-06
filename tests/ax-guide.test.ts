import { describe, expect, it } from "vitest";
import { buildAllInOnePrompt, guardPlan, setupGuide, TOOL_GUIDES, type AxGuideSection } from "../src/lib/ax/guide";
import { FACTOR_LABELS } from "../src/lib/ax/schema";
import { diagnosisFixture, planFixture } from "./fixtures/ax";
import type { AxDiagnosis, AxPlan } from "../src/lib/ax/types";

const sectionsOf = (prompt: string) => prompt.match(/^## \d+\. .+$/gm)?.map(line => line.replace(/^## \d+\. /, "")) ?? [];
const sectionBody = (prompt: string, title: string) => prompt.split(new RegExp(`^## \\d+\\. ${title}$`, "m"))[1]?.split(/\n## \d+\. /)[0] ?? "";
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

function expectContinuousSections(prompt: string) {
  const numbers = [...prompt.matchAll(/^## (\d+)\./gm)].map(match => Number(match[1]));
  expect(numbers.length).toBeGreaterThan(0);
  expect(numbers).toEqual(numbers.map((_, index) => index + 1));
  expect(prompt).not.toMatch(/\d+번/);
}

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
      expect(guide.map(step => step.title)).toEqual([
        "시작하기 전에 · 전체 흐름", "STEP 1 · 처음 한 번 환경 준비", "STEP 2 · 프로젝트 준비",
        "STEP 3 · Codex / Claude Code 실행", "STEP 4 · 올인원 지시문으로 작업", "STEP 5 · AI 작업 결과 검증",
        "STEP 6 · .gitignore / Secret 확인 후 Git 저장", "STEP 7 · GitHub CI / PR 확인",
        "STEP 8 · 배포 (Vercel / Cloudflare)", "STEP 9 · Production 최종 확인",
      ]);
      const all = guide.flatMap(step => step.sections.map(sectionText)).join("\n");
      for (const command of ["installCommand", "doctorCommand", "versionCommand"] as const) {
        expect(all).toContain(TOOL_GUIDES[tool][command]);
        expect(all).not.toContain(TOOL_GUIDES[other][command]);
      }
      const [check, ...installs] = guide[1].sections;
      expect(check.title).toBe("필요한 프로그램 확인");
      expect(check.blocks).toContainEqual({
        kind: "code", lines: ["git --version", "node --version", "npm --version", TOOL_GUIDES[tool].versionCommand],
        notes: ["Git 설치 여부와 버전을 확인합니다.", "Node.js 설치 여부와 버전을 확인합니다.", "npm 설치 여부와 버전을 확인합니다.", `${TOOL_GUIDES[tool].name} 설치 여부와 버전을 확인합니다.`],
      });
      expect(sectionText(check)).toContain("해당 설치 단계를 건너뜁니다");
      for (const install of installs) expect(install.when).toMatch(/에만|때만/);
      const toolInstall = installs[3];
      expect(toolInstall.title).toBe(`${TOOL_GUIDES[tool].name} 설치`);
      expect(toolInstall.blocks[0]).toEqual({ kind: "code", lines: [TOOL_GUIDES[tool].installCommand], notes: [`${TOOL_GUIDES[tool].name}를 설치합니다.`] });
      expect(installs[4].title).toBe("GitHub 인증 확인");
      expect(installs[4].when).toBe("GitHub CLI(gh)가 설치된 경우에만");
      expect(installs[4].blocks).toContainEqual({ kind: "code", lines: ["gh auth status"], notes: ["GitHub CLI의 로그인 상태를 확인합니다."] });
      expect(guide[2]).toEqual(setupGuide(other)[2]);
      for (const index of [0, 5, 6, 7, 8, 9]) expect(guide[index]).toEqual(setupGuide(other)[index]);
    }
  });
  it.each(["codex", "claude"] as const)("explains every code line and covers the complete %s workflow", tool => {
    const guide = setupGuide(tool);
    const all = JSON.stringify(guide);
    for (const term of ["작업할 때마다", "Preview", "Production", "되돌리기(Rollback)"]) expect(all).toContain(term);
    for (const block of guide.flatMap(step => step.sections.flatMap(section => section.blocks))) {
      if (block.kind !== "code") continue;
      expect(block.notes).toHaveLength(block.lines.length);
      for (const note of block.notes!) expect(note.trim()).not.toBe("");
    }
    expect(guide[6].sections.map(section => section.title)).toEqual([
      ".gitignore란", "기존 .gitignore 확인", ".env와 .env.example", "이미 추적 중인 파일", "올리기 전 체크리스트", "Git 저장 순서",
    ]);
    const gitSave = guide[6].sections.at(-1)!;
    expect(gitSave.blocks.flatMap(block => block.kind === "code" ? block.lines : [])).toEqual([
      "git add .", "git status", "git branch --show-current", 'git commit -m "작업 내용 요약"', "git push",
    ]);
  });
  it("builds dynamic, consecutively numbered sections grounded in the diagnosis", () => {
    const prompt = buildAllInOnePrompt(planFixture, "codex", { taskName: "월간 취합", diagnosis: diagnosisFixture });
    expect(prompt).toMatch(/^# 월간 취합 자동화 구현 지시문\n/);
    expectContinuousSections(prompt);
    expect(sectionsOf(prompt)).toEqual([
      "작업 목표", "현재 진단 기준", "작업 전 현재 프로젝트 확인", "AS-IS", "TO-BE", "작업 범위", "구현 전 확인사항", "구현 원칙",
      "구현 요구사항", "외부 연동", "예외 처리", "문제 발생 시 대응", "보안", "검증 방법", "Git 반영", "배포 및 운영 적용", "완료 조건", "완료 보고",
    ]);
    expect(sectionBody(prompt, "AS-IS")).toContain("1. 자료 수집\n2. 형식 검증\n3. 담당자 승인");
    expect(sectionBody(prompt, "TO-BE")).toContain("2. 승인 — 담당자: 결과 대조 후 승인");
    expect(sectionBody(prompt, "작업 범위")).toContain("### 제외\n\n- 자동 승인\n- 담당자 승인 (담당자 수행)");
    const requirements = sectionBody(prompt, "구현 요구사항");
    for (const heading of ["### 입력 확인", "### 검증", "### 처리 순서", "### 데이터 흐름", "### 예외 분리", "### 결과 생성", "### 담당자 검토"]) expect(requirements).toContain(heading);
    expect(requirements).toContain("1. 저장소 확인\n2. 샘플 실험\n3. 검증 후 구현");
    expect(requirements).toContain("확인 전에는 컬럼명이나 시트 이름을 하드코딩하지 마세요.");
    const verification = sectionBody(prompt, "검증 방법");
    for (const heading of ["### 정상 케이스", "### 경계값", "### 실패·예외 케이스", "### 사전 검증", "### 회귀 검증"]) expect(verification).toContain(heading);
    expect(sectionBody(prompt, "예외 처리")).toContain("- 누락 시 검토\n\n");
    expect(sectionBody(prompt, "예외 처리")).not.toMatch(/^- 누락$/m);
    expect(sectionBody(prompt, "완료 조건").indexOf("- 대조 통과")).toBeLessThan(sectionBody(prompt, "완료 조건").indexOf("- 요청한 기능이 정상 작동"));
  });
  it("states the Level 1 diagnosis and keeps the automation scope inside it", () => {
    const prompt = buildAllInOnePrompt(planFixture, "codex", { taskName: "월간 취합", diagnosis: levelOne });
    const criteria = sectionBody(prompt, "현재 진단 기준");
    expect(criteria).toContain("- 자동화 수준: AI 보조 · Level 1");
    for (const line of ["- 자동화 가치: 4/5", "- 기술 실현 가능성: 3/5", "- 담당자 판단 필요도: 4/5", "- 운영 위험: 3/5", "- 실행 상태: 확인 후 진행"]) expect(criteria).toContain(line);
    expect(criteria).toContain("자동화 범위를 Level 2~3 수준으로 확대하지 마세요.");
    expect(criteria).toContain("'구현 전 확인사항'을 확인하기 전에는 관련 기능을 확정 구현하지 마세요.");
    expect(sectionBody(prompt, "작업 범위")).toContain("진단에서 제외되거나 담당자 유지로 분류된 단계를 임의로 자동화하지 마세요.");
    expect(sectionBody(prompt, "작업 목표")).toContain("다음 담당자 검토·승인 단계는 유지합니다");
    expect(sectionBody(prompt, "완료 조건")).toContain("담당자 검토·승인 단계가 유지됩니다.");
    const ready = buildAllInOnePrompt(planFixture, "codex", { diagnosis: withFactors([5, 5, 5, 5, 1, 1], { decisionGate: { verdict: "go", reasons: [] }, technicalChecks: [] }) });
    expect(sectionBody(ready, "현재 진단 기준")).toContain("- 실행 상태: 진행 가능");
    expect(sectionBody(ready, "현재 진단 기준")).toContain("Level 3");
    expect(ready).not.toContain("진단에서 제외되거나 담당자 유지로 분류된 단계를 임의로 자동화하지 마세요.");
  });
  it("qualifies unverified policy in place, drops unsupported metrics and leaves no conflicting rule", () => {
    const prompt = buildAllInOnePrompt(freightPlan, "codex", { taskName: "월간 운임 정산", diagnosis: levelOne, context: "매월 사업장별 운송 실적 Excel을 운임표와 대조해 정산합니다." });
    for (const text of ["50%", "0% 목표", "95%", "재무팀", "운영팀"]) expect(prompt).not.toContain(text);
    expect(prompt).toContain("- 샘플 정산표 대조 통과");
    expect(prompt).toContain("- 중복 데이터 발견 시 자동 제거 후 재계산 (확인 필요: 업무 규칙에서 확인된 경우에만 적용하고, 아니면 대상 건을 표시만 하세요)");
    expect(prompt).not.toMatch(/^- 중복 데이터 발견 시 자동 제거 후 재계산$/m);
    expect(prompt).toContain("허용 오차가 기존 업무에 정의되어 있으면 그 기준을 사용하고, 없으면 임의의 허용 오차를 만들지 마세요.");
    expect(sectionBody(prompt, "문제 발생 시 대응")).toContain("담당 조직이 주관");
    expect(sectionBody(prompt, "문제 발생 시 대응")).toContain("(확인 필요: 실제 담당 조직을 확인하세요)");
    const named = buildAllInOnePrompt(freightPlan, "codex", { diagnosis: levelOne, context: "정산은 재무팀이 검토하고 시스템 운영팀이 장애를 맡습니다." });
    expect(sectionBody(named, "문제 발생 시 대응")).toContain("- 재무팀이 주관, 오류 시 시스템 운영팀이 대응\n");
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
    expect(prompt.match(/\(확인 필요:/g)).toHaveLength(5);
    expect(guardPlan(planFixture, "")).toEqual(planFixture);
    const allowed = guardPlan({ ...planFixture, implementation: ["중복 건은 자동 삭제한다."] }, "규정상 중복 건은 자동 삭제합니다.");
    expect(allowed.implementation).toEqual(["중복 건은 자동 삭제한다."]);
  });
  it("keeps the diagnosed level and gate across all four levels and three gates", () => {
    const cases: [AxDiagnosis, string, string][] = [
      [withFactors([3, 2, 2, 2, 5, 4]), "Level 0", "확인 후 진행"],
      [levelOne, "Level 1", "확인 후 진행"],
      [withFactors([4, 4, 4, 3, 3, 3], { decisionGate: { verdict: "go", reasons: [] }, technicalChecks: [] }), "Level 2", "진행 가능"],
      [withFactors([5, 5, 5, 5, 1, 1], { decisionGate: { verdict: "no-go", reasons: ["권한 없음"] } }), "Level 3", "진행 보류"],
    ];
    for (const [diagnosis, level, gate] of cases) {
      const criteria = sectionBody(buildAllInOnePrompt(planFixture, "codex", { diagnosis }), "현재 진단 기준");
      expect(criteria).toContain(level); expect(criteria).toContain(`- 실행 상태: ${gate}`);
    }
    expect(sectionBody(buildAllInOnePrompt(planFixture, "codex", { diagnosis: cases[2][0] }), "현재 진단 기준")).toContain("주요 예외와 승인 단계는 담당자에게 유지합니다.");
    expect(sectionBody(buildAllInOnePrompt(planFixture, "codex", { diagnosis: cases[3][0] }), "현재 진단 기준")).toContain("검증용 PoC 또는 준비 작업까지만 진행하세요.");
  });
  it("varies the instruction with the task instead of repeating one template", () => {
    const excel = buildAllInOnePrompt(freightPlan, "codex", { taskName: "월간 운임 정산", diagnosis: levelOne });
    const contract = buildAllInOnePrompt({ ...planFixture, goal: ["계약서 조항 위험 후보 표시"], implementation: ["조항 분리", "위험 후보 표시"], integrations: [] }, "codex", {
      taskName: "계약 검토 보조", diagnosis: withFactors([3, 2, 2, 2, 5, 4], { asIs: { ...diagnosisFixture.asIs, steps: ["계약서 수령", "조항 검토", "법무 판단"], inputs: ["계약서 PDF"] } }),
    });
    expect(sectionBody(contract, "현재 진단 기준")).toContain("Level 0");
    expect(sectionBody(contract, "현재 진단 기준")).toContain("시스템이 업무를 자동 실행하는 기능을 임의로 추가하지 마세요.");
    expect(sectionsOf(contract)).not.toContain("외부 연동");
    expect(sectionBody(contract, "AS-IS")).toContain("2. 조항 검토");
    expect(sectionBody(contract, "구현 요구사항")).toContain("- 계약서 PDF");
    expect(sectionBody(excel, "구현 요구사항")).toContain("1. 파싱·형식 검증");
    expect(sectionBody(excel, "현재 진단 기준")).not.toBe(sectionBody(contract, "현재 진단 기준"));
  });
  it("removes AI enumerators and near-duplicate review, scope and exception items", () => {
    const plan: AxPlan = { ...planFixture, implementation: ["1) 공유 폴더 감시", "2) 운임 계산", "③ 대조"], humanInLoop: ["예외 건 검토 및 사유 기록", "정산표 최종 승인"], exceptions: ["운임표 업데이트 지연 시 오류 보고"] };
    const diagnosis: AxDiagnosis = { ...levelOne, asIs: { ...levelOne.asIs, exceptions: ["운임표 업데이트 지연", "데이터 형식 불일치"] },
      stepAssessments: [{ step: "예외 건 검토", verdict: "사람 유지", owner: "사용자", note: "판단 필요" }, { step: "최종 승인", verdict: "사람 유지", owner: "사용자", note: "승인 유지" }, { step: "대외 보고", verdict: "사람 유지", owner: "사용자", note: "직접 보고" }] };
    const prompt = buildAllInOnePrompt(plan, "codex", { diagnosis });
    expect(sectionBody(prompt, "구현 요구사항")).toContain("1. 공유 폴더 감시\n2. 운임 계산\n3. 대조");
    const review = sectionBody(prompt, "구현 요구사항").split("### 담당자 검토")[1];
    expect(review).toContain("- 예외 건 검토 및 사유 기록\n- 정산표 최종 승인\n- 대외 보고 (담당자 수행)");
    expect(review).not.toContain("최종 승인 (담당자 수행)");
    expect(sectionBody(prompt, "예외 처리")).toContain("- 운임표 업데이트 지연 시 오류 보고\n- 데이터 형식 불일치\n");
    expect(sectionBody(prompt, "예외 처리")).not.toMatch(/^- 운임표 업데이트 지연$/m);
  });
  it("keeps repository, Git and deployment safety without platform boilerplate", () => {
    const prompt = buildAllInOnePrompt(planFixture, "codex", { diagnosis: diagnosisFixture });
    for (const text of [
      "현재 프로젝트 저장소를 먼저 확인한 뒤 아래 요구사항을 구현하세요.",
      "이 프로젝트가 웹 애플리케이션인지, 로컬 스크립트·CLI·Excel 자동화인지 확인하세요.",
      "확인되지 않은 항목은 '확인 필요'로 유지하고, 확인되지 않은 API나 권한이 있다고 가정해 구현하지 마세요.",
      "실패·미매칭·확인 불가 데이터를 정상 처리 결과에 섞지 말고",
      "secret은 코드에 하드코딩하지 말고 저장소의 기존 secret 관리 방식을 사용하세요.",
      "도구가 없으면 새로 설치하지 말고 그 사실을 보고하세요.",
      "의도한 파일만 `git add <파일>`로 stage하세요. `git add .`로 전체를 추가하지 마세요.",
      "force push, `git reset --hard` 같은 파괴적인 명령을 사용하지 마세요.",
      "stage·commit·push·PR은 사용자 요청 범위, 도구 권한, 저장소 branch/PR 정책이 모두 허용할 때만 진행하세요.",
      "허용되지 않으면 실행하지 말고 현재 Git 상태, 추천 commit 메시지, 다음에 실행할 명령을 보고하세요.",
      "배포 플랫폼을 임의로 선택하거나 새 배포 도구를 설치하지 마세요.",
      "로컬 스크립트·CLI·Excel 자동화처럼 웹 배포가 필요 없으면 배포 대신 실행 환경 구성과 운영 적용으로 처리하세요.",
      "Production 배포는 사용자가 배포를 요청했고 권한이 확인된 경우에만 기존 방식으로 실행하세요.",
      "배포 또는 운영 적용을 수행한 경우 실제 환경에서 핵심 기능을 검증합니다. 수행하지 않은 경우 사유와 미실행 항목을 명확히 보고합니다.",
      "실제로 수행하지 않은 작업을 완료했다고 보고하지 마세요.",
    ]) expect(prompt).toContain(text);
    for (const text of ["npm install -g", "winget", "PowerShell", "해당 없음", "vercel.json", "wrangler.toml", "Vercel과 Cloudflare", "실제 배포·운영 환경에서 검증했습니다."]) expect(prompt).not.toContain(text);
    expect(prompt.match(/저장소를 먼저 확인/g)).toHaveLength(1);
  });
  it("deduplicates plan and diagnostic prerequisites while preserving their order", () => {
    const options = { taskName: "월간 취합", prerequisites: [planFixture.prerequisites[0], "권한 확인", "권한 확인", "승인자 확인"] };
    const prompt = buildAllInOnePrompt(planFixture, "codex", options);
    expect(prompt.match(/^- 실제 저장소와 API 확인$/gm)).toHaveLength(1);
    expect(prompt).toContain("- 실제 저장소와 API 확인\n- 권한 확인\n- 승인자 확인");
    const onlyDiagnostic = buildAllInOnePrompt({ ...planFixture, prerequisites: [] }, "codex", { prerequisites: ["진단 조건 확인"] });
    expect(sectionBody(onlyDiagnostic, "구현 전 확인사항")).toMatch(/^\n+- 진단 조건 확인/);
  });
  it("is deterministic and identical between Codex and Claude Code", () => {
    const options = { taskName: "월간 취합", prerequisites: ["권한 확인"], diagnosis: levelOne };
    const codex = buildAllInOnePrompt(planFixture, "codex", options);
    expect(codex).toBe(buildAllInOnePrompt(planFixture, "codex", options));
    expect(buildAllInOnePrompt(planFixture, "claude", options)).toBe(codex);
  });
  it("omits empty task-specific sections and consecutively numbers required sections", () => {
    const prompt = buildAllInOnePrompt({
      repositoryFirst: planFixture.repositoryFirst, goal: [], asIs: [], toBe: [], inScope: [], outOfScope: [], prerequisites: [],
      humanInLoop: [], poc: [], implementation: [], dataFlow: [], integrations: [], exceptions: [],
      fallback: [], security: [], operation: [], tests: [], acceptance: [],
    }, "codex");
    expect(sectionsOf(prompt)).toEqual(["작업 전 현재 프로젝트 확인", "구현 원칙", "검증 방법", "Git 반영", "배포 및 운영 적용", "완료 조건", "완료 보고"]);
    expectContinuousSections(prompt);
    for (const text of ["해당 없음", "### 사전 검증", "### 담당자 검토", "담당자 검토·승인 단계가 유지됩니다.", "현재 진단 기준"]) expect(prompt).not.toContain(text);
    expect(prompt).toContain(`## 2. 구현 원칙\n\n- ${planFixture.repositoryFirst}\n- 기존 구현을 우선 재사용하고`);
    expect(prompt).toContain("## 6. 완료 조건\n\n- 요청한 기능이 정상 작동하고");
  });
  it.each(["inScope", "outOfScope"] as const)("keeps scope with only %s populated", key => {
    const prompt = buildAllInOnePrompt({ ...planFixture, inScope: [], outOfScope: [], [key]: ["범위 항목"] }, "codex");
    expect(sectionBody(prompt, "작업 범위")).toContain(`### ${key === "inScope" ? "포함" : "제외"}\n\n- 범위 항목`);
    expect(sectionBody(prompt, "작업 범위")).not.toContain(`### ${key === "inScope" ? "제외" : "포함"}`);
  });
  it.each(["fallback", "operation"] as const)("keeps recovery with only %s populated", key => {
    const prompt = buildAllInOnePrompt({ ...planFixture, fallback: [], operation: [], [key]: ["복구 항목"] }, "codex");
    const recovery = sectionBody(prompt, "문제 발생 시 대응");
    expect(recovery).toContain(`### ${key === "fallback" ? "자동화 실패 시" : "운영"}\n\n- 복구 항목`);
    expect(recovery).not.toContain(`### ${key === "fallback" ? "운영" : "자동화 실패 시"}`);
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
    expect(existingProject).toContain("미커밋 변경이 있으면 무조건 `git pull`부터 실행하지 마세요");
    const run = setupGuide("codex")[3].sections[0];
    expect(run.blocks).toContainEqual({
      kind: "code", lines: ['cd "프로젝트 경로"', "Get-Location", "dir", TOOL_GUIDES.codex.runCommand],
      notes: ["실제 프로젝트 경로로 바꾸어 이동합니다.", "현재 위치가 프로젝트 폴더인지 확인합니다.", "프로젝트 폴더의 파일과 하위 폴더를 확인합니다.", "Codex를 현재 프로젝트에서 실행합니다."],
    });
  });
});
