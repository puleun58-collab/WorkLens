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
      "STEP 06 · 데이터 저장 방식", "STEP 07 · GitHub 저장과 배포", "STEP 08 · 기능 검증과 MVP 완료",
    ]);
    expect(JSON.stringify(steps[3])).toContain("04 올인원 지시문");
    expect(JSON.stringify(steps[4])).toContain("실제 입력 데이터");
    expect(JSON.stringify(steps[8])).toContain("웹 배포가 필요 없는");
  });
  it.each(["codex", "claude"] as const)("starts the Wrangler no-CLI-addition sentence as its own paragraph: %s", tool => {
    const step05 = setupGuide(tool)[5];
    expect(step05.title).toBe("STEP 05 · 배포 플랫폼 선택");
    const wrangler = step05.sections.find(section => section.title === "Cloudflare의 Wrangler");
    expect(wrangler).toBeDefined();
    const texts = (wrangler?.blocks ?? []).filter(block => block.kind === "text").map(block => block.text);
    expect(texts).toContain("기존 Pages/Git 자동 배포에 CLI를 추가하지 않습니다.");
    // The sentence must be a standalone paragraph, not the tail of a longer paragraph,
    // so it always starts on a new line instead of dangling across a line break.
    expect(texts.filter(text => text.includes("기존 Pages/Git 자동 배포에 CLI를 추가하지 않습니다."))).toEqual([
      "기존 Pages/Git 자동 배포에 CLI를 추가하지 않습니다.",
    ]);
    expect(texts).toContain("기존 packageManager·lockfile·Wrangler 버전·스크립트를 유지합니다. 새 npm Cloudflare 프로젝트에 Wrangler CLI가 필요하고 없을 때에만 다음 명령으로 로컬 devDependency에 설치합니다.");
  });
  it("presents the intro glossary as the Git·GitHub work flow in execution order", () => {
    const flow = setupGuide("codex")[0].sections[2];
    expect(flow.title).toBe("Git·GitHub 작업 흐름");
    expect(flow.collapsed).toBe(true);
    const [terms, ...notes] = flow.blocks;
    expect(terms).toEqual({ kind: "steps", items: [
      "Git: 코드 변경 이력을 관리하는 도구",
      "git init / git clone: 새 저장소 만들기 / 기존 저장소 복제하기",
      "Branch: 기존 코드와 분리해 작업하는 공간",
      "git add: 변경 파일을 커밋 대상으로 선택",
      "git commit: 변경 내용을 이력으로 저장",
      "git push: 변경 이력을 GitHub에 업로드",
      "PR: 변경 내용을 검토하고 병합하도록 요청",
      "CI: 테스트·빌드 등을 자동 검사",
      "Merge: 변경 사항을 대상 브랜치에 병합",
      "Deploy: 실제 서비스 환경에 배포",
      "Production 검증: 배포된 서비스의 정상 작동 확인",
    ] });
    expect(notes).toEqual([
      { kind: "text", text: "git init과 git clone은 프로젝트 상태에 따라 선택하며, 기존 저장소를 다시 초기화하지 않습니다." },
      { kind: "text", text: "CI는 Push 또는 PR 생성 시 실행될 수 있습니다." },
      { kind: "text", text: "Merge와 Deploy는 서로 다른 작업이며, 배포 완료 후 실제 기능 검증이 필요합니다." },
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
      "설치 순서 안내", "Git 설치", "Git 사용자 정보 설정", "Node.js LTS 설치", `${TOOL_GUIDES[tool].name} 설치`, "설치 오류 확인",
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
    for (const term of ["packageManager", "D1", "R2", "KV", "외부 DB", "git remote -v", "git diff --cached", "폐기 → 재발급", "기록 재작성", "PASS/FAIL/NOT_RUN/BLOCKED", "[REDACTED]"]) expect(all).toContain(term);
    expect(JSON.stringify(steps[5])).toContain("npm i -D wrangler@latest");
    expect(JSON.stringify(steps[7])).toContain("자동 배포라면 수동 명령을 중복 실행하지 않습니다");
    expect(JSON.stringify(steps[8])).toContain("구현 완료, 테스트 통과, 배포 완료, 운영 기능 확인");
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
  it.each(["codex", "claude"] as const)("compares platforms and connects only needed storage for %s", tool => {
    const steps = setupGuide(tool);
    const platform = steps[5].sections.find(section => section.title === "배포 방식 비교")!;
    const comparison = platform.blocks.find(block => block.kind === "table");
    expect(comparison?.kind).toBe("table");
    if (comparison?.kind !== "table") throw new Error("missing comparison");
    expect(comparison.headers).toEqual(["비교", "Vercel", "Cloudflare"]);
    expect(JSON.stringify(comparison.rows)).toContain("D1");
    expect(JSON.stringify(platform)).toContain("vercel.com/docs/plans/hobby");
    const storage = steps[6].sections;
    expect(storage.map(section => section.title)).toContain("Cloudflare 저장소 연결");
    for (const term of ["D1 · 구조화된 기록", "R2 · 파일과 첨부", "KV · 조회 중심 값"]) {
      expect(storage.find(section => section.title === term)).toMatchObject({ collapsed: true, when: expect.any(String) });
    }
  });
});
