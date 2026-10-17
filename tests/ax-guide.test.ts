import { describe, expect, it } from "vitest";
import { buildAgentInstructionModel, buildAllInOnePrompt, guardPlan, planSummary, setupGuide, stepMethodLabel, TOOL_GUIDES, type AxGuideSection } from "../src/lib/ax/guide";
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
  it("keeps tool commands distinct and guides scoped to the selected tool", () => {
    for (const key of ["installCommand", "versionCommand", "runCommand", "doctorCommand"] as const) {
      expect(TOOL_GUIDES.codex[key]).toBeTruthy();
      expect(TOOL_GUIDES.claude[key]).toBeTruthy();
      expect(TOOL_GUIDES.codex[key]).not.toBe(TOOL_GUIDES.claude[key]);
    }
    const sectionText = (section: AxGuideSection) => [section.when ?? "", ...section.blocks.map(block => block.kind === "text" ? block.text : block.kind === "code" ? [...block.lines, ...(block.notes ?? [])].join("\n") : block.items.join("\n"))].join("\n");
    for (const tool of ["codex", "claude"] as const) {
      const other = tool === "codex" ? "claude" : "codex";
      const guide = setupGuide(tool);
      const all = guide.flatMap(step => step.sections.map(sectionText)).join("\n");
      for (const command of ["installCommand", "doctorCommand", "versionCommand"] as const) {
        expect(all).toContain(TOOL_GUIDES[tool][command]);
        expect(all).not.toContain(TOOL_GUIDES[other][command]);
      }
      // STEP 01: install-first order (install → verify → git config → auth → login)
      const step01 = guide[1];
      expect(step01.title).toContain("STEP 01");
      expect(step01.sections[0].title).toBe("필요한 프로그램 설치");
      expect(step01.sections[1].title).toBe("설치 확인");
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

describe("AX setup guide deployment platform and storage", () => {
  it.each(["codex", "claude"] as const)("includes platform selection and storage guidance in STEP 02 for %s", tool => {
    const step02 = setupGuide(tool)[2];
    const titles = step02.sections.map(section => section.title);
    expect(titles).toContain("배포 플랫폼 선택");
    expect(titles).toContain("데이터 저장 방식 선택");
    const platform = JSON.stringify(step02.sections.find(section => section.title === "배포 플랫폼 선택"));
    expect(platform).toContain("Vercel");
    expect(platform).toContain("Cloudflare");
    expect(platform).toMatch(/Hobby[^.]*개인·비상업적/u);
    const storage = JSON.stringify(step02.sections.find(section => section.title === "데이터 저장 방식 선택"));
    for (const term of ["D1", "R2", "KV", "브라우저 저장"]) expect(storage).toContain(term);
    expect(storage).toMatch(/최종 일관성[^.]*주 DB[^.]*권장하지/u);
  });
  it.each(["codex", "claude"] as const)("includes free tier limits with official sources in STEP 08 for %s", tool => {
    const step08 = setupGuide(tool)[8];
    const titles = step08.sections.map(section => section.title);
    expect(titles).toContain("배포 전 확인 체크리스트");
    expect(titles).toContain("Cloudflare D1·R2·KV 무료 한도");
    expect(titles).toContain("Vercel Hobby 제한 안내");
    const limits = JSON.stringify(step08.sections.find(section => section.title === "Cloudflare D1·R2·KV 무료 한도"));
    expect(limits).toContain("100,000회/일");
    expect(limits).toContain("500만 행/일");
    expect(limits).toContain("10GB-month/월");
    expect(limits).toContain("developers.cloudflare.com");
    expect(limits).toContain("기준일");
    const vercel = JSON.stringify(step08.sections.find(section => section.title === "Vercel Hobby 제한 안내"));
    expect(vercel).toMatch(/비상업적·개인/u);
    expect(vercel).toContain("vercel.com/docs/plans/hobby");
  });
  it.each(["codex", "claude"] as const)("uses native installers without winget for %s", tool => {
    expect(TOOL_GUIDES[tool].installCommand).not.toContain("winget");
    const step01 = JSON.stringify(setupGuide(tool)[1]);
    expect(step01).not.toContain("winget");
    expect(step01).toContain("https://git-scm.com/download/win");
    expect(step01).toContain("https://nodejs.org/");
    expect(step01).toContain("https://cli.github.com/");
  });
  it.each(["codex", "claude"] as const)("removes basic dir and Get-Location guidance in STEP 02 for %s", tool => {
    const step02 = JSON.stringify(setupGuide(tool)[2]);
    expect(step02).not.toContain("`dir`");
    expect(step02).not.toContain("Get-Location");
    expect(step02).toContain("git status");
  });
  it.each(["codex", "claude"] as const)("includes DB pre-connection checklist and storage connection flow in STEP 02 for %s", tool => {
    const step02 = setupGuide(tool)[2];
    const titles = step02.sections.map(section => section.title);
    expect(titles).toContain("DB 연결 전 준비");
    expect(titles).toContain("D1·R2·KV 연결 절차");
    const prep = JSON.stringify(step02.sections.find(section => section.title === "DB 연결 전 준비"));
    for (const term of ["필요한 서비스만 선택", "개발용·운영용", "기존 데이터"]) expect(prep).toContain(term);
    const flow = JSON.stringify(step02.sections.find(section => section.title === "D1·R2·KV 연결 절차"));
    for (const term of ["D1 연결", "R2 연결", "KV 연결", "사전 승인 없이 실행하지 않습니다"]) expect(flow).toContain(term);
  });
  it.each(["codex", "claude"] as const)("distinguishes overage handling per service in STEP 08 for %s", tool => {
    const limits = JSON.stringify(setupGuide(tool)[8].sections.find(section => section.title === "Cloudflare D1·R2·KV 무료 한도"));
    expect(limits).toMatch(/R2.*초과.*요금이 부과/u);
    expect(limits).toMatch(/실패하고 자동 과금되지 않습니다/u);
    const vercel = JSON.stringify(setupGuide(tool)[8].sections.find(section => section.title === "Vercel Hobby 제한 안내"));
    expect(vercel).toContain("2026-09-14");
    expect(vercel).toMatch(/30일/u);
  });
  it.each(["codex", "claude"] as const)("includes production DB verification in STEP 09 for %s", tool => {
    const step09 = setupGuide(tool)[9];
    const titles = step09.sections.map(section => section.title);
    expect(titles).toContain("DB·스토리지 Production 검증");
    const verify = JSON.stringify(step09.sections.find(section => section.title === "DB·스토리지 Production 검증"));
    expect(verify).toMatch(/사용하는 서비스[^.]*확인/u);
    expect(verify).toMatch(/검증하지 못한 항목[^.]*완료로 표시하지/u);
  });
  it.each(["codex", "claude"] as const)("keeps 9 steps and tool-independent steps identical for %s", tool => {
    const guide = setupGuide(tool);
    const other = tool === "codex" ? "claude" : "codex";
    expect(guide).toHaveLength(10);
    expect(guide[2]).toEqual(setupGuide(other)[2]);
    for (const index of [5, 6, 7, 8, 9]) expect(guide[index]).toEqual(setupGuide(other)[index]);
  });
});
