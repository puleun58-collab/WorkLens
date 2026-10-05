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

export function postImplementationGuide(): string[] {
  return ["배포 URL을 확인합니다. 배포가 없는 로컬 실행형이면 실제 실행 환경에서 같은 순서로 확인합니다.", "배포 URL에 접속하거나 실제 실행 환경을 실행합니다.", "핵심 기능을 실행합니다.", "입력 → 처리 → 결과를 확인합니다.", "네트워크와 브라우저 콘솔 오류를 확인합니다.", "Desktop에서 확인합니다.", "모바일 대응이면 Mobile에서도 확인합니다.", "오류가 있으면 수정·재배포하고 동일 시나리오를 재검증합니다. 로컬 실행형은 수정 후 다시 실행해 재검증합니다."];
}

export function githubGuide(): string[] {
  return ["저장소의 branch/PR 정책을 먼저 확인합니다.", "`git status`로 변경 상태를 확인합니다.", "`git branch --show-current`로 현재 브랜치를 확인합니다.", "`git remote -v`로 원격을 확인합니다. remote가 없는 신규 프로젝트는 Git 초기화·GitHub 저장소 생성·remote 연결이 별도 단계입니다.", "`git diff`로 변경 내용을 검토합니다.", "프로젝트에 실제 있는 테스트·lint·typecheck·build 명령만 실행하고 실패하면 수정합니다.", "변경 파일을 확인해 필요한 파일만 `git add <파일>`로 추가합니다. 전체 파일 일괄 추가는 금지합니다.", '`git commit -m "작업 내용"`으로 커밋합니다.', "현재 브랜치와 원격을 확인한 뒤 `git push`합니다. 확인 없는 main 직접 push, force push와 파괴적인 초기화를 기본 절차로 사용하지 않습니다."];
}

export type DeploymentKind = "ci" | "vercel" | "cloudflare" | "manual" | "unknown" | "none";
export function resolveDeploymentGuide(signals: { ci?: boolean; vercel?: boolean; cloudflare?: boolean; manualScript?: boolean; webDeploy?: boolean }): { kind: DeploymentKind; steps: string[] } {
  const principle = "프로젝트에서 확인된 방식만 따릅니다. Vercel/Cloudflare CLI를 임의로 설치하지 않습니다.";
  const kind: DeploymentKind = signals.webDeploy === false ? "none" : signals.ci ? "ci" : signals.vercel ? "vercel" : signals.cloudflare ? "cloudflare" : signals.manualScript ? "manual" : "unknown";
  const steps: Record<DeploymentKind, string[]> = {
    ci: ["저장소 정책에 따라 Push/merge합니다.", "CI 배포 상태를 확인합니다.", "Production URL을 확인합니다."],
    vercel: ["기존 GitHub 연동 자동 배포를 우선합니다.", "배포 상태와 Production URL을 확인합니다."],
    cloudflare: ["기존 Wrangler, package script, GitHub Actions 중 실제 방식을 확인합니다. 기존 script를 우선합니다.", "배포 상태와 Production URL을 확인합니다."],
    manual: ["저장소에서 확인한 기존 수동 배포 script와 운영 지침을 따릅니다.", "배포 상태와 실제 접속 URL을 확인합니다."],
    unknown: ["배포 방식 확인 필요", "확인 후보: vercel.json, wrangler.toml/json/jsonc, GitHub Actions, package scripts, README, AGENTS.md. 확인되지 않으면 임의로 플랫폼을 선택하지 않습니다."],
    none: ["웹 배포 대신 실제 실행 환경을 구성하고 운영에 적용합니다.", "해당 환경에서 핵심 기능과 수동 처리 전환을 확인합니다."],
  };
  return { kind, steps: [principle, ...steps[kind]] };
}

export function buildAllInOnePrompt(plan: AxPlan, tool: AxToolId, options?: { taskName?: string; prerequisites?: string[] }): string {
  const sections: [string, string[]][] = [
    ["작업 목표", plan.goal], ["현재 상태 (AS-IS)", plan.asIs], ["목표 상태 (TO-BE)", plan.toBe],
    ["작업 범위", plan.inScope], ["제외 범위", plan.outOfScope],
    ["구현 전 확인사항", [...new Set([...plan.prerequisites, ...(options?.prerequisites ?? [])])]],
    ["승인·검토 필요 단계", plan.humanInLoop], ["사전 검증(PoC)", plan.poc], ["구현 순서", plan.implementation],
    ["데이터 흐름", plan.dataFlow], ["외부 연동", plan.integrations], ["예외 처리", plan.exceptions],
    ["문제 발생 시 대응", plan.fallback], ["운영·수동 처리 전환", plan.operation], ["보안", plan.security],
    ["테스트", plan.tests], ["완료 조건", plan.acceptance],
    ["Repository-first 원칙", [plan.repositoryFirst, "저장소 지침(AGENTS.md 등)을 우선 확인하세요.", "현재 구조를 확인한 후 기존 패턴을 재사용하세요.", "package manager·테스트 명령·배포 방식을 저장소에서 확인하세요.", "확인되지 않은 파일명·API를 추측하지 마세요.", "불필요한 신규 패키지를 추가하지 마세요.", "요청 범위 외 파일 변경을 최소화하세요."]],
  ];
  const procedure = [
    "구현 전 `git status`로 저장소 상태를 확인하세요.",
    "구현 후 `git diff`로 변경 파일을 검토하세요.",
    "저장소의 기존 테스트·lint·typecheck·build를 실행하고 실패하면 수정하세요.",
    "저장소의 branch/PR 정책을 확인해 그 방식으로 GitHub에 반영하세요. force push, 확인 없는 main 직접 push, 전체 파일 일괄 add는 금지합니다.",
    "배포가 필요한 프로젝트면 저장소에서 확인된 기존 배포 방식만 사용하세요. vercel.json·wrangler 설정·GitHub Actions·package scripts·README/AGENTS.md를 확인하세요. 확인되지 않으면 임의로 플랫폼을 고르지 말고 확인 필요로 보고하세요. 웹 배포가 필요 없는 자동화면 실행 환경 구성으로 대체하세요.",
    "배포 후 실제 배포 URL에서 핵심 기능을 검증하세요. 입력 → 처리 → 결과, 브라우저 콘솔·네트워크 오류, Desktop, 모바일 대응 시 Mobile을 확인하세요. 오류가 있으면 수정·재배포·동일 시나리오 재검증하세요. 로컬 실행형이면 실제 실행 환경에서 같은 순서로 검증하세요.",
    "실행하지 않은 단계는 완료로 보고하지 말고 미실행이라고 보고하세요.",
  ];
  return [
    `# ${options?.taskName ?? "업무 자동화"} 구현 지시문 (${TOOL_GUIDES[tool].name}용)\n\n다음 지시를 현재 프로젝트 저장소에서 수행하세요.`,
    ...sections.filter(([, items]) => items.length).map(([title, items]) => `## ${title}\n${items.map(item => `- ${item}`).join("\n")}`),
    `## 작업 진행·완료 절차\n${procedure.map((item, i) => `${i + 1}. ${item}`).join("\n")}`,
  ].join("\n\n");
}
