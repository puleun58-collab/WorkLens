import { describe, expect, it } from "vitest";
import { buildAgentInstructionModel, buildAllInOnePrompt, guardPlan, planSummary, setupGuide, stepMethodLabel, TOOL_GUIDES } from "../src/lib/ax/guide";
import { executionGate } from "../src/lib/ax/policy";
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
  it("presents intro and eight executable stages without a separate pre-MVP development step", () => {
    const steps = setupGuide("codex");
    expect(steps).toHaveLength(9);
    expect(steps[0].sections.map(section => section.title)).toEqual(["처음 시작할 때", "이후 작업할 때", "Git·GitHub 작업 흐름"]);
    expect(steps.slice(1).map(step => step.title)).toEqual([
      "STEP 01 · 개발 환경 준비", "STEP 02 · 프로젝트 준비", "STEP 03 · 올인원 지시문 준비",
      "STEP 04 · 첫 MVP 구현과 실제 테스트", "STEP 05 · 배포 플랫폼 선택",
      "STEP 06 · 데이터 저장 방식", "STEP 07 · GitHub 저장과 배포", "STEP 08 · 실제 기능 확인 및 완료",
    ]);
    expect(JSON.stringify(steps[3])).toContain("올인원 지시문");
    expect(JSON.stringify(steps[3])).not.toContain("04 올인원 지시문");
    expect(JSON.stringify(steps[4])).toContain("실제 입력 데이터");
    expect(JSON.stringify(steps[8])).toContain("로컬 자동화 프로그램이라면");
  });
  it.each(["codex", "claude"] as const)("marks the C section for the widened after-gap without changing its wording: %s", tool => {
    const step02 = setupGuide(tool)[2];
    expect(step02.title).toBe("STEP 02 · 프로젝트 준비");
    const sectionC = step02.sections.find(section => section.title === "C. 다른 PC에서 작업 이어가기");
    expect(sectionC?.className).toBe("ax-guide-section--cautions");
    const texts = (sectionC?.blocks ?? []).filter(block => block.kind === "text").map(block => block.text);
    expect(texts).toContain("다른 PC의 작업이 GitHub에 푸시되어 있어야 합니다. 로컬 변경사항이 있다면 먼저 확인하고, 원격 기본 브랜치가 main이 아닌 경우 실제 브랜치명을 사용하세요.");
    expect(texts).toContain("로컬 변경사항이 있을 때는 무조건 브랜치를 전환하거나 가져오지 말고 현재 상태를 먼저 확인하세요. 로컬에 main 브랜치가 없으면 해당 상태를 먼저 확인하세요. 충돌이 발생하면 데이터를 삭제하거나 강제로 덮어쓰는 방식으로 해결하지 마세요.");
    expect(setupGuide(tool === "codex" ? "claude" : "codex")[2].sections.find(section => section.title === "C. 다른 PC에서 작업 이어가기")).toEqual(sectionC);
  });
  it.each(["codex", "claude"] as const)("keeps only the comparison section in STEP 05 without manual Wrangler or duplicate pricing sections: %s", tool => {
    const step05 = setupGuide(tool)[5];
    expect(step05.title).toBe("STEP 05 · 배포 플랫폼 선택");
    expect(step05.sections.map(section => section.title)).toEqual(["배포 방식 비교"]);
    const serialized = JSON.stringify(step05);
    for (const removed of ["Cloudflare의 Wrangler", "요금·정책 확인", "npm i -D wrangler@latest", "npx wrangler --version"]) expect(serialized).not.toContain(removed);
    // The platform-selection request is a different purpose from the STEP 07 deploy-execution
    // request, so it stays; only the deploy-execution request is the single integrated one.
    expect(serialized).toContain("어떤 배포 방식이 적합한지 확인해 줘");
    expect(serialized).toContain("vercel.com/docs/plans/hobby");
    expect(serialized).toContain("developers.cloudflare.com/workers/platform/pricing/");
  });
  it("presents the intro glossary as the Git·GitHub work flow in execution order", () => {
    const flow = setupGuide("codex")[0].sections[2];
    expect(flow.title).toBe("Git·GitHub 작업 흐름");
    expect(flow.collapsed).toBe(true);
    expect(flow.blocks).toHaveLength(1);
    const diagram = flow.blocks[0];
    expect(diagram?.kind).toBe("git-flow");
    if (diagram?.kind !== "git-flow") throw new Error("expected git-flow block");
    expect(diagram.subtitle).toBe("코드 변경부터 배포까지의 전체 과정을 순서대로 확인하세요.");
    expect(diagram.steps.map(step => `${step.no} ${step.title}`)).toEqual([
      "01 저장소 준비", "02 브랜치 생성", "03 변경 파일 추가", "04 변경 내용 저장", "05 원격 저장소 업로드",
      "06 PR 생성", "07 CI 실행", "08 PR 병합", "09 배포", "10 배포 검증",
    ]);
    expect(diagram.steps.map(step => step.tone)).toEqual(["blue", "blue", "green", "green", "purple", "purple", "orange", "orange", "blue", "blue"]);
    expect(diagram.steps[0]?.command).toEqual(["git init", "git clone"]);
    expect(diagram.steps[3]?.command).toEqual(["git commit -m", "\"변경 내용\""]);
    expect(diagram.groups.map(group => `${group.range} ${group.title}`)).toEqual([
      "01~02 저장소 준비·브랜치", "03~04 변경 추가·커밋", "05~06 업로드·PR", "07~08 CI·Merge", "09~10 배포·검증",
    ]);
    expect(diagram.groups.map(group => group.tone)).toEqual(["blue", "green", "purple", "orange", "blue"]);
    expect(diagram.notes).toEqual([
      "git init과 git clone은 프로젝트 상태에 따라 선택하며, 기존 저장소를 다시 초기화하지 않습니다.",
      "CI는 Push 또는 PR 생성 시 실행될 수 있으며, 실제 실행 조건은 프로젝트 설정에 따릅니다.",
      "Merge와 Deploy는 서로 다른 작업이며, 배포 완료 후 실제 기능 검증이 필요합니다.",
    ]);
    const serialized = JSON.stringify(flow);
    for (const removed of ["저장소/클론", "브랜치/PR/CI", "Preview/Production", "Secret:", "HITL: AI 제안"]) expect(serialized).not.toContain(removed);
    expect(setupGuide("claude")[0].sections[2]).toEqual(flow);
  });
  it.each(["codex", "claude"] as const)("scopes native installs and safety to the selected agent: %s", tool => {
    const other = tool === "codex" ? "claude" : "codex";
    const guide = setupGuide(tool);
    const installation = JSON.stringify(guide[1]);
    const copied = guide[1].sections.flatMap(section => section.blocks.flatMap(block => block.kind === "code" ? block.lines : []));
    expect(copied).toContain(TOOL_GUIDES[tool].installCommand);
    expect(copied).not.toContain(TOOL_GUIDES[other].installCommand);
    expect(copied).toContain(TOOL_GUIDES[tool].versionCommand);
    expect(guide[2]).toEqual(setupGuide(other)[2]);
    for (const index of [5, 6, 7, 8]) expect(guide[index]).toEqual(setupGuide(other)[index]);
    for (const term of ["Git", "Node.js", "Get-FileHash", "ExitCode", "Arm64", "LTS", "ErrorActionPreference"]) expect(installation).toContain(term);
    // STEP 01 keeps only the essentials for the selected agent: no GitHub CLI install/auth in the basic guide.
    expect(guide[1].sections.map(section => section.title)).toEqual([
      "설치 순서 안내", "Git 설치", "Git 사용자 정보 설정", "Node.js LTS 설치", `${TOOL_GUIDES[tool].name} 설치`,
    ]);
    expect(installation).not.toContain("GitHub CLI");
    expect(installation).not.toContain("Git 정보·로그인");
    for (const ghLine of ["gh auth status", "gh auth login", "gh --version"]) expect(copied).not.toContain(ghLine);
    expect(JSON.stringify(guide[1].sections[0])).toContain("Git 설치 → Git 사용자 정보 설정 → 필요한 경우 Node.js 설치 → 선택한 코딩 에이전트 설치 → 최초 실행·로그인 확인");
    const gitIdentity = guide[1].sections.find(section => section.title === "Git 사용자 정보 설정");
    const gitIdentityLines = gitIdentity?.blocks.flatMap(block => block.kind === "code" ? block.lines : []) ?? [];
    expect(gitIdentityLines).toEqual(["git config user.name", "git config user.email", 'git config --global user.name "본인 이름"', 'git config --global user.email "본인@example.com"']);
    expect(copied).toContain(TOOL_GUIDES[tool].runCommand);
    expect(copied).not.toContain(TOOL_GUIDES[other].runCommand);
    const installers = guide[1].sections.filter(section => ["Git 설치", "Node.js LTS 설치"].includes(section.title));
    expect(installers).toHaveLength(2);
    for (const section of installers) {
      const blocks = section.blocks.filter(block => block.kind === "code");
      expect(blocks[0]).toMatchObject({ kind: "code", lines: [expect.stringContaining("Get-FileHash")] });
      expect(blocks[1]).toMatchObject({ kind: "code" });
    }
    expect(installation).not.toMatch(/winget install|scoop install|choco install/i);
    // Node.js LTS 섹션은 조건 문구(when) 없이 보조 설명 한 줄만 표시하고, 설치·버전 확인 명령은 유지한다.
    const nodeSection = guide[1].sections.find(section => section.title === "Node.js LTS 설치");
    expect(nodeSection?.when).toBeUndefined();
    expect(JSON.stringify(guide)).not.toContain("호환 버전이 없을 때만");
    expect(nodeSection?.blocks[0]).toEqual({ kind: "text", text: "프로젝트 실행 또는 개발 도구에 필요한 경우 설치합니다." });
    expect(JSON.stringify(nodeSection)).toContain("node --version");
    expect(JSON.stringify(nodeSection)).toContain("npm --version");
  });
  it.each(["codex", "claude"] as const)("protects existing repo, storage, secrets and outcomes: %s", tool => {
    const steps = setupGuide(tool);
    const all = JSON.stringify(steps);
    const cases = steps[2].sections.filter(section => /^[ABCD]\. /.test(section.title));
    expect(cases.map(section => section.title)).toEqual([
      "A. GitHub에 있고 PC에는 없는 프로젝트",
      "B. PC에 이미 있는 프로젝트",
      "C. 다른 PC에서 작업 이어가기",
      "D. 새 프로젝트",
    ]);
    expect(cases.map(section => section.when)).toEqual([
      "GitHub 저장소를 현재 PC에 처음 가져오는 경우",
      "PC에 프로젝트 폴더가 있는 경우",
      "다른 PC에서 GitHub에 반영한 최신 작업을 가져오는 경우",
      "새 폴더에서 시작하는 경우",
    ]);
    const codeLines = (section: (typeof cases)[number]) => section.blocks.flatMap(block => block.kind === "code" ? block.lines : []);
    // A: 최초 클론은 clone → cd → status만, mkdir·fetch·pull 없음.
    expect(codeLines(cases[0])).toEqual(['git clone "https://github.com/owner/repository.git"', 'cd "repository"', "git status"]);
    expect(JSON.stringify(cases[0])).not.toContain("mkdir");
    expect(JSON.stringify(cases[0])).not.toContain("git fetch");
    expect(JSON.stringify(cases[0])).not.toContain("git pull");
    expect(JSON.stringify(cases[0])).toContain("현재 PowerShell 위치에 저장소 이름으로 폴더가 생성됩니다.");
    // B: cd와 status만, 원격 확인·동기화 명령 없음.
    expect(codeLines(cases[1])).toEqual(['cd "C:\\Work\\repository"', "git status"]);
    expect(JSON.stringify(cases[1])).not.toContain("git branch --show-current");
    expect(JSON.stringify(cases[1])).not.toContain("git remote -v");
    expect(JSON.stringify(cases[1])).toContain("실제 프로젝트 폴더 경로로 변경하세요. 기존 파일과 변경사항을 확인한 후 작업을 시작하세요.");
    // C: 다른 PC 이어가기 — status → fetch → checkout main → pull --ff-only 순서와 주의 안내.
    expect(codeLines(cases[2])).toEqual(['cd "C:\\Work\\repository"', "git status", "git fetch origin", "git checkout main", "git pull --ff-only origin main"]);
    expect(JSON.stringify(cases[2])).toContain("PC에 프로젝트가 없다면 C가 아닌 A를 사용하세요.");
    expect(JSON.stringify(cases[2])).toContain("git status: 현재 브랜치와 로컬 변경사항 확인");
    expect(JSON.stringify(cases[2])).toContain("git fetch origin: GitHub의 최신 원격 정보 가져오기");
    expect(JSON.stringify(cases[2])).toContain("git checkout main: main 브랜치로 전환");
    expect(JSON.stringify(cases[2])).toContain("git pull --ff-only origin main: 불필요한 병합 커밋 없이 최신 코드 반영");
    expect(JSON.stringify(cases[2])).toContain("다른 PC의 작업이 GitHub에 푸시되어 있어야 합니다. 로컬 변경사항이 있다면 먼저 확인하고, 원격 기본 브랜치가 main이 아닌 경우 실제 브랜치명을 사용하세요.");
    expect(JSON.stringify(cases[2])).toContain("로컬 변경사항이 있을 때는 무조건 브랜치를 전환하거나 가져오지 말고 현재 상태를 먼저 확인하세요.");
    expect(JSON.stringify(cases[2])).toContain("로컬에 main 브랜치가 없으면 해당 상태를 먼저 확인하세요.");
    // D: 기존 새 프로젝트 안내가 그대로 이동.
    expect(JSON.stringify(cases[3])).toContain("재초기화");
    // "packageManager" was only present in the removed Wrangler section, so it is no longer
    // an expected term; the remaining terms still guard repo, storage, secrets and outcomes.
    for (const term of ["D1", "R2", "KV", "외부 DB", "git remote -v", "git diff --cached", "폐기 → 재발급", "기록 재작성", "PASS/FAIL/NOT_RUN/BLOCKED", "[REDACTED]"]) expect(all).toContain(term);
    expect(JSON.stringify(steps[5])).not.toContain("npm i -D wrangler@latest");
    expect(JSON.stringify(steps[5])).not.toContain("npx wrangler --version");
    expect(JSON.stringify(steps[7])).toContain("Git 자동 배포와 CLI 배포를 중복 실행하지 않습니다");
    expect(JSON.stringify(steps[8])).toContain("실패했거나 확인하지 못한 항목은 별도로 기록하고 수정한 뒤 다시 검증하세요.");
    for (const destructive of ["git reset --hard", "git clean -fd", "git push --force", "git rm --cached -r ."]) expect(all).not.toContain(destructive);
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
      "내부 API를 호출해 자동 등록한다. (확인 필요: 업무 규칙에서 확인된 경우에만 적용하고, 아니면 대상 건을 표시만 하세요) (확인 필요: 실제 연동 방식과 권한을 확인한 뒤 확인된 방식만 사용하세요)",
      "사내 시스템 API로 업로드한다. (확인 필요: 실제 연동 방식과 권한을 확인한 뒤 확인된 방식만 사용하세요)",
      "형식 검증 결과를 표시한다.",
    ]);
    expect(once.humanInLoop).toEqual(["담당 조직이 최종 승인한다. (확인 필요: 실제 담당 조직을 확인하세요)"]);
    expect(once.outOfScope).toEqual(["자동 승인", "ERP 자동 전송"]);
    expect(once.prerequisites).toEqual(["ERP API 존재 여부 확인"]);
    expect(guardPlan(once, "매월 정산표를 만들어 담당자가 승인합니다.")).toEqual(once);
    // The raw unsupported metric stays visible for confirmation and never becomes a pass/fail criterion.
    const model = buildAgentInstructionModel(plan, { diagnosis: levelOne });
    expect(model.scoped.criteria.some(item => item.text.includes("정확도 95%"))).toBe(false);
    expect(model.classified).toContainEqual(expect.objectContaining({ scope: "confirm", originals: expect.arrayContaining(["정확도 95%를 달성한다."]) }));
    expect(guardPlan(planFixture, "")).toEqual(planFixture);
    const allowed = guardPlan({ ...planFixture, implementation: ["중복 건은 자동 삭제한다."] }, "규정상 중복 건은 자동 삭제합니다.");
    expect(allowed.implementation).toEqual(["중복 건은 자동 삭제한다."]);
  });
  it("keeps conditional integration dependencies visible without attaching them to an invented step", () => {
    const diagnosis = { ...levelOne,
      decisionGate: { verdict: "conditional" as const, reasons: ["접근 권한 확인"] },
      technicalChecks: [{ topic: "외부 서비스 사용", status: "확인 필요" as const, note: "실제 연동 방식 미확정" }],
    };
    const plan = { ...planFixture, prerequisites: ["미확정 ERP 연결 권한 확인"], integrations: ["미확정 ERP 연결"] };
    const before = structuredClone({ diagnosis, plan });
    const model = buildAgentInstructionModel(plan, { diagnosis });
    expect(model.gate).toBe("conditional");
    expect(model.steps.every(s => s.scope !== "implement")).toBe(true);
    const dependency = model.classified.find(item => item.text === "미확정 ERP 연결 권한 확인");
    expect(dependency).toBeDefined();
    expect(dependency?.scope).not.toBe("implement");
    expect(model.scoped.conditions).not.toContainEqual(expect.objectContaining({ text: "미확정 ERP 연결 권한 확인" }));
    const prompt = buildAllInOnePrompt(plan, "codex", { diagnosis });
    expect(prompt).toContain("미확정 ERP 연결 권한 확인");
    expect({ diagnosis, plan }).toEqual(before);
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
      const model = buildAgentInstructionModel(undefined, { diagnosis });
      for (const [index, step] of model.steps.entries()) {
        if (step.scope === "implement" || step.scope === "after-check" || step.scope === "verify") {
          expect(summary.include).toContain(`${step.step} ${stepMethodLabel(model, index)}`);
        }
      }
      if (level === 0 || verdict === "no-go") {
        expect(summary.include.join("\n")).not.toMatch(/규칙 기반 처리|자동 처리|결과\(후보·초안\) 생성/u);
        expect(summary.excluded).toContain("운영 자동화 적용");
      } else if (level === 1) {
        expect(model.methods[model.steps.findIndex(step => step.step === "형식 검증")]).toBe("confirm");
        expect(summary.include.join("\n")).not.toMatch(/규칙 기반 처리|자동 처리/u);
        expect(summary.excluded).toContain("운영 자동화 적용");
      }
      // Diagnosed steps outside the permitted Level × Gate scope are listed as current exclusions.
      expect(summary.excluded.includes("자료 수집 자동 실행")).toBe(scopeLevel < 2);
      expect(summary.excluded.includes("형식 검증 AI 보조 구현")).toBe(scopeLevel < 1);
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
    // "누락"은 "누락 데이터"의 부분집합이므로 의미 중복으로 통합 (03 완료 기준 중복 제거)
    expect(summary.exceptions).toEqual(["누락 데이터"]);
    expect(summary.data.find(group => group.label === "입력")?.items).toEqual(["입력 표"]);
    expect(summary.data.find(group => group.label === "사용 시스템")?.items).toEqual(["표 도구"]);
    expect(summary.data.find(group => group.label === "검증용 입력")?.items).toEqual(["샘플 표"]);
    const model = buildAgentInstructionModel(undefined, { diagnosis });
    for (const [source, text] of [["diagnosis.poc.evaluation", "샘플 대조"], ["diagnosis.poc.success", "샘플 대조 통과"], ["diagnosis.poc.failure", "누락 발생"]] as const) {
      const item = model.classified.find(item => item.sources.includes(source) && item.text === text);
      expect(item).toMatchObject({ scope: "confirm" });
      expect(item?.step).toBeUndefined();
    }
    expect(model.scoped.tests).toEqual([]);
    expect(model.scoped.criteria).toEqual([]);
    // Confirmed checks are not open conditions.
    expect(planSummary({ ...diagnosis, technicalChecks: [{ topic: "샘플 파일", status: "확인됨", note: "헤더 확인" }, ...diagnosis.technicalChecks] }).prerequisites.join("\n")).not.toContain("샘플 파일");
    expect(planSummary({ ...diagnosis, planCodex: freightPlan, planClaude: planFixture })).toEqual(summary);
    expect(planSummary(diagnosis)).toEqual(summary);
    expect(diagnosis).toEqual(before);
  });

  it.each(["conditional", "no-go"] as const)("keeps unlinked generated prerequisites nonrequired for a %s gate", verdict => {
    const diagnosis: AxDiagnosis = { ...levelOne, decisionGate: { verdict, reasons: ["접근 권한 확인"] }, technicalChecks: [], humanInLoop: ["최종 승인"] };
    const plan: AxPlan = {
      ...freightPlan,
      prerequisites: ["접근 권한 확인", "샘플 보관 위치 확인"],
      inScope: ["원본 읽기", "운임 계산"], humanInLoop: ["최종 승인 후 전송"], outOfScope: ["승인 없이 외부 전송"],
      poc: ["원본 샘플 보관"], tests: ["결과 파일 재열기"], acceptance: ["담당자 확인 기록 완료"], exceptions: ["운임표 미매칭"],
    };
    const before = structuredClone({ diagnosis, plan });
    const base = planSummary(diagnosis), withPlan = planSummary(diagnosis, plan, "월간 운임 정산");
    expect(withPlan.prerequisites.some(text => text === "샘플 보관 위치 확인")).toBe(false);
    const model = buildAgentInstructionModel(plan, { diagnosis });
    expect(model.conditions.confirm).toContainEqual(expect.objectContaining({ text: "샘플 보관 위치 확인" }));
    expect(withPlan.constraints.join("\n")).toContain("최종 승인 후 전송");
    expect(withPlan.constraints.join("\n")).toContain("승인 없이 외부 전송");
    // Internal source paths (plan.humanInLoop, plan.outOfScope) are tracked in the model
    // but not exposed in the final output (Goal 8: 내부 출처 필드명 노출 최소화)
    expect(withPlan.constraints.join("\n")).not.toContain("plan.humanInLoop");
    expect(withPlan.constraints.join("\n")).not.toContain("plan.outOfScope");
    expect(withPlan.include).toEqual(base.include);
    expect({ diagnosis, plan }).toEqual(before);
  });

  it("keeps unlinked whole-task PoC outputs and tests nonrequired at every Level", () => {
    const patch: Partial<AxDiagnosis> = {
      technicalChecks: [
        { topic: "샘플 데이터", status: "확인 필요", note: "실제 형식과 필수 항목 확인" },
        { topic: "AI·API 연동", status: "확인 필요", note: "사진 업로드 API와 AI 모델 접근 권한 확인" },
      ],
      poc: {
        ...diagnosisFixture.poc,
        outputs: ["자동 생성된 점검 기록 초안", "점검 결과 요약표"],
        evaluation: ["자동 초안과 수동 작성 초안을 전수 대조", "샘플 체크리스트 필수 항목 대조"],
      },
    };
    for (const factors of [[3, 2, 2, 2, 5, 4], [4, 4, 3, 2, 4, 3], [4, 4, 4, 3, 3, 3], [5, 5, 5, 5, 1, 1]] as const) {
      const diagnosis = withFactors([...factors], patch);
      const model = buildAgentInstructionModel(undefined, { diagnosis });
      expect(model.scoped.outputs).toEqual([]);
      expect(model.scoped.tests).toEqual([]);
      for (const source of ["diagnosis.poc.outputs", "diagnosis.poc.evaluation"]) {
        for (const item of model.classified.filter(item => item.sources.includes(source))) {
          expect(["confirm", "future"]).toContain(item.scope);
          expect(item.step).toBeUndefined();
        }
      }
      expect(executionGate(diagnosis)).toBe("conditional");
    }
  });
});

