import type { AxPlan } from "./types";

export type AxToolId = "codex" | "claude";

export const TOOL_GUIDES: Record<AxToolId, {
  name: string; versionCommand: string; installCommand: string; runCommand: string; doctorCommand: string; loginNote: string;
}> = {
  codex: { name: "Codex", versionCommand: "codex --version", installCommand: "npm install -g @openai/codex@latest", runCommand: "codex", doctorCommand: "codex doctor", loginNote: "첫 실행 시 ChatGPT 계정으로 로그인합니다." },
  claude: { name: "Claude Code", versionCommand: "claude --version", installCommand: "npm install -g @anthropic-ai/claude-code", runCommand: "claude", doctorCommand: "claude doctor", loginNote: "첫 실행 시 브라우저에서 로그인합니다." },
};

export function environmentGuide(tool: AxToolId): string[] {
  return [
    `PowerShell을 열고 먼저 버전을 확인합니다: \`git --version\`, \`node --version\`, \`npm --version\`, \`${TOOL_GUIDES[tool].versionCommand}\`. 이미 설치돼 있으면 다시 설치하지 않습니다.`,
    "Git이 없을 때만 `winget install --id Git.Git -e --source winget`을 실행합니다. 새 PowerShell을 열고 `git --version`으로 확인합니다.",
    "Node.js가 없을 때만 nodejs.org에서 LTS를 설치합니다. 프로젝트에 .nvmrc, .node-version 또는 package.json engines가 있으면 해당 요구사항을 우선합니다.",
    'Git 최초 설정을 `git config --global user.name`, `git config --global user.email`로 확인합니다. 비어 있을 때만 예를 들어 `git config --global user.name "이름"`, `git config --global user.email "메일주소"`로 설정합니다. 기존 값은 덮어쓰지 않습니다.',
    "기본 명령: `mkdir`은 새 폴더 만들기, `cd`는 폴더 이동, `dir`은 폴더 내용 확인, `Get-Location`은 현재 위치 확인입니다.",
  ];
}

export function installGuide(tool: AxToolId): string[] {
  const guide = TOOL_GUIDES[tool];
  return [`도구가 없을 때만 \`${guide.installCommand}\`로 설치합니다.`, `\`${guide.versionCommand}\`으로 버전을 확인합니다.`, `\`${guide.runCommand}\`을 실행합니다. ${guide.loginNote}`, `문제가 있으면 \`${guide.doctorCommand}\`으로 점검합니다.`];
}

export function projectPrepGuide(): { cases: { id: "github" | "local" | "new"; title: string; steps: string[] }[] } {
  const common = "AI 도구 실행 전 `Get-Location`, `dir`로 현재 프로젝트 폴더와 내용을 확인합니다.";
  return { cases: [
    { id: "github", title: "A · GitHub 기존 프로젝트", steps: ["`mkdir C:\\Work`", "`cd C:\\Work`", "`git clone <저장소 URL>`", "`cd <프로젝트 폴더>`", "`git status`", "clone 후 lockfile, package.json과 저장소 지침을 함께 확인해 설치 명령을 정합니다. package-lock.json → npm, pnpm-lock.yaml → pnpm, bun.lock → Bun, yarn.lock → Yarn이 단서이며 파일 하나로 단정하지 않습니다.", common] },
    { id: "local", title: "B · PC에 이미 있는 폴더", steps: ['`cd "C:\\프로젝트\\경로"`', "`git status`", "이미 Git 저장소면 그대로 사용합니다.", common] },
    { id: "new", title: "C · 새 프로젝트", steps: ["`mkdir C:\\Work\\MyProject`", "`cd C:\\Work\\MyProject`", "이후 AI 도구가 요구사항을 확인해 프레임워크, Git 초기화와 GitHub 연결 필요성을 결정합니다. 특정 프레임워크를 임의로 정하지 않습니다.", common] },
  ] };
}

