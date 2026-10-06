import type { AxDiagnosis, AxPlan } from "./types";
import { automationLevel, axes, executionGate, GATE_LABELS } from "./policy";

export type AxToolId = "codex" | "claude";

export const TOOL_GUIDES: Record<AxToolId, {
  name: string; versionCommand: string; installCommand: string; runCommand: string; doctorCommand: string; loginNote: string;
}> = {
  codex: { name: "Codex", versionCommand: "codex --version", installCommand: "npm install -g @openai/codex@latest", runCommand: "codex", doctorCommand: "codex doctor", loginNote: "첫 실행 시 ChatGPT 계정으로 로그인합니다." },
  claude: { name: "Claude Code", versionCommand: "claude --version", installCommand: "npm install -g @anthropic-ai/claude-code", runCommand: "claude", doctorCommand: "claude doctor", loginNote: "첫 실행 시 브라우저에서 로그인합니다." },
};

/** Inline text marks commands with backticks; `code` blocks hold PowerShell lines run in order. */
export type AxGuideBlock = { kind: "text"; text: string } | { kind: "code"; lines: string[] } | { kind: "steps"; items: string[] };
export interface AxGuideSection { title: string; when?: string; blocks: AxGuideBlock[] }
export interface AxGuideStep { title: string; sections: AxGuideSection[] }

const text = (value: string): AxGuideBlock => ({ kind: "text", text: value });
const code = (...lines: string[]): AxGuideBlock => ({ kind: "code", lines });

export function setupGuide(tool: AxToolId): AxGuideStep[] {
  const guide = TOOL_GUIDES[tool];
  return [
    { title: "STEP 0 · 개발 환경 준비", sections: [
      { title: "필요한 프로그램 확인", blocks: [
        text("PowerShell을 열고 먼저 설치 여부를 확인합니다. 버전이 표시되는 프로그램은 이미 설치된 것이므로 해당 설치 단계를 건너뜁니다."),
        code("git --version", "node --version", "npm --version", guide.versionCommand),
      ] },
      { title: "Git 설치", when: "Git 버전이 표시되지 않는 경우에만", blocks: [
        code("winget install --id Git.Git -e --source winget"),
        text("설치 후 새 PowerShell을 열고 `git --version`으로 다시 확인합니다."),
      ] },
      { title: "Node.js 설치", when: "Node.js 버전이 표시되지 않는 경우에만", blocks: [
        text("nodejs.org에서 LTS를 설치하고 `node --version`으로 다시 확인합니다. 프로젝트에 .nvmrc, .node-version 또는 package.json engines가 있으면 해당 요구사항을 우선합니다."),
      ] },
      { title: "Git 사용자 정보", when: "처음 한 번, 값이 비어 있을 때만", blocks: [
        text("현재 값을 확인합니다."),
        code("git config --global user.name", "git config --global user.email"),
        text("비어 있을 때만 설정합니다. 기존 값은 덮어쓰지 않습니다."),
        code('git config --global user.name "이름"', 'git config --global user.email "메일주소"'),
      ] },
      { title: `${guide.name} 설치`, when: `\`${guide.versionCommand}\`이 실패하는 경우에만`, blocks: [
        code(guide.installCommand),
        text(`설치 후 \`${guide.versionCommand}\`으로 다시 확인합니다. 문제가 있으면 \`${guide.doctorCommand}\`으로 점검합니다.`),
      ] },
    ] },
    { title: "STEP 1 · 프로젝트 준비", sections: [
      { title: "기본 명령", blocks: [text("`mkdir` 새 폴더 만들기 · `cd` 폴더 이동 · `dir` 폴더 내용 확인 · `Get-Location` 현재 위치 확인")] },
      { title: "A. GitHub에 있는 기존 프로젝트", when: "GitHub에는 프로젝트가 있지만 이 PC에는 아직 없는 경우", blocks: [
        code("mkdir C:\\Work", "cd C:\\Work", "git clone <저장소 URL>", "cd <프로젝트 폴더>", "git status"),
        text("clone 후 lockfile, package.json과 저장소 지침을 함께 확인해 설치 명령을 정합니다. package-lock.json → npm, pnpm-lock.yaml → pnpm, bun.lock → Bun, yarn.lock → Yarn이 단서이며 파일 하나로 단정하지 않습니다."),
      ] },
      { title: "B. PC에 이미 있는 프로젝트", when: "이 PC에 기존 프로젝트 폴더가 있는 경우", blocks: [
        code('cd "C:\\프로젝트\\경로"', "git status"),
        text("이미 Git 저장소면 그대로 사용합니다."),
      ] },
      { title: "C. 새 프로젝트", when: "새 폴더에서 처음 시작하는 경우", blocks: [
        code("mkdir C:\\Work\\MyProject", "cd C:\\Work\\MyProject"),
        text("이후 AI 도구가 요구사항을 확인해 프레임워크, Git 초기화와 GitHub 연결 필요성을 결정합니다. 특정 프레임워크를 임의로 정하지 않습니다."),
      ] },
    ] },
    { title: "STEP 2 · 도구 실행", sections: [
      { title: "프로젝트 폴더에서 실행", blocks: [
        text("AI 도구는 반드시 작업할 프로젝트 폴더 안에서 실행합니다. `Get-Location`과 `dir`로 위치와 내용을 확인한 뒤 실행하세요."),
        code('cd "프로젝트 경로"', "Get-Location", "dir", guide.runCommand),
        text(guide.loginNote),
      ] },
      { title: "올인원 지시문 실행", blocks: [{ kind: "steps", items: [
        `아래 ${guide.name}용 올인원 지시문 전체를 복사합니다.`,
        "실행한 AI 도구에 지시문을 붙여넣습니다.",
        "AI가 저장소를 분석하고 구현·검증을 진행합니다. 승인·검토 요청이 있으면 내용을 확인합니다.",
      ] }] },
    ] },
  ];
}