describe("AX guide conditional architecture", () => {
  it.each(["codex", "claude"] as const)("compares platforms and keeps only the storage-choice section for %s", tool => {
    const steps = setupGuide(tool);
    const platform = steps[5].sections.find(section => section.title === "배포 방식 비교")!;
    const comparison = platform.blocks.find(block => block.kind === "table");
    expect(comparison?.kind).toBe("table");
    if (comparison?.kind !== "table") throw new Error("missing comparison");
    expect(comparison.headers).toEqual(["비교", "Vercel", "Cloudflare"]);
    expect(JSON.stringify(comparison.rows)).toContain("D1");
    expect(JSON.stringify(platform)).toContain("vercel.com/docs/plans/hobby");
    const storage = steps[6].sections;
    expect(storage.map(section => section.title)).toEqual(["필요한 저장 방식만 선택하세요"]);
    for (const term of ["Cloudflare 저장소 연결", "D1 · 구조화된 기록", "R2 · 파일과 첨부", "KV · 조회 중심 값"]) {
      expect(storage.find(section => section.title === term)).toBeUndefined();
    }
    expect(JSON.stringify(steps)).not.toContain("wrangler d1 create");
    expect(JSON.stringify(steps)).not.toContain("r2_buckets");
    expect(JSON.stringify(steps)).not.toContain("kv_namespaces");
  });
});