export function runGuide(tool: AxToolId): string[] {
  const guide = TOOL_GUIDES[tool];
  return ["PowerShell을 실행합니다.", '`cd "프로젝트 경로"`로 작업할 폴더로 이동합니다.', "`Get-Location`, `dir`로 위치와 내용을 확인합니다.", `\`${guide.runCommand}\`을 실행합니다.`, guide.loginNote, `아래 ${guide.name}용 올인원 지시문 전체를 복사합니다.`, "실행한 AI 도구에 지시문을 붙여넣습니다.", "AI가 저장소를 분석하고 구현·검증을 진행합니다. 승인·검토 요청이 있으면 내용을 확인합니다."];
}

function axPromptTitle(taskName?: string): string {
  const name = taskName?.trim() || "업무";
  return `# ${name.endsWith("자동화") ? name : `${name} 자동화`} 구현 지시문`;
}

export function buildAllInOnePrompt(plan: AxPlan, _tool: AxToolId, options?: { taskName?: string; prerequisites?: string[] }): string {
  const bullets = (items: string[]) => items.map(item => `- ${item}`).join("\n");
  const numbered = (items: string[]) => items.map((item, i) => `${i + 1}. ${item}`).join("\n");
  const introduction = [
    axPromptTitle(options?.taskName),
    "현재 프로젝트 저장소를 먼저 확인한 뒤 아래 요구사항을 구현하세요. 확인되지 않은 파일명·함수명·API·배포 방식을 추측하지 말고 기존 프로젝트 구조와 패턴을 우선 재사용하세요.",
  ];
  const sections: { title: string; body: string }[] = [];
  const section = (title: string, ...content: string[]) => sections.push({ title, body: content.join("\n\n") });
  const prerequisites = [...new Set([...plan.prerequisites, ...(options?.prerequisites ?? [])])];

  if (plan.goal.length) section("작업 목표", "이 작업의 목표는 다음과 같습니다.", bullets(plan.goal));
  section("작업 전 현재 프로젝트 확인", "작업을 시작하기 전에 현재 저장소를 먼저 확인하세요.", bullets([
    "저장소 지침 파일(AGENTS.md 등)이 있으면 먼저 읽고 그 규칙을 따르세요.",
    "`git status`로 현재 작업 상태와 변경 파일을 확인하세요.",
    "현재 branch를 확인하세요.",
    "프로젝트 구조를 확인하세요.",
    "사용 중인 framework/runtime을 확인하세요.",
    "package manager와 lockfile(package-lock.json, pnpm-lock.yaml, bun.lock, yarn.lock)을 확인하세요.",
    "이 작업과 관련된 기존 구현을 확인하세요.",
    "재사용 가능한 컴포넌트·함수를 확인하세요.",
    "package scripts에서 테스트·typecheck·빌드·배포 명령을 확인하세요.",
    "테스트 방식을 확인하세요.",
    "배포 방식을 확인하세요.",
  ]), "현재 구현을 확인하기 전에 파일명·함수명·API·DB 구조를 추측하지 마세요.");
  if (plan.asIs.length) section("AS-IS", "현재 업무는 다음과 같이 수행됩니다. 자동화 후에도 이 흐름의 목적과 담당자 역할을 유지하세요.", bullets(plan.asIs));
  if (plan.toBe.length) section("TO-BE", "구현 후 업무는 다음과 같은 상태가 되어야 합니다. 담당자의 승인·검토 역할은 임의로 제거하지 마세요.", bullets(plan.toBe));
  if (plan.inScope.length || plan.outOfScope.length) section("작업 범위",
    ...(plan.inScope.length ? [`### 포함\n\n${bullets(plan.inScope)}`] : []),
    ...(plan.outOfScope.length ? [`### 제외\n\n${bullets(plan.outOfScope)}`] : []),
    "제외 범위에 해당하는 기능은 이번 작업에서 임의로 추가하지 마세요.",
  );
  if (prerequisites.length) section("구현 전 확인사항", bullets(prerequisites), "위 항목은 구현 전에 확인하세요. 확인되지 않은 항목은 '확인 필요'로 유지하고, 확인되지 않은 API나 권한이 있다고 가정해 구현하지 마세요.");
  section("구현 원칙", bullets([
    ...(plan.repositoryFirst ? [plan.repositoryFirst] : []),
    "현재 프로젝트 구조를 먼저 확인하세요.",
    "기존 구현을 우선 재사용하세요. 기존 컴포넌트·함수가 있으면 새로 만들기 전에 재사용을 검토하세요.",
    "요청 범위 안에서 최소 범위로 수정하세요.",
    "요청하지 않은 기능을 추가하지 마세요.",
    "불필요한 신규 라이브러리나 패키지를 추가하지 마세요.",
    "값을 하드코딩하지 마세요.",
    "테스트용 임시 데이터를 실제 로직에 남기지 마세요.",
    "기존 데이터와 기능의 호환성을 유지하세요.",
    "기존 인증·보안·권한 구조를 유지하세요.",
    "관련 없는 파일 변경을 최소화하세요.",
    "확인되지 않은 값이나 API를 추측하지 마세요.",
    "타입·빌드·런타임 오류를 남긴 채 완료로 처리하지 마세요.",
  ]));
  if (plan.implementation.length) section("구현 요구사항", "다음 순서로 구현하세요.", numbered(plan.implementation));
  if (plan.dataFlow.length) section("데이터 흐름", "데이터는 다음 흐름을 따르도록 구현하세요.", bullets(plan.dataFlow));
  if (plan.integrations.length) section("외부 연동", bullets(plan.integrations), "연동 대상의 실제 API·권한·인증 방식은 저장소와 공식 설정에서 확인하세요. 확인되지 않은 endpoint나 SDK를 지어내지 마세요.");
  if (plan.humanInLoop.length) section("승인·검토", bullets(plan.humanInLoop), "위 승인·검토 단계는 자동화 범위를 확장하면서 임의로 제거하지 마세요.");
  if (plan.exceptions.length) section("예외 처리", "다음 예외 상황을 처리하세요.", bullets(plan.exceptions), "실패를 정상 처리처럼 숨기지 말고 운영자 또는 사용자가 원인을 확인할 수 있게 처리하세요.");
  if (plan.fallback.length || plan.operation.length) section("문제 발생 시 대응",
    ...(plan.fallback.length ? [`### 자동화 실패 시\n\n${bullets(plan.fallback)}`] : []),
    ...(plan.operation.length ? [`### 운영·수동 처리\n\n${bullets(plan.operation)}`] : []),
    "자동화가 실패하면 기존 수동 업무 방식으로 안전하게 처리할 수 있어야 합니다.",
  );
  if (plan.security.length) section("보안", bullets([
    ...plan.security,
    "secret을 코드에 하드코딩하지 마세요. 기존 환경변수 등 저장소의 secret 관리 방식을 사용하세요.",
    "민감한 데이터를 불필요하게 로그에 남기지 마세요.",
    "최소 권한 원칙을 유지하세요.",
  ]));
  section("검증 방법",
    "현재 저장소에 실제로 존재하는 검증 명령과 도구를 먼저 확인한 뒤 실행하세요. 존재하지 않는 테스트 framework나 명령을 추측하거나 임의로 설치하지 마세요.",
    ...(plan.tests.length ? [`### 정상 케이스\n\n${bullets(plan.tests)}`] : []),
    ...(plan.poc.length ? [`### 사전 검증\n\n${bullets(plan.poc)}`] : []),
    ...(plan.exceptions.length ? ["### 주요 예외 케이스\n\n'예외 처리' 섹션에 정의된 각 상황을 재현해 정상적으로 처리되는지 확인하세요."] : []),
    "### 회귀 검증\n\n이 작업과 관련된 기존 기능이 이전과 동일하게 동작하는지 확인하세요.",
    "이 작업이 웹 UI를 포함하면 저장소에 기존 브라우저/E2E 도구(예: Playwright)가 있는지 확인하세요. 도구가 있으면 기존 흐름으로 주요 화면을 Desktop과 Mobile에서 확인하세요. 도구가 없으면 새로 설치하지 말고 그 사실을 보고하세요.",
  );
  section("Git 반영", numbered([
    "`git status`로 변경 상태를 확인하세요.",
    "`git diff`로 변경 내용을 검토하세요.",
    "현재 branch와 `git remote -v`로 원격을 확인하세요.",
    "의도하지 않은 파일 변경이 없는지 확인하세요.",
    "저장소의 branch/PR 정책을 확인하세요.",
    "필요한 파일만 골라 `git add <파일>`로 stage하세요.",
    "작업 내용을 설명하는 commit 메시지로 commit하세요.",
    "저장소 정책에 맞는 방식으로 push 또는 PR을 진행하세요.",
  ]), bullets([
    "`git add .`로 전체 파일을 한 번에 추가하지 마세요.",
    "확인 없이 main branch에 직접 push하지 마세요.",
    "force push를 사용하지 마세요.",
    "`git reset --hard` 같은 파괴적인 명령을 기본 흐름에 넣지 마세요.",
    "저장소 정책을 확인하지 않고 branch를 삭제하지 마세요.",
  ]));
  section("배포 및 운영 적용",
    "배포 방식을 추측하지 마세요. 저장소에서 vercel.json, wrangler.toml·wrangler.json·wrangler.jsonc, GitHub Actions, package scripts, README, AGENTS.md를 확인해 기존 배포·운영 방식을 먼저 찾으세요.",
    "기존 CI/CD가 있으면 그 방식을 우선하세요. 다음으로 GitHub 연동 자동 배포, 기존 package deploy script, 기존 CLI 배포 방식 순으로 확인하세요.",
    "Vercel과 Cloudflare 중 하나를 임의로 선택하거나 새 배포 도구를 설치하지 마세요.",
    "배포 방식을 확인할 수 없으면 임의로 진행하지 말고 '배포 방식 확인 필요'로 보고하세요.",
    "웹 배포가 필요 없는 자동화(CLI, 스크립트, Excel 자동화, 로컬 실행형 등)이면 배포 대신 실행 환경 구성 또는 운영 적용으로 처리하세요.",
    "실제 배포 또는 운영 적용을 수행했다면 다음을 확인하세요.", bullets([
    "실제 환경에서 실행되는지 여부",
    "핵심 기능",
    "입력 → 처리 → 결과 흐름",
    "오류 여부",
    "웹이면 브라우저 콘솔·네트워크 오류",
    "Desktop 화면",
    "모바일 영향이 있으면 Mobile 화면",
  ]), "문제가 발견되면 수정 → 재배포 또는 재적용 → 동일 시나리오 재검증 순서로 진행하세요.");
  section("완료 조건", bullets([
    ...plan.acceptance,
    "요청한 기능이 정상 작동합니다.",
    "기존 기능과 기존 데이터가 유지됩니다.",
    "승인·검토 단계가 유지됩니다.",
    "주요 예외가 정상 처리됩니다.",
    "관련 검증이 통과합니다.",
    "타입 오류와 빌드 오류가 없습니다.",
    "실제 배포·운영 환경에서 검증했습니다.",
    "실행하지 않은 검증은 완료로 보고하지 말고 미실행으로 명시합니다.",
  ]));
  section("완료 보고", "작업이 끝나면 다음 형식으로 보고하세요.", numbered([
    "확인한 현재 구조", "수정한 파일", "구현한 내용", "테스트·검증 결과", "Git 상태", "배포/운영 적용 결과", "남은 위험 또는 미실행 항목",
  ]), "실제로 수행하지 않은 작업을 완료했다고 보고하지 마세요.");
  return [...introduction, ...sections.filter(section => section.body).map((section, i) => `## ${i + 1}. ${section.title}\n\n${section.body}`)].join("\n\n");
}