function axPromptTitle(taskName?: string): string {
  const name = taskName?.trim() || "업무";
  return `# ${name.endsWith("자동화") ? name : `${name} 자동화`} 구현 지시문`;
}

/** Level constraints keep the implementation inside the diagnosed automation scope; a higher level is not a goal. */
const LEVEL_CONSTRAINTS = [
  "업무 정리와 보조 도구 수준으로 구현하세요. 시스템이 업무를 자동 실행하는 기능을 임의로 추가하지 마세요.",
  "결과를 만들어 제안하는 보조 기능 중심으로 구현하고 자동 실행 범위는 보수적으로 제한하세요. 예외 검토와 최종 판단·승인은 담당자에게 유지합니다. 자동화 범위를 Level 2~3 수준으로 확대하지 마세요.",
  "반복·규칙 기반 단계는 자동화할 수 있지만 주요 예외와 승인 단계는 담당자에게 유지합니다.",
  "높은 수준의 자동화가 가능하지만 승인·안전·법률·권한과 관련된 단계는 진단 결과대로 유지합니다.",
] as const;

const GATE_CONSTRAINTS = {
  ready: "현재 진단상 구현을 진행할 수 있습니다. 다만 저장소 구조와 실제 연동 조건은 작업 시작 전에 다시 확인하세요.",
  conditional: "'구현 전 확인사항'을 확인하기 전에는 관련 기능을 확정 구현하지 마세요. 확인되지 않은 API·권한·파일 형식·연동 방식을 추측하지 마세요.",
  blocked: "차단 사유가 해결되기 전에는 운영 적용이나 자동 실행 범위를 확대하지 마세요. 가능한 경우 검증용 PoC 또는 준비 작업까지만 진행하세요.",
} as const;

const OWNER_LABELS = { 시스템: "시스템", AI: "AI", 사용자: "담당자" } as const;
/** Quantified targets (절감률·정확도·배수) need evidence the plan cannot carry, so such items are removed. */
const UNSUPPORTED_METRIC = /\d+(?:\.\d+)?\s*(?:%|퍼센트|배)/u;
const ORGANIZATION = /[가-힣A-Za-z]+(?:팀|부서|본부)/gu;
const AUTO_ACTION = /자동(?:으로)?\s*(삭제|제거|승인|등록|전송|결재|수정|보정)/u;
const SYSTEM_INTERFACE = /\bAPI\b|SDK|엔드포인트|endpoint/iu;
const UNCONFIRMED = "(확인 필요:";
type PlanListKey = Exclude<keyof AxPlan, "repositoryFirst">;