describe("AX guide dev-prep integration", () => {
  const gitignorePrompt = "현재 프로젝트의 언어, 프레임워크, 실행 환경과 파일 구조를 확인하고 적절한 .gitignore를 구성해 줘. 기존 .gitignore가 있으면 필요한 규칙만 보완하고, 없으면 새로 만들어 줘. 의존성 폴더, 빌드 결과물, 캐시, 임시파일, 로컬 설정, 인증정보 등 GitHub에 올리면 안 되는 파일을 제외해 줘. 반대로 실제 개발에 필요한 소스코드, 설정 템플릿, 잠금 파일 등은 임의로 제외하지 마. 이미 Git이 추적하는 민감 파일이 있는지도 확인해 줘. 발견하면 파일을 삭제하거나 Git 기록을 변경하지 말고 처리 방법과 위험을 먼저 알려 줘. 완료 후 적용한 제외 규칙과 추가 확인이 필요한 사항을 간단히 보고해 줘.";
  const deployPromptLines = ["현재 프로젝트의 구조, GitHub 연결 상태, 배포 서비스 및 기존 배포 설정을 먼저 확인해 줘.", "", "Vercel 또는 Cloudflare 중 이미 구성된 배포 환경이 있다면 해당 환경을 우선 유지해 줘.", "", "GitHub 연동 자동 배포가 설정되어 있다면 기존 브랜치·CI·배포 흐름을 확인하고, 변경 사항이 실제 배포 환경에 반영되는지 검증해 줘.", "", "CLI 직접 배포가 필요한 경우에는 프로젝트의 기존 배포 스크립트와 설정을 우선 사용해 줘. Cloudflare 프로젝트라면 필요한 경우 Wrangler를 사용하고, 불필요한 도구 설치나 설정 변경은 하지 마.", "", "배포 전 필요한 빌드와 테스트를 실행하고, 실제 운영 환경에 영향을 줄 수 있는 변경 사항이 있다면 실행 전에 알려 줘. 인증이나 추가 승인이 필요하다면 사용자에게 요청해 줘.", "", "기존 데이터와 서비스 설정을 보존하면서 승인된 범위에서 배포를 진행해 줘.", "", "완료 후 실제 배포 환경, URL, 적용된 코드 버전, 테스트 및 배포 결과를 구분해 보고해 줘.", "", "배포가 실행되지 않았거나 실제 반영 여부를 확인하지 못했다면 완료로 표시하지 마."];
  const verifyPrompt = "완성한 프로그램을 실제 사용 상황처럼 직접 실행해 테스트해 줘. (1) 프로그램이 실제로 실행되는지, (2) 핵심 기능이 구현됐는지, (3) 입력 데이터를 올바르게 처리하는지, (4) 실제 출력 결과가 무엇인지, (5) 사용자 확정한 업무 규칙이 반영됐는지, (6) 정상·경계·실패 사례에서 어떻게 동작하는지, (7) 사용자 확인·승인 등 사람 검토 제한을 지키는지, (8) 미구현 기능과 오류가 무엇인지, (9) 검증되지 않은 기능이 무엇인지를 확인해 줘. 주요 기능에 정상적인 입력과 잘못된 입력을 각각 사용하고, 처리 결과가 요구사항과 일치하는지 확인해 줘. 데이터 저장 기능이 있다면 저장 후 다시 실행하거나 새로고침해도 데이터가 올바르게 유지되는지 검증해 줘. 웹서비스라면 실제 배포된 환경의 주요 기능을 확인하고, 로컬 자동화 프로그램이라면 해당 실행 환경에서 테스트해 줘. 각 항목을 통과(PASS)·실패(FAIL)·미실행(NOT_RUN)·차단(BLOCKED)으로 구분해 보고하고, 근거로 실제 테스트 입력·기대 결과·실제 결과·오류 메시지·실패한 테스트·실행 환경과 코드 버전·재현 방법을 함께 적어 줘. 기대 결과나 업무 규칙이 확정되지 않았다면 AI가 임의로 정답을 만들지 말고 미확정으로 구분해 보고해 줘. 실행하지 못한 테스트는 미검증으로 구분하고, HTTP 200 응답이나 빌드 성공만으로 업무 기능이 통과했다고 표시하지 마. 실패한 항목의 원인 및 필요한 수정 사항을 보고해 줘. 검증하지 못한 기능은 완료로 표시하지 마.";

  it.each(["codex", "claude"] as const)("offers the .gitignore natural-language request in STEP 02 before STEP 07 git add: %s", tool => {
    const steps = setupGuide(tool);
    const gitignore = steps[2].sections.find(section => section.title === "Git 업로드 제외 파일 자동 설정");
    expect(gitignore).toBeDefined();
    const codeBlock = gitignore?.blocks.find(block => block.kind === "code");
    expect(codeBlock).toEqual({ kind: "code", lines: [gitignorePrompt], notes: ["코딩 에이전트에게 요청할 때 복사해서 사용하세요.", "STEP 07에서 git add .을 실행하기 전에 완료하세요."] });
    expect(JSON.stringify(gitignore)).not.toContain("PowerShell에서 Codex 또는 Claude Code를 실행한 후 아래 요청문을 입력하세요.");
    expect(JSON.stringify(gitignore)).toContain("이미 Git이 추적 중인 파일은 .gitignore만으로 제외되지 않습니다.");
    expect(JSON.stringify(steps[7])).toContain("`git add .` 실행 전 STEP 02의 `.gitignore` 설정과 변경 파일을 확인하세요.");
  });

  it.each(["codex", "claude"] as const)("keeps only the STEP 07 PowerShell box for the five Git commands: %s", tool => {
    const step07 = setupGuide(tool)[7];
    expect(step07.sections.map(section => section.title)).toEqual(["안전하게 Git에 저장", "PR·CI 및 배포 확인"]);
    const save = step07.sections.find(section => section.title === "안전하게 Git에 저장")!;
    const lines = save.blocks.flatMap(block => block.kind === "code" ? block.lines : []);
    expect(lines).toEqual(["git status", "git add .", "git diff --cached", 'git commit -m "변경 사항 반영"', "git push"]);
    // The numbered per-command list was removed: the PowerShell box is now the only command list.
    expect(save.blocks.find(block => block.kind === "steps")).toBeUndefined();
    expect(lines).not.toContain("git diff");
    const serialized = JSON.stringify(save);
    for (const removed of ["git diff --cached --stat", "git branch --show-current", "git remote -v", "git add --"]) expect(serialized).not.toContain(removed);
    // Repeats formerly shown below the box are gone; the intro line above the box replaces them.
    expect(serialized).toContain("프로젝트 폴더에서 변경사항을 확인하고 GitHub에 업로드합니다.");
    for (const removed of ["프로젝트 폴더에서 실행하세요", "git diff --cached로 실제 커밋할 내용을 확인하세요", "API 키·비밀번호·토큰 등 민감정보가 포함된 경우 커밋을 진행하지 마세요."]) expect(serialized).not.toContain(removed);
    // Core safety cautions are kept, condensed: STEP 02 link, no secrets in Git, tracked-file caveat, exposed-key handling.
    expect(serialized).toContain("API 키·비밀번호 등 민감정보는 Git에 저장하지 마세요.");
    expect(serialized).toContain("이미 추적 중인 파일은 .gitignore만으로 보호되지 않습니다.");
    expect(serialized).toContain("이미 노출된 키는 폐기 → 재발급 → 플랫폼 설정 교체 순서로 대응하고, 기록 재작성은 자동 실행하지 않습니다.");
    // First-time setup link is kept: init/remote/user info only when needed.
    expect(serialized).toContain("Git 저장소 초기화와 원격 연결은 STEP 02의 해당 상황에 따라 안내합니다. 최초 커밋 전에 Git 사용자 이름·이메일 설정이 필요하면 STEP 01의 안내를 따르세요.");
    expect(serialized).toContain("최초 git push에서 업스트림 설정이 필요하면 해당 상황에서 추가 명령어를 안내합니다.");
  });

  it.each(["codex", "claude"] as const)("keeps the STEP 07 PR·CI·deploy guidance conditional: %s", tool => {
    const step07 = setupGuide(tool)[7];
    const pr = step07.sections.find(section => section.title === "PR·CI 및 배포 확인")!;
    expect(JSON.stringify(pr)).toContain("GitHub에 변경 사항을 업로드한 후 PR·CI를 사용하는 프로젝트에서는 해당 결과를 확인합니다. 배포는 프로젝트에 실제 설정된 Git 연동 또는 CLI 방식에 따라 진행하고, 실제 운영 환경에 반영되었는지 확인합니다.");
    expect(JSON.stringify(pr)).toContain("코드 업로드, CI 통과, 실제 운영 배포는 서로 다른 단계이므로 각각 확인합니다.");
    const prCode = pr.blocks.find(block => block.kind === "code");
    expect(prCode).toEqual({ kind: "code", lines: deployPromptLines, notes: ["코딩 에이전트에게 요청할 때 복사해서 사용하세요."], prose: true });
    // Exactly one deploy-execution copy block. The duplicated intro lines above it are
    // removed; the copy note below the box still identifies the agent as the target.
    expect(pr.blocks.filter(block => block.kind === "code")).toHaveLength(1);
    expect(JSON.stringify(pr)).not.toContain("PowerShell에서 Codex 또는 Claude Code를 실행한 후 아래 요청문을 입력하세요.");
    expect(JSON.stringify(pr)).not.toContain("PowerShell에서 직접 실행하는 명령이 아니라 실행 중인 코딩 에이전트에 붙여넣는 내용입니다.");
    for (const clause of ["이미 구성된 배포 환경이 있다면 해당 환경을 우선 유지해 줘", "GitHub 연동 자동 배포가 설정되어 있다면", "CLI 직접 배포가 필요한 경우에는 프로젝트의 기존 배포 스크립트와 설정을 우선 사용해 줘", "필요한 경우 Wrangler를 사용하고", "배포가 실행되지 않았거나 실제 반영 여부를 확인하지 못했다면 완료로 표시하지 마"]) expect(deployPromptLines.join("\n")).toContain(clause);
    const serialized = JSON.stringify(pr);
    for (const condition of ["CI가 없으면 통과한 것으로 표시하지 않고", "Preview와 Production 배포를 구분합니다", "git push만으로 운영 배포가 완료된 것은 아니며", "Git 자동 배포와 CLI 배포를 중복 실행하지 않습니다", "배포가 필요 없는 로컬 자동화 프로그램에는 웹 배포를 요구하지 않고", "특정 플랫폼의 배포 명령을 모든 프로젝트에 일괄 적용하지 않습니다"]) expect(serialized).toContain(condition);
    expect(serialized).not.toContain("실패 로그의 API Key·Token·Password·개인정보를 [REDACTED]로 가린 필요한 부분만 AI 도구에 전달하고 로그 전체를 무조건 복사하지 않습니다.");
  });

  it.each(["codex", "claude"] as const)("removes the duplicated agent-request intro from every guide section: %s", tool => {
    const serialized = JSON.stringify(setupGuide(tool));
    expect(serialized).not.toContain("PowerShell에서 Codex 또는 Claude Code를 실행한 후 아래 요청문을 입력하세요.");
    expect(serialized).not.toContain("이 요청문은 PowerShell에서 직접 실행하는 명령이 아니라 실행 중인 코딩 에이전트에 붙여넣는 내용입니다.");
    // The copy note below the request boxes stays, as do the request texts themselves.
    expect(serialized).toContain("코딩 에이전트에게 요청할 때 복사해서 사용하세요.");
    expect(serialized).toContain("현재 프로젝트의 언어, 프레임워크, 실행 환경과 파일 구조를 확인하고 적절한 .gitignore를 구성해 줘.");
    expect(serialized).toContain("현재 프로젝트의 구조, GitHub 연결 상태, 배포 서비스 및 기존 배포 설정을 먼저 확인해 줘.");
  });

  it.each(["codex", "claude"] as const)("keeps STEP 08 to four checks, the refined nine-item verify prompt and a plain completion note: %s", tool => {
    const step08 = setupGuide(tool)[8];
    expect(step08.title).toBe("STEP 08 · 실제 기능 확인 및 완료");
    expect(step08.purpose).toBe("구현한 프로그램을 직접 실행해 주요 기능이 정상 작동하는지 확인합니다.");
    const checks = step08.sections.find(section => section.title === "확인할 내용")!;
    expect(checks.blocks.find(block => block.kind === "steps")).toEqual({ kind: "steps", items: [
      "주요 기능이 요구사항대로 작동하는가?",
      "정상 입력과 잘못된 입력을 올바르게 처리하는가?",
      "데이터 저장 기능이 있다면 저장한 내용이 유지되는가?",
      "실제 사용 환경에서 오류 없이 실행되는가?",
    ] });
    const request = step08.sections.find(section => section.title === "AI 코딩 에이전트에게 기능 검증 요청")!;
    // The repeated PowerShell intro and the 1-5 agent-run steps are removed; only the prompt box remains.
    expect(request.blocks.find(block => block.kind === "steps")).toBeUndefined();
    expect(JSON.stringify(request)).not.toContain("PowerShell에서 Codex 또는 Claude Code를 실행한 후 아래 내용을 입력하세요.");
    const requestCode = request.blocks.find(block => block.kind === "code");
    expect(requestCode).toEqual({ kind: "code", lines: [verifyPrompt], notes: [] });
    // Displayed text and the copy-button string are both lines.join("\n") in AxGuideBlockView, so this pins them equal.
    expect(requestCode?.kind === "code" ? requestCode.lines.join("\n") : "").toBe(verifyPrompt);
    const completion = step08.sections.find(section => section.title === "완료 판정")!;
    expect(JSON.stringify(completion)).toContain("주요 기능이 요구사항대로 작동하고 필요한 검증을 통과했다면 완료로 판단할 수 있습니다. 실패했거나 확인하지 못한 항목은 별도로 기록하고 수정한 뒤 다시 검증하세요.");
    expect(JSON.stringify(completion)).not.toContain("로그의 API Key·Token·Password·개인정보는 [REDACTED]로 가린 필요한 부분만 AI 도구에 전달하며 로그 전체를 무조건 복사하지 않습니다.");
    for (const term of ["실행 증거", "실행 시각", "환경 식별자"]) expect(JSON.stringify(step08)).not.toContain(term);
    // 정밀화된 검증 요청: 9개 필수 확인 항목 + 결과 구분 + 근거 + HTTP 200·빌드 성공 단독 PASS 금지.
    for (const term of ["PASS", "FAIL", "NOT_RUN", "BLOCKED", "HTTP 200", "임의로 정답을 만들지 말고", "사용자 확정한 업무 규칙"]) expect(JSON.stringify(step08)).toContain(term);
  });
});