/**
 * Second line of defense after the generation prompt: keep grounded items, qualify plausible but unverified
 * ones in place, drop unsupported metrics. Qualified items carry the marker, so applying it twice changes nothing.
 */
export function guardPlan(plan: AxPlan, context: string): AxPlan {
  // Exclusions and prerequisites already name what must not happen or must be checked; only metrics and orgs apply there.
  const guardItem = (item: string, qualify: boolean): string | null => {
    if (UNSUPPORTED_METRIC.test(item)) return null;
    let value = item.replace(ORGANIZATION, org => context.includes(org) ? org : "담당 조직");
    if (value.includes(UNCONFIRMED)) return value;
    const action = qualify ? AUTO_ACTION.exec(value)?.[1] : undefined;
    if (action && !new RegExp(`자동(?:으로)?\\s*${action}`, "u").test(context)) value = `${value} ${UNCONFIRMED} 업무 규칙에서 확인된 경우에만 적용하고, 아니면 대상 건을 표시만 하세요)`;
    else if (qualify && SYSTEM_INTERFACE.test(value) && !/확인/u.test(value) && !SYSTEM_INTERFACE.test(context)) value = `${value} ${UNCONFIRMED} 실제 연동 방식과 권한을 확인한 뒤 확인된 방식만 사용하세요)`;
    if (value !== item && value.includes("담당 조직") && !value.includes(UNCONFIRMED)) value = `${value} ${UNCONFIRMED} 실제 담당 조직을 확인하세요)`;
    return value;
  };
  const guarded = { ...plan };
  for (const key of Object.keys(plan) as (keyof AxPlan)[]) {
    if (key === "repositoryFirst") continue;
    const qualify = key !== "outOfScope" && key !== "prerequisites";
    guarded[key as PlanListKey] = plan[key as PlanListKey].map(item => guardItem(item, qualify)).filter((item): item is string => item !== null);
  }
  return guarded;
}

export function buildAllInOnePrompt(rawPlan: AxPlan, _tool: AxToolId, options?: { taskName?: string; prerequisites?: string[]; diagnosis?: AxDiagnosis; context?: string }): string {
  const bullets = (items: string[]) => items.map(item => `- ${item}`).join("\n");
  // AI items sometimes carry their own "1)" prefix; the prompt numbers them itself.
  const numbered = (items: string[]) => items.map((item, i) => `${i + 1}. ${item.replace(/^\s*(?:\d+[.)]|[①-⑳])\s*/u, "")}`).join("\n");
  const unique = (items: string[]) => [...new Set(items.map(item => item.trim()).filter(Boolean))];
  const compact = (value: string) => value.replace(/\s+/gu, "");
  /** Adds extra items unless one already says the same thing (either contains the other). */
  const mergeDistinct = (base: string[], extra: string[]) => unique([...base, ...extra.filter(item => !base.some(existing => compact(existing).includes(compact(item).replace(/\(담당자수행\)$/u, "")) || compact(item).includes(compact(existing))))]);
  const context = [options?.taskName ?? "", options?.context ?? ""].join("\n");
  const plan = guardPlan(rawPlan, context);
  const d = options?.diagnosis;
  const level = d ? automationLevel(d) : null;
  const gate = d ? executionGate(d) : null;
  const manualSteps = d ? d.stepAssessments.filter(s => s.verdict === "사람 유지").map(s => s.step) : [];
  const manualLabels = manualSteps.map(step => `${step} (담당자 수행)`);
  const humanReview = mergeDistinct(plan.humanInLoop, manualLabels);
  const goals = plan.goal, acceptance = plan.acceptance, tests = plan.tests, poc = plan.poc, operation = plan.operation, fallback = plan.fallback;
  const prerequisites = unique([...plan.prerequisites, ...(options?.prerequisites ?? [])]);
  const exceptions = mergeDistinct(plan.exceptions, d?.asIs.exceptions ?? []);
  const introduction = [
    axPromptTitle(options?.taskName),
    "현재 프로젝트 저장소를 먼저 확인한 뒤 아래 요구사항을 구현하세요. 확인되지 않은 파일명·함수명·API·업무 규칙을 추측하지 말고 기존 구현과 실제 업무 자료를 우선 확인하세요.",
  ];
  const sections: { title: string; body: string }[] = [];
  const section = (title: string, ...content: string[]) => sections.push({ title, body: content.filter(Boolean).join("\n\n") });

  if (goals.length) section("작업 목표", bullets(goals),
    humanReview.length ? `구현 후에도 다음 담당자 검토·승인 단계는 유지합니다: ${humanReview.join(", ")}.` : "");
  if (d && level && gate) {
    const a = axes(d);
    section("현재 진단 기준", bullets([
      `자동화 수준: ${level.label.replace(/^L\d+ /, "")} · Level ${level.level}${level.provisional ? " (정보 부족으로 잠정 판정)" : ""}`,
      `자동화 가치: ${a.value}/5`, `기술 실현 가능성: ${a.feasibility}/5`, `담당자 판단 필요도: ${a.judgment}/5`, `운영 위험: ${a.risk}/5`,
      `실행 상태: ${GATE_LABELS[gate]}`,
    ]), `현재 진단은 \`${level.label.replace(/^L\d+ /, "")} · Level ${level.level}\`입니다. ${LEVEL_CONSTRAINTS[level.level]}`,
    `실행 상태는 \`${GATE_LABELS[gate]}\`입니다. ${GATE_CONSTRAINTS[gate]}`);
  }
  section("작업 전 현재 프로젝트 확인", bullets([
    "저장소 지침 파일(AGENTS.md 등)이 있으면 먼저 읽고 그 규칙을 따르세요.",
    "`git status`와 현재 branch로 작업 상태를 확인하세요.",
    "프로젝트 구조, framework/runtime, package manager와 lockfile을 확인하세요.",
    "이 작업과 관련된 기존 구현과 재사용할 수 있는 컴포넌트·함수를 확인하세요.",
    "package scripts에서 테스트·typecheck·빌드·배포 명령과 테스트 방식을 확인하세요.",
    "이 프로젝트가 웹 애플리케이션인지, 로컬 스크립트·CLI·Excel 자동화인지 확인하세요.",
  ]));
  if (d?.asIs.steps.length) section("AS-IS", `현재 업무는 다음 순서로 수행됩니다.${d.asIs.purpose ? ` 목적: ${d.asIs.purpose}` : ""}`, numbered(d.asIs.steps), "자동화 후에도 이 흐름의 목적과 담당자 역할을 유지하세요.");
  else if (plan.asIs.length) section("AS-IS", "현재 업무는 다음과 같이 수행됩니다. 자동화 후에도 이 흐름의 목적과 담당자 역할을 유지하세요.", bullets(plan.asIs));
  if (d?.toBe.length) section("TO-BE", "구현 후에는 다음 역할로 업무가 진행되어야 합니다.", numbered(d.toBe.map(s => `${s.step} — ${OWNER_LABELS[s.owner]}: ${s.description}`)), "담당자 역할로 표시된 단계는 자동화로 대체하지 마세요. 이 중 '작업 범위'의 제외 항목에 해당하는 부분은 이번 작업에서 구현하지 마세요.");
  else if (plan.toBe.length) section("TO-BE", "구현 후 업무는 다음과 같은 상태가 되어야 합니다. 담당자의 승인·검토 역할은 임의로 제거하지 마세요.", bullets(plan.toBe));
  const excluded = mergeDistinct(plan.outOfScope, manualLabels);
  if (plan.inScope.length || excluded.length) section("작업 범위",
    plan.inScope.length ? `### 포함\n\n${bullets(plan.inScope)}` : "",
    excluded.length ? `### 제외\n\n${bullets(excluded)}` : "",
    "제외 범위에 해당하는 기능은 이번 작업에서 임의로 추가하지 마세요.",
    level && level.level <= 2 ? "진단에서 제외되거나 담당자 유지로 분류된 단계를 임의로 자동화하지 마세요." : "",
  );
  if (prerequisites.length) section("구현 전 확인사항", bullets(prerequisites), "확인되지 않은 항목은 '확인 필요'로 유지하고, 확인되지 않은 API나 권한이 있다고 가정해 구현하지 마세요.");
  section("구현 원칙", bullets([
    ...(plan.repositoryFirst ? [plan.repositoryFirst] : []),
    "기존 구현을 우선 재사용하고, 요청 범위 안에서 최소한으로 수정하세요.",
    "요청하지 않은 기능이나 불필요한 신규 라이브러리를 추가하지 마세요.",
    "확인되지 않은 업무 규칙(매칭 기준·계산·반올림·중복 처리)은 추측하지 말고 '확인 필요'로 보고하세요.",
    "확인되지 않은 담당 조직·승인 주체·운영 체계를 지정하지 마세요.",
    "근거 없는 절감률·정확도·오류 감소율 같은 수치 목표를 만들지 마세요.",
    "값을 하드코딩하거나 테스트용 임시 데이터를 실제 로직에 남기지 마세요.",
    "기존 데이터·기능·인증·권한 구조와의 호환성을 유지하세요.",
    "타입·빌드·런타임 오류를 남긴 채 완료로 처리하지 마세요.",
  ]));
  const inputs = d?.asIs.inputs ?? [], outputs = d?.asIs.outputs ?? [];
  if (plan.implementation.length || inputs.length || plan.dataFlow.length) section("구현 요구사항",
    inputs.length ? `### 입력 확인\n\n${bullets(inputs)}\n\n실제 샘플의 구조(시트·헤더·필수 항목·데이터 형식)를 확인한 뒤 처리하세요. 확인 전에는 컬럼명이나 시트 이름을 하드코딩하지 마세요.` : "",
    "### 검증\n\n필수 항목 누락, 빈 행, 읽을 수 없는 값은 정상 데이터와 구분하세요. 오류가 있는 입력을 조용히 정상 처리하지 마세요.",
    plan.implementation.length ? `### 처리 순서\n\n${numbered(plan.implementation)}` : "",
    plan.dataFlow.length ? `### 데이터 흐름\n\n${bullets(plan.dataFlow)}` : "",
    "### 예외 분리\n\n매칭되지 않거나 확인할 수 없는 데이터에 임의의 값을 적용하지 말고 별도로 분리하세요. 자동 삭제·자동 보정은 기존 업무 규칙에 명시된 경우에만 적용하고, 그렇지 않으면 대상 건을 표시만 하세요.",
    `### 결과 생성\n\n${outputs.length ? `결과물: ${outputs.join(", ")}\n\n` : ""}결과에서 정상 처리 건과 검토 필요·처리 실패 건을 구분할 수 있어야 합니다.`,
    humanReview.length ? `### 담당자 검토\n\n${bullets(humanReview)}\n\n위 단계는 담당자가 확인할 수 있도록 유지하고, 자동화 범위를 넓히면서 제거하지 마세요.` : "",
  );
  if (plan.integrations.length) section("외부 연동", bullets(plan.integrations), "연동 대상의 실제 API·권한·인증 방식은 저장소와 공식 설정에서 확인하세요. 확인되지 않은 endpoint나 SDK를 지어내지 마세요.");
  if (exceptions.length) section("예외 처리", "다음 예외 상황을 처리하세요.", bullets(exceptions), "실패·미매칭·확인 불가 데이터를 정상 처리 결과에 섞지 말고, 사용자가 원인과 대상을 확인할 수 있게 구분하세요.");
  if (fallback.length || operation.length) section("문제 발생 시 대응",
    fallback.length ? `### 자동화 실패 시\n\n${bullets(fallback)}\n\n자동화와 기존 수동 절차 사이의 전환 지점을 명확히 유지하세요.` : "",
    operation.length ? `### 운영\n\n${bullets(operation)}\n\n운영 담당자와 장애 대응 담당자는 현재 조직의 실제 운영 체계를 확인한 뒤 반영하세요.` : "",
  );
  if (plan.security.length) section("보안", bullets([
    ...plan.security,
    "secret은 코드에 하드코딩하지 말고 저장소의 기존 secret 관리 방식을 사용하세요.",
    "민감한 데이터를 불필요하게 로그에 남기지 말고 최소 권한 원칙을 유지하세요.",
  ]));
  section("검증 방법",
    "저장소에 실제로 존재하는 검증 명령과 도구를 확인한 뒤 실행하세요. 없는 테스트 framework나 명령을 임의로 설치하지 마세요.",
    `### 정상 케이스\n\n${bullets([...tests, "정의된 샘플 데이터에 대해 자동 결과가 기존 수동 결과와 일치하는지 대조하세요. 허용 오차가 기존 업무에 정의되어 있으면 그 기준을 사용하고, 없으면 임의의 허용 오차를 만들지 마세요."])}`,
    "### 경계값\n\n입력 1건, 빈 입력, 같은 기준값이 여러 건인 경우, 선택 항목이 비어 있는 경우처럼 이 업무의 입력에 해당하는 경계 상황을 확인하세요.",
    `### 실패·예외 케이스\n\n${exceptions.length ? "'예외 처리' 섹션의 각 상황을 재현하고, " : ""}잘못된 형식·필수 항목 누락 같은 실패가 정상 결과로 표시되지 않는지 확인하세요.`,
    poc.length ? `### 사전 검증\n\n${bullets(poc)}` : "",
    "### 회귀 검증\n\n이 작업과 관련된 기존 기능이 이전과 동일하게 동작하는지 확인하세요. 웹 UI를 포함하면 기존 브라우저/E2E 도구가 있을 때 주요 화면을 Desktop과 Mobile에서 확인하고, 도구가 없으면 새로 설치하지 말고 그 사실을 보고하세요.",
  );
  section("Git 반영", bullets([
    "작업 전후로 `git status`, 현재 branch, `git diff`를 확인하고 기존 작업을 덮어쓰지 마세요.",
    "의도한 파일만 `git add <파일>`로 stage하세요. `git add .`로 전체를 추가하지 마세요.",
    "force push, `git reset --hard` 같은 파괴적인 명령을 사용하지 마세요.",
  ]), "stage·commit·push·PR은 사용자 요청 범위, 도구 권한, 저장소 branch/PR 정책이 모두 허용할 때만 진행하세요. 허용되지 않으면 실행하지 말고 현재 Git 상태, 추천 commit 메시지, 다음에 실행할 명령을 보고하세요.");
  section("배포 및 운영 적용", bullets([
    "웹 애플리케이션이면 저장소의 기존 CI/CD·배포 설정과 package scripts에서 배포 방식을 먼저 확인하세요. 배포 플랫폼을 임의로 선택하거나 새 배포 도구를 설치하지 마세요.",
    "로컬 스크립트·CLI·Excel 자동화처럼 웹 배포가 필요 없으면 배포 대신 실행 환경 구성과 운영 적용으로 처리하세요.",
    "배포 방식을 확인할 수 없으면 '배포 방식 확인 필요'로 보고하세요.",
    "Production 배포는 사용자가 배포를 요청했고 권한이 확인된 경우에만 기존 방식으로 실행하세요. 실행하지 않았다면 그 이유와 다음 행동을 보고하세요.",
    "배포 또는 운영 적용을 수행했다면 실제 환경에서 입력 → 처리 → 결과 흐름과 오류 여부를 확인하고, 문제가 있으면 수정 → 재적용 → 동일 시나리오 재검증 순서로 진행하세요.",
  ]));
  section("완료 조건", bullets([
    ...acceptance,
    "요청한 기능이 정상 작동하고 기존 기능과 데이터가 유지됩니다.",
    ...(humanReview.length ? ["담당자 검토·승인 단계가 유지됩니다."] : []),
    "정상·경계·실패 케이스 검증이 통과하고, 실패 건이 정상 결과와 구분됩니다.",
    "타입 오류와 빌드 오류가 없습니다.",
    "배포 또는 운영 적용을 수행한 경우 실제 환경에서 핵심 기능을 검증합니다. 수행하지 않은 경우 사유와 미실행 항목을 명확히 보고합니다.",
    "실행하지 않은 검증은 완료로 보고하지 말고 미실행으로 명시합니다.",
  ]));
  section("완료 보고", "작업이 끝나면 다음 형식으로 보고하세요.", numbered([
    "확인한 현재 구조", "수정한 파일", "구현한 내용", "테스트·검증 결과", "확인 필요로 남긴 업무 규칙", "Git 상태", "배포/운영 적용 결과", "남은 위험 또는 미실행 항목",
  ]), "실제로 수행하지 않은 작업을 완료했다고 보고하지 마세요.");
  return [...introduction, ...sections.filter(section => section.body).map((section, i) => `## ${i + 1}. ${section.title}\n\n${section.body}`)].join("\n\n");
}
