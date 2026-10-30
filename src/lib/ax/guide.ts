import type { AxDiagnosis, AxPlan, GenericRule } from "./types";
import { automationLevel, axes, executionProfile, gateBlockReasons, prerequisiteTopicKey, type ExecutionGate, type ExecutionProfile, type StepScope } from "./policy";
import { FACTOR_KEYS } from "./schema";
import { applyStateDefinition, confirmedStateNames, declaredStateCount, isUndecidableStateInvalid, resolveDecisionPoints, undecidedDecisionIds, validatedUndecidableState, type ResolvedDecisionPoint } from "./decision-points";
import { applicabilityPendingGenericRules, confirmedGenericRules, duplicateGenericRuleConflicts, pendingGenericRules, resolveGenericRules } from "./generic-rules";
import { checkPromptRuleDelivery, type PromptDeliveryReport } from "./prompt-delivery";
import { extractPlanReviewableItems, extractReviewableItems, getValidConfirmedReviews, buildPlanReviewKeyMap } from "./hitl";

export type AxToolId = "codex" | "claude";

export const TOOL_GUIDES: Record<AxToolId, {
  name: string; versionCommand: string; installCommand: string; runCommand: string; doctorCommand: string; loginNote: string;
}> = {
  codex: { name: "Codex", versionCommand: "codex --version", installCommand: 'powershell -ExecutionPolicy ByPass -c "irm https://chatgpt.com/codex/install.ps1 | iex"', runCommand: "codex", doctorCommand: "codex --help", loginNote: "첫 실행 시 ChatGPT 로그인 등 사용 가능한 인증 방식을 선택" },
  claude: { name: "Claude Code", versionCommand: "claude --version", installCommand: "irm https://claude.ai/install.ps1 | iex", runCommand: "claude", doctorCommand: "claude doctor", loginNote: "첫 실행 시 계정 인증 안내를 따릅니다" },
};

/** Inline text marks commands with backticks; `code` blocks default to PowerShell unless labeled as examples. */
export type AxGuideBlock = { kind: "text"; text: string } | { kind: "code"; lines: string[]; notes?: string[]; label?: "PowerShell" | ".gitignore" | "예시"; singleLine?: boolean; prose?: boolean } | { kind: "steps"; items: string[] } | { kind: "table"; headers: string[]; rows: string[][] } | AxGitFlowBlock;
/** Tone of one Git·GitHub work-flow card or group box: the whole card border uses it. */
export type AxGitFlowTone = "blue" | "green" | "purple" | "orange";
export interface AxGitFlowStep { no: string; title: string; description: string; command: string[]; tone: AxGitFlowTone }
export interface AxGitFlowGroup { range: string; title: string; tone: AxGitFlowTone; points: string[] }
export interface AxGitFlowBlock { kind: "git-flow"; subtitle: string; steps: AxGitFlowStep[]; groups: AxGitFlowGroup[]; notes: string[] }
export interface AxGuideSection { title: string; when?: string; collapsed?: boolean; listStyle?: "bullets"; brand?: "vercel" | "cloudflare"; className?: string; blocks: AxGuideBlock[] }
export interface AxGuideStep { title: string; purpose: string; sections: AxGuideSection[] }

/** Display text for a guide code block: repeated blank lines collapse to a single
 * line break so paragraph-separated request text renders at the same density as
 * single-paragraph request text. The copied text keeps the original lines
 * (including blank separators) — only the displayed text is collapsed. */
export function guideCodeDisplayText(lines: string[]): string {
  return lines.join("\n").replace(/\n{2,}/gu, "\n");
}

/** Display text for a prose code block: blank separators are dropped and the
 * sentences are joined with a single space, so the box wraps only at its own
 * width like a single-paragraph request. This is ONLY for blocks explicitly
 * marked `prose` (natural-language request text); executable command blocks
 * must keep their line breaks via guideCodeDisplayText, and the copied text
 * always keeps the original lines. */
export function guideProseDisplayText(lines: string[]): string {
  return lines.map(line => line.trim()).filter(line => line !== "").join(" ").replace(/\s+/gu, " ");
}

const text = (value: string): AxGuideBlock => ({ kind: "text", text: value });
const code = (lines: string[], notes: string[], label?: Extract<AxGuideBlock, { kind: "code" }>["label"]): AxGuideBlock => ({ kind: "code", lines, notes, ...(label ? { label } : {}) });
/** A natural-language request block, not executable commands: rendered as continuous prose. */
const proseCode = (lines: string[], notes: string[]): AxGuideBlock => ({ kind: "code", lines, notes, prose: true });

// Long single-line installer: shown on one line with ellipsis; copy keeps the full command.
const installCode = (lines: string[], notes: string[]): AxGuideBlock => ({ kind: "code", lines, notes, singleLine: true });

// A single copyable line per installer. Errors must stop before a cached file can run.
const gitInstall = [
  '& { $ErrorActionPreference = "Stop"',
  '$arch = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString(); if ($arch -notin @("X64","Arm64")) { throw "Unsupported architecture: $arch" }',
  '$suffix = if ($arch -eq "Arm64") { "arm64" } else { "64-bit" }',
  '$release = Invoke-RestMethod -Uri "https://api.github.com/repos/git-for-windows/git/releases/latest"',
  '$assets = @($release.assets | Where-Object { $_.name -match "^Git-[0-9.]+-$suffix\\.exe$" }); if ($assets.Count -ne 1 -or $assets[0].digest -notmatch "^sha256:[0-9a-fA-F]{64}$") { throw "Git asset/hash not unique" }',
  '$asset = $assets[0]; $path = Join-Path "$env:TEMP" ([guid]::NewGuid().ToString() + "-" + $asset.name)',
  'Invoke-WebRequest -Uri "$($asset.browser_download_url)" -OutFile "$path" -UseBasicParsing',
  'if (-not (Test-Path -LiteralPath "$path" -PathType Leaf) -or (Get-Item -LiteralPath "$path").Length -eq 0) { throw "Git download missing" }',
  'if ((Get-FileHash -LiteralPath "$path" -Algorithm SHA256).Hash -ne $asset.digest.Substring(7)) { throw "Git SHA256 mismatch" }',
  '$installer = Start-Process -FilePath "$path" -Wait -PassThru; if ($installer.ExitCode -ne 0) { throw "Git exit: $($installer.ExitCode)" } }',
].join("; ");
const nodeInstall = [
  '& { $ErrorActionPreference = "Stop"',
  '$arch = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString(); if ($arch -notin @("X64","Arm64")) { throw "Unsupported architecture: $arch" }',
  '$cpu = if ($arch -eq "Arm64") { "arm64" } else { "x64" }',
  '$releases = Invoke-RestMethod -Uri "https://nodejs.org/dist/index.json"; $lts = @($releases) | Where-Object { $_.lts -ne $false -and $_.files -contains "win-$cpu-zip" } | Select-Object -First 1',
  'if (-not $lts -or $lts.version -notmatch "^v[0-9]+\\.[0-9]+\\.[0-9]+$") { throw "No compatible Node LTS" }',
  '$file = "node-$($lts.version)-$cpu.msi"; $base = "https://nodejs.org/dist/$($lts.version)"',
  '$hashes = Invoke-RestMethod -Uri "$base/SHASUMS256.txt"; $hashLines = @($hashes -split "[\\r\\n]+" | Where-Object { $_ -match ("^[0-9a-fA-F]{64}\\s+\\*?" + [regex]::Escape($file) + "$") })',
  'if ($hashLines.Count -ne 1) { throw "Node MSI/hash not unique" }; $expected = ($hashLines[0] -split "\\s+")[0]',
  '$path = Join-Path "$env:TEMP" ([guid]::NewGuid().ToString() + "-" + $file)',
  'Invoke-WebRequest -Uri "$base/$file" -OutFile "$path" -UseBasicParsing',
  'if (-not (Test-Path -LiteralPath "$path" -PathType Leaf) -or (Get-Item -LiteralPath "$path").Length -eq 0) { throw "Node download missing" }',
  'if ((Get-FileHash -LiteralPath "$path" -Algorithm SHA256).Hash -ne $expected) { throw "Node SHA256 mismatch" }',
  '$installer = Start-Process -FilePath "msiexec.exe" -ArgumentList @("/i", "`"$path`"") -Wait -PassThru; if ($installer.ExitCode -notin @(0,3010)) { throw "Node exit: $($installer.ExitCode)" } }',
].join("; ");
const ghInstall = [
  '& { $ErrorActionPreference = "Stop"',
  '$arch = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString(); if ($arch -notin @("X64","Arm64")) { throw "Unsupported architecture: $arch" }',
  '$cpu = if ($arch -eq "Arm64") { "arm64" } else { "amd64" }',
  '$release = Invoke-RestMethod -Uri "https://api.github.com/repos/cli/cli/releases/latest"',
  '$assets = @($release.assets | Where-Object { $_.name -match ("^gh_[0-9.]+_windows_" + $cpu + "\\.msi$") }); if ($assets.Count -ne 1 -or $assets[0].digest -notmatch "^sha256:[0-9a-fA-F]{64}$") { throw "gh asset/hash not unique" }',
  '$asset = $assets[0]; $path = Join-Path "$env:TEMP" ([guid]::NewGuid().ToString() + "-" + $asset.name)',
  'Invoke-WebRequest -Uri "$($asset.browser_download_url)" -OutFile "$path" -UseBasicParsing',
  'if (-not (Test-Path -LiteralPath "$path" -PathType Leaf) -or (Get-Item -LiteralPath "$path").Length -eq 0) { throw "gh download missing" }',
  'if ((Get-FileHash -LiteralPath "$path" -Algorithm SHA256).Hash -ne $asset.digest.Substring(7)) { throw "gh SHA256 mismatch" }',
  '$installer = Start-Process -FilePath "msiexec.exe" -ArgumentList @("/i", "`"$path`"") -Wait -PassThru; if ($installer.ExitCode -notin @(0,3010)) { throw "gh exit: $($installer.ExitCode)" } }',
].join("; ");

export function setupGuide(tool: AxToolId): AxGuideStep[] {
  const guide = TOOL_GUIDES[tool];
  return [
    { title: "시작하기 전에 · 전체 흐름", purpose: "업무 검토 → 구현·테스트 → 배포 → 실제 기능 검증", sections: [
      { title: "처음 시작할 때", blocks: [
        text("Windows 11과 PowerShell 5.1을 기준으로 안내합니다. STEP 01에서 필요한 도구의 설치 여부와 정상 작동을 확인하세요. 코딩 에이전트는 Codex 또는 Claude Code 중 하나를 선택해 사용할 수 있습니다."),
      ] },
      { title: "이후 작업할 때", blocks: [
        text("개발 환경이 준비되어 있다면 필요한 단계부터 진행하세요. Codex 또는 Claude Code로 실제 기능을 구현하고 테스트한 뒤 배포합니다. 배포된 결과물은 실제 사용 환경에서 기능이 정상 작동하는지 반드시 검증합니다."),
      ] },
      { title: "Git·GitHub 작업 흐름", collapsed: true, blocks: [{ kind: "git-flow", subtitle: "코드 변경부터 배포까지의 전체 과정을 순서대로 확인하세요.", steps: [
        { no: "01", title: "저장소 준비", description: "새 저장소 만들기 또는 기존 저장소 확보하기", command: ["git init", "git clone"], tone: "blue" },
        { no: "02", title: "브랜치 생성", description: "기존 코드와 분리해 작업할 브랜치 생성", command: ["git switch -c", "브랜치명"], tone: "blue" },
        { no: "03", title: "변경 파일 추가", description: "변경할 파일을 커밋 대상으로 선택", command: ["git add ."], tone: "green" },
        { no: "04", title: "변경 내용 저장", description: "변경 내용을 이력으로 저장", command: ["git commit -m", "\"변경 내용\""], tone: "green" },
        { no: "05", title: "원격 저장소 업로드", description: "변경 내역을 GitHub에 업로드", command: ["git push"], tone: "purple" },
        { no: "06", title: "PR 생성", description: "변경 내용을 검토하고 병합하도록 요청", command: ["Pull Request", "생성"], tone: "purple" },
        { no: "07", title: "CI 실행", description: "테스트·빌드 등을 자동으로 검사", command: ["자동 실행", "(결과 확인)"], tone: "orange" },
        { no: "08", title: "PR 병합", description: "검토 완료 후 메인 브랜치에 병합", command: ["Merge", "(브랜치 병합)"], tone: "orange" },
        { no: "09", title: "배포", description: "실제 서비스 환경에 배포", command: ["Deploy", "(배포 실행)"], tone: "blue" },
        { no: "10", title: "배포 검증", description: "배포된 서비스가 정상 작동하는지 확인", command: ["서비스 확인", "(운영 환경)"], tone: "blue" },
      ], groups: [
        { range: "01~02", title: "저장소 준비·브랜치", tone: "blue", points: ["프로젝트 상태에 따라 git init 또는 git clone 선택", "기존 저장소를 다시 초기화하지 않음"] },
        { range: "03~04", title: "변경 추가·커밋", tone: "green", points: ["변경된 파일만 git add", "커밋 메시지는 변경 내용을 명확히 작성"] },
        { range: "05~06", title: "업로드·PR", tone: "purple", points: ["git push 후 Pull Request 생성", "변경 내용을 검토하고 병합 요청"] },
        { range: "07~08", title: "CI·Merge", tone: "orange", points: ["CI에서 테스트·빌드·자동 검사", "검토 완료 후 메인 브랜치에 병합"] },
        { range: "09~10", title: "배포·검증", tone: "blue", points: ["실제 서비스 환경에 배포", "배포 완료 후 정상 작동 확인"] },
      ], notes: [
        "git init과 git clone은 프로젝트 상태에 따라 선택하며, 기존 저장소를 다시 초기화하지 않습니다.",
        "CI는 Push 또는 PR 생성 시 실행될 수 있으며, 실제 실행 조건은 프로젝트 설정에 따릅니다.",
        "Merge와 Deploy는 서로 다른 작업이며, 배포 완료 후 실제 기능 검증이 필요합니다.",
      ] }] },
    ] },
    { title: "STEP 01 · 개발 환경 준비", purpose: "", sections: [
      { title: "설치 순서 안내", blocks: [
        text("Git 설치 → Git 사용자 정보 설정 → 필요한 경우 Node.js 설치 → 선택한 코딩 에이전트 설치 → 최초 실행·로그인 확인 순서로 진행하세요. 이미 설치했거나 설정한 항목은 건너뛸 수 있습니다."),
      ] },
      { title: "Git 설치", when: "Git이 아직 설치되지 않은 경우에만", blocks: [
        text("GitHub에 코드를 저장하고 변경 이력을 관리합니다."),
        installCode([gitInstall], []),
        code(["git --version"], []),
      ] },
      { title: "Git 사용자 정보 설정", blocks: [
        text("최초 한 번만 설정하며, 이미 설정되어 있다면 건너뛰세요."),
        code(["git config user.name", "git config user.email"], ["먼저 현재 설정된 값을 확인하세요. 이름과 이메일이 모두 표시되면 이미 설정된 것이므로 아래 설정 명령어를 실행하지 마세요."]),
        code(['git config --global user.name "본인 이름"', 'git config --global user.email "본인@example.com"'], ["\"본인 이름\"과 \"본인@example.com\"은 예시입니다. 그대로 입력하지 말고 실제 본인의 이름과 이메일로 바꿔서 설정하세요.", "이메일은 GitHub 계정에 등록된 이메일이나 GitHub에서 제공하는 비공개 이메일을 사용하세요."]),
      ] },
      { title: "Node.js LTS 설치", blocks: [
        text("프로젝트 실행 또는 개발 도구에 필요한 경우 설치합니다."),
        installCode([nodeInstall], []),
        code(["node --version", "npm --version"], []),
      ] },
      { title: `${guide.name} 설치`, when: `선택한 ${guide.name}을(를) 아직 설치하지 않은 경우에만`, blocks: [
        text("자연어 지시로 코드를 작성·수정하고 기능을 검증합니다."),
        installCode([guide.installCommand], []),
        code([guide.versionCommand], []),
        ...(tool === "codex" ? [text("Node/npm이 이미 필요해 설치되어 있다면 네이티브 설치 대신 `npm install -g @openai/codex`를 사용할 수 있습니다. 둘을 동시에 설치하지 마세요.")] : []),
        text("설치 후 아래 명령으로 처음 실행하면 로그인 절차가 시작됩니다."),
        code([guide.runCommand], [guide.loginNote, "코딩 에이전트 로그인은 GitHub 로그인과 서로 다른 인증 과정입니다. 이미 인증된 상태이면 다시 로그인할 필요가 없습니다."]),
      ] },
    ] },
    { title: "STEP 02 · 프로젝트 준비", purpose: "GitHub 클론 / 기존 로컬 프로젝트 / 다른 PC 작업 이어가기 / 새 프로젝트 중 하나", sections: [
      { title: "A. GitHub에 있고 PC에는 없는 프로젝트", when: "GitHub 저장소를 현재 PC에 처음 가져오는 경우", blocks: [
        code(['git clone "https://github.com/owner/repository.git"', 'cd "repository"', "git status"], ["URL과 폴더명은 실제 프로젝트 정보로 바꾸세요.", "현재 PowerShell 위치에 저장소 이름으로 폴더가 생성됩니다. 원하는 저장 위치가 있다면 먼저 해당 위치에서 PowerShell을 실행하세요."]),
      ] },
      { title: "B. PC에 이미 있는 프로젝트", when: "PC에 프로젝트 폴더가 있는 경우", blocks: [
        code(['cd "C:\\Work\\repository"', "git status"], ["실제 프로젝트 폴더 경로로 변경하세요. 기존 파일과 변경사항을 확인한 후 작업을 시작하세요."]),
      ] },
      { title: "C. 다른 PC에서 작업 이어가기", when: "다른 PC에서 GitHub에 반영한 최신 작업을 가져오는 경우", className: "ax-guide-section--cautions", blocks: [
        text("이미 프로젝트를 클론한 PC에서 진행합니다. PC에 프로젝트가 없다면 C가 아닌 A를 사용하세요."),
        code(['cd "C:\\Work\\repository"', "git status", "git fetch origin", "git checkout main", "git pull --ff-only origin main"], []),
        { kind: "steps", items: [
          "git status: 현재 브랜치와 로컬 변경사항 확인",
          "git fetch origin: GitHub의 최신 원격 정보 가져오기",
          "git checkout main: main 브랜치로 전환",
          "git pull --ff-only origin main: 불필요한 병합 커밋 없이 최신 코드 반영",
        ] },
        text("다른 PC의 작업이 GitHub에 푸시되어 있어야 합니다. 로컬 변경사항이 있다면 먼저 확인하고, 원격 기본 브랜치가 main이 아닌 경우 실제 브랜치명을 사용하세요."),
        text("로컬 변경사항이 있을 때는 무조건 브랜치를 전환하거나 가져오지 말고 현재 상태를 먼저 확인하세요. 로컬에 main 브랜치가 없으면 해당 상태를 먼저 확인하세요. 충돌이 발생하면 데이터를 삭제하거나 강제로 덮어쓰는 방식으로 해결하지 마세요."),
      ] },
      { title: "D. 새 프로젝트", when: "새 폴더에서 시작하는 경우", blocks: [
        code(['mkdir "C:\\Work\\MyProject"', 'cd "C:\\Work\\MyProject"'], ["예시 경로를 실제 값으로 바꾸세요. 폴더가 이미 있으면 먼저 내용을 확인하고 mkdir은 건너뜁니다."]),
        text("특정 프레임워크를 임의로 정하지 않습니다. Git 저장 전 Git 저장소인지, remote가 연결됐는지, 대상 GitHub 저장소가 맞는지 확인합니다. Git 저장소가 아닌 경우에만 초기화하고 기존 저장소를 재초기화하거나 기존 remote를 덮어쓰지 않습니다. branch 이름을 main으로 강제하지 않습니다."),
        code(["git init", 'git remote add origin "https://github.com/owner/repository.git"', "git remote -v"], ["git init은 저장소가 아닐 때만, remote add는 저장소를 만들고 remote가 없을 때만 실행합니다. 원격에 초기 커밋이 있으면 먼저 이력을 확인하고 충돌 없이 연결합니다. 첫 push 전에 대상 원격을 다시 확인하세요."]),
      ] },
      { title: "Git 업로드 제외 파일 자동 설정", blocks: [
        code(["현재 프로젝트의 언어, 프레임워크, 실행 환경과 파일 구조를 확인하고 적절한 .gitignore를 구성해 줘. 기존 .gitignore가 있으면 필요한 규칙만 보완하고, 없으면 새로 만들어 줘. 의존성 폴더, 빌드 결과물, 캐시, 임시파일, 로컬 설정, 인증정보 등 GitHub에 올리면 안 되는 파일을 제외해 줘. 반대로 실제 개발에 필요한 소스코드, 설정 템플릿, 잠금 파일 등은 임의로 제외하지 마. 이미 Git이 추적하는 민감 파일이 있는지도 확인해 줘. 발견하면 파일을 삭제하거나 Git 기록을 변경하지 말고 처리 방법과 위험을 먼저 알려 줘. 완료 후 적용한 제외 규칙과 추가 확인이 필요한 사항을 간단히 보고해 줘."], ["코딩 에이전트에게 요청할 때 복사해서 사용하세요.", "STEP 07에서 git add .을 실행하기 전에 완료하세요."]),
        text("이미 Git이 추적 중인 파일은 .gitignore만으로 제외되지 않습니다. .gitignore 작성 완료가 GitHub 업로드 안전성 확인과 같은 뜻은 아닙니다."),
      ] },
    ] },
    { title: "STEP 03 · 올인원 지시문 준비", purpose: "WorkLens의 업무·진단·HITL 판단을 지시문에 연결", sections: [
      { title: "WorkLens에서 확인", blocks: [
        text("WorkLens에서 올인원 지시문을 복사해 Codex 또는 Claude Code에 전달하세요. 이 지시문을 이용해 실제 프로그램을 만드는 과정이 1차 MVP 구현입니다."),
        text("업무 선택 → 진단과 판단 근거 확인 → 단계별 자동화 판단의 HITL 검토(유지·보류·제외·보완)와 확인된 기술 조건을 반영합니다. 보류·제외 항목을 AI가 임의로 구현하거나 승인하지 않습니다."),
        text("실제 화면의 ‘올인원 지시문’에서 Codex 또는 Claude Code를 선택하고 ‘전체 보기’로 확인한 뒤 ‘올인원 지시문 복사’를 누릅니다."),
      ] },
    ] },
    { title: "STEP 04 · 첫 MVP 구현과 실제 테스트", purpose: "선택한 AI 에이전트로 입력·처리·출력 구현 후 검증", sections: [
      { title: "프로젝트 폴더에서 실행", blocks: [
        code(['cd "C:\\Work\\repository"', guide.runCommand], ["실제 프로젝트 폴더로 바꾸세요."]),
        text("STEP 03에서 복사한 올인원 지시문 전체를 에이전트에 붙여넣습니다. 저장소 지침·기존 구현·승인 경계를 먼저 확인하고 파일 변경·실행·승인 요청을 검토하세요."),
      ] },
      { title: "입력 → 처리 → 출력 실동작", blocks: [
        text("실제 입력 데이터를 받아 형식과 필수 항목을 검증하고, 확정된 업무 규칙에 따라 처리한 뒤 요구사항에 맞는 결과를 출력합니다. 정상 입력과 오류·예외 상황을 테스트하고 실제 처리 결과를 확인하세요."),
        text("AI가 첫 MVP를 구현한 뒤 저장소에 실제 존재하는 테스트·빌드 명령과 수동 기능 검사를 실행합니다. 단계별 PASS/FAIL/NOT_RUN/BLOCKED와 실행 근거를 기록하세요. 실행하지 않은 명령이나 미확정 기준을 PASS로 기록하지 않습니다."),
        code(["git status", "git diff", "git diff --cached --stat"], ["관계없는 변경·대량 삭제·Secret은 중단하고 검토하세요."]),
      ] },
      { title: "실패 시", collapsed: true, blocks: [
        text("API Key·Token·Password·개인정보를 [REDACTED]로 가린 필요한 오류 내용만 AI 도구에 전달합니다. 로그 전체를 무조건 복사하지 않습니다. 수정 후 동일한 검증을 다시 실행합니다."),
      ] },
    ] },
    { title: "STEP 05 · 배포 플랫폼 선택", purpose: "기존 구성을 유지하거나 새 프로젝트의 실행 조건과 정책으로 선택", sections: [
      { title: "배포 방식 비교", blocks: [
        text("Vercel: 웹사이트와 Next.js 프로젝트를 GitHub에 연결해 배포하기 편리한 서비스입니다."),
        text("Cloudflare: 웹사이트와 서버 기능을 실행할 수 있고, 필요하면 데이터·파일 저장 기능도 연결할 수 있습니다."),
        text("기존 서비스의 배포 플랫폼·브랜치·워크플로는 먼저 확인하고 유지합니다. DB 유무만으로 플랫폼을 정하지 않습니다."),
        code(["현재 프로젝트에 Vercel과 Cloudflare 중 어떤 배포 방식이 적합한지 확인해 줘. 기존 배포 환경이 있다면 우선 유지하고, 비용이나 별도 설정이 필요하면 알려줘."], ["코딩 에이전트에게 요청할 때 복사해서 사용하세요."]),
        { kind: "table", headers: ["비교", "Vercel", "Cloudflare"], rows: [
          ["주요 강점", "Next.js 및 프론트엔드 Git 연동, Preview", "Workers/Pages와 D1·R2·KV 바인딩, Git 연동 또는 기존 Wrangler 스크립트"],
          ["실행·데이터", "Functions와 외부 DB·Blob 연결 가능", "Workers와 내장·외부 저장소 연결 가능; DB 사용을 강요하지 않음"],
          ["무료 조건", "Hobby 개인·비상업적 용도, Function 월 100만 호출 포함", "Workers Free 일 10만 요청·요청당 CPU 10ms; 저장 서비스별 별도 한도·결제"],
          ["업무용", "플랜 이용 조건을 확인하고 필요하면 Pro 검토", "무료 한도와 해당 서비스 청구 조건을 확인"],
        ] },
        text("수치는 현재 공식 정책에 근거한 예시이며 가입·배포 전 최신 정책을 확인하세요. https://vercel.com/docs/plans/hobby · https://developers.cloudflare.com/workers/platform/pricing/"),
      ] },
    ] },
    { title: "STEP 06 · 데이터 저장 방식", purpose: "기존 데이터는 유지하고, 필요한 저장 방식만 선택해 연결하세요.", sections: [
      { title: "필요한 저장 방식만 선택하세요", blocks: [
        text("입력한 내용이나 파일을 나중에도 사용해야 한다면 저장 기능이 필요합니다. 보관할 데이터와 사용 방식에 따라 적절한 저장 방법이 달라집니다."),
        { kind: "table", headers: ["방식", "쉬운 설명", "예시"], rows: [
          ["저장하지 않음", "실행 결과만 확인", "일회성 계산"],
          ["브라우저 저장", "현재 브라우저에 내용 보관", "개인 메모"],
          ["D1", "온라인에 업무 기록 저장", "업무 등록·조회"],
          ["R2", "온라인에 파일 저장", "PDF·Excel 첨부"],
          ["KV", "간단한 설정값·캐시 저장", "앱 설정"],
        ] },
        code(["현재 프로젝트에 필요한 데이터 저장 방식을 확인해 줘. 기존 저장소가 있다면 우선 사용하고, 없다면 적절한 방법을 추천해 줘. 필요한 코드는 구현하되 계정 연결·비용 발생·기존 데이터 변경은 먼저 내 확인을 받아."], ["코딩 에이전트에게 요청할 때 복사해서 사용하세요."]),
        text("이미 사용하는 DB/API/스토리지는 재사용합니다. 한 앱에 여러 저장소나 서로 다른 공급자를 함께 쓸 수 있습니다. 새 DB를 강제하거나 다른 저장소로 이전하지 말고 필요한 서비스만 연결하세요."),
      ] },
    ] },
    { title: "STEP 07 · GitHub 저장과 배포", purpose: "Secret 점검 → 정책에 맞는 commit/push → PR·CI → 실제 배포", sections: [
      { title: "안전하게 Git에 저장", blocks: [
        text("`git add .` 실행 전 STEP 02의 `.gitignore` 설정과 변경 파일을 확인하세요. API 키·비밀번호 등 민감정보는 Git에 저장하지 마세요."),
        text("이미 추적 중인 파일은 .gitignore만으로 보호되지 않습니다. 이미 노출된 키는 폐기 → 재발급 → 플랫폼 설정 교체 순서로 대응하고, 기록 재작성은 자동 실행하지 않습니다. AI 대화·터미널 로그·스크린샷에도 Secret을 붙여넣지 않습니다."),
        text("프로젝트 폴더에서 변경사항을 확인하고 GitHub에 업로드합니다."),
        code(["git status", "git add .", "git diff --cached", 'git commit -m "변경 사항 반영"', "git push"], []),
        text("Git 저장소 초기화와 원격 연결은 STEP 02의 해당 상황에 따라 안내합니다. 최초 커밋 전에 Git 사용자 이름·이메일 설정이 필요하면 STEP 01의 안내를 따르세요."),
        text("최초 git push에서 업스트림 설정이 필요하면 해당 상황에서 추가 명령어를 안내합니다."),
      ] },
      { title: "PR·CI 및 배포 확인", blocks: [
        text("GitHub에 변경 사항을 업로드한 후 PR·CI를 사용하는 프로젝트에서는 해당 결과를 확인합니다. 배포는 프로젝트에 실제 설정된 Git 연동 또는 CLI 방식에 따라 진행하고, 실제 운영 환경에 반영되었는지 확인합니다."),
        text("코드 업로드, CI 통과, 실제 운영 배포는 서로 다른 단계이므로 각각 확인합니다. CI가 없으면 통과한 것으로 표시하지 않고, Preview와 Production 배포를 구분합니다. git push만으로 운영 배포가 완료된 것은 아니며, Git 자동 배포와 CLI 배포를 중복 실행하지 않습니다. 배포가 필요 없는 로컬 자동화 프로그램에는 웹 배포를 요구하지 않고, 특정 플랫폼의 배포 명령을 모든 프로젝트에 일괄 적용하지 않습니다."),
        proseCode(["현재 프로젝트의 구조, GitHub 연결 상태, 배포 서비스 및 기존 배포 설정을 먼저 확인해 줘.", "", "Vercel 또는 Cloudflare 중 이미 구성된 배포 환경이 있다면 해당 환경을 우선 유지해 줘.", "", "GitHub 연동 자동 배포가 설정되어 있다면 기존 브랜치·CI·배포 흐름을 확인하고, 변경 사항이 실제 배포 환경에 반영되는지 검증해 줘.", "", "CLI 직접 배포가 필요한 경우에는 프로젝트의 기존 배포 스크립트와 설정을 우선 사용해 줘. Cloudflare 프로젝트라면 필요한 경우 Wrangler를 사용하고, 불필요한 도구 설치나 설정 변경은 하지 마.", "", "배포 전 필요한 빌드와 테스트를 실행하고, 실제 운영 환경에 영향을 줄 수 있는 변경 사항이 있다면 실행 전에 알려 줘. 인증이나 추가 승인이 필요하다면 사용자에게 요청해 줘.", "", "기존 데이터와 서비스 설정을 보존하면서 승인된 범위에서 배포를 진행해 줘.", "", "완료 후 실제 배포 환경, URL, 적용된 코드 버전, 테스트 및 배포 결과를 구분해 보고해 줘.", "", "배포가 실행되지 않았거나 실제 반영 여부를 확인하지 못했다면 완료로 표시하지 마."], ["코딩 에이전트에게 요청할 때 복사해서 사용하세요."]),
      ] },
    ] },
    { title: "STEP 08 · 실제 기능 확인 및 완료", purpose: "구현한 프로그램을 직접 실행해 주요 기능이 정상 작동하는지 확인합니다.", sections: [
      { title: "확인할 내용", blocks: [
        { kind: "steps", items: [
          "주요 기능이 요구사항대로 작동하는가?",
          "정상 입력과 잘못된 입력을 올바르게 처리하는가?",
          "데이터 저장 기능이 있다면 저장한 내용이 유지되는가?",
          "실제 사용 환경에서 오류 없이 실행되는가?",
        ] },
        text("해당 기능이 존재하지 않는 프로젝트에서는 관련 없는 확인 항목을 필수 조건으로 취급하지 않습니다."),
      ] },
      { title: "AI 코딩 에이전트에게 기능 검증 요청", blocks: [
        code(["완성한 프로그램을 실제 사용 상황처럼 직접 실행해 테스트해 줘. (1) 프로그램이 실제로 실행되는지, (2) 핵심 기능이 구현됐는지, (3) 입력 데이터를 올바르게 처리하는지, (4) 실제 출력 결과가 무엇인지, (5) 사용자 확정한 업무 규칙이 반영됐는지, (6) 정상·경계·실패 사례에서 어떻게 동작하는지, (7) 사용자 확인·승인 등 사람 검토 제한을 지키는지, (8) 미구현 기능과 오류가 무엇인지, (9) 검증되지 않은 기능이 무엇인지를 확인해 줘. 주요 기능에 정상적인 입력과 잘못된 입력을 각각 사용하고, 처리 결과가 요구사항과 일치하는지 확인해 줘. 데이터 저장 기능이 있다면 저장 후 다시 실행하거나 새로고침해도 데이터가 올바르게 유지되는지 검증해 줘. 웹서비스라면 실제 배포된 환경의 주요 기능을 확인하고, 로컬 자동화 프로그램이라면 해당 실행 환경에서 테스트해 줘. 각 항목을 통과(PASS)·실패(FAIL)·미실행(NOT_RUN)·차단(BLOCKED)으로 구분해 보고하고, 근거로 실제 테스트 입력·기대 결과·실제 결과·오류 메시지·실패한 테스트·실행 환경과 코드 버전·재현 방법을 함께 적어 줘. 기대 결과나 업무 규칙이 확정되지 않았다면 AI가 임의로 정답을 만들지 말고 미확정으로 구분해 보고해 줘. 실행하지 못한 테스트는 미검증으로 구분하고, HTTP 200 응답이나 빌드 성공만으로 업무 기능이 통과했다고 표시하지 마. 실패한 항목의 원인 및 필요한 수정 사항을 보고해 줘. 검증하지 못한 기능은 완료로 표시하지 마."], []),
      ] },
      { title: "완료 판정", blocks: [
        text("주요 기능이 요구사항대로 작동하고 필요한 검증을 통과했다면 완료로 판단할 수 있습니다. 실패했거나 확인하지 못한 항목은 별도로 기록하고 수정한 뒤 다시 검증하세요."),
      ] },
    ] },
  ];
}

function axPromptTitle(taskName?: string): string {
  const name = taskName?.trim() || "업무";
  return `# ${name.endsWith("자동화") ? name : `${name} 자동화`} 구현 지시문`;
}

/** Level constraints keep the implementation inside the diagnosed automation scope; a higher level is not a goal. */
const LEVEL_CONSTRAINTS = [
  "업무 정리와 검토·검증 수준으로 진행하세요. 시스템이 업무를 자동 실행하는 기능을 추가하지 마세요.",
  "담당자가 요청할 때 후보·초안을 제안하거나 진단 메모에 명시된 확인된 규칙을 보조적으로 처리하세요. 담당자 요청 없이 운영 업무가 무인·정기 자동 실행되거나 담당자 판단·승인을 대체하게 하지 마세요. 예외 검토와 최종 판단·승인은 담당자에게 유지합니다. 자동화 범위를 Level 2~3 수준으로 확대하지 마세요.",
  "반복·규칙 기반 단계는 자동화할 수 있지만 주요 예외와 승인 단계는 담당자에게 유지합니다.",
  "높은 수준의 자동화가 가능하지만 승인·안전·법률·권한과 관련된 단계는 진단 결과대로 유지합니다.",
] as const;

/** LEVEL_CONSTRAINTS의 출력용 버전: Level 번호 언급을 실행 조건 문장으로 바꾼다. 정책 제한 내용은 동일. */
const LEVEL_CONSTRAINTS_OUTPUT = [
  LEVEL_CONSTRAINTS[0],
  "담당자가 요청할 때 후보·초안을 제안하거나 진단 메모에 명시된 확인된 규칙을 보조적으로 처리하세요. 담당자 요청 없이 운영 업무가 무인·정기 자동 실행되거나 담당자 판단·승인을 대체하게 하지 마세요. 예외 검토와 최종 판단·승인은 담당자에게 유지합니다. 자동화 범위를 현재 보조 수준에서 확대하지 마세요.",
  LEVEL_CONSTRAINTS[2],
  LEVEL_CONSTRAINTS[3],
] as const;

/** Gate rules for section 03. A blocked gate never permits implementation, scaffolding or operational connection. */
const GATE_CONSTRAINTS = {
  ready: "현재 진단상 진행할 수 있습니다. 아래 항목이 있으면 해당 단계를 구현하기 전에 확인하세요.",
  conditional: "아래 항목을 저장소·실제 자료·담당자 답변으로 확인한 뒤 해당 조건에 의존하는 단계만 구현하세요. 확인되지 않은 조건에 의존하지 않는 허용 단계는 진행하되 미확인·거부된 보안·권한을 우회하지 마세요.",
  blocked: "차단 사유가 해결되기 전에는 기능 구현·코드 생성·스캐폴딩·운영 연결을 하지 마세요. 저장소 분석과 아래 검토·검증, 해결 방안 정리만 수행하세요.",
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
 * A quantified target is a confirmed business fact only when its number+unit AND its
 * measurement target both appear in the registration/diagnosis context. The same number
 * with a different meaning (e.g. 정산 오차율 0.5% vs 시스템 오류율 0.5%) is not confirmed.
 */
/** Every metric occurrence in the item, each verified against its own measurement target. */
const METRIC_GLOBAL = /(\d+(?:\.\d+)?\s*(?:%|퍼센트|배))/gu;
/** The noun phrase (up to 3 words) directly before a metric: the measurement target. */
const METRIC_SUBJECT_TAIL = /([가-힣A-Za-z]{2,}(?:\s+[가-힣A-Za-z]{2,}){0,2})\s*$/u;
/**
 * Deictic modifiers that never change what is measured. Quantitative modifiers
 * (목표/예상/평균/최대/최소/실제/기존값…) are deliberately kept: they can change the meaning.
 */
const NEUTRAL_SUBJECT_PREFIX = /^(?:기존|현재|해당)\s+/u;
const normalizeSubject = (subject: string) => subject.replace(/\s+/gu, " ").trim().replace(NEUTRAL_SUBJECT_PREFIX, "");
const normalizeMetric = (metric: string) => metric.replace(/퍼센트/u, "%").replace(/\s+/gu, "");
/** Words that change what a measurement means; never ignored when only one side has them. */
const MEANING_MODIFIER = /^(?:목표|예상|평균|최대|최소|실제|기준|표준|한도|상한|하한)$/u;
/** The core nouns of one subject are all present in the other: same measurement target, different wording. */
const subjectMatches = (itemSubject: string, ctxSubject: string) => {
  const wi = itemSubject.split(" ").filter(Boolean), wc = ctxSubject.split(" ").filter(Boolean);
  if (!wi.length || !wc.length) return false;
  if (wi.every(word => wc.includes(word))) return true;
  const extra = wi.filter(word => !wc.includes(word));
  return wc.every(word => wi.includes(word)) && extra.every(word => !MEANING_MODIFIER.test(word));
};
interface MetricClaim { text: string; subject: string; value: string; confirmed: boolean }
/** One claim per metric in the item; a confirmed first metric never covers the rest. */
function metricClaims(item: string, context: string): MetricClaim[] {
  return [...item.matchAll(METRIC_GLOBAL)].map(match => {
    const value = normalizeMetric(match[1]);
    const subject = normalizeSubject(METRIC_SUBJECT_TAIL.exec(item.slice(0, match.index))?.[1] ?? "");
    let confirmed = false;
    if (subject) {
      for (const ctx of context.matchAll(METRIC_GLOBAL)) {
        if (normalizeMetric(ctx[1]) !== value) continue;
        const ctxSubject = normalizeSubject(METRIC_SUBJECT_TAIL.exec(context.slice(0, ctx.index))?.[1] ?? "");
        if (ctxSubject && subjectMatches(subject, ctxSubject)) { confirmed = true; break; }
      }
    }
    return { text: `${METRIC_SUBJECT_TAIL.exec(item.slice(0, match.index))?.[1]?.trim() ?? ""} ${match[1]}`.trim(), subject, value, confirmed };
  });
}
/**
 * A quantified target is a confirmed business fact only when every metric in the item has its
 * number+unit AND its measurement target confirmed in the registration/diagnosis context.
 * The same number with a different meaning (e.g. 정산 오차율 0.5% vs 시스템 오류율 0.5%) is not confirmed.
 */
export function isConfirmedMetric(item: string, context: string): boolean {
  const claims = metricClaims(item, context);
  return claims.length > 0 && claims.every(claim => claim.confirmed);
}
/** System names before "API"; generic words are not an identifiable system. */
const API_SYSTEM = /([가-힣A-Za-z]+(?:\s+[가-힣A-Za-z]+){0,2})\s*API/giu;
const SYSTEM_STOP = /^(?:시스템|내부|외부|신규|기존|해당|관련|사내|전체|업무|전송|조회|읽기|등록|수정|삭제|승인|연동)$/u;
/** Last non-generic word of the phrase before "API": the system the API belongs to. */
const systemName = (phrase: string) => {
  const words = phrase.split(/\s+/u).filter(word => !SYSTEM_STOP.test(word));
  return words.length ? words[words.length - 1] : "";
};
const API_WRITE_OP = /(등록|생성|수정|삭제|전송|승인|결재|보정|반영|업로드|발행|확정)/u;
const API_READ_OP = /(조회|읽기|검색|확인|가져오|불러오|다운로드)/u;
/**
 * One confirmed API never confirms another: a read API does not grant write permission,
 * and system A's API says nothing about system B. Each system+operation is checked
 * independently against the context; confirmed normal reads are not blocked.
 */
function qualifyApi(value: string, item: string, context: string): string {
  if (!SYSTEM_INTERFACE.test(item) || /확인/u.test(item)) return value;
  const sentences = context.split(/[.\n。]/u);
  const sentenceHas = (name: string, op: RegExp) => sentences.some(sentence => sentence.includes(name) && op.test(sentence));
  let specific = false;
  for (const match of item.matchAll(API_SYSTEM)) {
    const system = systemName(match[1]);
    if (!system) continue;
    specific = true;
    const itemWrite = API_WRITE_OP.exec(item)?.[1];
    const itemRead = itemWrite ? undefined : API_READ_OP.exec(item)?.[1];
    if (itemWrite && !sentenceHas(system, API_WRITE_OP)) {
      value = `${value} ${UNCONFIRMED} ${system} API의 ${itemWrite} 기능과 실제 권한을 확인한 뒤 확인된 범위에서만 사용하세요)`;
    } else if (itemRead && !sentenceHas(system, API_READ_OP) && !sentenceHas(system, API_WRITE_OP)) {
      value = `${value} ${UNCONFIRMED} ${system} API의 ${itemRead} 가능 여부와 권한을 확인하세요)`;
    } else if (!sentences.some(sentence => sentence.includes(system))) {
      value = `${value} ${UNCONFIRMED} ${system} API의 존재·연동 방식·권한을 확인하세요)`;
    }
  }
  if (!specific && !SYSTEM_INTERFACE.test(context)) {
    value = `${value} ${UNCONFIRMED} 실제 연동 방식과 권한을 확인한 뒤 확인된 방식만 사용하세요)`;
  }
  return value;
}
/** The item carries metrics and none of them are confirmed: guardPlan drops it. */
function hasOnlyUnconfirmedMetrics(item: string, context: string): boolean {
  if (!UNSUPPORTED_METRIC.test(item)) return false;
  const claims = metricClaims(item, context);
  return claims.length > 0 && claims.every(claim => !claim.confirmed);
}

/**
 * Second line of defense after the generation prompt: keep grounded items, qualify plausible but unverified
 * ones in place, drop unsupported metrics. Qualified items carry the marker, so applying it twice changes nothing.
 */
export function guardPlan(plan: AxPlan, context: string): AxPlan {
  // A confirmed metric is preserved, but every other safety check still applies to the same sentence.
  // Each risk (auto action, unconfirmed API, unconfirmed org) is checked independently, so one
  // confirmed fact never suppresses the remaining checks.
  const guardItem = (item: string, qualify: boolean): string | null => {
    if (item.includes(UNCONFIRMED)) return item;
    if (UNSUPPORTED_METRIC.test(item)) {
      const claims = metricClaims(item, context);
      const unconfirmed = claims.filter(claim => !claim.confirmed);
      // Every metric unconfirmed: drop the performance goal as before.
      if (unconfirmed.length === claims.length) return null;
      // Partially confirmed: keep the original, but the unconfirmed metrics must not become criteria.
      // Remaining safety checks still apply below; the item is already marked, never marked twice.
      if (unconfirmed.length > 0) item = `${item} ${UNCONFIRMED} 다음 수치의 근거를 먼저 확인하세요: ${unconfirmed.map(claim => claim.text).join(", ")})`;
      // All metrics confirmed: the fact is preserved, remaining safety checks still apply below.
    }
    let value = item.replace(ORGANIZATION, org => context.includes(org) ? org : "담당 조직");
    const action = qualify ? AUTO_ACTION.exec(value)?.[1] : undefined;
    if (action && !new RegExp(`자동(?:으로)?\\s*${action}`, "u").test(context)) value = `${value} ${UNCONFIRMED} 업무 규칙에서 확인된 경우에만 적용하고, 아니면 대상 건을 표시만 하세요)`;
    if (qualify) value = qualifyApi(value, item, context);
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

/** Ignore only presentation differences, never distinct conditions or different wording. */
const normalizedItem = (item: string) => item.trim()
  .replace(/^(?:(?:\d+[.)]|[①-⑳]|[-*•·])\s*)+/u, "")
  .replace(/\s+/gu, "")
  .replace(/[.。]$/u, "")
  .replace(/\(담당자수행\)$/u, "");
const unique = (items: string[]) => {
  const seen = new Set<string>();
  return items.map(item => item.trim()).filter(item => {
    const key = normalizedItem(item);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};
const mergeDistinct = (base: string[], extra: string[]) => unique([...base, ...extra]);
const without = (items: string[], shown: string[]) => {
  const keys = new Set(shown.map(normalizedItem));
  return unique(items).filter(item => !keys.has(normalizedItem(item)));
};
/** Prefixes stripped from 03 completion criteria when all items share the same unconfirmed status. */
const TEST_SCOPE_PREFIX = /^적용 범위 확인 필요\s*:\s*/u;
const CRITERION_PREFIX = /^기준 확인 필요\s*:\s*/u;
const FUTURE_TEST_PREFIX = /^향후 검증\s*:\s*/u;
const FUTURE_CRITERION_PREFIX = /^향후 판정\s*:\s*/u;
/** Content words of a completion-criteria text, used for conservative semantic duplicate comparison. */
const criteriaWords = (text: string): Set<string> => new Set(
  stripEnumerator(text)
    .replace(TEST_SCOPE_PREFIX, "").replace(CRITERION_PREFIX, "")
    .replace(FUTURE_TEST_PREFIX, "").replace(FUTURE_CRITERION_PREFIX, "")
    .toLowerCase()
    .split(/[\s·・,，.。、；;:\-—–/()（）"“”']+/u)
    .map(word => {
      if (CONFIRM_BOILERPLATE.has(word)) return "";
      for (const tail of ["미확인", "미확정", "여부", "필요"]) {
        if (word.endsWith(tail) && word.length > tail.length + 1) return word.slice(0, -tail.length);
      }
      return word;
    })
    .filter(Boolean)
);
/**
 * Conservative semantic dedup for 03 completion criteria.
 * Merges items only when one's content words are a subset of another's
 * (i.e., the shorter adds no new information). Items with distinct causes,
 * conditions, or actions are preserved.
 */
const dedupCriteria = (items: string[]): string[] => {
  const result: string[] = [];
  for (const item of items) {
    const words = criteriaWords(item);
    if (!words.size) continue;
    const isSubset = result.some(existing => {
      const existingWords = criteriaWords(existing);
      if (!existingWords.size) return false;
      // item's words are all in existing → item adds nothing new
      if ([...words].every(w => existingWords.has(w))) return true;
      // existing's words are all in item → existing adds nothing new; replace it
      if ([...existingWords].every(w => words.has(w))) {
        const idx = result.indexOf(existing);
        result[idx] = item;
        return true;
      }
      return false;
    });
    if (!isSubset && !result.includes(item)) result.push(item);
  }
  return result;
};
/** 03↔04 완료 기준 일치 (결함 A-1·A-2) 공유 규칙.
 * 03의 criteria() 접두어와 04의 전체 완료 기준이 같은 한정자를 쓰도록 하고,
 * 출처 충돌·수치 충돌은 어느 쪽에서도 합격 조건으로 남기지 않고 확인 대상 섹션으로 분리한다.
 * 특정 수치·문구·업무명·기술명·법령명을 하드코딩하지 않으며, Level·Gate·HITL·scoped 판정은 건드리지 않는다. */
/** 미연결 기준의 출처 라벨. 출처를 알 수 없으면 붙이지 않는다. */
const criterionSourceLabel = (item: { sources?: string[] }): string | null => {
  const sources = item.sources ?? [];
  if (sources.includes("plan.acceptance")) return "계획 acceptance";
  if (sources.some(source => source.startsWith("plan."))) return "생성 계획";
  if (sources.some(source => source.startsWith("diagnosis."))) return "진단";
  if (sources.some(source => source.startsWith("policy."))) return "정책";
  return null;
};
/** 미연결(비 scoped) 기준의 03식 한정자: 04 전체 완료 기준도 같은 문구로 표시한다.
 * 출처가 확인되면 함께 표시해, 미연결 기준이 확정 규칙으로 오독되지 않게 한다. */
const unlinkedCriterionText = (item: { scope: string; text: string; sources?: string[] }): string => {
  const label = criterionSourceLabel(item);
  const prefix = item.scope === "future" ? "향후 판정" : "기준 확인 필요";
  return label ? `${prefix}: [출처: ${label}] ${item.text}` : `${prefix}: ${item.text}`;
};
/** 알림·전송·승인 요청 등 외부 행위를 요구하는 표현. 미확정 기준이 이런 행위를
 * 요구하면 전체 완료 기준으로 승격하지 않고 "확인 필요(외부 행위)"로 분리한다. */
const EXTERNAL_ACTION_WORD = /(알림|전송|발송|통보|승인\s*요청|외부\s*승인)/u;
const isExternalActionCriterion = (item: { text: string }): boolean => EXTERNAL_ACTION_WORD.test(item.text);
/** 파일형 산출물 문장에서 컬럼·열 목록을 파싱한다. "열:/컬럼:" 라벨이 있거나,
 * 괄호 안에 쉼표로 구분된 공백 없는 토큰이 2개 이상 있으면 목록으로 본다.
 * "(원본 행 수와 동일한 행 수, ...)"처럼 공백을 포함한 설명 문장은 목록이 아니다. */
export function parseOutputColumns(text: string): string[] | null {
  const labeled = /(?:열|컬럼|columns?)\s*[:：]\s*([^()\n;；]+)/iu.exec(text);
  if (labeled) {
    const cols = labeled[1].split(/[,，、·]/u).map(col => col.trim()).filter(Boolean);
    if (cols.length >= 1 && cols.every(col => /^[^\s()]{1,40}$/u.test(col))) return cols;
  }
  for (const segment of [...text.matchAll(/[（(]([^）)]*)[）)]/gu)].map(match => match[1])) {
    const cols = segment.split(/[,，、]/u).map(col => col.trim()).filter(Boolean);
    if (cols.length >= 2 && cols.every(col => /^[^\s()]{1,40}$/u.test(col))) return cols;
  }
  return null;
}
/** 컬럼·열 목록이 파싱되지 않는 파일형 산출물의 파일명 목록. 컬럼을 만들지 않고
 * 미확정으로만 표시하기 위한 판정이다. */
export function detectUndeterminedOutputs(outputs: string[]): string[] {
  const out: string[] = [];
  for (const text of outputs) {
    const file = /([\w가-힣][\w가-힣.-]*\.(?:csv|xlsx|xls|json|txt))/u.exec(text)?.[1]
      ?? (/(?:CSV|파일)/u.test(text) ? "파일형 산출물" : null);
    if (!file) continue;
    if (!parseOutputColumns(text)) out.push(file);
  }
  return [...new Set(out)];
}
/** 조사(은/는/이/가/을/를/에/의/로/과/와/도/만 등)를 떼어 핵심어를 만든다. */
const stripParticle = (word: string): string => {
  let out = word;
  for (;;) {
    const next = out.replace(/(에서|에게|한테|부터|까지|으로|로|은|는|이|가|을|를|에|의|과|와|도|만)$/u, "");
    if (next === out || next.length < 2) break;
    out = next;
  }
  return out;
};
const CONFIRM_FILLER = new Set(["확인", "필요", "미확정", "미확인", "여부", "검토", "처리", "해당", "경우", "대상", "행", "결과", "상태",
  // 일반 동사·범용어는 대상 공유 근거가 되지 않는다 (예: D2 "합산 제외"와 판매자 예외의 "제외" 공유는 충돌이 아님).
  "제외", "합산", "분리", "표시", "적용", "입력", "출력", "파일", "기준", "규칙", "값", "건"]);
const contentWordsOf = (text: string, stateNames: string[]): string[] => text
  .split(/[\s·・,，.。、；;:\-—–/()（）"“”'→]+/u)
  .map(word => stripParticle(word.trim()))
  .filter(word => word.length >= 2 && !stateNames.includes(word) && !CONFIRM_FILLER.has(word));
/** 두 문장이 같은 대상을 다루는지: 한쪽 핵심어가 다른 쪽 핵심어의 부분 문자열이면 공유로 본다
 * (예: "판매자" ⊂ "판매자마스터"). */
const sharesTargetWord = (a: string, b: string, stateNames: string[]): boolean => {
  const wordsA = contentWordsOf(a, stateNames);
  const wordsB = contentWordsOf(b, stateNames);
  return wordsA.some(wordA => wordsB.some(wordB => wordB.includes(wordA) || wordA.includes(wordB)));
};
const SPECIAL_VALUE_WORDS = ["음수", "비숫자", "빈칸", "누락", "중복"];
const specialValuesOf = (text: string): string[] => {
  const tokens = text.split(/[\s·・,，.。、；;:\-—–/()（）"“”'→]+/u).map(token => token.trim()).filter(Boolean);
  const found = SPECIAL_VALUE_WORDS.filter(word => tokens.some(token => stripParticle(token) === word));
  if (tokens.includes("0")) found.push("0");
  return [...new Set(found)];
};
export interface DecisionExceptionConflict { line: string; exception: string; }
/**
 * 확정 결정 지점(D1~D3)과 §4 예외 문장 간 충돌·누락 검출 (P0-2, 저장 계약 변경 없음).
 * - 상태 충돌: 양쪽이 서로 겹치지 않는 D4 상태명을 지정하고 같은 대상을 다루면 충돌.
 * - 범위 누락: D3 특이값 목록 중 일부만 예외에 있고 일부가 빠졌으며 같은 상태·대상을 다루면 충돌.
 * 어느 경우도 예외 문장을 단정적 요구로 남기지 않기 위해 충돌한 예외 문장을 반환한다.
 */
export function detectDecisionExceptionConflicts(
  points: ResolvedDecisionPoint[],
  exceptionLines: string[],
  stateNames: string[],
): DecisionExceptionConflict[] {
  const out: DecisionExceptionConflict[] = [];
  const rulePoints = points.filter(point => ["D1", "D2", "D3"].includes(point.id) && point.status === "확정" && point.detail);
  for (const point of rulePoints) {
    const detail = point.detail as string;
    const dStates = stateNames.filter(state => detail.includes(state));
    const dSpecials = specialValuesOf(detail);
    for (const exception of exceptionLines) {
      const eStates = stateNames.filter(state => exception.includes(state));
      if (!sharesTargetWord(detail, exception, stateNames)) continue;
      if (dStates.length && eStates.length && !dStates.some(state => eStates.includes(state))) {
        out.push({
          exception,
          line: `${point.id} 확정 규칙 "${detail}"과(와) 예외 "${exception}"가 같은 대상에 서로 다른 결과 상태(${dStates.join("/")} / ${eStates.join("/")})를 지정합니다. 어느 쪽도 단정적 요구로 쓰지 말고 확인 대상으로 보고하세요.`,
        });
        continue;
      }
      const eSpecials = specialValuesOf(exception);
      const omitted = dSpecials.filter(value => !eSpecials.includes(value));
      const sharedState = dStates.some(state => eStates.includes(state));
      if (dSpecials.length && eSpecials.some(value => dSpecials.includes(value)) && omitted.length && sharedState) {
        out.push({
          exception,
          line: `${point.id} 확정 규칙 "${detail}"에 있는 특이값(${omitted.join("·")}) 처리가 예외 "${exception}"에 없습니다. 어느 쪽도 단정적 요구로 쓰지 말고 확인 대상으로 보고하세요.`,
        });
      }
    }
  }
  return out;
}
/**
 * 범용 확정 규칙과 §4 예외 문장 간 결과 상태 충돌 검출 (§9.2 검증 경로 확장).
 * D1~D3 검사의 상태 충돌 부분과 같은 기준을 쓴다: 같은 대상을 다루면서 양쪽이
 * 서로 겹치지 않는 D4 상태명을 지정하면 충돌. 특이값 누락 검사는 D3 전용으로 두지
 * 않으며, 의미적 동일성 판단이 불확실한 경우는 충돌로 단정하지 않는다.
 */
export function detectGenericRuleExceptionConflicts(
  rules: readonly { id: string; name: string; detail?: string }[],
  exceptionLines: string[],
  stateNames: string[],
): DecisionExceptionConflict[] {
  const out: DecisionExceptionConflict[] = [];
  for (const rule of rules) {
    const detail = rule.detail?.trim();
    if (!detail) continue;
    const rStates = stateNames.filter(state => detail.includes(state));
    for (const exception of exceptionLines) {
      const eStates = stateNames.filter(state => exception.includes(state));
      if (!sharesTargetWord(detail, exception, stateNames)) continue;
      if (rStates.length && eStates.length && !rStates.some(state => eStates.includes(state))) {
        out.push({
          exception,
          line: `${rule.id} ${rule.name} 확정 규칙 "${detail}"과(와) 예외 "${exception}"가 같은 대상에 서로 다른 결과 상태(${rStates.join("/")} / ${eStates.join("/")})를 지정합니다. 어느 쪽도 단정적 요구로 쓰지 말고 확인 대상으로 보고하세요.`,
        });
      }
    }
  }
  return out;
}
/** 표시된 기준에서 한정자 접두어를 뗀 원문. */
const bareCriterionText = (text: string): string =>
  text.replace(CRITERION_PREFIX, "").replace(FUTURE_CRITERION_PREFIX, "").trim();
/** 통과 조건과 실패 기준 양쪽에 나타나는 동일 기준을 양쪽에서 빼서 충돌 목록으로 분리한다. */
const splitSourceConflicts = (success: string[], failure: string[]): { success: string[]; failure: string[]; conflict: string[] } => {
  const successKeys = new Set(success.map(item => normalizedItem(bareCriterionText(item))));
  const failureKeys = new Set(failure.map(item => normalizedItem(bareCriterionText(item))));
  const inBoth = (item: string): boolean => {
    const key = normalizedItem(bareCriterionText(item));
    return successKeys.has(key) && failureKeys.has(key);
  };
  const conflict: string[] = [];
  const seen = new Set<string>();
  for (const item of [...success, ...failure]) {
    const key = normalizedItem(bareCriterionText(item));
    if (inBoth(item) && !seen.has(key)) { seen.add(key); conflict.push(bareCriterionText(item)); }
  }
  return { success: success.filter(item => !inBoth(item)), failure: failure.filter(item => !inBoth(item)), conflict };
};
/** 표시 목록에서 원문이 주어진 집합에 속하는 항목을 뺀다 (한정자 접두어 무시). */
const withoutBareTexts = (items: string[], bare: string[]): string[] => {
  const keys = new Set(bare.map(normalizedItem));
  return items.filter(item => !keys.has(normalizedItem(bareCriterionText(item))));
};
/** 합의 판정 문구: 한 결과를 다른 결과와 견주어 합격·실패를 가리는 기준. */
const AGREEMENT_WORD = /(일치|대조|비교|동일)/u;
const EXPLICIT_PERCENT = /(\d+(?:\.\d+)?)\s*(?:%|퍼센트)/u;
/** 0이 아닌 편차를 허용하는 표현. 엄격 표현보다 먼저 본다: "없거나 사소한 오류만" 같은
 * 선언은 편차가 있어도 통과시키므로 허용 수준은 허용 쪽이다. */
const TOLERANT_WORD = /(사소한|일부|소수|경미한|대부분|약간)[^,.;]{0,8}(오류|불일치|차이|누락)|(?:오류|불일치|차이|누락)[^,.;]{0,8}허용/u;
/** 편차를 허용하지 않는 표현 (전수·모두 일치, 오류·불일치 없음 등). */
const STRICT_WORD = /(전수|모두|완전)[^,.;]{0,8}(일치|대조|비교|동일)|(?:오류|불일치|차이|누락)[^,.;]{0,4}없/u;
/** 합의 기준의 허용 수준. 명시 %가 있으면 그 값(100이면 엄격), 없으면 허용/엄격 표현으로
 * 가늠하고, 둘 다 없으면 판정 불가(undefined)로 충돌 대상에서 제외한다. */
const agreementTolerance = (text: string): string | undefined => {
  if (!AGREEMENT_WORD.test(text)) return undefined;
  const pct = EXPLICIT_PERCENT.exec(text)?.[1];
  if (pct !== undefined) return Number(pct) >= 100 ? "strict" : `pct:${pct}`;
  if (TOLERANT_WORD.test(text)) return "tolerant";
  if (STRICT_WORD.test(text)) return "strict";
  return undefined;
};
/** 동일 비교 대상(연결 단계가 있으면 그 단계, 미연결이면 업무 전체) 안에서 허용 수준이
 * 다른 합의 기준 항목. 수준이 하나뿐이거나 판정 불가인 항목은 충돌이 아니다. */
const numericConflictItems = <T extends { text: string; step?: string }>(items: T[]): T[] => {
  const groups = new Map<string, { item: T; tolerance: string }[]>();
  for (const item of items) {
    const tolerance = agreementTolerance(item.text);
    if (tolerance === undefined) continue;
    const key = item.step ?? "__overall__";
    const group = groups.get(key) ?? [];
    group.push({ item, tolerance });
    groups.set(key, group);
  }
  const out: T[] = [];
  for (const group of groups.values()) {
    if (new Set(group.map(entry => entry.tolerance)).size > 1) out.push(...group.map(entry => entry.item));
  }
  return out;
};
/** 수치 충돌 항목의 표시 문구 (연결 단계가 있으면 단계 표기 유지). */
const numericConflictText = (item: { text: string; step?: string }): string =>
  item.step ? `${item.text} (관련 단계: ${item.step})` : item.text;
/** Presentation-only suffixes; the stage column and card badges already carry this meaning. */
const CONDITION_SUFFIX = /\s*\((?:적용 단계 확인 필요|향후 단계 조건)\)\s*$/u;
/** Words that only describe the confirmation act, never the condition itself. */
const CONFIRM_BOILERPLATE = new Set(["확인", "필요", "미확인", "미확정", "여부", "검토", "체크", "확정"]);
/** Content words of a condition text, used for conservative duplicate comparison against check cards. */
const conditionWords = (text: string): Set<string> => new Set(
  stripEnumerator(text).replace(CONDITION_SUFFIX, "").toLowerCase()
    .split(/[\s·・,，.。、；;:\-—–/()（）"“”']+/u)
    .map(word => {
      if (CONFIRM_BOILERPLATE.has(word)) return "";
      for (const tail of ["미확인", "미확정", "여부", "필요"]) {
        if (word.endsWith(tail) && word.length > tail.length + 1) return word.slice(0, -tail.length);
      }
      return word;
    })
    .filter(word => word.length > 1 && !CONFIRM_BOILERPLATE.has(word)),
);
/** An entry adds nothing when every content word already appears in the check card. Distinct conditions
 * (존재 여부 vs 접근 권한 vs 인증 방식) keep at least one uncovered word and are never merged. */
const coveredByCheck = (entryWords: Set<string>, checkWords: Set<string>) =>
  entryWords.size > 0 && [...entryWords].every(word => checkWords.has(word));
const shortConditionLabel = (text: string) => {
  const clean = stripEnumerator(text).replace(CONDITION_SUFFIX, "").replace(/\s+(?:확인이?\s*필요|미확인|확인)\s*$/u, "").trim();
  return clean || text;
};
/**
 * Conditions for the "추가 확인 사항" table: everything not already shown as a top check card.
 * Block reasons stay out (차단 사유 card). Diagnosis order is preserved; policy scopes are untouched.
 */
function buildAdditionalChecks(
  model: AgentInstructionModel,
  technicalChecks: AxDiagnosis["technicalChecks"],
  checkTexts: Set<string>,
  excludeTexts: Set<string>,
): AxAdditionalCheck[] {
  const checkWordSets = technicalChecks.map(check =>
    conditionWords(check.note ? `${check.topic} — ${check.note}` : check.topic));
  const isCheckDuplicate = (item: AgentInstructionItem | null, text: string): boolean => {
    if (item?.sources.includes("diagnosis.technicalChecks")) return true;
    const clean = text.replace(CONDITION_SUFFIX, "");
    if (checkTexts.has(normalizedItem(clean))) return true;
    const words = conditionWords(clean);
    return checkWordSets.some(checkWords => coveredByCheck(words, checkWords));
  };
  const toRow = (text: string, item: AgentInstructionItem | null, future: boolean): AxAdditionalCheck => {
    const content = text.replace(CONDITION_SUFFIX, "").trim();
    return {
      item: shortConditionLabel(content), content,
      stage: item?.step ?? null,
      status: future ? "향후 검토" : "확인 필요",
      tone: future ? "future" : "required",
      future,
      relation: conditionRelation(model, item, future),
    };
  };
  const rows: AxAdditionalCheck[] = [];
  const seen = new Set<string>();
  const push = (text: string, item: AgentInstructionItem | null, future: boolean) => {
    const key = normalizedItem(text.replace(CONDITION_SUFFIX, ""));
    if (!key || seen.has(key) || excludeTexts.has(key) || isCheckDuplicate(item, text)) return;
    seen.add(key);
    rows.push(toRow(text, item, future));
  };
  for (const item of model.conditions.current) push(item.text, item, false);
  for (const item of model.conditions.confirm) push(`${item.text} (적용 단계 확인 필요)`, item, false);
  for (const item of model.conditions.future) push(item.text, item, true);
  for (const text of model.gaps) push(text, null, false);
  return rows;
}
/** Step relation normalization preserves interior word boundaries unlike general item dedupe. */
const normalizedStepText = (value: string) => value.trim().replace(/\s+/gu, " ").replace(/[.。]\s*$/u, "").trim();
const explicitStep = (value: string, step: StepScope) => {
  const clean = normalizedStepText(value), name = normalizedStepText(step.step);
  if (!name) return false;
  if (clean === name) return true;
  const delimiter = /\s+[—–-]\s+|:\s+/u.exec(clean);
  if (delimiter && normalizedStepText(clean.slice(0, delimiter.index)) === name) return true;
  return !!step.treatment && clean === normalizedStepText(`${step.step} ${step.treatment}`);
};
const HUMAN_DECISION_CHECK = "담당자 유지 항목의 확정·시스템 반영·외부 전송 조건을 해당 단계에서 확인하세요. 확인 전 최종 처리는 대기하지만, 허용된 독립 후보·초안·규칙 검토는 각 단계의 선행 조건 안에서 진행할 수 있습니다.";
/** Card tone for one technical check; `future` only when the check is explicitly linked to a step outside the current Level scope.
 * `held` marks a HITL-deferred check: not a current required task, shown with its hold reason and resume condition. */
export type AxCheckTone = "required" | "future" | "done" | "blocked" | "held";
/** How a condition relates to diagnosed steps, for display only (never a policy decision):
 * - "연결 확인": the condition carries an explicit step link in the model.
 * - "관련 후보": the condition text mentions a diagnosed step name, but no explicit
 *   step link exists — it stays "확인 필요" and is never promoted to a required
 *   dependency of that step.
 * - "적용 단계 미확인": no step link and no step mention.
 * - "공통 조건": the same condition text arrived from two or more distinct sources
 *   without a single-step link, i.e. task-wide evidence, not a confirmed multi-step link.
 * - "향후 조건": explicitly a future-stage condition. */
export type AxConditionRelation = "연결 확인" | "관련 후보" | "적용 단계 미확인" | "공통 조건" | "향후 조건";
export function conditionRelation(model: AgentInstructionModel, item: AgentInstructionItem | null, future: boolean): AxConditionRelation {
  if (future) return "향후 조건";
  if (item?.step) return "연결 확인";
  if (!item) return "적용 단계 미확인";
  const text = normalizedStepText(item.text);
  if (model.steps.some(s => { const name = normalizedStepText(s.step); return name.length >= 2 && text.includes(name); })) return "관련 후보";
  if (new Set(item.sources).size >= 2) return "공통 조건";
  return "적용 단계 미확인";
}
/** One row of the "추가 확인 사항" table: a condition not already shown as a top check card. */
export interface AxAdditionalCheck {
  /** Short label for the 확인 항목 column. */
  item: string;
  /** Full detail for the 확인 필요 내용 column. */
  content: string;
  /** Linked diagnosis step, or null when the stage link is unconfirmed (never guessed). */
  stage: string | null;
  status: "확인 필요" | "확인됨" | "향후 검토" | "불가";
  tone: AxCheckTone;
  future: boolean;
  /** Display-only step relation (see AxConditionRelation); never a confirmed dependency. */
  relation: AxConditionRelation;
}
/** Read-only Step 4 summary; tentative PoC claims are visible but never promoted to required checks. */
export interface AxPlanSummary {
  include: string[]; humanKept: string[]; excluded: string[];
  prerequisites: string[];
  /** Technical checks as status cards, in diagnosis order. */
  checks: { topic: string; status: AxDiagnosis["technicalChecks"][number]["status"]; note: string; tone: AxCheckTone }[];
  /** Block reasons, shown as the 차단 사유 card; never mixed into the additional-checks table. */
  blockReasons: string[];
  /** Conditions not already shown as a check card, with stage linkage kept explicit. */
  additionalChecks: AxAdditionalCheck[];
  /** Internal traceability for each displayed prerequisite: the model sources that
   * carried the same condition text (merged display keeps every source; a merged
   * row never silently drops an origin). Not rendered by the 01~03 cards. */
  prerequisiteSources: { text: string; sources: string[] }[];
  /** Prerequisites not already shown as a check card; blocked gates list block reasons as `current`. */
  conditions: { current: string[]; future: string[] };
  /** Existing structured human/exclusion fields, with their source retained. */
  constraints: string[];
  /** Constraints whose item is not already listed in `humanKept` or `excluded`. */
  approvals: string[];
  data: { label: string; items: string[] }[];
  tests: string[]; success: string[]; failure: string[]; exceptions: string[];
  /** 03에서 보류·제외 기능과 연결돼 필수 완료 조건에서 빠진 기준. 삭제하지 않고
   * 04의 강등 표기("현재 필수 완료 조건 아님")와 같은 문구로 분리 표시한다. */
  demotedCriteria: string[];
  /** 03에서 보류·제외 기능과 연결돼 필수 완료 조건에서 빠진 예외·위험 문구. */
  demotedExceptions: string[];
  /** 03·04 공통: 성공·실패 양쪽 출처에서 온 동일 기준. 어느 쪽으로도 확정하지 않고
   * 04의 "판정 기준 출처 충돌 (확인 필요)"와 같은 의미로 분리 표시한다. */
  conflictingCriteria: string[];
  /** 03·04 공통: 동일 비교 대상의 상충 수치·허용 기준. 우선순위를 정하지 않으며
   * 어느 쪽도 합격 조건으로 쓰지 않고 확인 대상 섹션으로 분리 표시한다. */
  numericConflictCriteria: string[];
  /** Common notice when all tests share the same unconfirmed scope; individual prefixes are stripped. */
  testsNotice?: string;
  /** Common notice when all criteria share the same unconfirmed status; individual prefixes are stripped. */
  criteriaNotice?: string;
}

/** 03 강등 표기 접미사 (04의 demotedPocCriteria·deferredCriteria와 같은 취지). */
type AxDemotionAction = "exclude" | "defer";
const demotedLabel = (text: string, action: AxDemotionAction): string =>
  `${text} — 현재 필수 완료 조건 아님 (${action === "defer" ? "관련 단계 보류됨" : "관련 단계 제외됨"})`;

/** 활성 단계와 단어를 공유하면 강등하지 않는다 (isExcludedStepCriterion과 같은 보수 기준:
 * 구현·확인 후 구현 단계가 없으면 검증 단계 중 제외 단계명을 뺀 나머지가 비교 기준). */
function sharesActiveStepWords(model: AgentInstructionModel, text: string): boolean {
  const words = scopeWords(text);
  let activeStepNames = model.steps.filter(s => s.scope === "implement" || s.scope === "after-check").map(s => s.step);
  if (activeStepNames.length === 0) {
    const excluded = new Set(model.hitlDetails?.validatedExcludedStepNames ?? []);
    activeStepNames = model.steps.filter(s => s.scope === "verify" && !excluded.has(s.step)).map(s => s.step);
  }
  return activeStepNames.some(name => {
    const nameWords = scopeWords(name);
    return words.some(w => nameWords.includes(w)) || nameWords.some(w => words.includes(w));
  });
}

/** 전파 결과 직접 참조: HITL로 빠진 항목(removed)과의 연결.
 * 정확 일치(hitlDispositionForText) 또는 전파 규칙 그대로(2개 이상 내용 토큰 겹침 +
 * 특이 토큰, planDecisionMatches)를 쓴다. 전파 규칙을 완화하지 않으며, 전파 대상이
 * 아닌 진단 출처 항목도 removed 항목과 같은 기능이면 여기서 강등한다 — 전파 자체는
 * 계획 출처 항목에만 적용되므로 진단 PoC 기준·예외 문구는 이 경로가 아니면 03에 남는다.
 * removed에 없는 항목은 이 함수가 잡지 않는다 (단계명 경로는 아래 별도). */
function removedDemotionForText(model: AgentInstructionModel, text: string): AxDemotionAction | undefined {
  const removed = model.hitlDetails?.removed ?? [];
  if (removed.length === 0) return undefined;
  const disp = hitlDispositionForText(model, text);
  if (disp) return disp.action;
  const tokens = planDecisionTokens(text);
  if (tokens.length === 0) return undefined;
  const hit = removed.find(entry => planDecisionMatches(tokens, planDecisionTokens(entry.text)));
  return hit?.action;
}

/** 03 완료 기준 강등 판정: 현재 범위(scoped) 항목은 강등하지 않는다.
 * removed 연결이 있으면 그 판정을 우선하고, 없으면 기존 단계명 판정(isExcludedStepCriterion)을 쓴다. */
function demotionForCriterion(model: AgentInstructionModel, item: AgentInstructionItem): AxDemotionAction | undefined {
  if (item.role !== "criteria") return undefined;
  if (model.scoped.criteria.includes(item) || model.scoped.validationMethods.includes(item)) return undefined;
  const viaRemoved = removedDemotionForText(model, item.text);
  if (viaRemoved) return sharesActiveStepWords(model, item.text) ? undefined : viaRemoved;
  if (isExcludedStepCriterion(model, item)) return "exclude";
  return undefined;
}

/** 04 예외 정리와 같은 단어 겹침 기준 (2개 이상 단어 겹침, 또는 3자 이상 단어 1개 겹침). */
function relatesToStepName(text: string, stepName: string): boolean {
  const textWords = scopeWords(text);
  const nameWords = new Set(scopeWords(stepName));
  const overlap = textWords.filter(w => nameWords.has(w));
  return overlap.length >= 2 || overlap.some(w => w.length >= 3);
}

/** 03 예외·위험 강등 판정: removed 연결(전파 규칙) 또는 04와 같은 제외 단계명 단어 겹침.
 * 활성 단계(구현·확인 후 구현)와도 겹치는 공통 예외는 유지한다. */
function demotionForException(model: AgentInstructionModel, text: string): AxDemotionAction | undefined {
  const work = model.steps.filter(s => s.scope === "implement" || s.scope === "after-check");
  const viaRemoved = removedDemotionForText(model, text);
  if (viaRemoved) return work.some(s => relatesToStepName(text, s.step)) ? undefined : viaRemoved;
  const names = model.hitlDetails?.validatedExcludedStepNames ?? [];
  if (names.length > 0 && names.some(name => relatesToStepName(text, name))
    && !work.some(s => relatesToStepName(text, s.step))) return "exclude";
  return undefined;
}

export function planSummary(diagnosis: AxDiagnosis, rawPlan?: AxPlan, context = "", options: { hitlReviews?: import("./types").HitlReview[]; hitlTool?: "codex" | "claude" } = {}): AxPlanSummary {
  const model = buildAgentInstructionModel(rawPlan, { diagnosis, context, hitlReviews: options.hitlReviews, hitlTool: options.hitlTool });
  const profile = model.profile;
  const humanKept = mergeDistinct((profile?.manualSteps ?? []).map(step => `${step} (담당자 수행)`),
    model.classified.filter(item => item.role === "human").map(item => item.original ?? item.text));
  const scopeLevel = model.scopeLevel;
  const restricted = [
    ...(scopeLevel !== undefined && scopeLevel >= 2 ? [] : (profile?.automationSteps ?? []).map(step => `${step} 자동 실행`)),
    ...(scopeLevel !== undefined && scopeLevel >= 1 ? [] : (profile?.assistSteps ?? []).map(step => `${step} AI 보조 구현`)),
  ];
  const manualAutomation = (profile?.manualSteps ?? []).map(step => `${step} 자동화 (담당자 수행)`);
  const conditionEntries = [
    ...(model.gate === "blocked" ? profile?.blockReasons ?? [] : []).map(text => ({ text, future: false })),
    ...model.conditions.current.map(item => ({ text: item.text, future: false })),
    ...model.conditions.confirm.map(item => ({ text: `${item.text} (적용 단계 확인 필요)`, future: false })),
    ...model.conditions.future.map(item => ({ text: item.text, future: true })),
    ...model.gaps.map(text => ({ text, future: false })),
  ];
  const prerequisites = unique(conditionEntries.map(entry => entry.future ? `${entry.text} (향후 단계 조건)` : entry.text));
  const technicalChecks = diagnosis.technicalChecks ?? [];
  const checkTexts = new Set(technicalChecks.flatMap(check => [
    check.note ? `${check.topic} — ${check.note}` : check.topic,
    ...(check.status === "불가" ? [check.note ? `${check.topic} 불가 — ${check.note}` : `${check.topic} 불가`] : []),
  ]).map(normalizedItem));
  const openConditions = conditionEntries.filter(entry => !checkTexts.has(normalizedItem(entry.text.replace(/ \(적용 단계 확인 필요\)$/u, ""))));
  const checks = technicalChecks.flatMap(check => {
    const text = `${check.topic}${check.note ? ` — ${check.note}` : ""}`;
    const disp = hitlDispositionForText(model, text);
    // HITL 제외된 확인 항목은 현재 확인 작업에서 빠진다 (거부(불가) 증거는 모델이
    // 이미 보존하므로 removed에 없어 그대로 유지된다). 보류 항목은 확인 필요
    // 작업으로 승격하지 않고 보류 상태·사유·재개 조건과 함께 구분해 안내한다.
    if (disp?.action === "exclude") return [];
    const linked = model.classified.find(item => item.sources.includes("diagnosis.technicalChecks") && item.text === text);
    const tone: AxCheckTone = disp?.action === "defer" ? "held" : check.status === "확인됨" ? "done" : check.status === "불가" ? "blocked" : linked?.scope === "future" ? "future" : "required";
    const note = disp?.action === "defer"
      ? [check.note, `보류: ${disp.reason ?? "보류 중"}`, ...(disp.resumeCondition ? [`재개 조건: ${disp.resumeCondition}`] : [])].filter(Boolean).join(" · ")
      : check.note;
    return [{ topic: check.topic, status: check.status, note, tone }];
  });
  // P0-4: 파일형 산출물의 컬럼·열 목록이 파싱되지 않으면 확인 카드로 표시한다
  // (컬럼을 임의로 만들지 않는다). 04 최종 산출물과 같은 판정 기준을 쓴다.
  const summaryOutputs = model.scoped.outputs.length
    ? model.scoped.outputs.map(item => item.text)
    : (diagnosis.asIs?.outputs ?? []);
  const summaryUndeterminedOutputs = detectUndeterminedOutputs(summaryOutputs);
  if (summaryUndeterminedOutputs.length) {
    checks.push({ topic: "출력 컬럼 미확정", status: "확인 필요", note: `출력 컬럼이 확정되지 않은 산출물: ${summaryUndeterminedOutputs.join(", ")}. 컬럼명·순서·타입을 확정하기 전에는 해당 출력의 형식을 단정하지 않는다.`, tone: "required" });
  }
  // D4/D5 미확정은 summary.checks(기술 점검 카드 전용)에는 넣지 않는다.
  // 02 카드의 출처·개수를 바꾸면 기존 중복 제거 계약이 깨진다. 대신 지시문
  // §1 결정 지점 블록과 §5 미확정 항목 처리의 범위별 보류 문장으로 다룬다.
  const additionalChecks = buildAdditionalChecks(model, technicalChecks, checkTexts,
    new Set((model.gate === "blocked" ? profile?.blockReasons ?? [] : []).map(normalizedItem)));
  const excluded = mergeDistinct(restricted, without([
    ...(profile?.poc.outOfScope ?? []), ...model.classified.filter(item => item.role === "excluded").map(item => item.original ?? item.text),
    // HITL 확정 제외(계획 항목·단계)는 01의 제외 카드에도 동일하게 표시해
    // 구현 범위와 확정 결정이 어긋나지 않게 한다. 보류 항목은 제외가 아니므로
    // 여기에 넣지 않는다 (보류 안내는 02 보류 카드·로드맵 보류 안내·04 검토 구간이 담당).
    ...(model.hitlDetails?.excluded.map(entry => entry.name) ?? []),
  ], [...manualAutomation, ...humanKept]));
  const shownScope = new Set([...humanKept, ...excluded].map(normalizedItem));
  const pocTests = model.classified.filter(item => item.role === "tests");
  const criteria = (source: string) => unique(model.classified.filter(item => item.sources.includes(source) && !model.scoped.validationMethods.includes(item) && !demotionForCriterion(model, item)).map(item => model.scoped.criteria.includes(item)
    ? item.text : `${item.scope === "future" ? "향후 판정" : "기준 확인 필요"}: ${item.text}`));
  // 강등 기준은 통과·실패 목록에서 빼는 대신 별도 목록으로 분리 표시한다 (삭제 아님).
  // 강등 항목은 scoped가 아니므로 criteria()와 같은 미확인 접두어를 붙인 뒤 강등 접미사를 단다.
  const demotedCriteria = unique(model.classified.filter(item => item.role === "criteria"
    && (item.sources.includes("diagnosis.poc.success") || item.sources.includes("diagnosis.poc.failure") || item.sources.includes("plan.acceptance")))
    .flatMap(item => {
      const action = demotionForCriterion(model, item);
      if (!action) return [];
      return [demotedLabel(`${item.scope === "future" ? "향후 판정" : "기준 확인 필요"}: ${item.text}`, action)];
    }));
  return {
    include: unique((profile?.poc.inScope ?? []).flatMap(line => {
      // HITL로 빠진 단계(제외·보류)는 현재 구현 범위에서 빠진다. 보류 단계는
      // 01의 포함 목록에 올리지 않으며, 보류 안내는 02·로드맵·04 검토 구간이 담당한다.
      if (hitlDispositionForStepLine(model, line)) return [];
      const matches = model.steps.map((step, index) => ({ step, index }))
        .filter(({ step }) => step.treatment && normalizedStepText(`${step.step} ${step.treatment}`) === normalizedStepText(line));
      return matches.length > 1
        ? matches.map(({ step, index }) => `${step.step} ${stepMethodLabel(model, index)} (진단 단계 ${index + 1}; 진단 메모: ${step.note || "없음"})`)
        : [scopeItemLabel(model, line)];
    })),
    humanKept,
    excluded,
    prerequisites,
    checks,
    blockReasons: model.gate === "blocked" ? [...(profile?.blockReasons ?? [])] : [],
    additionalChecks,
    prerequisiteSources: prerequisites.map(text => {
      const key = normalizedItem(text.replace(/ \(적용 단계 확인 필요\)$/u, "").replace(/ \(향후 단계 조건\)$/u, ""));
      const sources = [...new Set(model.classified.filter(item => item.role === "conditions"
        && (normalizedItem(item.text) === key || normalizedItem(`${item.text} (적용 단계 확인 필요)`) === key))
        .flatMap(item => item.sources))];
      return { text, sources };
    }),
    conditions: {
      current: unique(openConditions.filter(entry => !entry.future).map(entry => entry.text)),
      future: unique(openConditions.filter(entry => entry.future).map(entry => entry.text)),
    },
    constraints: approvalConstraints(model),
    approvals: approvalConstraints(model, entry => !shownScope.has(normalizedItem(entry.original ?? entry.text)) && !shownScope.has(normalizedItem(entry.text))),
    data: [
      { label: "입력", items: unique(diagnosis.asIs?.inputs ?? []) },
      { label: "출력", items: unique((diagnosis.asIs?.outputs ?? []).map(text => `${text} (기존 업무 출력·참고)`)) },
      { label: "사용 시스템", items: unique(diagnosis.asIs?.systems ?? []) },
      { label: "검증용 입력", items: without(diagnosis.poc?.inputs ?? [], diagnosis.asIs?.inputs ?? []) },
      { label: "검증용 출력", items: unique(model.classified.filter(item => item.sources.includes("diagnosis.poc.outputs")).map(item => `${item.text}${model.scoped.outputs.includes(item) ? item.scope === "after-check" ? " (현재 조건부 출력)" : " (현재 출력)" : item.scope === "future" ? " (향후 출력)" : " (연결 근거 확인 필요)"}`)) },
    ].filter(row => row.items.length),
    ...completionCriteria(model, pocTests, criteria, diagnosis, demotedCriteria),
  };
}

/**
 * 03 완료 기준: repeated unconfirmed-status prefixes are folded into a single
 * common notice, and semantically duplicate items are merged. Original data,
 * Level × Gate policy, and the all-in-one prompt (which reads the model
 * directly) are unchanged — this only affects the summary presentation.
 */
function completionCriteria(
  model: AgentInstructionModel,
  pocTests: AgentInstructionItem[],
  criteria: (source: string) => string[],
  diagnosis: AxDiagnosis,
  demotedCriteria: string[],
): Pick<AxPlanSummary, "tests" | "success" | "failure" | "exceptions" | "demotedCriteria" | "demotedExceptions" | "conflictingCriteria" | "numericConflictCriteria" | "testsNotice" | "criteriaNotice"> {
  const rawTests = unique([...pocTests.map(item => model.scoped.tests.includes(item) ? item.text
    : `${item.scope === "future" ? "향후 검증" : "적용 범위 확인 필요"}: ${item.text}`), ...model.scoped.validationMethods.map(item => item.text)]);
  const rawSuccess = mergeDistinct(criteria("diagnosis.poc.success"), criteria("plan.acceptance"));
  const rawFailure = criteria("diagnosis.poc.failure");
  // Fold the repeated "적용 범위 확인 필요:" prefix into one notice when every
  // test item shares that unconfirmed status (mixed confirmed/unconfirmed stays explicit).
  let tests = rawTests;
  let testsNotice: string | undefined;
  if (tests.length > 1 && tests.every(item => TEST_SCOPE_PREFIX.test(item))) {
    tests = tests.map(item => item.replace(TEST_SCOPE_PREFIX, ""));
    testsNotice = "검증 대상 단계와 적용 범위는 확인이 필요합니다.";
  }
  // Same for the "기준 확인 필요:" prefix on pass/fail criteria.
  let success = rawSuccess;
  let failure = rawFailure;
  let criteriaNotice: string | undefined;
  const unconfirmed = (items: string[]) => items.length > 1 && items.every(item => CRITERION_PREFIX.test(item));
  if (unconfirmed(success) && unconfirmed(failure)) {
    success = success.map(item => item.replace(CRITERION_PREFIX, ""));
    failure = failure.map(item => item.replace(CRITERION_PREFIX, ""));
    criteriaNotice = "정확한 합격 판정 기준은 실제 업무 규칙 확인 후 확정합니다.";
  } else if (unconfirmed(success)) {
    success = success.map(item => item.replace(CRITERION_PREFIX, ""));
    criteriaNotice = "정확한 합격 판정 기준은 실제 업무 규칙 확인 후 확정합니다.";
  } else if (unconfirmed(failure)) {
    failure = failure.map(item => item.replace(CRITERION_PREFIX, ""));
    criteriaNotice = "정확한 실패 판정 기준은 실제 업무 규칙 확인 후 확정합니다.";
  }
  // A-1(c): 성공·실패 양쪽에 나타나는 동일 기준은 어느 쪽으로도 확정하지 않고
  // 04의 출처 충돌 분리 방식과 같은 의미로 분리 표시한다 (03 렌더링의 별도 행).
  const sourceSplit = splitSourceConflicts(dedupCriteria(success), dedupCriteria(failure));
  // A-2: 통과 조건 항목(PoC 성공 + 계획 acceptance, 강등·검증 방법 제외)에서
  // 동일 비교 대상의 상충 수치·허용 기준을 검출해 합격 조건에서 뺀다. 출처 충돌
  // 항목은 이미 분리됐으므로 수치 충돌 판정에서 제외한다.
  const passItems = model.classified.filter(item => item.role === "criteria"
    && (item.sources.includes("diagnosis.poc.success") || item.sources.includes("plan.acceptance"))
    && !model.scoped.validationMethods.includes(item) && !demotionForCriterion(model, item)
    && !(item.sources.includes("diagnosis.poc.success") && item.sources.includes("diagnosis.poc.failure"))
    && !sourceSplit.conflict.some(text => normalizedItem(text) === normalizedItem(item.text)));
  const numericItems = numericConflictItems(passItems);
  const numericTexts = unique(numericItems.map(item => numericConflictText(item)));
  // 예외·위험도 기준과 같은 방식으로 강등 표기한다: 기존에는 어떤 HITL 필터도
  // 거치지 않아 보류·제외 기능의 실패 처리 문구가 일반 예외로 남았다. tests 목록은
  // 건드리지 않는다 — 계획 출처 테스트는 전파 규칙이 이미 제거하고, scoped 테스트는
  // 현재 범위이며, 진단 PoC 테스트에는 04의 강등 대응 표시가 없어 새로 만들지 않는다.
  const rawExceptions = unique([...(diagnosis.asIs?.exceptions ?? []), ...(diagnosis.risks ?? []), ...model.classified.filter(item => item.role === "exception").map(item => item.text)]);
  const exceptions: string[] = [];
  const demotedExceptions: string[] = [];
  for (const text of rawExceptions) {
    const action = demotionForException(model, text);
    if (action) demotedExceptions.push(demotedLabel(text, action));
    else exceptions.push(text);
  }
  return {
    tests: dedupCriteria(tests),
    success: withoutBareTexts(sourceSplit.success, numericItems.map(item => item.text)),
    failure: sourceSplit.failure,
    exceptions: dedupCriteria(exceptions),
    demotedCriteria,
    demotedExceptions: dedupCriteria(demotedExceptions),
    conflictingCriteria: sourceSplit.conflict,
    numericConflictCriteria: numericTexts,
    ...(testsNotice ? { testsNotice } : {}),
    ...(criteriaNotice ? { criteriaNotice } : {}),
  };
}

/** Comparative targets need an expected result before they can pass or fail. */
const VAGUE_CRITERION = /감소|증가|개선|단축|향상|최소화|최대화/u;
const stripEnumerator = (item: string) => item.replace(/^\s*(?:\d+[.)]|[①-⑳])\s*/u, "").trim();
/** An explicit test label in a feature field marks a scenario, not a feature. */
const TEST_LABEL = /^(?:테스트(?:\s*시나리오)?|(?:정상|경계|경계값|실패|예외|오류)\s*(?:케이스|사례|시나리오)?)\s*:/u;
/** Level 1 never runs unattended; a proposal describing that method needs confirmation, not authorization. */
const UNATTENDED_METHOD = /(무인|자동\s*(?:생성|작성|실행|전송|발행|승인|확정|수집|계산))/u;
const REQUESTED = /(담당자 요청|담당자 확인 후|수동 요청|요청 시)/u;
const RULE_NOTE = /(규칙\s*기반|확정된 규칙|정해진 규칙|알고리즘|계산식(?:을|으로|에 따라|대로)|확정\s*(?:계산식|운임표|단가표|요율표|기준)|정해진\s*(?:기간|기준|조건)|(?:증감률|증감액|평균|합계|총합|차액|비율|금액|단가|수량)\s*(?:을|를)?\s*(?:계산|산출))/u;
const SCRIPT_NOTE = /(?:스크립트|프로그램|시스템|라이브러리).*(?:파일|데이터|자료|텍스트|문서).*(?:읽|병합|취합|추출|집계|변환)|(?:파일|데이터|자료|텍스트|문서).*(?:읽|병합|취합|추출|집계|변환).*(?:라이브러리|스크립트|프로그램)\s*사용|(?:파일|데이터|자료)\s*(?:집계|병합|취합|추출|변환|읽|쓰|저장|로드)|(?:API|SDK)\s*(?:호출|연동)|(?:Excel|엑셀|파일|시스템|화면|양식|템플릿)에\s*(?:\S+\s*){0,2}?(?:입력|등록)(?!\s*(?:후보|초안))/iu;
const CANDIDATE_NOTE = /(?:AI(?:로|가|는|은|을|를|와|과)?(?:\s+\S+){0,3}?\s*(?:후보|초안|생성|모델|처리)|인공지능|언어\s*모델|LLM|(?:후보|초안)(?:\s*·\s*(?:후보|초안))?\s*(?:생성|제안|검토|분류|작성)|후보와 변환 결과)/iu;
const MANUAL_NOTE = /(?:담당자|사람)(?:가|이)\s*[^,.;]{0,30}?(?:직접|수동으로)?\s*(?:처리|검토|판단|작성|승인|확인|확정)/u;
const VALIDATION_METHOD = /대조|비교|기록/u;
const PASS_CONDITION = /통과|(?<!불)일치|동일|모두|빠짐없이|않(?:아야|음)|없(?:어야|음)|실패|정상.*(?:섞|처리)|분리/u;
/** Level 0 permits no system integration or AI implementation, so a check about one cannot gate the current review work. */
const INTEGRATION_CHECK = /(API|연동|인증|라이선스|AI\s*(?:모델|서비스|엔진)|생성\s*모델|외부\s*시스템|자동\s*(?:저장|전송|업로드))/iu;
/** A Level 0 review has no automated or AI output to compare against. */
const AUTOMATED_RESULT = /(?:자동|AI|인공지능)\s*(?:생성|작성|초안|결과|처리|판단|판정|분류|추출)/iu;
export interface AgentInstructionItem {
  /** First source field; `sources` lists every field that carried the same item. */
  source: string;
  sources: string[];
  role: string;
  text: string;
  /** Raw wording when the plan guard qualified or replaced part of it. */
  original?: string;
  /** Original variants retained when presentation duplicates share a classification. */
  originals: string[];
  scope: StepScope["scope"] | "confirm" | "excluded";
  step?: string;
  reason?: string;
  /** HITL reviewable key for exact target matching (occurrence-aware).
   * 동일 문구 중복 항목의 오매칭 방지를 위해 계획 항목 생성 시 부여. */
  reviewKey?: string;
}
/** Actual processing evidence, independent of the Level/Gate execution restriction. */
export type StepMethod = "assist" | "rule" | "script" | "manual" | "confirm" | "composite";
export interface AgentInstructionModel {
  profile?: ExecutionProfile;
  level?: { level: number; label: string; provisional: boolean };
  gate?: ExecutionGate;
  scopeLevel?: number;
  /** Policy step scope, unchanged and in diagnosis order. */
  steps: StepScope[];
  /** Index-aligned with `steps`; explicit diagnosis note evidence only, never inferred from policy/verdict. */
  methods: StepMethod[];
  methodReasons: string[];
  /** Index-aligned with `steps`; user-facing reasons without internal field paths. */
  methodUserReasons: string[];
  /** Index-aligned with `steps`; the ordered roles of a composite method, or undefined. */
  methodChains: (StepMethod[] | undefined)[];
  /** Index-aligned with `steps`; execution order of a composite method: explicit sequence or parallel. */
  methodOrders: (MethodOrder | undefined)[];
  conditions: { current: AgentInstructionItem[]; future: AgentInstructionItem[]; global: AgentInstructionItem[]; confirm: AgentInstructionItem[] };
  classified: AgentInstructionItem[];
  ambiguous: AgentInstructionItem[];
  scoped: { features: AgentInstructionItem[]; tests: AgentInstructionItem[]; criteria: AgentInstructionItem[]; validationMethods: AgentInstructionItem[]; outputs: AgentInstructionItem[]; conditions: AgentInstructionItem[] };
  diagnosis?: AxDiagnosis;
  plan?: AxPlan;
  prerequisites: string[];
  gaps: string[];
  /** HITL 3차: 검토 결과가 반영되었는지 여부 */
  hitlApplied?: boolean;
  /** 1차 MVP 개선: 항상 7개인 고정 결정 지점 (기본값 미확정). */
  decisionPoints?: ResolvedDecisionPoint[];
  /** 범용 업무 규칙 목록 (D1~D7과 별개 체계, 없으면 빈 배열). */
  genericRules?: GenericRule[];
  /** HITL 3차: 적용된 검토 상세 */
  hitlDetails?: {
    appliedReviews: Array<{ id: string; action: string; targetKey: string }>;
    /** 보류 대상: 내부 키는 보조 식별자이며, 표시는 실제 업무 단계명·항목명을 우선한다. */
    deferred: Array<{ key: string; name: string; reason?: string; resumeCondition?: string }>;
    /** 제외 대상: 지시문에서 명시적으로 전달하기 위한 확정 제외 목록 (이름 포함). */
    excluded: Array<{ key: string; name: string }>;
    supplements: Array<{ key: string; name: string; content: string }>;
    /** Priority 5: 유효성 검증된 step-type exclude/defer 검토 + 계획 항목 결정으로 전파된 단계명 집합 (PoC 기준 demote용) */
    validatedExcludedStepNames?: string[];
    /** 유효성 검증된 step-type defer 검토 + 계획 항목 보류로 전파된 단계명 (보류 산출물·예외 정리용) */
    deferredStepNames?: string[];
    /** 유효성 검증된 step-type exclude 검토 + 계획 항목 제외로 전파된 단계명 (제외 산출물·예외 정리용) */
    excludedStepNames?: string[];
    /** HITL로 현재 실행 범위에서 빠진 표시 항목 (로드맵·01~03 공통 표시 모델용). */
    removed?: HitlRemovedItem[];
    /** HITL로 현재 실행 범위에서 빠진 진단 단계 (로드맵 단계 상세 공통 표시 모델용). */
    removedSteps?: HitlRemovedStep[];
  };
}
/** HITL로 현재 실행 범위에서 빠진 표시 항목 1건: 로드맵·01~03이 04와 같은
 * 확정 범위를 표시하기 위해, 매칭 규칙을 복사하지 않고 모델이 직접 제공한다.
 * action이 exclude면 현재 작업에서 제거하고, defer면 보류 상태·사유·재개 조건과
 * 함께 구분해 안내한다. 거부(불가) 증거는 여기에 포함되지 않는다. */
export interface HitlRemovedItem {
  text: string;
  originals: string[];
  role: string;
  step?: string;
  action: "exclude" | "defer";
  reason?: string;
  resumeCondition?: string;
}
/** HITL로 현재 실행 범위에서 빠진 진단 단계 1건 (단계 검토 또는 계획 결정 전파). */
export interface HitlRemovedStep {
  step: string;
  action: "exclude" | "defer";
  reason?: string;
  resumeCondition?: string;
}
/** Strong markers of an explicit execution order; weak connectors need an explicit actor to count. */
const STRONG_SEQUENCE = /(먼저|다음|그\s*뒤|뒤에|그\s*후|후에|한\s*뒤|→|이후|그다음)/u;
const PARALLEL_WORD = /(병행|동시에|나란히)/u;
const WEAK_SEQUENCE = /(그리고|하고|이어서)/u;
/** An explicit actor as grammatical subject after a weak connector signals a real sequence. */
const ACTOR_SUBJECT = /(담당자|사람|AI|시스템)(가|이|는|은)/u;
/** Order of a composite flow: an explicit sequence, or an explicit parallel execution. */
export type MethodOrder = "sequence" | "parallel";
/** Ordered processing roles inside one evidence text, by first occurrence. */
const methodsIn = (text: string): StepMethod[] => {
  const ordered: { method: StepMethod; at: number }[] = [];
  const push = (method: StepMethod, pattern: RegExp) => {
    const match = pattern.exec(text);
    if (match) ordered.push({ method, at: match.index ?? 0 });
  };
  push("rule", RULE_NOTE); push("script", SCRIPT_NOTE); push("assist", CANDIDATE_NOTE); push("manual", MANUAL_NOTE);
  return [...new Set(ordered.sort((a, b) => a.at - b.at).map(entry => entry.method))];
};
function stepMethod(s: StepScope, duplicate: boolean, diagnosis?: AxDiagnosis): { method: StepMethod; reason: string; userReason: string; chain?: StepMethod[]; order?: MethodOrder } {
  if (duplicate) return { method: "confirm", reason: "동일 이름의 진단 단계 중복: 적용 단계 확인 필요", userReason: "동일 이름의 진단 단계 중복: 처리 방식·적용 단계 확인 필요" };
  if (s.scope === "human") return { method: "manual", reason: s.note, userReason: s.note };
  // Owner/verdict describe responsibility and policy, not an implementation-method enum.
  // Only exactly linked descriptions contribute evidence; similar names never establish a relation.
  // TO-BE evidence links by exact name; a strict containment links only when it is
  // unambiguous (exactly one TO-BE entry and exactly one diagnosed step participate).
  // Mere similarity never links: "증감률 계산" ⊂ "전주 대비 증감률 계산" links, but
  // "만료 대상 추출" vs "만료 예정 계약 추출" shares no containment and stays unlinked.
  const toBeItems = diagnosis?.toBe ?? [];
  const exactToBe = toBeItems.filter(item => normalizedStepText(item.step) === normalizedStepText(s.step));
  const containedToBe = exactToBe.length ? [] : toBeItems.filter(item => {
    const a = normalizedStepText(item.step), b = normalizedStepText(s.step);
    return a && b && a !== b && (b.includes(a) || a.includes(b));
  });
  const unambiguousToBe = containedToBe.length === 1
    && (diagnosis?.stepAssessments ?? []).filter(other => {
      const a = normalizedStepText(containedToBe[0].step), b = normalizedStepText(other.step);
      return a && b && a !== b && (b.includes(a) || a.includes(b));
    }).length === 1 ? containedToBe : [];
  const evidence = [
    ...(s.note ? [{ source: "diagnosis.stepAssessments.note", text: s.note }] : []),
    ...[...exactToBe, ...unambiguousToBe]
      .map(item => ({ source: "diagnosis.toBe.description", text: item.description })),
  ];
  // 내부 추적용 (출처 경로 포함)
  const reason = evidence.map(item => `${item.source}: ${item.text}`).join("; ");
  // 사용자 표시용 (출처 경로 제거, 실제 근거만)
  const userReason = evidence.map(item => item.text).join("; ");
  const itemChains = evidence.map(item => ({ item, chain: methodsIn(item.text) }));
  const all = methodsIn(evidence.map(item => item.text).join("\n"));
  const processing = (chain: StepMethod[]) => chain.filter(method => method !== "manual");
  // A confirmed composite is one coherent statement: distinct processing roles with either an
  // explicit order (sequential) or an explicit parallel relation. Mere enumeration never
  // establishes an order, and the same processing role described differently by different
  // sources is a conflict, not a composite.
  const orderOf = (text: string, chain: StepMethod[]): MethodOrder | undefined => {
    if (chain.length < 2 || processing(chain).length < 1) return undefined;
    if (PARALLEL_WORD.test(text)) return "parallel";
    if (STRONG_SEQUENCE.test(text)) return "sequence";
    const weak = WEAK_SEQUENCE.exec(text);
    if (weak && ACTOR_SUBJECT.test(text.slice(weak.index + weak[0].length))) return "sequence";
    return undefined;
  };
  const sequenced = itemChains
    .map(({ item, chain }) => ({ item, chain, order: orderOf(item.text, chain) }))
    .find(entry => entry.order);
  if (sequenced) {
    const chain = sequenced.chain;
    const consistent = itemChains.every(({ chain: other }) => processing(other).every(method => processing(chain).includes(method)));
    if (consistent) return { method: "composite", reason, userReason, chain, order: sequenced.order };
    return { method: "confirm", reason: ["처리 방식 근거 충돌", reason].filter(Boolean).join("; "), userReason: ["처리 방식 근거 충돌", userReason].filter(Boolean).join("; ") };
  }
  if (all.length > 1 && processing(all).length >= 2) return { method: "confirm", reason: ["처리 방식 근거 충돌", reason].filter(Boolean).join("; "), userReason: ["처리 방식 근거 충돌", userReason].filter(Boolean).join("; ") };
  const method = processing(all).length === 1 ? processing(all)[0] : all.length === 1 ? all[0] : "confirm";
  // PART C: 내부 추적용 reason은 "명시적 처리 방식 확인 필요"를 유지하되,
  // 사용자 표시용 userReason은 실제 근거가 있으면 근거만, 없으면 구체적 확인 안내로 표시한다.
  const reasonPrefix = method === "confirm" && !all.length ? "명시적 처리 방식 확인 필요" : "";
  const userReasonPrefix = method === "confirm" && !all.length && !userReason
    ? "진단에 처리 방식의 구체적 근거가 없음: 실제 처리 규칙·입력 형식을 확인하세요" : "";
  return {
    method,
    reason: [reasonPrefix, reason].filter(Boolean).join("; "),
    userReason: [userReasonPrefix, userReason].filter(Boolean).join("; "),
  };
}
/** Short user-facing name of one processing role inside a composite chain. */
export function stepMethodShortLabel(method: StepMethod): string {
  return method === "rule" ? "규칙 기반 처리" : method === "script" ? "일반 시스템·스크립트 처리"
    : method === "assist" ? "AI 후보·초안 생성" : method === "manual" ? "담당자 확인" : "처리 방식 확인 필요";
}
/**
 * 처리 방식이 실제로 확인된 상태인지 판정한다.
 * - method가 confirm이 아니거나, 동일 이름 중복인 경우는 false
 * - 근거 충돌("처리 방식 근거 충돌")인 경우는 false — 임의 선택 금지
 * - 근거 없음("명시적 처리 방식 확인 필요" / "구체적 근거가 없음")인 경우는 false
 * - 실제 근거 텍스트가 있는 경우에만 true
 * 설명 텍스트 존재 ≠ 확정. 이 구분 없이 "확인된 처리 기준"이라고 표시하지 않는다.
 */
export function isConfirmedMethodEvidence(model: AgentInstructionModel, index: number): boolean {
  if (model.methods[index] !== "confirm") return false;
  const step = model.steps[index];
  if (step && model.steps.filter(s => normalizedStepText(s.step) === normalizedStepText(step.step)).length > 1) return false;
  const reason = model.methodReasons?.[index] ?? "";
  if (reason.includes("처리 방식 근거 충돌")) return false;
  if (reason.includes("명시적 처리 방식 확인 필요")) return false;
  const userReason = model.methodUserReasons?.[index]?.trim() ?? "";
  if (!userReason) return false;
  if (userReason.includes("구체적 근거가 없음")) return false;
  return true;
}
/** 처리 방식 근거가 충돌하는 상태인지 */
export function isConflictingMethodEvidence(model: AgentInstructionModel, index: number): boolean {
  if (model.methods[index] !== "confirm") return false;
  return (model.methodReasons?.[index] ?? "").includes("처리 방식 근거 충돌");
}
/**
 * Display-only reason for an undetermined processing method (method "confirm" without
 * confirmed evidence or a conflict). The category is derived only from evidence text
 * actually recorded in the diagnosis (step note / TO-BE description); with no such
 * evidence it returns undefined and the generic "처리 방식 미확정" wording stays.
 * It never changes the method, the Level × Gate scope, or any policy decision.
 */
export function methodUndeterminedCategory(model: AgentInstructionModel, index: number): string | undefined {
  if (model.methods[index] !== "confirm") return undefined;
  if (isConflictingMethodEvidence(model, index) || isConfirmedMethodEvidence(model, index)) return undefined;
  const step = model.steps[index];
  if (step && model.steps.filter(s => normalizedStepText(s.step) === normalizedStepText(step.step)).length > 1) return undefined;
  const evidence = (model.methodUserReasons?.[index] ?? "").replace(/^진단에 처리 방식의 구체적 근거가 없음[^:]*:\s*/u, "").trim();
  if (!evidence || evidence.startsWith("명시적 처리 방식 확인 필요")) return undefined;
  if (/(승인\s*(?:주체|자|조건|절차)|판단\s*주체|결재\s*(?:주체|자|조건)|승인자)/u.test(evidence)) return "승인 주체·조건 미확인";
  if (/(확정|정해진|기존)\s*(규칙|계산식)/u.test(evidence) && /(원본|실제\s*자료|샘플)/u.test(evidence) && /(미확인|확인\s*필요|없음|부족)/u.test(evidence)) return "계산 규칙 존재하나 원본 자료 미확인";
  if (/(API|연동|권한|인증|접근\s*권한|로그인)/u.test(evidence)) return "외부 연동·접근 권한 미확인";
  if (/(입력\s*형식|파일\s*형식|데이터\s*형식|필드|컬럼|포맷)/u.test(evidence)) return "입력 형식 미확정";
  if (/(계산식|계산\s*규칙|계산\s*기준|산출\s*기준|요율|단가\s*기준)/u.test(evidence)) return "확정 계산식 없음";
  if (/(출력\s*양식|보고\s*양식|매핑|출력\s*형식)/u.test(evidence)) return "출력 양식·매핑 기준 미확정";
  if (/(Python|파이썬|Excel|엑셀|스크립트|매크로|RPA|시스템|프로그램|도구)/u.test(evidence)) return "기술 제안됐으나 실제 사용 가능 여부 미확정";
  if (/(기술|방식|방법)/u.test(evidence)) return "처리 기술·방법 미확정";
  return undefined;
}
/** One user-facing processing label shared across timeline, summary and prompt. */
export function stepMethodLabel(model: AgentInstructionModel, index: number): string {
  const step = model.steps[index];
  if (!step) return "처리 방식 확인 필요";
  const method = model.methods[index];
  const chain = model.methodChains[index];
  if (method === "composite" && chain?.length) {
    const order = model.methodOrders[index];
    const verifySuffix = step.scope === "verify" ? " · 검토·검증만 (운영 구현 금지)" : "";
    if (order === "parallel") {
      const parts = chain.map(stepMethodShortLabel).join(" · ");
      return `복합 처리 (병행): ${parts} — 실행 순서·의존성 확인 필요${verifySuffix}`;
    }
    const ordered = chain.map(stepMethodShortLabel).join(" → ");
    return `복합 처리 (확인된 순서): ${ordered}${verifySuffix}`;
  }
  const processing = method === "rule" ? "규칙 기반 처리 (구체 규칙 확인 필요)" : method === "script" ? "일반 시스템·스크립트 처리" : method === "assist" ? "AI 후보·초안 생성" : method === "manual" ? "담당자 수동 처리" : "처리 방식 확인 필요";
  if (step.scope === "verify") return `${processing} · 검토·검증만 (운영 구현 금지)`;
  if (step.scope === "human") return "담당자 수행 유지 (자동화·판단 대체 금지)";
  if (method === "confirm") {
    if (model.steps.filter(s => normalizedStepText(s.step) === normalizedStepText(step.step)).length > 1)
      return "동일 이름의 진단 단계 중복: 처리 방식·적용 단계 확인 필요";
    // 근거 충돌: "확인된 처리 기준"으로 표시하지 않고 충돌 해결을 요구한다
    if (isConflictingMethodEvidence(model, index)) {
      const evidence = (model.methodUserReasons?.[index]?.trim() ?? "").replace(/^처리 방식 근거 충돌\s*[;:]\s*/, "");
      return `처리 방식 근거 충돌 · 확인 후 진행\n충돌된 근거: ${evidence}\n충돌을 해결하기 전에는 처리 방식을 임의로 선택·구현하지 마세요. 확인과 무관한 독립 단계는 계속 진행할 수 있습니다.`;
    }
    // 실제 확인된 근거가 있을 때만 "확인된 처리 기준"으로 표시한다
    if (isConfirmedMethodEvidence(model, index)) {
      const confirmed = model.methodUserReasons?.[index]?.trim();
      return `확인된 처리 기준에 따라 구현\n확인된 기준: ${confirmed}\n위 기준에 명시되지 않은 처리 방식은 담당자에게 확인하기 전에는 선택·구현하지 마세요.`;
    }
    const category = methodUndeterminedCategory(model, index);
    return category
      ? `처리 방식 미확정 · 확인 후 진행\n미확정 사유: ${category} — 실제 근거: ${(model.methodUserReasons?.[index] ?? "").trim()}\n해당 사유가 확인되기 전에는 해당 처리만 보류하세요. 확인과 무관한 독립 단계는 계속 진행할 수 있습니다.`
      : "처리 방식 미확정 · 확인 후 진행\n처리 방식의 구체적 근거가 확인되지 않았습니다. 실제 처리 규칙·입력 형식을 먼저 확인하고, 확인 전에는 해당 처리만 보류하세요. 확인과 무관한 독립 단계는 계속 진행할 수 있습니다.";
  }
  if (method === "assist") return "AI 후보·초안 생성 (담당자 확정 전 운영 반영 금지)";
  if (method === "manual") return "담당자 수동 처리 (시스템 구현 전 역할·범위 확인 필요)";
  if (method === "script") return model.scopeLevel === 1
    ? "일반 시스템·스크립트 처리 (담당자 요청 시 실행·형식·병합 키·예외 기준 확인 후 구현)"
    : "일반 시스템·스크립트 처리 (형식·업무 규칙 확인 후 구현)";
  return model.scopeLevel === 1
    ? "규칙 기반 처리 (규칙 확인 후 담당자 요청 시 실행·결과는 담당자 확인 후 확정)"
    : "규칙 기반 처리 (규칙 확인 후 구현·예외는 담당자 확인)";
}
/** Rewrite an exact policy-generated step/treatment line, leaving support and narrative text untouched. */
export function scopeItemLabel(model: AgentInstructionModel, text: string): string {
  const prefix = text.startsWith("샘플 범위: ") ? "샘플 범위: " : "";
  const line = prefix ? text.slice(prefix.length) : text;
  const matches = model.steps.map((step, index) => ({ step, index }))
    .filter(({ step }) => step.treatment && normalizedStepText(`${step.step} ${step.treatment}`) === normalizedStepText(line));
  if (matches.length > 1) return `${prefix}${matches[0].step.step} 동일 이름의 진단 단계 중복: 처리 방식·적용 단계 확인 필요 (진단 단계 ${matches.map(({ index }) => index + 1).join(", ")})`;
  return matches.length === 1 ? `${prefix}${matches[0].step.step} ${stepMethodLabel(model, matches[0].index)}` : text;
}
/** Per-step INPUT/PROCESS/OUTPUT spec derived from confirmed evidence only.
 * Inputs: plan dataFlow items linked to the step, else the task-level inputs as reference.
 * Process: the step treatment + method chain. Outputs: scoped outputs linked to the step,
 * else the task-level PoC outputs as the overall deliverable (never auto-excluded).
 * Missing pieces are reported as "확인 필요", never invented. */
export interface StepIoSpec { inputs: string[]; process: string[]; outputs: string[]; overallOutputs: string[]; reviewPoint?: string }
/** One step's own direct outputs, split by how they were linked:
 * scoped outputs linked to the step, keyword-related PoC outputs, and — only for
 * the last implementable step — the task's final deliverable when it matches. */
function stepDirectOutputs(model: AgentInstructionModel, step: StepScope, pocOutputs: string[]): { outputs: string[]; relatedOutputs: string[]; producingOutputs: string[] } {
  const d = model.diagnosis;
  const outputs = model.scoped.outputs.filter(item => item.step === step.step).map(item => item.text);
  const stepKeywords = new Set(step.step.replace(/[^\uAC00-\uD7A3A-Za-z0-9]/gu, " ").split(/\s+/u).filter(w => w.length >= 2));
  // 2개 이상 핵심어 일치, 또는 3자 이상 핵심어 1개 일치가 필요 ("가격" 같은 일반 명사 1개만으로는 연결하지 않음).
  const relatedOutputs = !outputs.length ? pocOutputs.filter(out => {
    const outWords = out.replace(/[^\uAC00-\uD7A3A-Za-z0-9]/gu, " ").split(/\s+/u).filter(w => w.length >= 2);
    const overlap = outWords.filter(w => stepKeywords.has(w));
    return overlap.length >= 2 || overlap.some(w => w.length >= 3);
  }) : [];
  // The task's final deliverable is produced by the last implementable step of the
  // diagnosed flow. When that step has no linked output of its own and a final output
  // keyword-matches the step, the deliverable is that step's direct output — it is not
  // repeated on every other step, and unmatched intermediates stay unassigned.
  const workSteps = model.steps.filter(st => st.scope === "implement" || st.scope === "after-check");
  // 확정 산출물(허용 단계에 연결된 출력)이 있으면 AS-IS 산출물을 이 단계의 직접
  // 산출물로 귀속하지 않는다 — AS-IS 결과물은 참고 정보이지 구현 목표가 아니다.
  const producingOutputs = !outputs.length && !relatedOutputs.length && !model.scoped.outputs.length && workSteps[workSteps.length - 1] === step
    ? (d?.asIs?.outputs ?? []).filter(out => {
      const outWords = out.replace(/[^\uAC00-\uD7A3A-Za-z0-9]/gu, " ").split(/\s+/u).filter(w => w.length >= 2);
      const overlap = outWords.filter(w => stepKeywords.has(w));
      return overlap.length >= 2 || overlap.some(w => w.length >= 3);
    }) : [];
  return { outputs, relatedOutputs, producingOutputs };
}
export function stepIoSpec(model: AgentInstructionModel, index: number): StepIoSpec {
  const step = model.steps[index];
  if (!step) return { inputs: [], process: [], outputs: [], overallOutputs: [] };
  const d = model.diagnosis;
  const flowItems = model.classified.filter(item => item.role === "flow" && item.step === step.step);
  const featureItems = model.scoped.features.filter(item => item.step === step.step);
  const methodIdx = model.steps.indexOf(step);
  const process = [
    ...(step.treatment ? [`처리 방식: ${step.treatment}`] : []),
    `판정: ${stepMethodLabel(model, methodIdx)}`,
    ...featureItems.map(item => `구현: ${item.text}`),
  ];
  // Overall PoC outputs are references, not permission to reintroduce a
  // future, human or HITL-excluded step into the current feature.
  const excludedStepNames = model.hitlDetails?.validatedExcludedStepNames ?? [];
  const pocOutputs = unique(model.classified.filter(item => item.role === "outputs"
    && item.sources.includes("diagnosis.poc.outputs") && !["future", "human", "excluded"].includes(item.scope)
    && !excludedStepNames.some(name => normalizedStepText(item.text).startsWith(`${normalizedStepText(name)} `)))
    .map(item => item.text));
  const { outputs, relatedOutputs, producingOutputs } = stepDirectOutputs(model, step, pocOutputs);
  const workSteps = model.steps.filter(st => st.scope === "implement" || st.scope === "after-check");
  // Data-flow link: in a sequential diagnosed flow the last implementable step
  // consumes the preceding implementable steps' direct outputs. Only outputs
  // already attributed to those steps are listed — never invented fields.
  // Non-terminal steps keep the task-level inputs unless a flow item links them.
  const chainInputs = !flowItems.length && workSteps.length > 1 && workSteps[workSteps.length - 1] === step
    ? unique(model.steps.slice(0, index)
      .filter(st => st.scope === "implement" || st.scope === "after-check")
      .flatMap(st => {
        const direct = stepDirectOutputs(model, st, pocOutputs);
        return [...direct.outputs, ...direct.relatedOutputs, ...direct.producingOutputs];
      })).map(text => `${text} (선행 단계 산출물)`)
    : [];
  const inputs = flowItems.length ? flowItems.map(item => item.text)
    : [...chainInputs, ...(d?.asIs?.inputs?.length ? d.asIs.inputs.map(text => `${text} (업무 전체 입력)`) : [])];
  // PoC outputs not attributed to this step stay overall-deliverable references,
  // even when the step has direct outputs of its own (including the final
  // deliverable it produces): attribution is per output item, not all-or-nothing.
  const overallOutputs = pocOutputs.filter(out => !relatedOutputs.includes(out));
  const reviewPoint = step.scope === "after-check" ? "관련 선행 조건 확인 후 진행"
    : model.methods[methodIdx] === "assist" ? "AI 결과는 담당자 확정 전 운영 반영 금지" : undefined;
  return { inputs, process, outputs: [...outputs, ...relatedOutputs.map(t => `${t} (관련 산출물)`), ...producingOutputs], overallOutputs, reviewPoint };
}

/** Existing human/exclusion fields are restrictive evidence; preserve wording and provenance. */
export function approvalConstraints(model: AgentInstructionModel, keep: (item: AgentInstructionItem) => boolean = () => true): string[] {
  const entries = model.classified.filter(item => item.role === "human" || item.role === "excluded")
    .filter(item => item.sources.some(source => source === "diagnosis.humanInLoop" || source === "diagnosis.poc.outOfScope"
      || source === "plan.humanInLoop" || source === "plan.outOfScope" || source === "policy.manualSteps"))
    .filter(keep);
  return unique(entries.map(item => `${item.original ?? item.text}${item.original ? ` (현재 계획 문구: ${item.text})` : ""}`));
}
type PromptOptions = {
  taskName?: string;
  prerequisites?: string[];
  diagnosis?: AxDiagnosis;
  context?: string;
  /** HITL 3차: 현재 유효한 confirmed 검토 (getValidConfirmedReviews 결과) */
  hitlReviews?: import("./types").HitlReview[];
  /** HITL 3차: 현재 선택한 코딩 도구 (계획 출처 구분용) */
  hitlTool?: "codex" | "claude";
  /** 범용 업무 규칙 목록 (D1~D7과 별개 체계, 없으면 0건으로 취급). */
  genericRules?: GenericRule[];
};
const PLAN_ROLES: Record<Exclude<keyof AxPlan, "repositoryFirst">, string> = {
  goal: "goal", asIs: "reference", toBe: "reference", inScope: "features", outOfScope: "excluded",
  prerequisites: "conditions", humanInLoop: "human", poc: "reference", implementation: "features",
  dataFlow: "flow", integrations: "conditions", exceptions: "exception", fallback: "fallback",
  security: "security", operation: "operation", tests: "tests", acceptance: "criteria",
};

/** Derive one read-only scope before rendering; narrative evidence cannot enlarge a policy step. */
export function buildAgentInstructionModel(rawPlan: AxPlan | undefined, options: PromptOptions = {}): AgentInstructionModel {
  const d = options.diagnosis;
  // Old sparse runtime records must not acquire a fabricated Level or Gate through defaults.
  const validFactors = d?.factors?.length === FACTOR_KEYS.length && FACTOR_KEYS.every(key => d.factors.some(f => f.key === key && Number.isFinite(f.aiValue)));
  const validGate = d?.decisionGate && ["go", "conditional", "no-go"].includes(d.decisionGate.verdict)
    && ["sufficient", "partial", "needs-check"].includes(d.informationSufficiency);
  const safe = d && validFactors && validGate ? {
    ...d,
    asIs: { purpose: "", trigger: "", inputs: [], outputs: [], steps: [], exceptions: [], systems: [], humanDecisions: [], ...(d.asIs as Partial<AxDiagnosis["asIs"]> | undefined) },
    stepAssessments: d.stepAssessments ?? [], toBe: d.toBe ?? [], humanInLoop: d.humanInLoop ?? [],
    technicalChecks: d.technicalChecks ?? [], risks: d.risks ?? [], followUpQuestions: d.followUpQuestions ?? [],
    poc: { hypothesis: "", inScope: [], outOfScope: [], inputs: [], outputs: [], evaluation: [], success: [], failure: [], ...(d.poc as Partial<AxDiagnosis["poc"]> | undefined) },
    decisionGate: { ...d.decisionGate, reasons: d.decisionGate.reasons ?? [] },
    operation: { owner: "", failureOwner: "", maintenanceBurden: "medium" as const, fallback: "", notes: [], ...(d.operation as Partial<AxDiagnosis["operation"]> | undefined) },
  } as AxDiagnosis : undefined;
  const profile = safe ? executionProfile(safe) : undefined;
  const level = safe ? automationLevel(safe) : undefined;
  const gate = profile?.gate;
  const scopeLevel = profile ? gate === "blocked" ? 0 : profile.level : undefined;
  const steps = profile?.stepScope ?? [];
  const guarded = rawPlan ? guardPlan(rawPlan, [options.taskName ?? "", options.context ?? ""].join("\n")) : undefined;
  const classified: AgentInstructionItem[] = [];
  const closed = new Set([
    ...(profile?.poc.outOfScope ?? []), ...(d?.humanInLoop ?? []), ...(rawPlan?.outOfScope ?? []), ...(rawPlan?.humanInLoop ?? []),
    ...steps.filter(s => s.scope === "human").flatMap(s => [s.step, `${s.step} 자동화`, `담당자 ${s.step}`, `${s.step} (담당자 수행)`]),
  ].map(normalizedItem));
  const append = (source: string, role: string, text: string, override?: string, original?: string, reviewKey?: string) => {
    if (!text?.trim()) return;
    // A whole technical-check topic is stable source evidence, not a substring-based step guess.
    if (role === "conditions" && source !== "diagnosis.technicalChecks") {
      const checks = (d?.technicalChecks ?? []).filter(check =>
        [check.topic, `${check.topic} 확인`, `${check.topic}${check.note ? ` — ${check.note}` : ""}`,
          // gatePrerequisites labels: `${topic} (선택) — …` / `${topic} (필수) — …` are the same
          // check evidence; without them the labeled copy stays a separate unlinked condition
          // that HITL exclude/defer matching (by check source) cannot reach.
          `${check.topic} (선택)${check.note ? ` — ${check.note}` : ""}`,
          `${check.topic} (필수)${check.note ? ` — ${check.note}` : ""}`].some(value => normalizedItem(value) === normalizedItem(text)));
      // 잔여 검증 R6: 동일 토픽·비고의 확인 항목이 2개(필수+선택)면 매칭 후보가 2개가
      // 되어 라벨 사본이 표준 문구로 바뀌지 않고 HITL 제외를 비껴갔다. 후보들의
      // 표준 문구와 상태가 모두 동일할 때만(의미상 같은 확인 항목) 병합한다.
      // 토픽만 같고 비고·상태가 다르면 기존대로 별도 항목으로 유지한다.
      const canonicalTexts = new Set(checks.map(check => normalizedItem(`${check.topic}${check.note ? ` — ${check.note}` : ""}`)));
      const checkStatuses = new Set(checks.map(check => check.status));
      if (checks.length >= 1 && canonicalTexts.size === 1 && checkStatuses.size === 1) {
        const check = checks[0];
        original ??= text;
        text = `${check.topic}${check.note ? ` — ${check.note}` : ""}`;
        if (check.status === "확인됨") { role = "reference"; override = "이미 확인된 기술 조건 (참고)"; }
      }
    }
    let clean = stripEnumerator(text);
    if (role === "human" && /(?:승인|판단|결재|확정)\s*자동화|자동\s*(?:승인|판단|결재|확정)/u.test(clean)) role = "excluded";
    if (["features", "goal"].includes(role) && TEST_LABEL.test(clean)) {
      role = "tests";
      // A bare "테스트:" label adds nothing; 정상·경계·실패 labels name the case type and stay.
      clean = clean.replace(/^테스트(?:\s*시나리오)?\s*:\s*/u, "");
    }
    const relation = normalizedStepText(clean.replace(/\s*\(확인 필요:[^)]*\)\s*$/u, ""));
    if (source === "plan.poc") {
      const field = /^(?:PoC\s*)?(성공|실패|평가|검증|출력)\s*:/iu.exec(clean)?.[1];
      if (field === "성공" || field === "실패") role = "criteria";
      else if (field === "평가" || field === "검증") role = "tests";
      else if (field === "출력") role = "outputs";
    }
    // Only a whole name or an explicit name-prefix relation links a step; check topics are not step IDs.
    // A detail that itself starts with another whole diagnosed name makes the relation ambiguous.
    const directMatches = steps.filter(s => explicitStep(relation, s));
    const detail = relation.split(/\s+[—–-]\s+|:\s+/u).slice(1).join(" ");
    const otherMatches = directMatches.length === 1 && detail ? steps.filter(s => s !== directMatches[0]
      && normalizedStepText(s.step) && (detail === normalizedStepText(s.step) || detail.startsWith(`${normalizedStepText(s.step)} `))) : [];
    const matches = [...directMatches, ...otherMatches];
    // A bare-space prefix is NOT a link. It only prevents an unlinked PoC item from silently
    // becoming a current required check when it may instead describe future/human work.
    const deferredMention = !matches.length ? steps.filter(s => (s.scope === "future" || s.scope === "human")
      && normalizedStepText(s.step) && relation.startsWith(`${normalizedStepText(s.step)} `)) : [];
    let scope: AgentInstructionItem["scope"] = "confirm";
    let reason: string | undefined;
    if (closed.has(normalizedItem(relation)) || role === "excluded" || role === "human") {
      scope = "excluded";
      reason = role === "human" ? "담당자 수행 유지" : "현재 자동화 제외";
    } else if (source === "diagnosis.asIs.outputs") {
      scope = matches.length === 1 && matches[0].scope === "future" ? "future" : "confirm";
      reason = "기존 업무의 전체 출력·참고: 현재 생성 단계와 재사용 조건 확인 전 필수 출력 아님";
    } else if (override) {
      reason = override;
    } else if (scopeLevel === 0 && !matches.length && (source === "diagnosis.technicalChecks" || source.startsWith("plan.")) && role === "conditions" && INTEGRATION_CHECK.test(clean)) {
      scope = "future";
      reason = `${gate === "blocked" ? "진행 보류 상태(검토·검증만 허용)" : "Level 0"}에서는 시스템 연동·AI 구현을 하지 않아 현재 검토·검증의 선행 조건이 아님 (전체 실행 상태는 그대로 적용)`;
    } else if (scopeLevel === 0 && ["tests", "criteria", "outputs"].includes(role) && AUTOMATED_RESULT.test(clean)) {
      scope = "future";
      reason = `${gate === "blocked" ? "진행 보류 상태" : "Level 0"}에는 자동·AI 결과물이 없음: 검증·출력을 위해 생성 기능을 만들지 말고, 기존 비교 자료가 없으면 검증 불가 사유를 기록`;
    } else if (scopeLevel === 0 && ["features", "goal"].includes(role) && source.startsWith("plan.") && !(matches.length === 1 && matches[0].scope === "human")) {
      // Level 0 and a blocked gate permit review only: no generated feature is implementable, linked or not.
      scope = "future";
      reason = gate === "blocked" ? "진행 보류 상태" : "Level 0은 검토·검증만 허용";
    } else if (deferredMention.length && source.startsWith("diagnosis.poc.")
      && ["tests", "criteria", "outputs"].includes(role)) {
      reason = `향후·담당자 단계 이름으로 시작하나 명시적 연결 없음 (${deferredMention.map(s => s.step).join(", ")}): 현재 PoC 필수 항목으로 승격 금지`;
    } else if (!matches.length && ["outputs", "tests", "criteria"].includes(role)) {
      reason = "생성·검증 대상 단계의 연결 근거 확인 필요: 업무 전체 산출물·PoC 문구만으로 현재 필수 항목으로 승격하지 않음";
    } else if (matches.length !== 1) {
      // PART D/E: 내부 문구("연결된 진단 단계가 확인되지 않았습니다")를 사용자 친화 문구로 교체.
      reason = matches.length ? "여러 업무 단계에 연결되어 적용 범위를 확인해야 합니다." : source === "diagnosis.technicalChecks" ? "적용 단계를 실제 의존 관계로 확인하세요. 관련 없는 독립 단계는 진행하되 권한·보안 조건을 우회하지 마세요." : "어느 업무 단계에 적용되는지 확인되지 않았습니다.";
    } else {
      scope = matches[0].scope;
      if (scope === "future") reason = `현재 Level ${scopeLevel} 범위 밖`;
      if (scope === "human") reason = "담당자 수행 단계";
      if (scope === "verify") reason = gate === "blocked" ? "진행 보류 상태" : "검토·검증만 허용";
      // A permitted Level 1 step keeps its policy scope; an unattended method proposed for it is held for confirmation.
      if (scopeLevel === 1 && (scope === "implement" || scope === "after-check") && ["features", "goal"].includes(role)
        && UNATTENDED_METHOD.test(clean) && !REQUESTED.test(clean)) {
        scope = "confirm";
        reason = "Level 1은 담당자 요청 없는 무인 실행·자동 확정을 허용하지 않습니다. 담당자 요청 기반 후보·초안 방식으로 적용할 수 있는지 확인하세요.";
      }
    }
    // A guarded model proposal cannot authorize an unconfirmed mutation, integration,
    // metric or organization merely because its prefix names a permitted step.
    if (source.startsWith("plan.") && ["features", "goal"].includes(role) && clean.includes(UNCONFIRMED)
      && (scope === "implement" || scope === "after-check")) {
      scope = "confirm";
      reason = "생성 계획의 미확인 규칙·연동·권한은 확인 전 구현 불가";
    }
    if (["criteria", "tests"].includes(role) && UNSUPPORTED_METRIC.test(clean) && !isConfirmedMetric(clean, [options.taskName ?? "", options.context ?? ""].join("\n"))) {
      scope = "confirm";
      reason = "수치 기준 확인 필요: 측정 대상·방법·데이터 범위·비교 기준·판정 근거가 확인되지 않음";
    }
    const step = matches.length === 1 ? matches[0].step : undefined;
    // reviewKey가 부여된 계획 항목은 동일 키끼리만 병합한다.
    // 동일 문구의 중복 항목이 하나로 합쳐지면 HITL에서 개별 제외·보류가 불가능해지므로,
    // 키가 다르면(또는 한쪽에만 키가 있으면) 별도 항목으로 유지한다.
    const same = matches.length > 1 ? undefined : classified.find(item => item.role === role && item.scope === scope && item.step === step && normalizedItem(item.text) === normalizedItem(clean)
      && (reviewKey ? item.reviewKey === reviewKey : !item.reviewKey));
    if (same) {
      if (!same.sources.includes(source)) same.sources.push(source);
      if (!same.originals.includes(original ?? text)) same.originals.push(original ?? text);
      return;
    }
    classified.push({ source, sources: [source], originals: [original ?? text], role, text: clean, ...(original && stripEnumerator(original) !== clean ? { original } : {}), scope, ...(step ? { step } : {}), ...(reason ? { reason } : {}), ...(reviewKey ? { reviewKey } : {}) });
  };
  // HITL 중복 식별 정확성: 계획 항목에 occurrence 기반 reviewKey를 미리 부여
  // (extractPlanReviewableItems와 동일한 키 생성 규칙 사용)
  const planReviewKeyMap = rawPlan && options.hitlTool ? buildPlanReviewKeyMap(rawPlan, options.hitlTool) : new Map<string, string>();
  if (rawPlan) for (const key of Object.keys(PLAN_ROLES) as (keyof typeof PLAN_ROLES)[]) {
    let guardedIndex = 0;
    const planContext = [options.taskName ?? "", options.context ?? ""].join("\n");
    let fieldIndex = 0;
    for (const item of rawPlan[key] ?? []) {
      const unsupported = hasOnlyUnconfirmedMetrics(item, planContext);
      const reviewKey = planReviewKeyMap.get(`${key}:${fieldIndex++}`);
      append(`plan.${key}`, PLAN_ROLES[key], unsupported ? item : guarded?.[key]?.[guardedIndex++] ?? item,
        unsupported ? "근거 없는 성능 수치: 측정 근거와 판정 기준 확인 필요" : undefined, item, reviewKey);
    }
  }
  if (d) {
    for (const [source, role, values] of [
      ["diagnosis.asIs.steps", "reference", d.asIs?.steps ?? []],
      ["diagnosis.asIs.outputs", "outputs", d.asIs?.outputs ?? []],
      ["diagnosis.humanInLoop", "human", d.humanInLoop ?? []],
      ["diagnosis.toBe", "reference", (d.toBe ?? []).map(s => `${s.step} — ${s.description}`)],
      ["diagnosis.poc.inScope", "features", d.poc?.inScope ?? []],
      ["diagnosis.poc.outOfScope", "excluded", d.poc?.outOfScope ?? []],
      ["diagnosis.poc.inputs", "input", d.poc?.inputs ?? []],
      ["diagnosis.poc.outputs", "outputs", d.poc?.outputs ?? []],
      ["diagnosis.poc.evaluation", "tests", d.poc?.evaluation ?? []],
      ["diagnosis.poc.success", "criteria", d.poc?.success ?? []],
      ["diagnosis.poc.failure", "criteria", d.poc?.failure ?? []],
    ] as const) for (const item of values) append(source, role, item);
    for (const step of steps.filter(s => s.scope === "human")) append("policy.manualSteps", "human", step.step);
    // Confirmed checks are reference facts, not open conditions.
    // Priority 2: Preserve the reviewable item text format as original for HITL matching
    // (extractReviewableItems uses `${topic}: ${status} - ${note}` format)
    for (const check of d.technicalChecks ?? []) append("diagnosis.technicalChecks", check.status === "확인됨" ? "reference" : "conditions",
      `${check.topic}${check.note ? ` — ${check.note}` : ""}`, check.status === "확인됨" ? "이미 확인된 기술 조건 (참고)" : undefined,
      `${check.topic}: ${check.status} - ${check.note}`);
  }
  for (const item of options.prerequisites ?? []) append("options.prerequisites", "conditions", item);
  for (const item of profile?.prerequisites ?? []) {
    // Reuse the technical check's exact evidence instead of creating a second, unlinked condition.
    const existing = classified.find(entry => entry.role === "conditions" && normalizedItem(entry.text) === normalizedItem(item));
    if (existing) {
      if (!existing.sources.includes("policy.prerequisites")) existing.sources.push("policy.prerequisites");
    } else append("policy.prerequisites", "conditions", item);
  }
  // Review-only scope (Level 0 or blocked) is still the permitted scope for its checks, criteria and outputs.
  const permitted = (item: AgentInstructionItem) => item.scope === "implement" || item.scope === "after-check" || item.scope === "verify";
  const scoped = {
    features: classified.filter(item => item.role === "features" && (item.scope === "implement" || item.scope === "after-check")),
    tests: classified.filter(item => item.role === "tests" && permitted(item)),
    criteria: classified.filter(item => item.role === "criteria" && permitted(item) && !VAGUE_CRITERION.test(item.text) && !(VALIDATION_METHOD.test(item.text) && !PASS_CONDITION.test(item.text))),
    validationMethods: classified.filter(item => item.role === "criteria" && permitted(item) && VALIDATION_METHOD.test(item.text) && !PASS_CONDITION.test(item.text)),
    outputs: classified.filter(item => item.role === "outputs" && permitted(item)),
    conditions: classified.filter(item => item.role === "conditions" && permitted(item)),
  };
  const conditions: AgentInstructionModel["conditions"] = {
    current: scoped.conditions,
    future: classified.filter(item => item.role === "conditions" && item.scope === "future"),
    global: classified.filter(item => item.role === "human" || item.role === "security" && item.scope !== "future" && item.scope !== "human"),
    confirm: classified.filter(item => item.role === "conditions" && !permitted(item) && item.scope !== "future"),
  };
  const gaps = !d ? ["진단 결과 없음: Level·실행 상태를 확인하기 전에는 생성 계획의 제안을 확정 구현하지 마세요."] : [
    ...(!profile ? ["Factor·Decision Gate 등 실행 범위의 필수 진단 정보가 누락됨: 확인 전 구현 금지"] : []),
    ...(d.asIs?.inputs?.length ? [] : ["입력 자료와 샘플 형식 (진단에 입력 정보 없음)"]),
    ...(d.asIs?.outputs?.length ? [] : ["결과물 형식과 보고 양식 (진단에 출력 정보 없음)"]),
    ...(steps.length ? [] : ["업무 단계별 진단 정보 없음: 구현할 단계와 담당자 단계를 먼저 확인"]),
  ];
  const methodEvidence = steps.map((s, index) => stepMethod(s,
    steps.some((other, otherIndex) => otherIndex !== index && normalizedStepText(other.step) === normalizedStepText(s.step)), d));

  // HITL 3차: 유효한 confirmed 검토를 실행 범위에 반영
  // Level × Gate 정책이 우선하며, 검토는 허용 범위 내에서만 제한·구체화
  let finalClassified = classified;
  let finalScoped = scoped;
  let finalSteps = steps;
  // 단계와 메타데이터를 함께 묶어 인덱스 어긋남 방지
  let finalMethodEvidence = methodEvidence;
  let hitlActuallyApplied = false;
  let hitlDetails: AgentInstructionModel["hitlDetails"];
  const hitlReviews = options.hitlReviews ?? [];
  const hitlTool = options.hitlTool;
  if (hitlReviews.length > 0) {
    // 실행 모델 생성 경계에서 현재 원본 기준으로 재검증 (임의 배열 직접 전달 시에도 우회 불가)
    // 진단 항목 + 양쪽 도구 계획 항목을 모두 현재 원본으로 사용
    // diagnosis가 없어도 rawPlan이 있으면 계획 항목 추출 (테스트·직접 호출 호환)
    const currentItems = [
      ...(d ? extractReviewableItems(d) : []),
      ...(d?.planCodex ? extractPlanReviewableItems(d.planCodex, "codex") : []),
      ...(d?.planClaude ? extractPlanReviewableItems(d.planClaude, "claude") : []),
      // diagnosis에 계획이 없지만 rawPlan이 직접 전달된 경우
      ...(!d?.planCodex && !d?.planClaude && rawPlan && hitlTool
        ? extractPlanReviewableItems(rawPlan, hitlTool)
        : []),
    ];
    const validReviews = currentItems.length > 0
      ? getValidConfirmedReviews({ reviews: hitlReviews } as import("./types").AxTaskV2, currentItems)
      : [];
    const applied = applyHitlToModel(classified, scoped, steps, methodEvidence, validReviews, hitlTool, d);
    finalClassified = applied.classified;
    finalScoped = applied.scoped;
    finalSteps = applied.steps;
    finalMethodEvidence = applied.methodEvidence;
    // 실제 적용 여부: 항목이 변경되었거나 검토가 적용된 경우
    hitlActuallyApplied = applied.appliedCount > 0 || applied.appliedReviews.length > 0;
    // Priority 5: 유효성 검증된 step-type exclude/defer 검토의 단계명 집합 계산
    // (buildAllInOnePrompt에서 동일한 검증 기준으로 재사용 — 중복 검증 방지)
    const validatedExcludedStepNames: string[] = [];
    const deferredStepNames: string[] = [];
    const excludedStepNames: string[] = [];
    if (d?.stepAssessments) {
      const reviewableSteps = extractReviewableItems(d).filter(i => i.type === "step");
      for (const r of validReviews) {
        if (r.action !== "exclude" && r.action !== "defer") continue;
        if (r.target.type !== "step") continue;
        const matched = reviewableSteps.find(i => i.key === r.target.key);
        if (matched) {
          const name = matched.text.split(":")[0].trim();
          if (name && !validatedExcludedStepNames.includes(name)) validatedExcludedStepNames.push(name);
          const perAction = r.action === "defer" ? deferredStepNames : excludedStepNames;
          if (name && !perAction.includes(name)) perAction.push(name);
        }
      }
    }
    // 검토 대상의 표시명: 내부 키가 아니라 원본 항목에서 확인되는 실제 단계명·항목명을 쓴다.
    // (step 항목의 원본 텍스트는 "단계명: 판정 (담당) - 메모" 형식이므로 단계명만 분리)
    const currentItemByKey = new Map(currentItems.map(item => [item.key, item]));
    const targetDisplayName = (key: string): string => {
      const item = currentItemByKey.get(key);
      if (!item) return key;
      return item.type === "step" ? item.text.split(":")[0].trim() || item.text : item.text;
    };
    // 제외 명시는 확정된 작업 항목(단계·계획 항목·완료 기준)의 제외를 대상으로 한다.
    // 기존에는 단계명과 같은 계획 항목만 나열해, 단계명이 아닌 계획 항목의 제외가
    // 사람 검토 구간에서 누락되는 결함이 있었다 (보류는 전건 나열과 비대칭).
    // 진단 위험(기술 확인) 제외는 제외한다: 위험 제외는 "해당 조건이 적용되지 않음"을
    // 뜻해 작업 제외 목록에 올리는 것이 아니라 지시문에서 전수 부재여야 한다는
    // 기존 R1·R2·T15 동작을 유지한다.
    for (const name of applied.planExcludedStepNames) {
      if (name && !validatedExcludedStepNames.includes(name)) validatedExcludedStepNames.push(name);
      if (name && !excludedStepNames.includes(name)) excludedStepNames.push(name);
    }
    for (const name of applied.planDeferredStepNames) {
      if (name && !validatedExcludedStepNames.includes(name)) validatedExcludedStepNames.push(name);
      if (name && !deferredStepNames.includes(name)) deferredStepNames.push(name);
    }
    hitlDetails = {
      appliedReviews: applied.appliedReviews,
      deferred: applied.deferred.map(entry => ({ ...entry, name: targetDisplayName(entry.key) })),
      excluded: applied.appliedReviews.filter(r => r.action === "exclude")
        .map(r => ({ key: r.targetKey, name: targetDisplayName(r.targetKey), targetType: currentItemByKey.get(r.targetKey)?.type }))
        .filter(entry => entry.targetType !== "risk")
        .map(({ key, name }) => ({ key, name })),
      supplements: applied.supplements.map(entry => ({ ...entry, name: targetDisplayName(entry.key) })),
      validatedExcludedStepNames,
      deferredStepNames,
      excludedStepNames,
      removed: applied.removed,
      removedSteps: applied.removedSteps,
    };
  }

  // Priority 1: HITL 제외·보류가 conditions에도 일관되게 반영되도록 필터링된 데이터로 재계산
  // (conditions는 applyHitlToModel 호출 전에 계산되므로 제외된 항목이 남아있는 결함 수정)
  const finalConditions: AgentInstructionModel["conditions"] = hitlActuallyApplied ? {
    current: finalScoped.conditions,
    future: finalClassified.filter(item => item.role === "conditions" && item.scope === "future"),
    global: finalClassified.filter(item => item.role === "human" || item.role === "security" && item.scope !== "future" && item.scope !== "human"),
    confirm: finalClassified.filter(item => item.role === "conditions" && !permitted(item) && item.scope !== "future"),
  } : conditions;

  return { profile, level, gate, scopeLevel, steps: finalSteps, methods: finalMethodEvidence.map(item => item.method), methodReasons: finalMethodEvidence.map(item => item.reason), methodUserReasons: finalMethodEvidence.map(item => item.userReason),
    methodChains: finalMethodEvidence.map(item => item.chain), methodOrders: finalMethodEvidence.map(item => item.order), conditions: finalConditions, classified: finalClassified,
    ambiguous: finalClassified.filter(item => item.scope === "confirm" && item.role !== "reference"),
    scoped: finalScoped, diagnosis: d, plan: guarded, prerequisites: options.prerequisites ?? [], gaps,
    decisionPoints: d ? resolveDecisionPoints(d) : undefined, genericRules: resolveGenericRules(options.genericRules),
    hitlApplied: hitlActuallyApplied, hitlDetails };
}

/** 로드맵·01~03 공통 표시 모델 조회: HITL이 없거나 해당 항목이 아니면 undefined.
 * 조건 문구는 (선택)/(필수) 표기와 "적용 단계 확인 필요" 접미사를 뗀 뒤 비교한다
 * (게이트 라벨·요약 접미사 등 표시 변형이 달라도 같은 조건으로 식별한다). */
export type HitlDisposition = { action: "exclude" | "defer"; reason?: string; resumeCondition?: string };
const stripConditionMarkers = (text: string) => text
  .replace(/\s*\((선택|필수)\)\s*/gu, " ")
  .replace(/\s*\(적용 단계 확인 필요\)\s*$/u, "")
  .replace(/\s*\(향후 단계 조건\)\s*$/u, "")
  .trim();
export function hitlDispositionForText(model: AgentInstructionModel, text: string): HitlDisposition | undefined {
  const removed = model.hitlDetails?.removed;
  if (!removed) return undefined;
  const query = normalizedItem(stripConditionMarkers(text));
  if (!query) return undefined;
  const hit = removed.find(r => normalizedItem(stripConditionMarkers(r.text)) === query
    || r.originals.some(o => normalizedItem(stripConditionMarkers(o)) === query));
  return hit ? { action: hit.action, reason: hit.reason, resumeCondition: hit.resumeCondition } : undefined;
}
/** 진단 단계명 기준 조회 (정규화된 단계명 완전 일치). */
export function hitlDispositionForStep(model: AgentInstructionModel, stepName: string): HitlDisposition | undefined {
  const removed = model.hitlDetails?.removedSteps;
  if (!removed) return undefined;
  const query = normalizedStepText(stepName);
  const hit = removed.find(r => normalizedStepText(r.step) === query);
  return hit ? { action: hit.action, reason: hit.reason, resumeCondition: hit.resumeCondition } : undefined;
}
/** "단계명 + 처리 방식" 형태의 로드맵·요약 행에서 단계명 접두사로 판정을 찾는다.
 * 긴 단계명을 먼저 시도해 접두사 충돌(부분 이름)을 피한다. */
export function hitlDispositionForStepLine(model: AgentInstructionModel, line: string): HitlDisposition | undefined {
  const removed = model.hitlDetails?.removedSteps;
  if (!removed) return undefined;
  const text = normalizedStepText(line.startsWith("샘플 범위: ") ? line.slice("샘플 범위: ".length) : line);
  const hit = [...removed].sort((a, b) => b.step.length - a.step.length)
    .find(r => { const name = normalizedStepText(r.step); return text === name || text.startsWith(`${name} `); });
  return hit ? { action: hit.action, reason: hit.reason, resumeCondition: hit.resumeCondition } : undefined;
}
/** 로드맵 Phase 항목을 확정 HITL 범위로 나눈다. 제외 항목은 현재 작업에서 빠지고,
 * 보류 항목은 현재 작업에서 빠진 뒤 보류 상태·사유·재개 조건과 함께 별도 안내한다.
 * 조건 문구 완전 일치 → 단계명 접두사 순으로 판정하며, 어느 쪽에도 해당하지 않으면
 * 현재 작업으로 유지한다 (원본 참고 정보·독립 안전조건·평가 문구는 건드리지 않는다).
 * 차단 게이트의 "조건 해결" 항목(`${주제} 해결 방안 확인`)은 조건 문구와 달라 유지된다:
 * 차단 해제 작업이지 구현 범위가 아니며, 거부(불가) 증거는 모델이 이미 보존한다. */
export interface RoadmapPhaseFilter {
  current: string[];
  held: Array<{ text: string; reason?: string; resumeCondition?: string }>;
}
export function filterRoadmapItems(model: AgentInstructionModel, items: string[]): RoadmapPhaseFilter {
  const current: string[] = [];
  const held: RoadmapPhaseFilter["held"] = [];
  for (const raw of items) {
    const line = raw.startsWith("샘플 범위: ") ? raw.slice("샘플 범위: ".length) : raw;
    const cond = hitlDispositionForText(model, line);
    if (cond) {
      if (cond.action === "exclude") continue;
      held.push({ text: raw, reason: cond.reason, resumeCondition: cond.resumeCondition });
      continue;
    }
    const step = hitlDispositionForStepLine(model, raw);
    if (step) {
      if (step.action === "exclude") continue;
      held.push({ text: raw, reason: step.reason, resumeCondition: step.resumeCondition });
      continue;
    }
    current.push(raw);
  }
  return { current, held };
}
/** 정책 단계 순서대로 단계 상세 행을 만든다. HITL 모델의 단계 목록은 정책 단계의
 * 부분집합이므로, 동일 단계명의 회차를 순서대로 대응시켜 인덱스를 맞춘다.
 * 모델에 없는 단계는 HITL 판정(없으면 판정 없음)과 함께 반환해 표시층이 구분한다. */
export interface StepDetailEntry {
  step: StepScope;
  modelIndex: number | null;
  disposition?: HitlDisposition;
}
export function stepDetailEntries(model: AgentInstructionModel, profile: ExecutionProfile): StepDetailEntry[] {
  const counts = new Map<string, number>();
  return profile.stepScope.map(step => {
    const key = normalizedStepText(step.step);
    const occurrence = counts.get(key) ?? 0;
    counts.set(key, occurrence + 1);
    const matches = model.steps.map((s, i) => ({ s, i })).filter(({ s }) => normalizedStepText(s.step) === key);
    if (occurrence < matches.length) return { step, modelIndex: matches[occurrence].i };
    return { step, modelIndex: null, disposition: hitlDispositionForStep(model, step.step) };
  });
}
/** 계획 항목 결정이 전파되는 역할: 구현 요구로 렌더링되는 계획 출처 항목만 대상이다.
 * 사람·제외·보안·참고 역할은 제약·증거이므로 전파로 제거하지 않는다. */
const PLAN_PROPAGATION_ROLES = new Set(["features", "goal", "criteria", "tests", "conditions", "flow", "outputs"]);
/** 외래어 표기 정규화: 같은 외부 시스템을 영어 표기와 한글 표기로 각각 적어도
 * 같은 토큰으로 본다 ("Google Sheets" ↔ "구글 시트"). 특정 업무·특정 항목을
 * 가리키는 표가 아니라, 시스템 명칭에 흔히 쓰이는 일반 외래어 대응이다.
 * 한글 표기가 이미 정착된 토큰은 그대로 두고, 영어 토큰만 한글 표준형으로 바꾼다. */
const LOANWORD_MAP: Record<string, string> = {
  google: "구글", sheets: "시트", sheet: "시트", spreadsheet: "스프레드시트",
  email: "이메일", mail: "메일", server: "서버", drive: "드라이브",
  excel: "엑셀", word: "워드", calendar: "캘린더",
};
const LOANWORD_CANONICAL = new Set(Object.values(LOANWORD_MAP));
/** 외래어 토큰을 한글 표준형으로 바꾼다 (해당 없으면 원형). 라틴 토큰은 대소문자 구분 없이 비교한다. */
const normalizeLoanwordToken = (token: string): string => {
  if (/^[A-Za-z]+$/u.test(token)) return LOANWORD_MAP[token.toLowerCase()] ?? token.toLowerCase();
  return token;
};
/** 렌더 단계 단어 비교: 구분 기호를 공백으로 바꾸고 2자 이상 단어만 외래어 표준형으로 비교한다.
 * 모듈 층위 단일 정의로, 04 지시문과 03 요약이 같은 단어 비교를 쓴다. */
const scopeWords = (text: string): string[] => text.replace(/[^\uAC00-\uD7A3A-Za-z0-9]/gu, " ").split(/\s+/u).filter(w => w.length >= 2).map(normalizeLoanwordToken);
/** 제외 단계 관련 완료 기준 판정 (03 요약이 적용하는 범위).
 * 모델의 scoped criteria·검증 방법에 들지 않은 완료 기준 항목이 유효성 검증된
 * 제외 단계와만 관련되고 활성 작업 단계와는 무관하면 true.
 * 활성 단계와 단어를 공유하면 보수적으로 유지한다 (강등하지 않음).
 * 출처를 PoC로 한정하지 않는다: 03 통과 조건은 진단 PoC 기준과 계획 acceptance
 * 기준을 합쳐 표시하므로, 제외된 기능의 문구가 계획 acceptance에 사본으로 남아
 * 있으면 PoC 항목만 걸러서는 표시가 남는다 (라이브 간극 원인). 04는 범위 밖
 * 비-PoC 기준을 참고 판정으로 이미 구분하므로, 03에서 같은 항목을 빼는 것은
 * 04와 일치하는 방향이다. 단계에 연결된 scoped 기준은 여기서 걸러지지 않는다.
 * 차단 상태·Level 0은 03의 진단 기준 표시와 무관하므로 여기서 다루지 않는다:
 * 03 "완료 기준"은 진단 자체의 기준 기록이고, 실행 불가 여부는 게이트 배지가
 * 표시한다 (E2E ax.spec.ts:1356이 전 Level×Gate에서 기준 표시를 고정한다). */
export function isExcludedStepCriterion(model: AgentInstructionModel, item: AgentInstructionItem): boolean {
  if (item.role !== "criteria") return false;
  if (model.scoped.criteria.includes(item) || model.scoped.validationMethods.includes(item)) return false;
  const excludedStepNames = model.hitlDetails?.validatedExcludedStepNames ?? [];
  if (excludedStepNames.length === 0) return false;
  const words = scopeWords(item.text);
  const matchesExcluded = excludedStepNames.some(name => {
    const nameWords = scopeWords(name);
    return words.some(w => nameWords.includes(w)) || nameWords.some(w => words.includes(w));
  });
  if (!matchesExcluded) return false;
  // 활성 작업 단계와도 관련되면 제외하지 않음 (보수적: 제외 단계와만 관련될 때만 demote).
  // 구현 범위 단계가 없을 때(차단·Level 0)는 검증 범위 단계가 비교 기준이 된다:
  // 그렇지 않으면 비교 대상 자체가 없어 제외 단계와 단어를 공유하는 모든 기준이
  // "제외 단계와만 관련"으로 잡혀 일반어(예: "정산")까지 과도하게 제거된다.
  // 제외 단계가 단계 목록에 남아 있다면 비교 대상에서 뺀다.
  let activeStepNames = model.steps.filter(s => s.scope === "implement" || s.scope === "after-check").map(s => s.step);
  if (activeStepNames.length === 0) {
    const excluded = new Set(excludedStepNames);
    activeStepNames = model.steps.filter(s => s.scope === "verify" && !excluded.has(s.step)).map(s => s.step);
  }
  const matchesActive = activeStepNames.some(name => {
    const nameWords = scopeWords(name);
    return words.some(w => nameWords.includes(w)) || nameWords.some(w => words.includes(w));
  });
  return !matchesActive;
}
/** 제외 단계 관련 PoC 기준 판정 (04 강등 판정의 제외 단계 관련 부분).
 * isExcludedStepCriterion에 PoC 출처 조건을 더한 것으로, 04의 판정 결과는
 * 이 래퍼를 써도 달라지지 않는다 (isDemotedPocCriterion이 출처를 먼저 검사한다). */
export function isExcludedPocCriterion(model: AgentInstructionModel, item: AgentInstructionItem): boolean {
  const isPoc = item.sources.some(s => s === "diagnosis.poc.success" || s === "diagnosis.poc.failure");
  if (!isPoc) return false;
  return isExcludedStepCriterion(model, item);
}
/** PoC 기준 강등 판정 (04 지시문이 적용하는 범위).
 * 차단 상태(Level 0·Gate blocked)에서는 PoC 기준을 구현 가능한 완료 조건으로
 * 제시하지 않으며, 그 외에는 제외 단계 관련 판정과 같다. 04는 실행 지시문이므로
 * 실행 불가 기준을 필수 조건에서 빼는 것이고, 03은 진단 기준 표시이므로
 * 차단 분기를 공유하지 않는다 (03은 isExcludedStepCriterion을 쓴다). */
export function isDemotedPocCriterion(model: AgentInstructionModel, item: AgentInstructionItem): boolean {
  if (item.role !== "criteria") return false;
  const isPoc = item.sources.some(s => s === "diagnosis.poc.success" || s === "diagnosis.poc.failure");
  if (!isPoc) return false;
  if (model.scoped.criteria.includes(item) || model.scoped.validationMethods.includes(item)) return false;
  // 차단 상태에서는 PoC 기준을 구현 가능한 완료 조건으로 제시하지 않음.
  if (model.gate === "blocked" || model.scopeLevel === 0) return true;
  return isExcludedPocCriterion(model, item);
}
/** 내용 토큰: 한글 어절과 라틴/숫자 토큰을 분리 추출한다 ("API로" → API + 로). 1자 토큰은 잡음으로 제외한다. */
const planDecisionTokens = (text: string): string[] => {
  const tokens = [...text.matchAll(/[가-힣]+|[A-Za-z0-9]+/gu)].map(m => m[0]);
  return [...new Set(tokens.filter(t => t.length >= 2).map(normalizeLoanwordToken))];
};
/** 어간: 조사·어미를 뗀 형태 ("명세서가" → "명세서", "전송됨" → "전송").
 * 어간이 2자 미만으로 줄면 원형을 유지한다. "이"는 어간 말음과 구분이 어려워 떼지 않는다. */
const PLAN_TOKEN_SUFFIXES = ["에서", "에게", "으로", "로서", "로부터", "까지", "보다", "처럼", "에", "로", "를", "을", "가", "은", "는", "의", "와", "과", "도", "만", "됨"];
const planDecisionStem = (token: string): string => {
  if (!/[가-힣]/u.test(token)) return token;
  for (const suffix of PLAN_TOKEN_SUFFIXES) {
    if (token.length > suffix.length + 1 && token.endsWith(suffix)) return token.slice(0, -suffix.length);
  }
  return token;
};
const planDecisionStems = (tokens: string[]): string[] => [...new Set(tokens.map(planDecisionStem))];
/** 같은 기능 판정: 한쪽 토큰 집합이 다른 쪽에 온전히 포함되거나, 2개 이상 내용 토큰이
 * 겹치고 그중 특이 토큰이 있을 때 같은 기능으로 본다. 특이 토큰은 3자 이상 토큰,
 * 또는 외래어 표준형 토큰이다 (외래어는 특정 시스템을 가리키므로 2자라도 일반어와
 * 다르다 — 예: "구글 시트" 겹침은 "결과 확인" 같은 2자 일반어 쌍과 다르다).
 * 원형·어간 어느 쪽으로든 일치하면 같은 기능이다. */
function planDecisionMatches(itemTokens: string[], decisionTokens: string[]): boolean {
  const matchSets = (a: string[], b: string[]): boolean => {
    const bSet = new Set(b);
    if (a.length > 0 && a.every(t => bSet.has(t))) return true;
    if (b.length > 0 && b.every(t => new Set(a).has(t))) return true;
    const overlap = a.filter(t => bSet.has(t));
    return overlap.length >= 2 && overlap.some(t => t.length >= 3 || LOANWORD_CANONICAL.has(t));
  };
  return matchSets(itemTokens, decisionTokens)
    || matchSets(planDecisionStems(itemTokens), planDecisionStems(decisionTokens));
}
/** 유지(keep) 보호: 유지 항목과 동일 기능일 때만 보호한다 (토큰 집합 동일, 원형·어간 기준).
 * 부분집합 관계(좁은 기능·넓은 기능)는 다른 기능이므로 보호하지 않는다 — 예를 들어
 * "데이터 검증 후처리" 유지는 "데이터 검증" 제외를 막지 않고, 그 역도 마찬가지이다. */
function planDecisionProtected(itemTokens: string[], keptTokenSets: string[][]): boolean {
  const sameSet = (a: Set<string>, b: Set<string>): boolean => a.size === b.size && [...a].every(t => b.has(t));
  const item = new Set(itemTokens);
  const itemStems = new Set(planDecisionStems(itemTokens));
  return keptTokenSets.some(kept => {
    const keptSet = new Set(kept);
    const keptStems = new Set(planDecisionStems(kept));
    return sameSet(item, keptSet) || sameSet(itemStems, keptStems);
  });
}

/** HITL 3차: 검토 결과를 실행 범위 모델에 반영
 * - exclude: 해당 항목을 구현 범위에서 제외
 * - defer: 해당 항목을 보류 (사유·재개 조건과 함께)
 * - supplement: 보완 내용을 관련 항목에 추가 (별도 표시)
 * - keep: 변경 없음
 * Level × Gate 정책을 우회하지 않으며, 원본을 수정하지 않음 */
function applyHitlToModel(
  classified: AgentInstructionItem[],
  scoped: AgentInstructionModel["scoped"],
  steps: StepScope[],
  methodEvidence: Array<{ method: StepMethod; reason: string; userReason: string; chain?: StepMethod[]; order?: MethodOrder }>,
  reviews: import("./types").HitlReview[],
  tool?: "codex" | "claude",
  diagnosis?: import("./types").AxDiagnosis,
): {
  classified: AgentInstructionItem[];
  scoped: AgentInstructionModel["scoped"];
  steps: StepScope[];
  methodEvidence: Array<{ method: StepMethod; reason: string; userReason: string; chain?: StepMethod[]; order?: MethodOrder }>;
  appliedCount: number;
  appliedReviews: Array<{ id: string; action: string; targetKey: string }>;
  deferred: Array<{ key: string; reason?: string; resumeCondition?: string }>;
  supplements: Array<{ key: string; content: string }>;
  planExcludedStepNames: string[];
  planDeferredStepNames: string[];
  removed: HitlRemovedItem[];
  removedSteps: HitlRemovedStep[];
} {
  // 도구별 필터: planItem/criterion은 해당 도구의 계획에만 적용
  const relevant = reviews.filter(r => {
    if (r.target.source === "planCodex") return tool === "codex";
    if (r.target.source === "planClaude") return tool === "claude";
    return true; // diagnosis 출처는 공통 적용
  });

  const excludeKeys = new Set<string>();
  const deferKeys = new Set<string>();
  const supplements = new Map<string, string>(); // key -> 보완 내용
  const deferDetails = new Map<string, { reason?: string; resumeCondition?: string }>();
  const appliedReviews: Array<{ id: string; action: string; targetKey: string }> = [];

  for (const r of relevant) {
    if (r.status !== "confirmed") continue;
    const key = r.target.key;
    if (r.action === "exclude") {
      excludeKeys.add(key);
      appliedReviews.push({ id: r.id, action: "exclude", targetKey: key });
    } else if (r.action === "defer") {
      deferKeys.add(key);
      deferDetails.set(key, { reason: r.reason, resumeCondition: r.resumeCondition });
      appliedReviews.push({ id: r.id, action: "defer", targetKey: key });
    } else if (r.action === "supplement" && r.supplement) {
      supplements.set(key, r.supplement);
      appliedReviews.push({ id: r.id, action: "supplement", targetKey: key });
    } else if (r.action === "keep") {
      appliedReviews.push({ id: r.id, action: "keep", targetKey: key });
    }
  }

  if (excludeKeys.size === 0 && deferKeys.size === 0 && supplements.size === 0) {
    return { classified, scoped, steps, methodEvidence, appliedCount: 0, appliedReviews, deferred: [], supplements: [], planExcludedStepNames: [], planDeferredStepNames: [], removed: [], removedSteps: [] };
  }

  // 계획 항목 층위 전파: 같은 도구 계획에서 제외·보류된 기능은 구현 항목 필드만의
  // 문구가 아니라, 같은 계획의 다른 필드(inScope·integrations·acceptance·tests·
  // dataFlow 등)에 같은 기능으로 다시 등장해도 구현 요구가 아니다. 진단 출처 항목은
  // 이 규칙으로 건드리지 않는다 (진단 항목은 진단 검토 채널이 담당한다).
  // 유지(keep) 결정은 전파보다 우선한다: 유지 항목과 겹치는 항목은 제거하지 않는다.
  const planDecisions: Array<{ action: "exclude" | "defer"; type: string; text: string; tokens: string[]; reason?: string; resumeCondition?: string }> = [];
  const keptTexts = new Set<string>();
  // 유지 보호의 토큰 부분집합 판정은 계획 항목(기능) 유지 결정에만 적용한다.
  // 완료 기준 유지("…결과 확인")는 그 기준 문구의 유지를 뜻할 뿐, 같은 기능을
  // 수행하는 단계·항목까지 유지하는 결정이 아니므로 토큰 보호에 쓰지 않는다.
  const keptTokenSets: string[][] = [];
  for (const r of relevant) {
    if (r.status !== "confirmed") continue;
    if (r.target.type !== "planItem" && r.target.type !== "criterion") continue;
    if (r.target.source !== "planCodex" && r.target.source !== "planClaude") continue;
    const text = (r.target.sourceText ?? "").trim();
    if (!text) continue;
    if (r.action === "keep") {
      keptTexts.add(normalizedItem(text));
      if (r.target.type === "planItem") keptTokenSets.push(planDecisionTokens(text));
    } else if (r.action === "exclude" || r.action === "defer") {
      planDecisions.push({ action: r.action, type: r.target.type, text, tokens: planDecisionTokens(text), reason: r.reason, resumeCondition: r.resumeCondition });
    }
  }
  const planItemDecisions = planDecisions.filter(d => d.type === "planItem");

  // 검토 대상 키와 classified 항목 매칭
  // Plan reviews match occurrence-aware keys. A diagnosis risk review can only
  // affect its own technical-check item, never unrelated plan/security text.
  const normalizeForMatch = (text: string) => text.trim().replace(/\s+/g, " ").toLowerCase();
  // 잔여 검증 R7/R8/R9/R11: 같은 확인 항목의 사본은 원본 출처·범위와 무관하게
  // 하나의 조건이다. 계획 항목이 먼저 append되면 병합 항목의 source가
  // plan.*이 되고(Level 0에서는 범위까지 달라져 병합 자체가 안 된다),
  // 기존의 source === "diagnosis.technicalChecks" 가드는 HITL 제외를 비껴갔다.
  // 따라서 conditions 역할 항목은 표준 문구·주제 키로도 확인 항목과 매칭한다.
  // features/criteria 등 다른 역할은 기존 가드를 유지해 과도한 제거를 막는다.
  const checkEvidence = (diagnosis?.technicalChecks ?? []).map(check => ({
    canonical: normalizeForMatch(`${check.topic}${check.note ? ` — ${check.note}` : ""}`),
    sourceText: normalizeForMatch(`${check.topic}: ${check.status} - ${check.note}`),
    topicKey: prerequisiteTopicKey(`${check.topic}${check.note ? ` — ${check.note}` : ""}`),
  }));
  const matchReview = (item: AgentInstructionItem): string | null => {
    if (item.reviewKey) return relevant.find(r => r.status === "confirmed" && r.target.key === item.reviewKey)?.target.key ?? null;
    // conditions 외 역할은 기존 가드를 그대로 유지한다 (원본 진단 항목만 매칭).
    if (item.role !== "conditions" && item.source !== "diagnosis.technicalChecks") return null;
    const itemTexts = new Set([item.text, item.original, ...item.originals].filter((text): text is string => !!text).map(normalizeForMatch));
    for (const r of relevant) {
      if (r.status !== "confirmed" || r.target.source !== "diagnosis" || r.target.type !== "risk") continue;
      if (itemTexts.has(normalizeForMatch(r.target.sourceText))) return r.target.key;
    }
    if (item.role === "conditions") {
      const itemTopicKey = prerequisiteTopicKey(item.text);
      for (const evidence of checkEvidence) {
        const review = relevant.find(r => r.status === "confirmed" && r.target.source === "diagnosis" && r.target.type === "risk"
          && normalizeForMatch(r.target.sourceText) === evidence.sourceText);
        if (!review) continue;
        if (itemTexts.has(evidence.canonical)
          || (itemTopicKey.length >= 3 && evidence.topicKey.length >= 3 && itemTopicKey === evidence.topicKey)) return review.target.key;
      }
      return null;
    }
    if (item.source !== "diagnosis.technicalChecks") return null;
    return null;
  };

  /** HITL 제거 판정: 기존 제외 여부와 동일한 가드·순서로, 제거 사유까지 함께 반환한다.
   * 로드맵·01~03이 매칭 규칙을 복사하지 않고 모델의 판정을 재사용하기 위한 공통 표시 모델이다.
   * 동일 문구에 제외·보류 결정이 모두 연결되면(별개 회차) 강한 쪽인 제외를 우선한다. */
  const pickDecision = (candidates: Array<{ action: "exclude" | "defer"; reason?: string; resumeCondition?: string }>): HitlDisposition | null => {
    const hit = candidates.find(d => d.action === "exclude") ?? candidates[0];
    return hit ? { action: hit.action, reason: hit.reason, resumeCondition: hit.resumeCondition } : null;
  };
  const dispositionOf = (item: AgentInstructionItem): HitlDisposition | null => {
    const key = matchReview(item);
    if (key) {
      if (excludeKeys.has(key)) return { action: "exclude" };
      if (deferKeys.has(key)) {
        const details = deferDetails.get(key);
        return { action: "defer", reason: details?.reason, resumeCondition: details?.resumeCondition };
      }
      return null;
    }
    // occurrence 보호: 구현 항목 필드의 개별 회차는 각각 검토 가능한 별개 항목이다.
    // 같은 문구의 다른 회차(다른 reviewKey)는 전파로 제거하지 않는다 — 전파는
    // 검토 키가 없는 필드 사본(inScope·integrations·dataFlow 등)과, 구현 항목이
    // 아닌 검토 항목(완료 기준·테스트)처럼 같은 요구를 다른 자리에서 반복하는
    // 경우에만 적용한다.
    if (item.reviewKey && item.sources.includes("plan.implementation")) return null;
    // 같은 도구 계획의 다른 필드에 남은 동일 기능: 정확 일치 또는 토큰 규칙으로 전파한다.
    // 유지 항목과 겹치면(유지 문구와 동일하거나 부분집합 관계면) 제거하지 않는다.
    // 선행 조건(conditions)은 예외적으로 출처를 따지지 않는다: 제외·보류된 기능만을
    // 위한 준비 조건이 진단 기술확인·정책 전제·호출자 전달 중 어느 경로로 왔든
    // 현재 범위 전제 조건으로 남으면 지시문이 자기모순이 된다. 진단 출처 항목
    // 일반(기능·산출물 등)은 이 규칙으로 건드리지 않는다 — 진단 검토 채널이 담당한다.
    // 거부(불가) 증거는 filterReview가 별도로 보존한다.
    if (!PLAN_PROPAGATION_ROLES.has(item.role)) return null;
    if (item.role !== "conditions" && !item.sources.some(source => source.startsWith("plan."))) return null;
    const itemTexts = [item.text, item.original, ...item.originals].filter((text): text is string => !!text);
    if (itemTexts.some(text => keptTexts.has(normalizedItem(text)))) return null;
    const exactMatches = planDecisions.filter(d => itemTexts.some(text => normalizedItem(d.text) === normalizedItem(text)));
    if (exactMatches.length) {
      const itemTokens = planDecisionTokens(item.text);
      return planDecisionProtected(itemTokens, keptTokenSets) ? null : pickDecision(exactMatches);
    }
    const itemTokens = planDecisionTokens(item.text);
    if (!itemTokens.length || planDecisionProtected(itemTokens, keptTokenSets)) return null;
    return pickDecision(planDecisions.filter(d => planDecisionMatches(itemTokens, d.tokens)));
  };
  // A review that removes a risk card cannot grant access denied by diagnosis.
  // Keep denied permission evidence in the generated instructions.
  // 사본 경로(plan/options/profile)에서도 거부 증거가 유지되도록 표준 문구까지 포함한다.
  const deniedTexts = new Set((diagnosis?.technicalChecks ?? []).filter(check => check.status === "불가")
    .flatMap(check => [
      normalizeForMatch(`${check.topic}${check.note ? ` — ${check.note}` : ""}`),
      normalizeForMatch(`${check.topic}: ${check.status} - ${check.note}`),
    ]));
  /** HITL로 빠진 표시 항목 기록: 동일 객체는 여러 목록에 나타나므로 객체 기준으로 1회만 기록한다.
   * 직접 판정이 먼저 기록되고, 단계 연결 제거는 그 뒤에 이미 기록된 항목을 덮지 않는다. */
  const removedByItem = new Map<AgentInstructionItem, HitlRemovedItem>();
  const recordRemoved = (item: AgentInstructionItem, disp: HitlDisposition) => {
    if (removedByItem.has(item)) return;
    removedByItem.set(item, { text: item.text, originals: item.originals, role: item.role, ...(item.step ? { step: item.step } : {}), ...disp });
  };
  const filterReview = (item: AgentInstructionItem) => {
    const itemTexts = [item.text, item.original, ...item.originals].filter((text): text is string => !!text).map(normalizeForMatch);
    if (itemTexts.some(text => deniedTexts.has(text))) return true;
    const disp = dispositionOf(item);
    if (disp) { recordRemoved(item, disp); return false; }
    return true;
  };
  let filteredClassified = classified.filter(filterReview);
  let filteredScoped = {
    features: scoped.features.filter(filterReview),
    tests: scoped.tests.filter(filterReview),
    criteria: scoped.criteria.filter(filterReview),
    validationMethods: scoped.validationMethods.filter(filterReview),
    outputs: scoped.outputs.filter(filterReview),
    conditions: scoped.conditions.filter(filterReview),
  };
  let appliedCount = classified.length - filteredClassified.length;

  // Supplement 내용을 해당 항목에 추가 (원본 보존, 보완 구분 표시)
  const supplementList: Array<{ key: string; content: string }> = [];
  for (const [key, content] of supplements) {
    supplementList.push({ key, content });
  }

  // Defer 상세 정보
  const deferredList: Array<{ key: string; reason?: string; resumeCondition?: string }> = [];
  for (const [key, details] of deferDetails) {
    deferredList.push({ key, ...details });
  }

  // Steps 필터링: step 타입의 exclude/defer 검토가 있으면 해당 단계 제외
  // 올바른 매칭: extractReviewableItems()로 현재 원본의 검토 대상을 생성하고,
  // 각 단계와 리뷰 키를 정확히 연결 (문자열 직접 비교 금지)
  const removedSteps: HitlRemovedStep[] = [];
  const stepExcludeIndices = new Set<number>();
  if (diagnosis) {
    const reviewableItems = extractReviewableItems(diagnosis);
    // step 타입 항목만 필터링 (순서 유지)
    const stepItems = reviewableItems.filter(item => item.type === "step");

    // 각 단계와 reviewable item을 순서대로 매칭
    // (extractReviewableItems는 stepAssessments 순서대로 생성하므로 인덱스로 매칭 가능)
    const stepAssessments = diagnosis.stepAssessments ?? [];
    for (let i = 0; i < steps.length && i < stepAssessments.length && i < stepItems.length; i++) {
      const itemKey = stepItems[i].key;
      // 해당 키에 대한 exclude/defer 검토가 있는지 확인
      for (const r of relevant) {
        if (r.status !== "confirmed") continue;
        if (r.target.type !== "step") continue;
        if (r.target.key !== itemKey) continue;
        if (r.action === "exclude" || r.action === "defer") {
          stepExcludeIndices.add(i);
          removedSteps.push({ step: steps[i].step, action: r.action, reason: r.reason, resumeCondition: r.resumeCondition });
          break;
        }
      }
    }
  }
  // diagnosis가 없을 경우: 안전을 위해 단계 제외하지 않음 (오적용 방지)

  // 계획 항목 결정 → 진단 단계 전파: 계획 항목만 검토한 경우에도 같은 기능의
  // 진단 단계가 범위 표·기능 목록에 구현 대상으로 남으면 지시문이 자기모순이 된다.
  // 단계명은 진단의 권위 있는 명칭이므로, 단계 토큰이 결정 문구에 온전히 포함되거나
  // 2개 이상 내용 토큰이 겹치고 특이 토큰을 공유할 때만 해당 단계를 제거한다.
  // 1토큰 단계명·유사 명칭(단계 토큰의 일부만 겹침)은 전파하지 않는다.
  // 유지 항목과 동일 기능(토큰 집합 동일)이면 전파하지 않는다. 부분집합 관계의
  // 좁은·넓은 기능은 다른 기능이므로 보호하지 않는다.
  // 완료 기준(criterion) 결정은 단계 전파에 쓰지 않는다 (판정 문구는 기능 자체가 아니다).
  const planExcludedStepNames: string[] = [];
  const planDeferredStepNames: string[] = [];
  steps.forEach((s, idx) => {
    if (stepExcludeIndices.has(idx)) return;
    const stepTokens = planDecisionTokens(s.step);
    if (stepTokens.length < 2) return;
    if (planDecisionProtected(stepTokens, keptTokenSets)) return;
    let matched: (typeof planItemDecisions)[number] | undefined;
    for (const d of planItemDecisions) {
      if (!planDecisionMatches(stepTokens, d.tokens)) continue;
      if (d.action === "exclude") { matched = d; break; }
      matched ??= d;
    }
    if (!matched) return;
    stepExcludeIndices.add(idx);
    removedSteps.push({ step: s.step, action: matched.action, reason: matched.reason, resumeCondition: matched.resumeCondition });
    if (matched.action === "exclude") planExcludedStepNames.push(s.step);
    else planDeferredStepNames.push(s.step);
  });

  // 단계와 메타데이터를 함께 필터링 (인덱스 어긋남 방지)
  const filteredSteps: StepScope[] = [];
  const filteredMethodEvidence: typeof methodEvidence = [];
  steps.forEach((s, idx) => {
    if (!stepExcludeIndices.has(idx)) {
      filteredSteps.push(s);
      if (idx < methodEvidence.length) {
        filteredMethodEvidence.push(methodEvidence[idx]);
      }
    }
  });
  // Removing a step must also remove proposals, criteria, outputs and conditions
  // explicitly linked to that exact diagnosed step; filtering the timeline alone
  // would quietly reintroduce excluded work in the execution instructions.
  if (stepExcludeIndices.size) {
    const removedNames = new Set([...stepExcludeIndices].map(index => steps[index].step));
    const activeNames = new Set(filteredSteps.map(step => step.step));
    const removed = (item: AgentInstructionItem) => !!item.step && removedNames.has(item.step)
      && !activeNames.has(item.step) && item.role !== "human" && item.role !== "excluded";
    // 단계 연결 제거 항목도 단계 판정으로 기록한다 (직접 판정이 먼저 기록된 항목은 덮지 않음).
    const stepDispByName = new Map(removedSteps.map(d => [d.step, d]));
    const removedByStep = (item: AgentInstructionItem) => {
      if (!removed(item)) return false;
      const disp = item.step ? stepDispByName.get(item.step) : undefined;
      if (disp) recordRemoved(item, disp);
      return true;
    };
    filteredClassified = filteredClassified.filter(item => !removedByStep(item));
    filteredScoped = {
      features: filteredScoped.features.filter(item => !removedByStep(item)),
      tests: filteredScoped.tests.filter(item => !removedByStep(item)),
      criteria: filteredScoped.criteria.filter(item => !removedByStep(item)),
      validationMethods: filteredScoped.validationMethods.filter(item => !removedByStep(item)),
      outputs: filteredScoped.outputs.filter(item => !removedByStep(item)),
      conditions: filteredScoped.conditions.filter(item => !removedByStep(item)),
    };
    appliedCount = classified.length - filteredClassified.length;
  }

  return {
    classified: filteredClassified,
    scoped: filteredScoped,
    steps: filteredSteps,
    methodEvidence: filteredMethodEvidence,
    appliedCount,
    appliedReviews,
    deferred: deferredList,
    supplements: supplementList,
    planExcludedStepNames,
    planDeferredStepNames,
    removed: [...removedByItem.values()],
    removedSteps,
  };
}

/** One coding-agent instruction for any supported tool; the model is computed once.
 * 실행형 6개 영역 구조 (구현 목표 / 구현 범위 / 기능별 요구사항 / 예외 및 유지 조건 /
 * 구현 순서 및 검증 / 결과 보고). 같은 의미의 설명은 한 영역에서 한 번만 출력한다:
 * 단계 상태·사유는 '구현 범위' 표에, 처리 방식 표기는 짧은 한 줄 형태로만 사용하고,
 * 기능별 요구사항은 입력·처리·출력·검증만 단계별로 기술한다. */
export function buildAllInOnePrompt(rawPlan: AxPlan | undefined, _tool: AxToolId, options: PromptOptions = {}): string {
  const model = buildAgentInstructionModel(rawPlan, options);
  const bullets = (items: string[]) => items.map(item => `- ${item}`).join("\n");
  const numbered = (items: string[]) => items.map((item, i) => `${i + 1}. ${stripEnumerator(item)}`).join("\n");
  const { profile, level, gate, scopeLevel, steps, gaps } = model;
  const d = model.diagnosis;
  const work = steps.filter(s => s.scope === "implement" || s.scope === "after-check");
  const review = steps.filter(s => s.scope === "verify");
  const future = steps.filter(s => s.scope === "future");
  const human = steps.filter(s => s.scope === "human");
  const humanKept = unique([...human.map(s => `${s.step} (담당자 수행)`), ...model.classified.filter(item => item.role === "human").map(item => item.original ?? item.text)]);
  // "<human step> 자동화" only restates that a human step is kept; the human line above already says so.
  const humanRestatements = new Set(human.flatMap(s => [`${s.step} 자동화`, `${s.step} 자동화 (담당자 수행)`]).map(normalizedItem));
  const excluded = without([...(profile?.poc.outOfScope ?? []), ...model.classified.filter(item => item.role === "excluded").map(item => item.text)], humanKept)
    .filter(item => !humanRestatements.has(normalizedItem(item)));
  const proposal = (item: AgentInstructionItem) => ["goal", "features"].includes(item.role) && item.sources.some(source => source.startsWith("plan."));
  // Only generated proposals are labelled as plan proposals; raw diagnosis PoC scope is superseded by the policy scope above.
  const outside = unique(model.classified.filter(item => item.scope === "future" && proposal(item) && !future.some(s => s.step === item.step)).map(item => `생성 계획 제안: ${item.text} — ${item.reason}`));
  const outsideHuman = unique(model.classified.filter(item => item.scope === "human" && proposal(item)).map(item => `생성 계획 제안: ${item.text} — ${item.reason}`));
  const unlinked = unique(model.ambiguous.filter(item => item.role === "features" && proposal(item)).map(item => `${item.text} — ${item.reason}`));
  const goals = model.classified.filter(item => item.role === "goal");
  // PART C: goal은 업무 전체 목표이므로 "어느 업무 단계에 적용되는지 확인되지 않았습니다" 같은
  // 단계 연결 문구를 표시하지 않는다. 내부 추적용 reason은 model에 보존된다.
  const GOAL_LINK_REASON = "어느 업무 단계에 적용되는지 확인되지 않았습니다.";
  // 실행 지시문에는 내부 출처 경로·원문 비교 설명을 싣지 않는다 (원본 근거는 내부 데이터에 보존).
  const evidenceLine = (item: AgentInstructionItem) => `${item.text}${item.step ? ` (관련 단계: ${item.step})` : ""}${item.reason && !(item.role === "goal" && item.reason === GOAL_LINK_REASON) ? ` — ${item.reason}` : ""}`;
  const conditions = model.conditions.current.map(evidenceLine);
  // 미연결 조건의 표준 안내 문구는 항목마다 반복하지 않는다 — 아래 섹션의 안내
  // 단락이 한 번 설명하므로, 항목에서는 조건 자체와 고유 사유만 남긴다.
  const UNLINKED_GUIDANCE = "적용 단계를 실제 의존 관계로 확인하세요. 관련 없는 독립 단계는 진행하되 권한·보안 조건을 우회하지 마세요.";
  const unassignedConditionLines = model.conditions.confirm.map(item => {
    if (!item.reason?.includes(UNLINKED_GUIDANCE)) return evidenceLine(item);
    const reason = item.reason.replace(` — ${UNLINKED_GUIDANCE}`, "").replace(UNLINKED_GUIDANCE, "").trim();
    return `${item.text}${item.step ? ` (관련 단계: ${item.step})` : ""}${reason ? ` — ${reason}` : ""}`;
  });
  // Display-only split of unassigned conditions: "관련 후보" names a diagnosed step
  // in its text but has no explicit step link, so it stays "확인 필요" and is never
  // presented as a required dependency of that step; the rest stay "적용 단계 미확인".
  const relatedCandidateLines = unassignedConditionLines.filter((_, i) => conditionRelation(model, model.conditions.confirm[i], false) === "관련 후보");
  const unassignedRestLines = unassignedConditionLines.filter((_, i) => conditionRelation(model, model.conditions.confirm[i], false) !== "관련 후보");
  const exceptions = unique([...model.classified.filter(item => item.role === "exception").map(item => item.text), ...(d?.asIs?.exceptions ?? []), ...(d?.risks ?? [])]);
  const humanConstraints = model.classified.some(item => item.role === "human"
    && item.sources.some(source => source === "diagnosis.humanInLoop" || source === "plan.humanInLoop" || source === "policy.manualSteps"));
  // 담당자·제외 제약 중 '구현 범위'에 이미 이름이 표시된 항목은 다시 반복하지 않고,
  // 범위 표에 없는 추가 제약만 별도로 남긴다.
  const scopeListed = new Set([...steps.map(s => s.step), ...excluded, ...humanKept].map(normalizedItem));
  const extraConstraints = unique(model.classified
    .filter(item => (item.role === "human" || item.role === "excluded")
      && item.sources.some(source => source === "diagnosis.humanInLoop" || source === "diagnosis.poc.outOfScope"
        || source === "plan.humanInLoop" || source === "plan.outOfScope" || source === "policy.manualSteps"))
    .map(item => item.text)
    .filter(text => !scopeListed.has(normalizedItem(text))));
  const collapse = (text: string) => text.replace(/\s+/gu, " ").trim();
  const dupName = (s: StepScope) => steps.filter(o => normalizedStepText(o.step) === normalizedStepText(s.step)).length > 1;
  const scopeLabel = (scope: StepScope["scope"]): string => scope === "implement" ? "구현"
    : scope === "after-check" ? "확인 후 구현" : scope === "verify" ? "검토·검증" : scope === "human" ? "담당자 수행" : "향후 확장";
  /** 단계 처리 방식을 한 줄로만 표기한다. 긴 methodLabel 전문은 범위 표·기능 검증 어디에도 반복하지 않는다. */
  const shortMethod = (s: StepScope): string => {
    const idx = steps.indexOf(s);
    const m = model.methods[idx];
    const chain = model.methodChains[idx];
    if (m === "composite" && chain?.length) {
      const base = model.methodOrders[idx] === "parallel"
        ? `복합 처리 (병행): ${chain.map(stepMethodShortLabel).join(" · ")} — 실행 순서·의존성 확인 필요`
        : `복합 처리 (확인된 순서): ${chain.map(stepMethodShortLabel).join(" → ")}`;
      return s.scope === "verify" ? `${base} · 검토·검증만 (운영 구현 금지)` : base;
    }
    if (m === "confirm") {
      if (dupName(s)) return "동일 이름 단계 중복 — 처리 방식·적용 단계 확인 필요";
      if (isConflictingMethodEvidence(model, idx)) return "처리 방식 근거 충돌 — 해결 전 임의 선택·구현 금지";
      if (isConfirmedMethodEvidence(model, idx)) return `확인된 처리 기준: ${collapse(model.methodUserReasons?.[idx] ?? "")}`;
      const category = methodUndeterminedCategory(model, idx);
      return category ? `처리 방식 미확정 (미확정 사유: ${category}) — 근거·필수 기준 확인 후 진행` : "처리 방식 미확정 — 근거·필수 기준 확인 후 진행";
    }
    if (m === "assist") return "AI 후보·초안 생성 (담당자 확정 전 운영 반영 금지)";
    if (m === "manual") return "담당자 수동 처리";
    if (m === "rule") return "규칙 기반 처리";
    if (m === "script") return "일반 시스템·스크립트 처리";
    return stepMethodShortLabel(m);
  };
  const checkNote = (s: StepScope): string => {
    if (s.scope === "human") return "담당자 확인 유지";
    if (s.scope === "future") return "현재 실행 범위 밖 — 이번에 구현하지 않음";
    if (s.scope === "verify") return `${shortMethod(s)} · 검토·검증만 허용`;
    return shortMethod(s);
  };
  /** 기능별 검증 한 줄. stepMethodLabel과 동일한 확정 판정원을 사용해 표기와 모순되지 않게 한다.
   * 처리 방식별 검증 기준이 본문이고, Level 1 사용자 실행형의 실행 조건은 짧은 전제로만 앞에 붙인다
   * (전역 실행 조건은 1·4영역에도 명시되므로 방식별 기준을 덮어쓰지 않는다). */
  const verifyLine = (s: StepScope): string => {
    const idx = steps.indexOf(s);
    const m = model.methods[idx];
    const methodText = m === "assist"
      ? "실제 입력으로 후보·초안이 생성되고, 담당자 확정 전에는 운영 결과로 반영되지 않으며, 생성할 수 없는 건은 검토 필요·실패로 표시됩니다."
      : m === "composite" && model.methodOrders[idx] === "parallel"
      ? "병행 처리가 확인되었으나 실행 순서와 의존성이 확정되지 않았습니다. 실제 실행 전 처리 순서를 담당자에게 확인하고, 각 역할의 완료 기준을 모두 만족할 때 완료로 인정합니다. 확인 전에는 순차 실행을 가정하지 마세요."
      : m === "composite"
      ? "확인된 처리 순서대로 각 역할이 실제 입력으로 동작하고, AI 결과는 담당자 확정 전 운영 결과로 반영되지 않으며, 규칙·스크립트는 확인된 기준만 적용되고, 담당자 확인이 유지됩니다."
      : m === "rule" || m === "script"
      ? "확인된 형식·키·업무 규칙으로 실제 입력이 처리되고, 담당자가 확정한 기대 결과와 대조한 기록 및 원본 대응 관계가 남습니다. 기대 결과·판정 기준이 없으면 '기준 확인 필요'로 보고하고 합격으로 단정하지 마세요."
      : m === "manual"
      ? "담당자가 수행할 작업과 시스템이 보조할 범위를 확인하고, 담당자 수행 결과와 미확인 조건만 기록합니다. 수동 업무를 신규 자동화 기능으로 바꾸지 마세요."
      : isConflictingMethodEvidence(model, idx)
      ? "처리 방식 근거가 충돌합니다. 충돌을 해결하기 전에는 처리 방식을 임의로 선택·구현하지 마세요. 충돌 해결 후 재개 조건을 보고하세요."
      : isConfirmedMethodEvidence(model, idx)
      ? "확인된 처리 기준을 그대로 구현하고, 기준에 없는 처리 방식은 담당자에게 확인하기 전에는 선택·구현하지 않습니다."
      : dupName(s)
      ? "동일 이름의 진단 단계가 중복되었습니다. 처리 방식·적용 단계를 확인하기 전에는 해당 처리를 보류하고 확인 사항을 보고하세요."
      : "처리 방식이 확정되지 않았습니다. 해당 기능의 실제 구현은 처리 방식과 선행조건이 확인될 때까지 보류합니다. 다만 기존 정책과 권한에서 허용하는 저장소 조사·실제 자료 확인·조건 검증은 수행하세요. 다른 기능 중 독립성과 필수 조건이 확인된 작업은 허용 범위에서 구현하고 실제 데이터로 검증하세요. 처리 방식의 근거·충돌 내용·필수 기준을 먼저 확인하고, 미확정 사항과 재개 조건을 보고하세요.";
    // PART B: Level 1 사용자 실행형 — 담당자 요청 기반이며 무인 자동화가 아니다.
    // 실행 조건 자체는 전역으로도 명시되므로 여기서는 짧은 전제로만 덧붙인다.
    return s.treatment === "사용자 실행 결과 생성"
      ? `담당자가 실행을 요청할 때만 동작하고 담당자 확정 전에는 운영 결과로 반영되지 않아야 합니다(스케줄러·정기 무인 실행 금지). ${methodText}`
      : methodText;
  };
  /** 방식별 검증 기준의 그룹 라벨. 동일한 검증 문구가 여러 기능에 반복되지 않도록
   * 기준 전문은 '방식별 검증 기준' 블록에 한 번만 정의하고 기능별 검증 줄은 이를 참조한다. */
  const verifyGroupLabel = (s: StepScope): string => {
    const idx = steps.indexOf(s);
    const m = model.methods[idx];
    if (m === "assist") return "AI 후보·초안 생성";
    if (m === "composite") return "복합 처리";
    if (m === "rule") return "규칙 기반 처리";
    if (m === "script") return "일반 시스템·스크립트 처리";
    if (m === "manual") return "담당자 수동 처리";
    if (isConflictingMethodEvidence(model, idx)) return "처리 방식 근거 충돌";
    if (isConfirmedMethodEvidence(model, idx)) return "확인된 처리 기준";
    if (dupName(s)) return "동일 이름 단계 중복";
    return "처리 방식 미확정";
  };
  const verifyGroups = new Map<string, { labels: string[]; stepNames: string[] }>();
  for (const s of work) {
    const text = verifyLine(s);
    const group = verifyGroups.get(text) ?? { labels: [], stepNames: [] };
    const label = verifyGroupLabel(s);
    if (!group.labels.includes(label)) group.labels.push(label);
    group.stepNames.push(s.step);
    verifyGroups.set(text, group);
  }
  const sections: { title: string; body: string }[] = [];
  const section = (title: string, ...content: string[]) => sections.push({ title, body: content.filter(Boolean).join("\n\n") });
  const objective = !profile ? "진단 결과가 없어 실행 범위를 확정할 수 없습니다. 진단 결과를 확인하기 전에는 아래 제안을 구현하지 말고 확인할 항목을 보고하세요."
    : scopeLevel === 0 ? gate === "blocked"
      // 차단 문구는 '실행 조건'에 이미 전문이 있으므로 목표에서는 반복하지 않는다.
      // 실행 조건 블록이 렌더링되지 않는 경우(레벨 정보 없음)에만 목표에 전문을 유지한다.
      ? d && level ? "아래 검토·검증 결과와 다음 진단에 필요한 정보를 보고하세요."
        : `${GATE_CONSTRAINTS.blocked} 아래 검토·검증 결과와 다음 진단에 필요한 정보를 보고하세요.`
      : "검토·검증 범위입니다. 운영 기능을 구현하지 말고 아래 검토·검증 결과와 다음 진단에 필요한 정보를 보고하세요."
    : !work.length ? "현재 실행 범위에 구현할 업무 단계가 없습니다. 아래 확인 작업과 보고만 수행하세요."
    : gate === "ready" ? "'구현' 단계를 실제 입력으로 동작하고 검증된 기능으로 완성하세요."
    : "선행 조건을 각 단계의 실제 의존 관계에 대조해 확인된 '확인 후 구현' 단계부터 실제로 동작하고 검증된 기능으로 완성하세요. 미확인 조건에 의존하는 부분만 보류 사유와 함께 보고하세요.";
  const inputs = d ? unique([...(d.asIs?.inputs ?? []), ...without(d.poc?.inputs ?? [], d.asIs?.inputs ?? []).map(item => `검증용: ${item}`)]) : [];
  const currentOutputs = unique(model.scoped.outputs.map(item => item.text));
  // HITL로 보류·제외된 단계에 연결된 산출물은 현재 필수 산출물이 아니다.
  // 단계 연결 판정은 기존 validatedExcludedStepNames(유효성 검증된 step-type
  // defer/exclude 단계명)를 단일 기준으로 재사용한다. 산출물명과 제거 단계명의
  // 핵심어가 2개 이상 겹치거나 3자 이상 핵심어 1개가 겹칠 때만 연결된 것으로
  // 보되(stepDirectOutputs와 같은 보수적 기준), 활성 단계와도 겹치면 공유
  // 산출물로 보고 유지한다.
  const removedStepNames = model.hitlDetails?.validatedExcludedStepNames ?? [];
  // 렌더 단계의 단어 비교도 모델 층위와 같은 외래어 표준형을 쓴다
  // ("Google Sheets" 산출물·기준이 "구글 시트" 단계와 연결되도록).
  const relatesToStepName = (text: string, stepName: string): boolean => {
    const textWords = scopeWords(text);
    const nameWords = new Set(scopeWords(stepName));
    const overlap = textWords.filter(w => nameWords.has(w));
    return overlap.length >= 2 || overlap.some(w => w.length >= 3);
  };
  const relatesOnlyToRemovedSteps = (text: string): boolean => removedStepNames.length > 0
    && removedStepNames.some(name => relatesToStepName(text, name))
    && !work.some(s => relatesToStepName(text, s.step));
  // 산출물 귀속 판정: 단계명의 행위어(생성·반영·검증 등)를 제외한 핵심 토큰이
  // 모두 산출물명에 포함되면 그 단계의 산출물로 본다. 도메인 공통어(가격 등)를
  // 공유한다는 이유만으로 활성 단계의 산출물로 보지는 않는다 — 활성 단계 귀속도
  // 같은 포함 기준으로만 인정해, 보류·제외 단계의 산출물이 공통어 겹침 때문에
  // 최종 산출물에 남는 일을 막는다.
  const STEP_ACTION_TOKENS = new Set(["생성", "반영", "작성", "대조", "검증", "계산", "처리", "확인", "수집", "저장", "조회", "기록", "전송", "발송", "등록", "수정", "삭제", "분석", "분류", "추출", "변환", "출력", "제공", "점검", "검토", "승인", "관리"]);
  const stepCoreTokens = (stepName: string): string[] => {
    const words = scopeWords(stepName);
    const core = words.filter(w => !STEP_ACTION_TOKENS.has(w));
    return core.length ? core : words;
  };
  const isStepProduct = (text: string, stepName: string): boolean => {
    const textWords = new Set(scopeWords(text));
    const core = stepCoreTokens(stepName);
    return core.length > 0 && core.every(w => textWords.has(w));
  };
  const outputRelatesOnlyToRemovedSteps = (text: string): boolean => removedStepNames.length > 0
    && removedStepNames.some(name => relatesToStepName(text, name) || isStepProduct(text, name))
    && !work.some(s => isStepProduct(text, s.step));
  // 최종 산출물은 현재 구현 범위에서 확정된 산출물(허용 단계에 연결된 출력)을
  // 우선한다. AS-IS 산출물은 확정 산출물이 없을 때만 전체 산출물로 쓰고, 확정
  // 산출물이 있으면 기존 업무 참고로만 남긴다 — 현재 결과물을 그대로 최종 구현
  // 목표로 확정하면 TO-BE에서 달라지는 처리·출력이 누락될 수 있다.
  const finalOutputs = (currentOutputs.length ? currentOutputs : unique(d?.asIs?.outputs ?? []))
    .filter(out => !outputRelatesOnlyToRemovedSteps(out));
  // P0-4: 파일형 산출물의 컬럼·열 목록이 파싱되지 않으면 컬럼을 만들지 않고 미확정으로 표시한다.
  const undeterminedOutputs = detectUndeterminedOutputs(finalOutputs);
  const asIsReferenceOutputs = currentOutputs.length
    ? unique((d?.asIs?.outputs ?? []).filter(out => !currentOutputs.some(cur => normalizedItem(cur) === normalizedItem(out) || normalizedItem(cur).includes(normalizedItem(out)))))
        .filter(out => !outputRelatesOnlyToRemovedSteps(out))
    : [];
  const fallback = unique([...(d?.operation?.fallback ? [d.operation.fallback] : []), ...model.classified.filter(item => (item.role === "fallback" || item.role === "operation") && ["implement", "after-check", "verify"].includes(item.scope)).map(item => item.text)]);
  const tests = unique(model.scoped.tests.map(item => item.text));
  // 판정 기준 구분: 출처가 성공·실패 의미를 결정한다 (PoC 성공과 계획
  // acceptance는 모두 성공 의미, PoC 실패는 실패 의미). 단계에 연결됐는지
  // 여부가 의미를 바꾸지 않도록, 단계 연결 기준도 렌더링 단계에서 출처별로
  // 분리한다. 성공·실패 양쪽 출처에서 온 항목은 어느 한쪽으로 임의 확정하지
  // 않고 출처 충돌(확인 대상)로 분리한다.
  const pocKindOf = (item: AgentInstructionItem): "success" | "failure" | "conflict" | "none" => {
    const success = item.sources.includes("diagnosis.poc.success") || item.sources.includes("plan.acceptance");
    const failure = item.sources.includes("diagnosis.poc.failure");
    return success && failure ? "conflict" : success ? "success" : failure ? "failure" : "none";
  };
  const scopedCriteriaItems = model.scoped.criteria.filter(item => pocKindOf(item) !== "failure" && pocKindOf(item) !== "conflict");
  const stepFailureCriteria = unique(model.scoped.criteria.filter(item => pocKindOf(item) === "failure").map(evidenceLine));
  const scopedConflictingCriteria = model.scoped.criteria.filter(item => pocKindOf(item) === "conflict");
  // PART B: PoC 성공·실패 기준은 업무 전체 판정 기준이므로 단계 연결이 없어도 격하하지 않음.
  // 단 성공 기준만 완료 조건이고 실패 기준은 완료를 부정하는 판정이라 렌더링에서 분리한다.
  // 단계 연결 근거가 없는 다른 criteria는 P1에 따라 강등·차단·Level 0이 아니면
  // 참고 판정이 아니라 한정자付き 전체 완료 기준으로 둔다 (아래 movedNonPocItems).
  const isPocCriterion = (item: AgentInstructionItem) =>
    item.sources.some(s => s === "diagnosis.poc.success" || s === "diagnosis.poc.failure");
  // PART A-5: PoC 기준 안전성 — 제외된 단계나 차단 상태에서 필수 완료 조건으로 승격 금지.
  // 판정은 isDemotedPocCriterion 단일 기준을 쓴다 (03 요약은 제외 단계 관련
  // 판정(isExcludedStepCriterion)을 모든 완료 기준 출처에 적용한다 — PoC 항목은
  // 04와 같은 판정, 계획 acceptance 사본까지 걸러진다. 차단 분기는 04 실행 지시문 전용이다).
  // (Priority 5: 모델에서 유효성 검증된 제외 단계명 집합 사용, 검증 기준 단일화).
  // 차단 상태에서는 PoC 기준을 구현 가능한 완료 조건으로 제시하지 않음.
  // Level 0(검토·검증 전용)도 구현이 허용되지 않는 범위이므로 동일하게 취급한다 —
  // 단계 연결이 없는 PoC 기준을 "업무 전체 완료 조건"으로 승격하지 않는다.
  // (단계에 연결된 기준은 검토·검증 판정 기준으로 그대로 유지된다.)
  // 모델이 검증 방법으로 분류한 항목은 성공·실패 판정 기준이 아니다 —
  // '검증 방법·기록 (합격 조건 아님)'에 이미 분리돼 있으므로, 단계 연결된
  // 검증 방법이 업무 전체 완료/실패 기준으로 중복 승격되지 않게 제외한다
  // (계획 요약 경로의 criteria()와 동일한 제외 기준).
  const pocCriteriaItems = model.classified.filter(item => item.role === "criteria" && isPocCriterion(item) && !model.scoped.criteria.includes(item) && !model.scoped.validationMethods.includes(item));
  // 성공 기준과 실패 판정 기준은 의미가 정반대이므로 완료 기준에 합치지 않는다.
  // 실패 항목(예: "중복 ID 허용")은 완료 조건처럼 읽히면 요구사항과 충돌해
  // 에이전트가 전면 기권하는 원인이 된다 — 별도 실패 판정 섹션으로 분리한다.
  const eligiblePocCriteria = pocCriteriaItems
    .filter(item => !isDemotedPocCriterion(model, item));
  // P1 (결함 A-1): 미연결 비-PoC 기준(계획 acceptance 등)은 03의 통과 조건과
  // 달리 참고 판정으로 갈리지 않는다. 강등(보류·제외 연결)되거나 차단·Level 0
  // 상태가 아니고 단계 연결 근거가 없는 확인 대기 항목은, 미연결 PoC 기준과
  // 함께 한정자付き 전체 완료 기준으로 둔다. 양쪽 모두 "확인 대기 중인 완료 기준"이다.
  const movedNonPocItems = model.classified.filter(item => item.role === "criteria" && !isPocCriterion(item)
    && !model.scoped.criteria.includes(item) && !model.scoped.validationMethods.includes(item)
    && (item.scope === "confirm" || item.scope === "future") && scopeLevel !== 0 && !demotionForCriterion(model, item));
  // P0-3: 알림·전송 등 외부 행위를 요구하는 미연결 기준은 전체 완료 기준으로 승격하지 않고
  // "확인 필요(외부 행위)" 섹션으로 분리한다 (deferred 판정은 원래 movedNonPocItems 기준 유지).
  const movedExternalItems = movedNonPocItems.filter(isExternalActionCriterion);
  const movedExternalCriteria = movedExternalItems.map(unlinkedCriterionText);
  let overallSuccessItems = [
    ...eligiblePocCriteria.filter(item => pocKindOf(item) === "success"),
    ...movedNonPocItems.filter(item => !movedExternalItems.includes(item)),
  ];
  let overallFailureItems = eligiblePocCriteria.filter(item => pocKindOf(item) === "failure");
  // A-1(c) 텍스트 수준 출처 충돌: 별개 항목이지만 동일 문장이 성공·실패 양쪽에
  // 있으면 03의 분리 표시와 같은 의미로 충돌 섹션으로 옮긴다 (항목 수준 충돌은 아래 기존 처리).
  const overallSuccessKeys = new Set(overallSuccessItems.map(item => normalizedItem(item.text)));
  const overallFailureKeys = new Set(overallFailureItems.map(item => normalizedItem(item.text)));
  const textConflictTexts = unique([...overallSuccessItems, ...overallFailureItems]
    .filter(item => overallSuccessKeys.has(normalizedItem(item.text)) && overallFailureKeys.has(normalizedItem(item.text)))
    .map(item => item.text));
  const textConflictKeys = new Set(textConflictTexts.map(normalizedItem));
  overallSuccessItems = overallSuccessItems.filter(item => !textConflictKeys.has(normalizedItem(item.text)));
  overallFailureItems = overallFailureItems.filter(item => !textConflictKeys.has(normalizedItem(item.text)));
  // A-2: 단계 연결 판정 기준과 미연결 전체 완료 기준에서 동일 비교 대상의
  // 상충 수치·허용 기준을 검출해 어느 쪽도 합격 조건으로 남기지 않는다.
  const numericItems04 = numericConflictItems([...scopedCriteriaItems, ...overallSuccessItems]);
  const numericConflictCriteria = unique(numericItems04.map(item => numericConflictText(item)));
  const criteria = unique(scopedCriteriaItems.filter(item => !numericItems04.includes(item)).map(evidenceLine));
  const overallCriteria = unique(overallSuccessItems.filter(item => !numericItems04.includes(item)).map(unlinkedCriterionText));
  const overallFailureCriteria = unique(overallFailureItems.map(unlinkedCriterionText));
  // 성공·실패 양쪽 출처에서 전달된 항목은 성공 기준으로 조용히 승격하지
  // 않는다 (과거 동작). 단계 연결 여부와 무관하게 확인 대상으로 분리한다.
  const conflictingCriteria = unique([
    ...scopedConflictingCriteria.map(evidenceLine),
    ...eligiblePocCriteria.filter(item => pocKindOf(item) === "conflict").map(item => item.text),
    ...textConflictTexts,
  ]);
  const demotedPocCriteria = pocCriteriaItems
    .filter(item => isDemotedPocCriterion(model, item))
    .map(item => `${item.text} — 현재 필수 완료 조건 아님${gate === "blocked" ? " (실행 차단 상태)" : scopeLevel === 0 ? " (검토·검증 전용 범위)" : " (관련 단계 제외됨)"}`);
  // 업무 전체 완료 기준은 단계 연결 reason을 표시하지 않음 (전체 기준으로 명시하므로).
  // 전체 완료 기준으로 옮긴 미연결 비-PoC 항목은 참고 판정에 중복 표시하지 않는다.
  const deferredCriteria = [
    ...model.classified.filter(item => item.role === "criteria" && !isPocCriterion(item) && !model.scoped.criteria.includes(item) && !model.scoped.validationMethods.includes(item) && !movedNonPocItems.includes(item))
      .map(item => `${evidenceLine(item)} — 현재 필수 완료 조건 아님`),
    ...demotedPocCriteria,
  ];
  const hitl = model.hitlDetails;
  // 고정 결정 지점·범용 규칙 (지시문 생성 시점의 출력용; 저장 원문은 고치지 않는다).
  const decisionPoints = model.decisionPoints ?? [];
  const stateNames = confirmedStateNames(decisionPoints);
  const undecidedIds = undecidedDecisionIds(decisionPoints);
  // D5는 D4 목록으로 검증된 상태명만 인용한다. D4 확정 시 목록에 없는 덩어리·복수
  // 상태·목록 외 상태명은 "D5 상태명 미확정"으로 표시한다 (D4 미확정 시에는 기존대로 인용).
  const d5State = validatedUndecidableState(decisionPoints);
  const d5StateInvalid = isUndecidableStateInvalid(decisionPoints);
  // 범용 업무 규칙: 확정 규칙만 01~04에 전달하고, 미확정·적용 여부 미확정은 확인 대상으로 구분한다.
  const genericRules = resolveGenericRules(model.genericRules);
  const confirmedRules = confirmedGenericRules(genericRules);
  const pendingRules = pendingGenericRules(genericRules);
  const applicabilityPendingRules = applicabilityPendingGenericRules(genericRules);
  const duplicateRuleConflicts = duplicateGenericRuleConflicts(genericRules);
  // 사용자가 직접 입력한 블록은 D4 치환(applyStateDefinition) 대상에서 제외한다.
  // 치환하면 "정상·오류·확인 필요" 같은 D4 정의 행 자체가 다시 바뀌어 상태가 중복된다.
  const userBlocks: string[] = [];
  const protectUserBlock = (text: string) => { userBlocks.push(text); return `\u0000${userBlocks.length - 1}\u0000`; };
  const stateList = stateNames?.join(" · ");
  const decisionBlock = decisionPoints.length ? protectUserBlock(`### 결정 지점 (D1~D7)\n\n${bullets(decisionPoints.map(point => point.status === "미확정"
    ? `${point.id} ${point.title} — 미확정 (임의로 정하지 않음)`
    : point.id === "D5" && d5StateInvalid
      ? "D5 판단 불가 — 확정: D5 상태명 미확정 (D4 결과 상태 목록에 없는 상태명이므로 판정 불가 행을 보낼 상태를 임의로 정하지 않는다)"
    : point.id === "D4" && stateList ? `${point.id} ${point.title} — ${point.status}: ${stateList}`
    : point.detail ? `${point.id} ${point.title} — ${point.status}: ${point.detail}` : `${point.id} ${point.title} — ${point.status}`))}
${stateList ? `\n결과 상태 목록: ${stateList} — 지시문 전체에서 결과 상태를 언급할 때는 이 목록의 이름과 개수만 사용한다.` : ""}`) : "";
  // 범용 확정 규칙 블록. 미확정·적용 여부 미확정 규칙은 확정 표시 없이 구분해 표시한다.
  const genericRulesBlock = genericRules.length ? protectUserBlock(`### 업무 규칙 (범용)\n\n${bullets([
    ...confirmedRules.map(rule => `${rule.id} ${rule.name} (${rule.category}) — 확정${rule.detail ? `: ${rule.detail}` : ""}${rule.step ? ` [관련 단계: ${rule.step}]` : ""}${rule.source ? ` [근거: ${rule.source}]` : ""}${rule.linkedDecisionId ? ` [연계: ${rule.linkedDecisionId}]` : ""}`),
    ...pendingRules.map(rule => `${rule.id} ${rule.name} (${rule.category}) — 미확정 (임의로 정하지 않음)`),
    ...applicabilityPendingRules.map(rule => `${rule.id} ${rule.name} (${rule.category}) — 적용 여부 확인 필요 (임의로 적용·해당 없음 처리하지 않음)`),
  ])}${duplicateRuleConflicts.length ? `\n\n범용 규칙 의미 중복·충돌 (확인 필요):\n${bullets(duplicateRuleConflicts)}` : ""}`) : "";
  // 01. 구현 목표: 업무명·목적·핵심 기능·최종 산출물을 한 번만 제시한다.
  // 업무 등록 원문과 생성 계획 목표가 중복되면 하나의 구현 목표로 통합한다.
  const goalTexts = goals.filter(item => item.scope !== "future").map(item => item.text);
  const coreFeatures = unique(goalTexts.filter(text => {
    const n = normalizedItem(text);
    return !(d?.asIs?.purpose && normalizedItem(d.asIs.purpose).includes(n))
      && !(options.context && normalizedItem(options.context).includes(n));
  }));
  section("구현 목표",
    profile && d ? bullets([
      ...(options.taskName ? [`업무명: ${options.taskName}`] : []),
      ...(d.asIs?.purpose ? [`업무 목적: ${d.asIs.purpose}`] : []),
      ...(coreFeatures.length ? [`핵심 기능: ${coreFeatures.join("; ")}`] : work.length ? [`핵심 기능: ${work.map(s => s.step).join(", ")}`] : []),
      ...(finalOutputs.length ? [`최종 산출물: ${finalOutputs.join(", ")}`] : []),
      ...(undeterminedOutputs.length ? [`출력 컬럼 미확정: ${undeterminedOutputs.join(", ")} — 컬럼명·순서·타입을 확정하기 전에는 해당 출력의 형식을 단정하지 않는다. 컬럼명을 임의로 만들지 않는다.`] : []),
    ]) : "",
    d && level && gate ? `### 실행 조건\n\n${bullets([
      LEVEL_CONSTRAINTS_OUTPUT[level.level],
      GATE_CONSTRAINTS[gate],
    ])}\n\n실제 실행 범위는 현재 허용 범위를 따르며, TO-BE·생성 계획·매트릭스 위치는 이 범위를 넓히지 않습니다.` : "",
    `### 이번 작업 목표\n\n${objective}`,
    options.context?.trim() ? `### 업무 설명 (등록 내용)\n\n${options.context.trim()}\n\n등록 내용과 진단이 충돌하면 임의로 하나를 선택하지 말고, 실제 구현에 영향을 주는 충돌 사항만 확인 대상으로 남기세요.` : "",
    decisionBlock,
    genericRulesBlock,
  );
  // 02. 구현 범위: 각 단계의 상태·사유는 이 표에서 한 번만 표시한다.
  const extraHuman = humanKept.filter(item => !human.some(s => normalizedItem(item) === normalizedItem(`${s.step} (담당자 수행)`) || normalizedItem(item) === normalizedItem(s.step)));
  section("구현 범위",
    steps.length ? `| 업무 단계 | 처리 구분 | 확인 사항 |\n| --- | --- | --- |\n${steps.map(s => `| ${collapse(s.step)} | ${scopeLabel(s.scope)} | ${checkNote(s)} |`).join("\n")}` : "",
    profile?.scopeSupport.length ? `### 함께 수행할 확인\n\n${bullets(profile.scopeSupport)}` : "",
    extraHuman.length ? `### 담당자 수행 (단계 외 항목)\n\n${bullets(extraHuman)}` : "",
    excluded.length || outsideHuman.length ? `### 현재 자동화 제외\n\n${bullets([...excluded, ...outsideHuman])}` : "",
    outside.length ? `### 향후 확장 (이번 작업에서 구현하지 않음)\n\n${bullets(outside)}` : "",
    unlinked.length ? `### 적용 단계 확인 필요 제안\n\n${bullets(unlinked)}` : "",
    hitl && (hitl.deferred.length > 0 || hitl.excluded.length > 0 || hitl.supplements.length > 0) ? `### 사람 검토 반영\n\n${[
      hitl.deferred.length > 0 ? `보류된 작업 (현재 구현하지 않음):\n${unique(hitl.deferred.map(x => `- ${x.name} — 보류${x.reason ? `: ${x.reason}` : ""}${x.resumeCondition ? `\n  - 재개 조건: ${x.resumeCondition}` : ""}`))}\n위 작업은 현재 구현 범위에서 제외됩니다. 재개 조건이 충족되어도 자동으로 재개하지 말고 담당자에게 확인하세요.` : "",
      hitl.excluded.length > 0 ? `제외된 작업 (현재 구현 범위에서 제외):\n${unique(hitl.excluded.map(x => `- ${x.name} — 현재 구현 범위에서 제외. 관련 기능을 구현하지 않습니다.`))}\n위 작업은 업무 배경 설명에 언급되더라도 구현 목표·필수 기능·필수 산출물·완료 조건이 아닙니다.` : "",
      hitl.supplements.length > 0 ? `보완 요구사항·검증 기준:\n${unique(hitl.supplements.map(x => `- ${x.name}\n  - 보완 내용: ${x.content}`))}\n위 보완 내용은 원본 범위에 추가하여 관련 구현·검증 기준에 반영하세요. 단, 담당자 유지·제외·보류 범위를 넘어서는 부분은 구현하지 말고 사유를 보고하세요. 확인되지 않은 API·권한·DB를 임의로 추가하지 마세요.` : "",
    ].filter(Boolean).join("\n\n")}` : "",
  );
  // 03. 기능별 요구사항: 공통 입력·출력은 상단에 한 번만 정의하고,
  // 단계별로는 실제 필요한 입력·처리·출력·검증만 기술한다.
  const ioBlocks = work.map((s, i) => {
    const spec = stepIoSpec(model, steps.indexOf(s));
    const ownInputs = spec.inputs.filter(text => !text.endsWith("(업무 전체 입력)"));
    const hasCommonInputs = spec.inputs.some(text => text.endsWith("(업무 전체 입력)"));
    const processParts = [
      ...(s.treatment ? [s.treatment] : []),
      `방식: ${shortMethod(s)}`,
      // '구현:' 항목이 단계명을 그대로 재진술하면 기능 제목과 중복되므로 제외한다.
      ...spec.process.filter(text => text.startsWith("구현:") && normalizedStepText(text.slice(3)) !== normalizedStepText(s.step)),
    ];
    const isLastWork = work[work.length - 1] === s;
    // 단계별 착수 증거: 이 단계에 명시적으로 연결된 조건만 이 단계의 착수 조건이다.
    // 연결되지 않은 조건은 §4 전역에서만 다루며, 이 단계를 일괄 보류하는 근거가 되지 않는다.
    // 관련 후보는 단계명을 언급하지만 명시적 연결 근거가 없어 필수 조건으로 확정하지 않는다.
    // 어떤 조건도 새로 만들지 않고, 기존 분류 결과(current/confirm)에 있는 항목만 사용한다.
    const linkedConditions = unique([...model.conditions.current, ...model.conditions.confirm]
      .filter(item => item.step === s.step).map(evidenceLine));
    const relatedCandidates = unique(model.conditions.confirm
      .filter(item => conditionRelation(model, item, false) === "관련 후보"
        && normalizedStepText(item.text).includes(normalizedStepText(s.step)))
      .map(item => item.text));
    const startCondition = s.scope === "after-check"
      ? linkedConditions.length ? `착수 조건: ${linkedConditions.join("; ")}`
        : "착수 조건: 이 단계에 직접 연결된 필수 조건 없음 — §4의 필수 조건·보안·담당자 확인 항목 중 이 단계에 실제로 적용되는 것만 대조하세요. 적용되는 조건이 없으면 이 단계를 독립 단계로 진행할 수 있습니다."
      : linkedConditions.length ? `연결된 조건: ${linkedConditions.join("; ")}` : "";
    const unmetLine = s.scope === "after-check" && linkedConditions.length
      ? "미충족 시: 연결된 확인 항목이 확인되지 않으면 해당 부분만 보류하고 보류 사유·확인 대상·재개 조건을 보고하세요. 독립적인 다른 기능은 계속 진행하세요."
      : "";
    // 단계 메모 전달 누락 수정: 진단 단계 메모는 지금까지 방식 분류 신호로만
    // 소비되고 기능 블록에서는 사라졌다. 원문 그대로(신설·추측 없음) 전달한다.
    // 메모가 '미확인·미확정'을 적으면 그 자체가 미확정 표시이며, 확정 규칙으로
    // 승격되지 않는다. 처리 줄과 완전히 같은 문구일 때만 중복을 피한다.
    const stepNote = (s.note ?? "").trim();
    const stepNoteLine = stepNote && !processParts.some(part => collapse(part) === collapse(stepNote))
      ? `진단 단계 메모: ${collapse(stepNote)}`
      : "";
    return `### 기능 ${i + 1}. ${s.step}\n\n${bullets([
      `입력: ${ownInputs.length ? `${ownInputs.join("; ")}${hasCommonInputs ? " + 공통 입력 (위 공통 입력·출력 참조)" : ""}` : inputs.length ? "공통 입력 사용 (위 공통 입력·출력 참조)" : "입력 자료 미확정 — 진단에 입력 정보가 없음 (§4 '적용 단계 확인 필요' 참조)"}`,
      `처리: ${processParts.join(" → ")}`,
      ...(stepNoteLine ? [stepNoteLine] : []),
      spec.outputs.length ? `출력: ${spec.outputs.join("; ")}` : isLastWork ? "출력: 이 단계의 직접 산출물 없음 — 위 업무 전체 산출물에 기여" : "출력: 이 단계의 직접 산출물 없음 — 처리 결과는 후속 단계의 입력으로 이어짐",
      ...(spec.reviewPoint ? [`담당자 검토·승인 지점: ${spec.reviewPoint}`] : []),
      ...(startCondition ? [startCondition] : []),
      ...(relatedCandidates.length ? [`관련 후보 (필수 조건 아님): ${relatedCandidates.join("; ")} — 실제 의존 관계를 확인한 뒤에만 현재 조건으로 승격하세요.`] : []),
      ...(unmetLine ? [unmetLine] : []),
      `검증: '${verifyGroupLabel(s)}' 검증 기준 적용 (위 '방식별 검증 기준' 참조)`,
    ])}`;
  }).join("\n\n");
  section("기능별 요구사항",
    work.length || inputs.length ? `### 공통 입력·출력\n\n${bullets([
      ...(inputs.length ? [`공통 입력: ${inputs.join("; ")}`] : []),
      ...(d?.asIs?.trigger ? [`업무 발생 주기·시점: ${d.asIs.trigger} ${/(자동|스케줄|무인|정기\s*실행)/u.test(d.asIs.trigger) ? "(원본에 자동 실행 표현이 있어 실제 실행 방식·정책 허용 여부를 확인 대상으로 표시 — 자동 실행 허용으로 확정하지 않음)" : "(자동 실행 요구사항 아님)"}`] : []),
      ...(d?.asIs?.systems?.length ? [`사용 시스템: ${d.asIs.systems.join(", ")}`] : []),
      ...(finalOutputs.length ? [`업무 전체 산출물 (공통 출력): ${finalOutputs.join("; ")}`] : []),
      ...(asIsReferenceOutputs.length ? [`기존 업무 산출물 (참고 — 최종 구현 목표 아님): ${asIsReferenceOutputs.join("; ")}`] : []),
    ])}\n\n실제 입력 자료의 형식과 필수 필드를 확인하고 파싱·검증한 뒤 처리하세요. 확인 전에는 항목명·경로·값을 하드코딩하지 마세요. 계산·판정이 있으면 확인된 계산식·입력·순서·반올림·누락 처리 기준만 사용하고, 정의되지 않은 기준은 해당 처리만 보류해 '확인 필요'로 보고하세요. 원본 추적이 필요한 업무라면 결과에서 원본 출처·처리 단계·오류 위치·담당자 확인 결과를 확인할 수 있게 유지하세요.` : "",
    verifyGroups.size ? `### 방식별 검증 기준\n\n${bullets([...verifyGroups].map(([text, group]) => `${group.labels.join(" / ")} (${group.stepNames.join(", ")}): ${text}`))}` : "",
    work.length ? ioBlocks : "",
    review.length ? `### 검토·검증 작업\n\n${bullets(review.map(s => `${s.step} — ${shortMethod(s)}${(s.note ?? "").trim() ? ` (진단 메모: ${collapse(s.note)})` : ""}`))}\n\n샘플과 업무 규칙으로 확인한 결과를 보고하는 범위입니다. ${gate === "blocked" ? "운영 기능·자동 실행 코드·스캐폴딩을" : "운영 기능이나 자동 실행 코드를"} 만들지 마세요.` : "",
    work.length ? "실제 입력 수신→형식 파싱·필수값 검증→확정된 처리·담당자 확인→예외 분리→실제 출력으로 연결하세요. 업무상 필요한 저장·재조회는 기존 방식을 사용하고, 외부 API가 필요하면 권한과 실패 응답을 처리하세요. 독립적으로 허용된 단계는 다른 단계의 미확정 규칙 때문에 일괄 중단하지 마세요. 처리 없는 화면, 읽지 못하는 업로드, 입력이 달라도 같은 고정 결과, 더미 데이터 결과, 가짜 API 응답, TODO만 있는 핵심 함수, 승인 없이 확정되는 AI 결과는 완료가 아닙니다. 기존 구현을 우선 재사용하고 요청 범위 안에서 최소한으로 수정하세요. 요청하지 않은 기능·라이브러리, 하드코딩 값, 실제 로직에 남은 테스트용 임시 데이터, 근거 없는 수치 목표, 확인되지 않은 담당 조직·승인 주체를 만들지 마세요. 허용된 독립 단계가 없으면 코드를 만들지 말고 선행 확인사항을 보고하세요." : "",
  );
  // 포함 관계 중복 제거: 다른 항목에 온전히 포함되는 짧은 항목은 긴 항목이 같은
  // 사실을 이미 전달하므로 한 번만 남긴다 (예: '가격 미공시일' ⊂ '가격 미공시일 분리').
  // 단, 문자열 포함 관계가 의미적 동일성을 보장하지는 않는다 — 긴 항목이 짧은 항목에
  // 부정·금지·허용·필수·승인 등 의미를 바꾸는 말을 덧붙인 경우(예: '데이터 누락' ⊂
  // '데이터 누락 없음')는 같은 사실로 확정할 수 없으므로 양쪽을 모두 유지한다.
  // 예외 조건이 조용히 삭제되면 담당자 확인·자동 실행 제한이 사라질 수 있다.
  const MEANING_FLIP = /없|불가|불허|불필요|금지|면제|제외|아님|아닌|않|못하|거부|차단|보류|취소|중단|가능|허용|필수|의무|선택|필요|승인|확정/u;
  const dropContainedDuplicates = (items: string[]): string[] => {
    const norms = items.map(item => collapse(item).replace(/[.。]$/u, ""));
    const seen = new Set<string>();
    return items.filter((_, i) => {
      if (seen.has(norms[i])) return false;
      seen.add(norms[i]);
      return !norms.some((other, j) => {
        if (j === i || other === norms[i] || norms[i].length < 2 || !other.includes(norms[i])) return false;
        // 포함 지점을 제외한 나머지에 의미를 바꾸는 말이 있으면 동일성 미확정 — 유지한다.
        return !MEANING_FLIP.test(other.replace(norms[i], " "));
      });
    });
  };
  // 보류·제외 단계 전용 예외는 필수 구현으로 요구하지 않는다. 활성 단계와도
  // 겹치는 공통 예외는 relatesOnlyToRemovedSteps가 false이므로 그대로 유지된다.
  const exceptionLines = dropContainedDuplicates(exceptions)
    .filter(text => !relatesOnlyToRemovedSteps(text));
  // P0-2: 확정 결정 지점과 예외가 같은 대상에 서로 다른 판정을 내리면, 충돌한 예외
  // 문장을 §4 예외에서 빼고 충돌 섹션으로 분리한다. D 블록(protectUserBlock)은 그대로 둔다.
  const decisionExceptionConflicts = stateNames
    ? detectDecisionExceptionConflicts(decisionPoints, exceptionLines, stateNames)
    : [];
  // 범용 확정 규칙도 같은 결과 상태 충돌 기준으로 예외와 대조한다 (§9.2 검증 경로 확장).
  const genericRuleConflicts = stateNames
    ? detectGenericRuleExceptionConflicts(confirmedRules, exceptionLines, stateNames)
    : [];
  const ruleExceptionConflicts = [...decisionExceptionConflicts, ...genericRuleConflicts];
  const conflictExceptionTexts = new Set(ruleExceptionConflicts.map(conflict => conflict.exception));
  const shownExceptionLines = exceptionLines.filter(text => !conflictExceptionTexts.has(text));
  // 04. 예외 및 유지 조건: 같은 예외·제한은 한 번만 출력한다.
  section("예외 및 유지 조건",
    gate === "conditional" && scopeLevel === 0
      ? "검토·검증만 허용됩니다. 각 검토 작업이 의존하는 항목이 확인되지 않았으면 그 검토만 보류하고 '확인·승인 대기'로 보고하세요. 의존하지 않는 검토(프로젝트 구조·기존 자료 확인 등)는 진행할 수 있습니다."
      : "",
    gate === "blocked" && profile?.blockReasons.length ? `### 차단 사유\n\n${bullets(profile.blockReasons)}` : "",
    conditions.length ? `### 현재 필수 조건\n\n${bullets(conditions)}` : "",
    relatedCandidateLines.length ? `### 관련 후보 (필수 조건으로 확정하지 않음)\n\n${bullets(relatedCandidateLines)}\n\n위 조건은 업무 단계명을 언급하지만 명시적 단계 연결 근거가 없어 관련 가능성만 표시합니다. 해당 단계의 필수 의존 조건으로 확정하지 말고, 실제 의존 관계를 확인한 뒤에만 현재 조건으로 승격하세요. 확인 전에는 확인 필요 상태를 유지합니다.` : "",
    unassignedRestLines.length || gaps.length ? `### 적용 단계 확인 필요\n\n${bullets([...unassignedRestLines, ...gaps])}\n\n미연결 조건의 적용 대상과 의존 관계를 실제 자료로 확인하세요. 무관하다고 임의로 해제하지 말고, 영향 가능성이 있는 작업은 확인·승인 대기로 두세요. 해당 조건과 독립적이라는 근거가 확인된 허용 작업만 계속 진행할 수 있습니다.` : "",
    extraConstraints.length ? `### 담당자·제외 제약 (추가)\n\n${bullets(extraConstraints)}` : "",
    humanConstraints || humanKept.length ? `### 담당자 확인·승인\n\n${HUMAN_DECISION_CHECK} 담당자 판단·확정이 필요한 결과를 확인되지 않은 승인으로 확정·시스템 반영·외부 전송하거나 담당자 판단을 대체하지 마세요. 승인 주체·권한이 확인되지 않았으면 지정하지 마세요.` : "",
    "확인되지 않은 API·권한·파일 형식·연동 방식·계산식·반올림·중복 기준·승인 주체를 가정해 구현하지 마세요. 특히 '불가'·거부된 접근 권한은 검토에서 제외해도 허용으로 바뀌지 않습니다.",
    exceptionLines.length ? `### 예외\n\n${bullets(shownExceptionLines.length ? shownExceptionLines : ["(결정 지점·업무 규칙과 충돌하는 예외 문장은 아래 '결정 지점·업무 규칙·예외 충돌 (확인 필요)'로 분리했다.)"])}\n\n${stateList ? `확정 규칙으로 처리하지 못한 데이터는 결과 상태 목록(${stateList}) 중 해당 상태로 분리해 원인과 대상을 확인할 수 있게 하세요.` : "실패·미매칭·확인 불가 데이터는 정상 결과와 분리해 원인과 대상을 확인할 수 있게 하세요."} 자동 삭제·자동 보정은 업무 규칙에 명시된 경우에만 적용하고, 아니면 대상 건을 표시만 하세요.` : "",
    ruleExceptionConflicts.length ? `### 결정 지점·업무 규칙·예외 충돌 (확인 필요)\n\n${bullets(ruleExceptionConflicts.map(conflict => conflict.line))}\n\n위 항목은 확정 결정 지점·업무 규칙과 예외 문장이 같은 대상에 서로 다른 판정·범위를 제시하므로, 어느 쪽도 단정적 요구로 쓰지 말고 충돌 내용을 확인 대상으로 보고하세요.` : "",
    `### 실행 방식\n\n${scopeLevel === 1 ? "담당자 요청 기반 실행만 허용합니다. 스케줄러·폴더 감시 등 정기 무인 실행을 구현하지 마세요." : scopeLevel === 0 ? "검토·검증만 허용하며 업무 자동 실행을 추가하지 마세요." : "업무 발생 주기와 시스템 자동 실행은 별개입니다. 실제 자동 실행 요청·근거·정책 허용 여부가 확인되지 않았다면 실행 방식 확인 필요로 보고하세요."}${d?.asIs?.trigger && /(자동|스케줄|무인|정기\s*실행)/u.test(d.asIs.trigger) ? " 원본 주기 표현에 자동 실행 언급이 있어도 정책 허용 범위와 담당자 확인 없이는 자동 실행으로 확정하지 않고, 실제 실행 방식은 확인 대상으로 보고하세요." : ""}`,
    `### 보안\n\n${bullets([
      ...model.conditions.global.filter(item => item.role === "security").map(evidenceLine),
      "secret은 코드에 하드코딩하지 말고 저장소의 기존 secret 관리 방식을 사용하세요. 기존 인증·권한 구조와 최소 권한 원칙을 유지하고, 민감한 데이터를 불필요하게 로그에 남기지 마세요.",
      "외부 AI 서비스로 업무 자료를 보내기 전에 보안 조건을 확인하고, 확인되지 않은 연동은 자동 실행하지 마세요.",
    ])}`,
    `### 수동 전환\n\n${fallback.length ? `${bullets(fallback)}\n\n` : ""}자동화가 실패해도 기존 수동 업무를 계속할 수 있게 유지하세요. 실제 수동 절차와 운영 담당이 확인되지 않았으면 새로 정하지 마세요.`,
  );
  // P0-5: 상태 플래그 미확정과 구분되는 내용 미확정. D4 파싱 실패·D5∉D4·출력 컬럼
  // 부재·D-예외 충돌이 있으면 "미확정 항목: 없음"으로 가려지지 않게 §5에 별도 표시한다.
  const d4Point = decisionPoints.find(point => point.id === "D4");
  const declaredCount = d4Point?.status === "확정" && d4Point.detail ? declaredStateCount(d4Point.detail) : null;
  const contentUndetermined: string[] = [];
  if (stateNames && declaredCount !== null && declaredCount !== stateNames.length) contentUndetermined.push(`D4 상태 개수 불일치 (표기 ${declaredCount}개와 파싱 결과 ${stateNames.length}개가 다름)`);
  if (d4Point?.status === "확정" && d4Point.detail && !stateNames) contentUndetermined.push("D4 상태 파싱 실패");
  if (d5StateInvalid) contentUndetermined.push("D5 상태명 미확정 (D5가 D4 결과 상태 목록에 없음)");
  if (undeterminedOutputs.length) contentUndetermined.push(`출력 컬럼 미확정 (${undeterminedOutputs.join(", ")})`);
  if (ruleExceptionConflicts.length) contentUndetermined.push(`결정 지점·업무 규칙·예외 충돌 ${ruleExceptionConflicts.length}건 (확인 필요)`);
  // 05. 구현 순서 및 검증: 코딩 에이전트 실행 순서 10단계. 순서는 실제 개발 작업만
  // 간결하게 쓰고, 기능별 요구사항·예외 및 유지 조건의 전문을 다시 반복하지 않는다.
  // 이 확인 순서는 Level·Gate·HITL 판정을 변경하거나 새 구현 권한을 부여하지 않는다.
  // "확인 후 구현"은 확인되면 허용 범위에서 구현하고, 미확정이면 그 부분만 보류한다는
  // 뜻이며, 무조건 즉시 구현으로 바꾸지 않는다.
  section("구현 순서 및 검증",
    "구분 — A. 구현 전 확인 작업: 기존 정책과 실제 접근 권한에서 허용되는 읽기·분석·검증 작업(저장소 구조·기존 코드 확인, 실제 입력 자료·파일 형식 확인, 확정된 계산식·업무 규칙 확인, 기존 API·인증 설정의 존재 여부 확인, 출력 템플릿·매핑 규칙 확인, 업무 단계별 실제 의존관계 확인, 기존 테스트·설정·실행 환경 확인)은 확인 후 구현 상태에서도 수행할 수 있습니다. 권한이 없는 데이터·외부 시스템에 접근하거나 인증을 우회해서는 안 됩니다. B. 조건 충족 후 구현 작업: 기존 Level·Gate가 해당 구현을 허용하고, HITL 제외·보류 대상이 아니며, 필수 입력 자료·규칙·권한과 처리 방식에 필요한 확정 근거, 실제 의존조건, 필요한 담당자 확인·승인 조건이 모두 확인된 경우에만 실제 기능을 구현합니다. C. 구현 보류 작업: 필수 조건 미확인, HITL 보류, Gate 차단, 권한 거부 등의 사유로 구현할 수 없는 작업은 구현하지 않고 보류 사유·확인 대상·재개 조건을 보고합니다. 해당 기능의 실제 구현은 필수 처리 방식과 선행조건이 확인될 때까지 보류합니다. 다만 확인 작업 허용은 구현 권한 부여가 아닙니다. 실제 자료가 부족하면 임의 값을 만들어 구현 완료로 처리하지 말고 부족 사항을 구체적으로 보고하세요. 정책상 구현이 금지된 작업은 자료가 충분해도 그대로 보류합니다.",
    numbered([
      "대상 저장소·기존 구현 확인: 저장소 지침(AGENTS.md 등)과 현재 branch·미커밋 변경을 확인하고, 프로젝트 구조·실행 환경·테스트·빌드 명령을 파악하세요. 이 업무가 웹앱인지 CLI·스크립트·파일 자동화인지 확인하고 해당 환경의 기존 구현을 재사용하세요. 확인한 사실과 추정을 구분해 기록하고, 추정은 '확인 필요'로 남기세요.",
      "실제 입력 파일·자료·설정 확인: 실제 샘플로 입력 형식·필수 항목을 확인하세요. 실제 샘플로 형식을 확인하기 전에는 항목명·경로·값을 하드코딩하지 마세요.",
      "확정된 업무 규칙 확인: '기능별 요구사항'의 처리 기준 중 확정된 업무 규칙만 사용하세요. 정의되지 않은 계산식·판정 기준·외부 연동 방식은 추측해 구현하지 말고 해당 처리만 '확인 필요'로 보고하세요.",
      "접근 권한·보안·승인 조건 확인: '예외 및 유지 조건'의 필수 조건·보안·담당자 확인 항목을 실제 권한·승인 주체와 대조하세요. '불가'·거부된 접근 권한은 우회하지 말고, 승인 주체·조건이 확인되지 않았으면 지정하지 마세요.",
      "단계별 실제 의존 관계 확인: 각 단계가 실제로 의존하는 선행 조건을 '구현 범위'와 '예외 및 유지 조건'에서 대조하세요. 관련 후보는 필수 의존으로 확정하지 않고, 적용 단계가 미확인인 조건은 확인 필요로 유지하세요.",
      "기존 정책에서 허용된 실행 범위 확인: '구현 범위'의 처리 구분(구현·확인 후 구현·검토·검증·담당자 수행·향후 확장)을 그대로 따르세요. 허용 범위를 넓히거나, 보류·제외 단계를 독립 기능으로 재분류하거나, Level·Gate를 초과해 처리하지 마세요.",
      work.length ? "조건 충족 독립 단계부터 구현: '기능별 요구사항'의 각 기능을 입력·처리·출력 명세대로 구현하세요. 다른 단계의 미확정 규칙 때문에 독립 단계까지 일괄 중단하지 마세요." : "조건 충족 독립 단계부터 구현: 이번 범위에서 구현할 단계가 없습니다. 입력 자료의 형식 확인과 보고만 수행하세요.",
      "미확정 조건 의존 부분만 보류: 미확정 조건에 실제로 의존하는 작업만 보류하고, 보류 사유와 재개 조건을 보고하세요. 재개 조건이 충족되어도 담당자 재확인·승인 없이 자동으로 재개하지 마세요.",
      work.length ? `실제 데이터로 검증: 처리 결과를 ${finalOutputs.length ? finalOutputs.join(", ") : "확인된 출력 형식"}으로 연결하고, 업무에 필요한 저장·재조회가 있으면 기존 저장소·인증 방식으로 동작을 확인하세요. '예외 및 유지 조건'의 예외 항목을 처리하고 ${stateList ? `확정 규칙으로 처리하지 못한 데이터를 결과 상태 목록(${stateList}) 중 해당 상태로 분리하세요` : "실패·미매칭·확인 불가 데이터를 정상 결과와 분리하세요"}. 저장소의 실제 테스트·빌드 명령으로 아래 검증 기준을 확인하고, 실행하지 않은 검증은 완료로 보고하지 마세요. 저장 기능이 없는 업무에 DB 검증을, 웹앱이 아닌 업무에 브라우저 테스트·웹 배포를 강제하지 마세요.${undeterminedOutputs.length ? ` 출력 컬럼이 미확정인 산출물(${undeterminedOutputs.join(", ")})은 컬럼명·순서·타입이 확정될 때까지 형식을 단정하지 않는다.` : ""}` : "실제 데이터로 검증: 해당 없음 — 확보한 샘플과 기존 자료로 확인할 수 있는 범위만 검증하고, 비교 자료가 없으면 '검증 불가'와 사유를 기록하세요.",
      "담당자 확인·승인 경계 유지: 담당자 확인 전 결과가 확정·전송되지 않는지, 제외·보류된 단계가 다시 필수 작업으로 나타나지 않는지 확인하세요. 담당자 판단을 자동 승인으로 대체하지 말고, 완료 여부는 실제 실행·검증 결과로만 판단해 '결과 보고'의 4개 항목으로 보고하세요.",
    ]),
    "위 순서를 지키되 의존성이 없는 독립 단계는 병렬로 진행할 수 있습니다. 선행 확인이 필요한 단계는 실제 의존 관계를 확인하고 해당 부분만 '확인·승인 대기'로 보고하세요. 미확인 권한·보안 조건을 독립이라고 단정하거나 우회하지 마세요.",
    decisionPoints.length ? `### 결정 지점·업무 규칙 기반 구현 순서\n\n${bullets([
      `1. 코딩 전에 결과 상태 정의와 미확정 항목(${undecidedIds.length ? undecidedIds.join(", ") : "없음"})을 한 번 정리해 출력한다. 미확정 항목의 규칙을 임의로 정하지 않는다.`,
      "2. 핵심 처리 로직을 화면과 분리된 함수로 먼저 구현한다.",
      "3. 확정된 업무 규칙을 실제 입력 자료로 검증한다. 각 확정 규칙에 대해 실제 입력으로 처리 결과를 대조하고, 입력을 바꿨을 때 출력이 규칙대로 달라지는지 확인한다. 미확정 규칙에 의존하는 검증은 미실행으로 두고, 확정되지 않은 규칙을 테스트 기준으로 만들지 않는다.",
      "4. 다음 두 조건을 테스트에 포함한다: 하나의 항목은 결과 목록 하나에만 들어간다 / 모든 입력 행은 하나의 결과에 반영되거나, 정해진 제외 사유와 함께 표시된다.",
      "5. 화면을 연결한 뒤 같은 실제 입력 자료로 처리해 결과가 같은지 확인한다.",
      "6. 배포한 경우 배포된 주소에서 같은 실제 입력 자료로 다시 확인한다.",
    ])}` : "",
    decisionPoints.length ? `### 미확정 항목 처리\n\n${[
      d5State
        ? `미확정 규칙에 해당하는 행만 '${d5State}'로 보내고 사유에 해당 D번호를 표시한다. 나머지 행은 확정된 규칙대로 처리한다. 확정 규칙으로 판정할 수 있는 행까지 '${d5State}'로 보내는 구현은 완료가 아니다.`
        : d5StateInvalid
          ? "D5 상태명 미확정 — D5에 적힌 상태명이 D4 결과 상태 목록에 없으므로 판정 불가 행을 보낼 상태를 임의로 정하지 않는다. 판정 불가 행만 보류하고 사유에 해당 D번호를 표시한다."
          : "D5가 미확정이므로 판정 불가 행을 보낼 상태명을 임의로 만들지 않는다. 판정 불가 행만 보류하고 확정 규칙으로 판정 가능한 행은 정상 처리한다. 해당 행은 기존 조건부 보류 체계에 따라 처리되며, 사유에 D번호를 표시한다.",
      `미확정 항목: ${undecidedIds.length ? undecidedIds.join(", ") : contentUndetermined.length ? "상태 미확정 없음" : "없음"}${pendingRules.length ? ` — 미확정 범용 규칙: ${pendingRules.map(rule => `${rule.id} ${rule.name}`).join(", ")}` : ""}${applicabilityPendingRules.length ? ` — 적용 여부 확인 필요 범용 규칙: ${applicabilityPendingRules.map(rule => `${rule.id} ${rule.name}`).join(", ")}` : ""}${contentUndetermined.length ? ` — 내용 미확정: ${contentUndetermined.join("; ")}` : ""} — 위 항목의 규칙을 임의로 정하지 않는다.`,
      ...(undecidedIds.includes("D4") ? ["D4가 미확정이므로 결과 상태 정의가 필요한 범위(결과 상태 판정·결과 상태 판정 검증)만 보류하고, D4 정의 없이 판단 가능한 처리는 확정된 규칙대로 진행한다. D4 미확정을 이유로 전체를 일괄 보류하지 않는다."] : []),
      ...(!undecidedIds.includes("D4") && !undecidedIds.includes("D5") && undecidedIds.length ? ["D4·D5가 확정되고 다른 결정 지점이 미확정이므로, 확정 규칙으로 판단 가능한 데이터는 정상 처리하고, 미확정 규칙이 필요한 데이터만 해당 D번호와 함께 보류한다. 다른 지점 미확정을 이유로 확정 가능 데이터까지 일괄 보류하지 않는다."] : []),
    ].join("\n\n")}` : "",
    decisionPoints.length || genericRules.length ? `### 업무 규칙 검증\n\n${bullets([
      ...(confirmedRules.length ? [`확정된 범용 규칙(${confirmedRules.map(rule => rule.id).join(", ")})은 실제 입력 자료로 처리 결과를 대조하고, 입력을 바꿨을 때 출력이 규칙대로 달라지는지 확인한다.`] : []),
      ...(pendingRules.length ? [`미확정 범용 규칙(${pendingRules.map(rule => rule.id).join(", ")})에 의존하는 검증은 미실행으로 두고, 해당 규칙을 임의로 정하지 않는다.`] : []),
      ...(applicabilityPendingRules.length ? [`적용 여부 확인 필요 범용 규칙(${applicabilityPendingRules.map(rule => rule.id).join(", ")})은 적용 여부를 확인하기 전에는 검증 기준으로 쓰지 않는다.`] : []),
      "실제 입력으로 처리·출력과 필요한 저장·재조회를 확정된 기대 결과와 대조하세요. 서로 다른 입력으로 다시 실행해 각 입력에 맞게 출력이 달라지는지 확인하고 고정 결과를 배제하세요. 기대 결과·허용 오차가 정의되지 않았다면 '확인 필요'로 보고하세요.",
    ])}\n\n독립 평가 데이터는 이 지시문에 포함하지 않으며, 구현 에이전트에 정답을 사전 노출하지 않는다.\n\n### 완료 불인정 기준\n\n아래 중 하나라도 해당하면 완료로 인정하지 않는다.\n\n${bullets([
      "동작하지 않는 버튼·링크·입력 (클릭·제출이 실제 동작으로 이어지지 않음)",
      "정적 예시·더미 데이터만 보여주는 화면 (실제 입력과 무관한 고정 결과)",
      "입력 미독립 (다른 입력에도 같은 결과가 나옴)",
      "통신 없는 API (가짜 응답·스텁만 반환)",
      "미저장 CRUD (재조회 시 반영되지 않음)",
      "권한 없는 제한 우회 (거부된 권한으로 처리·조회됨)",
      "승인 없는 외부 전송 (담당자 확인 전 확정·전송)",
      "원본 무관 문서 (원본 내용·변경 이력과 대조되지 않음)",
      "하드코딩된 기대 결과·값 (입력·규칙과 무관한 고정값)",
      "형식적 코드 (TODO만 있는 핵심 함수·처리 없는 화면)",
    ])}\n\n비데이터 업무에 Excel/CSV 입력을 완료 조건으로 강제하지 않는다. 해당 업무의 실제 입력·출력 방식으로 검증한다.` : "",
    work.length ? `### 정상 케이스\n\n${tests.length ? `${bullets(tests)}\n\n` : ""}실제 입력으로 처리·출력과 필요한 저장·재조회를 확정된 기대 결과와 대조하세요. 서로 다른 입력으로 다시 실행해 각 입력에 맞게 출력이 달라지는지 확인하고 고정 결과를 배제하세요. 기대 결과·허용 오차가 정의되지 않았다면 '확인 필요'로 보고하세요.`
      : `### 현재 검토·검증\n\n${tests.length ? `${bullets(tests)}\n\n` : ""}확보한 샘플과 기존 자료로 확인할 수 있는 범위만 검증하세요. 검증을 위해 새 기능·자동 생성 코드를 만들지 말고, 비교 자료가 없으면 '검증 불가'와 사유를 기록하세요.`,
    model.scoped.validationMethods.length ? `### 검증 방법·기록 (합격 조건 아님)\n\n${bullets(model.scoped.validationMethods.map(evidenceLine))}` : "",
    work.length ? `### 경계·실패 케이스\n\n입력 1건·빈 입력·같은 기준값 여러 건·선택 항목 누락·확정된 업무 경계값 중 해당하는 상황을 확인하세요. 현재 구현 단계의 잘못된 형식·파싱 오류·필수 항목 누락과 외부 API가 필요한 경우 응답 오류·권한 거부·연결 실패가 ${stateList ? "근거 없이 확정 규칙의 판정 결과" : "정상 결과"}나 성공한 저장으로 표시되지 않는지 확인하세요.` : "",
    "### 범위·승인·회귀 확인\n\n담당자 확인 전 결과가 확정·전송되지 않는지, 제외·보류된 단계와 검증 기준이 다시 필수 작업으로 나타나지 않는지, 거부된 권한에 의존하는 처리가 실행되지 않는지 확인하세요. 이 작업과 관련된 기존 기능이 이전과 동일하게 동작하는지 확인하세요. 웹 UI를 포함하면 기존 브라우저/E2E 도구가 있을 때 주요 화면을 Desktop과 Mobile에서 확인하세요.",
    work.length ? `### 단계별 완료 기준\n\n${bullets([
      ...(work.some(s => s.scope === "implement") ? [`구현 단계 (${work.filter(s => s.scope === "implement").map(s => s.step).join(", ")}): '기능별 요구사항'의 해당 기능 검증 기준을 모두 충족하면 완료`] : []),
      ...(work.some(s => s.scope === "after-check") ? [`확인 후 구현 단계 (${work.filter(s => s.scope === "after-check").map(s => s.step).join(", ")}): 각 단계가 실제로 의존하는 확인 항목이 확인되어 '기능별 요구사항'의 해당 기능 검증 기준을 충족하면 완료하고, 의존 항목을 확인하지 못했다면 '확인·승인 대기'로 보고. 이 단계가 의존하지 않는 확인 항목은 완료 판정을 막지 않음`] : []),
    ])}` : "",
    review.length ? `### 검토·검증 완료 기준\n\n${bullets([
      "확인한 프로젝트 구조와 재사용 가능한 기존 구현이 정리됩니다.",
      ...review.map(s => `${s.step}: 처리 가능성과 기술적 제약이 근거 자료와 함께 정리됩니다.`),
      "다음 진단에 필요한 정보가 보고됩니다.",
    ])}` : "",
    criteria.length ? `### 판정 기준\n\n${bullets(criteria)}` : "",
    stepFailureCriteria.length ? `### 단계별 실패 판정 기준\n\n${bullets(stepFailureCriteria)}\n\n위 항목은 완료 조건이 아니라 실패 판정 기준입니다. 어느 하나라도 해당하면 해당 단계를 완료로 판정하지 마세요.` : "",
    overallCriteria.length ? `### 업무 전체 완료 기준\n\n${bullets(overallCriteria)}\n\n위 기준은 업무 전체 산출물에 대한 완료 조건입니다. 단계별 검증과 함께 확인하세요. '기준 확인 필요'로 표시된 기준은 확인 대기 중인 완료 기준이며, 실제 업무 규칙 확인 후 확정합니다.` : "",
    overallFailureCriteria.length ? `### 업무 전체 실패 판정 기준\n\n${bullets(overallFailureCriteria)}\n\n위 항목은 완료 조건이 아니라 실패 판정 기준입니다. 어느 하나라도 해당하면 완료로 판정하지 마세요. '기준 확인 필요'로 표시된 기준은 확인될 때까지 실패 판정으로 확정하지 않습니다.` : "",
    movedExternalCriteria.length ? `### 확인 필요(외부 행위)\n\n${bullets(movedExternalCriteria)}\n\n위 항목은 알림·전송·승인 등 외부 행위를 요구하는 미확정 기준이므로 업무 전체 완료 기준으로 확정하지 않습니다. 외부 행위의 대상·채널·필수 여부를 확인 대상으로 보고하세요.` : "",
    conflictingCriteria.length ? `### 판정 기준 출처 충돌 (확인 필요)\n\n${bullets(conflictingCriteria)}\n\n위 항목은 성공 기준과 실패 판정 기준으로 모두 제시되어 의미가 충돌합니다. 어느 한쪽으로 임의로 해석해 완료·실패를 판정하지 말고, 충돌 내용을 확인 대상으로 보고하세요.` : "",
    numericConflictCriteria.length ? `### 수치 기준 충돌 (확인 필요)\n\n${bullets(numericConflictCriteria)}\n\n위 항목은 동일 비교 대상에 대해 양립할 수 없는 수치·허용 기준으로 제시되어 있습니다. 우선순위를 정하지 않으며, 실제 업무 규칙이 확정될 때까지 어느 쪽도 합격 조건으로 쓰지 말고, 충돌 내용을 확인 대상으로 보고하세요.` : "",
    deferredCriteria.length ? `### 참고 판정 (필수 완료 조건 아님)\n\n${bullets(deferredCriteria)}` : "",
    gate === "blocked" || !profile ? "운영 구현과 실행은 차단되고 검토·검증 결과와 차단 해제 조건만 기록됩니다. 타입 오류와 빌드 오류가 없어야 합니다."
      : work.length ? "타입 오류와 빌드 오류가 없어야 합니다. 실행하지 않은 검증은 완료로 보고하지 말고 미실행으로 명시하세요."
      : "코드를 변경했다면 타입 오류와 빌드 오류가 없어야 합니다. 실행하지 않은 검증은 완료로 보고하지 말고 미실행으로 명시하세요.",
  );
  // 06. 결과 보고: 4개 항목으로 통합한다.
  section("결과 보고",
    work.length
      ? "완료 상태는 실제 실행 근거로 구분해 표기하세요: 구현·검증 완료 / 구현 완료·검증 미완료 / 부분 구현 / 확인·승인 대기 / 정책상 제외·차단 / 구현 실패."
      : "완료 상태는 실제 실행 근거로 구분해 표기하세요: 검토 완료 / 검증 완료 / 일부 확인 / 확인 필요 / 확인·승인 대기 / 정책상 제외·차단 / 검증 실패 / 미실행.",
    `### Git·배포\n\n${bullets([
      "작업 전후로 `git status`, 현재 branch, `git diff`를 확인하고 기존 작업을 덮어쓰지 마세요. 의도한 파일만 `git add <파일>`로 stage하세요 (`git add .` 금지). force push, `git reset --hard` 같은 파괴적인 명령을 사용하지 마세요. stage·commit·push·PR은 사용자 요청 범위, 도구 권한, 저장소 branch/PR 정책이 모두 허용할 때만 진행하세요.",
      "배포는 저장소의 기존 CI/CD·배포 설정에서 방식을 먼저 확인하고 플랫폼을 임의로 선택하지 마세요. 확인할 수 없으면 '배포 방식 확인 필요'로 보고하세요. 로컬 스크립트·CLI·파일 자동화처럼 웹 배포가 필요 없으면 배포 대신 실행 환경 구성과 운영 적용 방법을 정리하세요. Production 배포는 사용자가 요청했고 권한이 확인된 경우에만 기존 방식으로 실행하세요.",
      "배포 또는 운영 적용을 수행했다면 실제 환경에서 서로 다른 입력 → 파싱·처리 → 실제 출력·필요한 저장·재조회, 오류와 권한·승인 경계를 확인하세요. 배포하지 않았다면 운영 검증 완료로 보고하지 마세요.",
      ...(gate === "blocked" || !profile ? ["실행 범위가 차단·미확정 상태에서는 배포·운영 적용·연결을 수행하지 마세요. 차단 해제에 필요한 조건만 보고하세요."] : []),
    ])}`,
    `작업이 끝나면 다음 4개 항목으로 보고하세요. 각 항목의 완료 여부는 실제 실행 근거를 기준으로 판단하고, 실행하지 않은 테스트나 배포를 완료로 표시하지 마세요. 배포가 필요하지 않은 프로그램은 실제 실행 검증 결과로 보고하세요. 확인하지 않은 환경변수·API·파일 경로를 적지 말고, 계획이나 미구현 기능을 실행 가능한 코드와 구분하세요. 완료 보고에는 확정 규칙별 처리 결과, 실제 결과, 일치 여부를 실제 실행 결과로 보고한다. 실행하지 못한 검증은 실행하지 못했다고 쓴다. 확정 규칙 통과만으로 구현 완료·정확성 PASS를 판단하지 않는다. 실제 정확성 검증은 별도 독립 평가 데이터로 수행하고, 수행하지 못한 검증은 NOT_VERIFIED로 보고한다. 배포 후 검증 보고에는 실제 배포 주소(URL), 입력, 실제 결과, 독립 정답 대조 결과를 포함한다.`,
    numbered([
      "구현한 기능 및 변경 파일",
      "실제 실행·테스트 결과 (실행하지 않은 검증은 미실행으로 명시)",
      "미완료·보류 사항 및 사유",
      "Git·배포·운영 적용 상태",
    ]),
  );
  const prompt = [
    axPromptTitle(options.taskName),
    "대상 저장소를 먼저 확인한 뒤, 아래 '구현 범위' 안에서 첫 MVP를 구현하세요. 완료 여부는 실제 실행·검증 결과로만 판단합니다.",
    ...sections.filter(s => s.body).map((s, i) => `## ${i + 1}. ${s.title}\n\n${s.body}`),
  ].join("\n\n");
  // D4 단일 정의는 생성 출력에만 적용한다 (저장된 진단 원문은 고치지 않는다).
  // 보호한 사용자 입력 블록은 치환 후 원래 내용으로 되돌린다.
  return applyStateDefinition(prompt, stateNames).replace(/\u0000(\d+)\u0000/gu, (_, index: string) => userBlocks[Number(index)]);
}

/**
 * MVP 검증 → 수정·보완 지시문 생성기. 04 생성기(buildAllInOnePrompt)와는 별도
 * 출력이며, 04 본문·모델·planSummary·HITL 적용 로직을 바꾸지 않는다. 모델은
 * buildAgentInstructionModel()로 읽기 전용으로만 재사용해 04와 동일한 범위·
 * 기준·보류·제외·승인 경계 판정을 얻는다. 입력은 모두 사용자 제공 검증 결과다:
 * WorkLens가 구현 코드나 실행 로그에 접근하지 못하므로, 지시문은 "사용자 제공
 * 결과"와 "코딩 에이전트가 실제 코드·실행 결과로 직접 확인해야 할 사항"을
 * 문장으로 구분한다. 날짜·라운드 구분은 호출 측이 넘긴 보고 일시로만 표시하고,
 * 코드 변경 이력은 Git에 위임한다 (WorkLens 내부 형상관리 없음).
 */
export interface AxVerificationFailure {
  /** 실패 기능명. 원본 범위의 단계명과 같은 표기를 권장한다. */
  feature: string;
  /** 기대 결과 (사용자 제공). 없으면 "사용자 제공 없음"으로 명시한다. */
  expected?: string;
  /** 실제 결과 (사용자 제공). */
  actual?: string;
  /** 오류 내용. 개인정보·키·토큰은 입력 단계에서 [REDACTED]로 가린 필요 부분만 받는다. */
  error?: string;
  /** 재현 절차 (사용자 제공). */
  reproduction?: string;
}
export interface AxVerificationInput {
  /** 이번 라운드의 실패 항목. 빈 배열이면 지시문 대신 안내 문구를 반환한다. */
  failures: AxVerificationFailure[];
  /** 유지해야 할 정상 기능 (사용자 지정). */
  keptFeatures?: string[];
  /** 현재 구현 프로그램의 목적·코드·버전 등 사용자 제공 구현 정보. */
  implementationNote?: string;
  /** 검증 환경 (예: 로컬·스테이징·운영 주소). 선택 필드이며, 검증 라운드 스키마의 environment와 같은 값이다. */
  environment?: string;
  /** 적용된 업무 규칙 (사용자 제공). */
  rulesNote?: string;
  /** 사용자 확인이 필요한 미확정 업무 규칙 목록. 임의 확정하지 않는다. */
  unconfirmedRules?: string[];
  /** 테스트 실행 자체가 실패한 경우 그 사유 (환경 문제와 기능 오류 구분용). */
  testRunFailure?: string;
  /** 이번 라운드 보고 일시 (라운드 구분용). 생성기가 현재 시각을 만들지 않는다. */
  reportedAt?: string;
  /** 이전 라운드 보고 일시 (있으면 함께 표시한다). */
  previousReportedAt?: string;
  /** 이전 라운드에 보고됐던 실패 기능명 목록. 이번 라운드와 겹치면 반복 실패 확인 대상으로 표시한다. */
  previousFailureNames?: string[];
}
export interface AxFixPromptOptions {
  taskName?: string;
  prerequisites?: string[];
  diagnosis?: AxDiagnosis;
  context?: string;
  hitlReviews?: import("./types").HitlReview[];
  hitlTool?: "codex" | "claude";
  genericRules?: GenericRule[];
}
export function buildFixPrompt(rawPlan: AxPlan | undefined, options: AxFixPromptOptions = {}, input: AxVerificationInput): string {
  const model = buildAgentInstructionModel(rawPlan, options);
  const title = `# ${(options.taskName?.trim() || "업무")} 수정·보완 지시문`;
  const gate = model.gate;
  if (gate === "blocked") {
    const reasons = options.diagnosis ? gateBlockReasons(options.diagnosis) : ["Decision Gate에서 진행 불가(no-go)로 판정되었습니다."];
    return `${title}\n\n현재 진단에서는 구현 계획 생성이 차단되어 수정·보완 지시문을 만들 수 없습니다. 차단 사유가 해결된 뒤 다시 생성하세요.\n\n차단 사유:\n${reasons.map(reason => `- ${reason}`).join("\n")}`;
  }
  const failures = input.failures.filter(failure => failure.feature.trim());
  if (!failures.length) {
    return `${title}\n\n수정 대상이 없습니다. 검증 결과에서 실패한 기능을 먼저 기록한 뒤 다시 생성하세요. 실패 항목이 없으면 수정 지시문 대신 검증 결과를 그대로 보관하세요.`;
  }
  const norm = (value: string) => value.replace(/\s+/gu, "");
  const matches = (a: string, b: string) => {
    const na = norm(a), nb = norm(b);
    return Boolean(na && nb && (na === nb || na.includes(nb) || nb.includes(na)));
  };
  const excludedNames = [
    ...(model.hitlDetails?.excluded.map(entry => entry.name) ?? []),
    ...model.classified.filter(item => item.role === "excluded").map(item => item.text),
  ];
  const deferredNames = [
    ...(model.hitlDetails?.deferred.map(entry => entry.name) ?? []),
    ...(model.hitlDetails?.removedSteps?.filter(step => step.action === "defer").map(step => step.step) ?? []),
  ];
  const deferredDetails = model.hitlDetails?.deferred ?? [];
  type ClassifiedFailure = { failure: AxVerificationFailure; kind: "target" | "excluded" | "deferred" | "human" | "future"; step?: string; scopeNote: string };
  const classified: ClassifiedFailure[] = failures.map(failure => {
    const step = model.steps.find(item => matches(item.step, failure.feature));
    const stepDisposition = hitlDispositionForStep(model, failure.feature);
    const textDisposition = hitlDispositionForText(model, failure.feature);
    if (stepDisposition?.action === "exclude" || textDisposition?.action === "exclude" || excludedNames.some(name => matches(name, failure.feature))) {
      return { failure, kind: "excluded", step: step?.step, scopeNote: "제외 항목 — 현재 구현 범위에서 제외된 항목이므로 수정 대상이 아닙니다." };
    }
    if (stepDisposition?.action === "defer" || textDisposition?.action === "defer" || deferredNames.some(name => matches(name, failure.feature))) {
      return { failure, kind: "deferred", step: step?.step, scopeNote: "보류 항목 — 보류 사유와 재개 조건이 확인되기 전에는 수정 대상이 아닙니다." };
    }
    if (step?.scope === "human") return { failure, kind: "human", step: step.step, scopeNote: "사용자 수행 단계 — 프로그램 수정 대상이 아니라 사용자가 직접 수행하는 단계입니다." };
    if (step?.scope === "future") return { failure, kind: "future", step: step.step, scopeNote: "향후 단계 — 현재 구현 범위가 아니므로 수정 대상이 아닙니다." };
    return { failure, kind: "target", step: step?.step, scopeNote: step ? `원본 범위 단계: ${step.step}` : "원본 범위에서 확인되지 않은 항목 — 실제 구현에서 해당 기능의 존재 여부를 먼저 확인하고, 없으면 수정 대상에서 제외하고 보고하세요." };
  });
  const targets = classified.filter(entry => entry.kind === "target");
  const notTargets = classified.filter(entry => entry.kind !== "target");
  const previousNames = (input.previousFailureNames ?? []).filter(name => name.trim());
  const userKept = (input.keptFeatures ?? []).map(name => name.trim()).filter(Boolean);
  const modelKept = model.scoped.features.map(item => item.text)
    .filter(text => !failures.some(failure => matches(text, failure.feature)))
    .filter((text, index, all) => all.findIndex(other => norm(other) === norm(text)) === index);
  const kept = [...userKept, ...modelKept.filter(text => !userKept.some(keptName => matches(keptName, text)))];
  const criteriaFor = (entry: ClassifiedFailure) => entry.step
    ? model.scoped.criteria.filter(item => item.step === entry.step).map(item => item.text)
    : [];
  const targetLines = targets.map(entry => {
    const { failure } = entry;
    const given = (value: string | undefined) => value?.trim() ? value.trim() : "사용자 제공 없음 — 에이전트가 직접 재현·확인";
    const repeat = previousNames.some(name => matches(name, failure.feature));
    const criteria = criteriaFor(entry);
    return [
      `- ${failure.feature} (${entry.scopeNote})`,
      `  사용자 보고 — 기대 결과: ${given(failure.expected)}`,
      `  사용자 보고 — 실제 결과: ${given(failure.actual)}`,
      `  사용자 보고 — 오류: ${given(failure.error)}`,
      `  사용자 보고 — 재현 절차: ${given(failure.reproduction)}`,
      `  에이전트 확인 사항: ${criteria.length ? `이 기능의 완료 기준에 대조해 실제 실행 결과로 확인하세요 — ${criteria.join(" / ")}` : "이 기능의 단계별 완료 기준과 실패 판정 기준에 대조해 실제 실행 결과로 확인하세요."}`,
      ...(previousNames.length ? [repeat
        ? "  반복 실패 확인 대상: 이전 라운드에도 보고된 문제입니다. 동일 원인이 반복되는지 확인하고, 이전 수정이 왜 유지되지 않았는지 보고하세요."
        : "  신규 실패: 이전 라운드에 없던 문제입니다. 이전 라운드 항목과 별도로 구분해 보고하세요."] : []),
    ].join("\n");
  });
  const sections: Array<{ title: string; body: string }> = [];
  const bullets = (items: string[]) => items.map(item => `- ${item}`).join("\n");
  const nonEmpty = (value: string | undefined) => value?.trim() ? value.trim() : undefined;
  sections.push({
    title: "전제 — 사용자 제공 결과와 에이전트 확인 사항의 구분",
    body: [
      "아래 '검증 결과(사용자 제공)'는 사용자가 실제 실행에서 확인해 전달한 내용이며, WorkLens가 구현 코드나 실행 로그에 직접 접근해 검증한 것이 아닙니다.",
      "코딩 에이전트는 이를 단서로 삼아 실제 코드와 실행 결과로 직접 확인하고, 사용자 제공 내용과 다르면 실제 실행 결과를 우선해 보고하세요.",
      "사용자 제공 내용이 없는 항목은 '사용자 제공 없음 — 직접 재현·확인'으로 명시했습니다. 없는 정보를 꾸며내지 마세요.",
      ...(input.reportedAt ? [`이번 라운드 보고 일시: ${input.reportedAt}`] : []),
      ...(input.previousReportedAt ? [`이전 라운드 보고 일시: ${input.previousReportedAt}`] : []),
      ...(previousNames.length ? [`이전 라운드 보고 항목: ${previousNames.join(" / ")} — 이번 라운드 수정 대상에 없는 이전 항목은 불필요하게 다시 수정하지 마세요.`] : []),
      `현재 구현 프로그램: ${nonEmpty(input.implementationNote) ?? "사용자 제공 없음 — 저장소에서 구현 상태와 코드 버전을 직접 확인하세요."}`,
      ...(nonEmpty(input.environment) ? [`검증 환경: ${nonEmpty(input.environment)}`] : []),
      `적용된 업무 규칙: ${nonEmpty(input.rulesNote) ?? "사용자 제공 없음 — 04 지시문의 구현 범위와 확정 규칙에서 확인하세요."}`,
    ].join("\n"),
  });
  sections.push({
    title: "기존 구현 확인",
    body: [
      "대상 저장소를 먼저 확인하세요. 현재 구현 상태, 적용된 코드 버전, 실행 환경, 오류가 발생한 경로를 실제 저장소와 실행 결과로 확인하세요.",
      "확인되지 않은 파일명·함수명·API를 추측하지 마세요. 저장소에서 확인할 수 없는 사항은 확인 필요로 보고하세요.",
      "오류 전달 시 개인정보·API Key·Token·Password는 [REDACTED]로 가린 필요한 부분만 다루고, 로그 전체를 무조건 복사하지 마세요 (STEP 04 '실패 시' 원칙).",
    ].join("\n"),
  });
  sections.push({
    title: "수정 대상",
    body: targets.length
      ? targetLines.join("\n")
      : "이번 라운드에서 수정할 수 있는 대상이 없습니다. 아래 '수정 대상 아님' 항목만 보고됐으므로, 보류·제외·사용자 수행·향후 항목을 임의로 구현하지 마세요.",
  });
  if (notTargets.length) {
    sections.push({
      title: "수정 대상 아님 — 건드리지 말 것",
      body: notTargets.map(entry => {
        const detail = entry.kind === "deferred"
          ? deferredDetails.find(item => matches(item.name, entry.failure.feature))
          : undefined;
        return `- ${entry.failure.feature} (${entry.scopeNote})${detail?.reason ? ` 보류 사유: ${detail.reason}` : ""}${detail?.resumeCondition ? ` 재개 조건: ${detail.resumeCondition}` : ""}`;
      }).join("\n"),
    });
  }
  sections.push({
    title: "오류 원인 분석",
    body: [
      "각 수정 대상의 재현 절차와 실제 실행 결과로 원인을 분석하세요. 재현 가능한 근거가 없는 상태에서 특정 파일·함수·코드가 문제라고 단정하지 마세요.",
      "원인이 확인되지 않았다면 원인 미확인으로 보고하고, 추측한 원인을 확정된 원인처럼 적지 마세요.",
      ...(targets.some(entry => !entry.failure.error?.trim())
        ? ["오류 내용이 제공되지 않은 항목이 있습니다. 확인 사실과 미확정 원인을 구분해 보고하고, 실행 결과를 직접 재현해 확인하세요. 실행 결과를 창작하지 마세요."]
        : []),
    ].join("\n"),
  });
  const unconfirmed = (input.unconfirmedRules ?? []).map(rule => rule.trim()).filter(Boolean);
  sections.push({
    title: "최소 범위 수정",
    body: [
      "기존 구조를 유지하고, 확인된 부분만 최소 범위로 수정하세요.",
      "프로그램 전체를 처음부터 다시 작성하지 마세요.",
      "사용자가 확정하지 않은 업무 규칙을 새로 만들지 마세요.",
      ...(unconfirmed.length ? [`사용자 확인 필요 항목(미확정 업무 규칙): ${unconfirmed.join(" / ")} — 이 항목들은 임의로 확정하지 말고 사용자 확인을 받아야 합니다.`] : []),
      "테스트 통과를 위해 기대 결과를 하드코딩하지 마세요.",
      "보류·제외 항목을 임의로 구현하지 마세요.",
      "기존 정상 기능을 불필요하게 수정하지 마세요.",
    ].join("\n"),
  });
  sections.push({
    title: "유지할 정상 기능 — 수정하지 말고 회귀만 확인",
    body: kept.length
      ? bullets(kept.map(name => `${name} — 이 기능은 수정하지 마세요. 재검증에서 이전과 동일하게 동작하는지만 확인하세요.`))
      : "사용자가 지정한 유지 기능이 없고, 원본 범위에서 실패 목록에 없는 기능이 확인되지 않았습니다. 수정 범위를 넓히지 말고 수정 대상만 다루세요.",
  });
  sections.push({
    title: "실제 기능 재검증",
    body: [
      "수정 후에는 다음 항목을 모두 확인하고, 각 항목을 해결 확인 / 일부 해결 / 미해결 / 미검증으로 구분해 보고하세요.",
      "1. 이전 실패 항목이 해결됐는지 — 같은 실패 사례를 다시 실행해 기대 결과와 비교하세요.",
      "2. 동일 입력에서 기대 결과가 나오는지 확인하세요.",
      "3. 변경된 입력에서도 기존 업무 규칙을 준수하는지 확인하세요.",
      "4. 기존 정상 기능이 유지되는지 확인하세요.",
      "5. 신규 오류가 없는지 확인하세요.",
      "6. 미구현·미검증 항목이 남아 있는지 확인하세요.",
      "수정 전 실패 항목이 통과했더라도, 유지할 정상 기능의 회귀 확인이 끝나기 전에는 완료로 보고하지 마세요.",
      "실행 증거 없이 해결 완료로 판정하지 마세요. 실행하지 않은 테스트는 미검증으로 표시하세요.",
      "HTTP 200 응답이나 빌드 성공만으로 업무 기능이 통과했다고 표시하지 마세요.",
    ].join("\n"),
  });
  sections.push({
    title: "회귀 검증",
    body: [
      "수정으로 인한 신규 오류가 있는지 관련 정상 기능을 다시 검증하세요.",
      "회귀 오류가 발생하면 해결 완료로 판정하지 마세요. 회귀 오류의 원인과 범위를 별도로 보고하세요.",
      "이전 라운드에서 해결된 문제는 불필요하게 다시 수정하지 마세요. 새로 발견된 문제는 별도로 구분하고, 최초 구현 결과와 수정 후 결과를 혼동하지 마세요.",
      "동일 문제가 반복 실패하는지 확인하세요. 같은 수정을 무한히 반복하지 마세요. 반복 실패 시 원인을 다시 분석해 보고하고 사용자 확인을 받으세요.",
    ].join("\n"),
  });
  sections.push({
    title: "결과 보고",
    body: [
      "작업이 끝나면 다음 4개 항목으로 보고하세요. 각 항목의 완료 여부는 실제 실행 근거를 기준으로 판단하고, 실행하지 않은 테스트나 배포를 완료로 표시하지 마세요.",
      "1. 구현한 기능 및 변경 파일",
      "2. 실제 실행·테스트 결과 (실행하지 않은 검증은 미실행으로 명시)",
      "3. 미완료·보류 사항 및 사유",
      "4. Git·배포·운영 적용 상태",
      "실패 결과를 숨기거나 완료 표시로 바꾸지 마세요. 남은 문제는 남은 문제대로 구분해 보고하세요.",
      "작업 전후로 `git status`, 현재 branch, `git diff`를 확인하고, 의도한 파일만 `git add <파일>`로 stage하세요 (`git add .` 금지). force push, `git reset --hard` 같은 파괴적인 명령을 사용하지 마세요.",
    ].join("\n"),
  });
  const approvalLines = approvalConstraints(model);
  const supplements = model.hitlDetails?.supplements ?? [];
  const points = model.decisionPoints ?? [];
  const stateNames = confirmedStateNames(points);
  const d5Invalid = isUndecidableStateInvalid(points);
  const d5State = stateNames && !d5Invalid ? validatedUndecidableState(points) : null;
  sections.push({
    title: "예외 처리와 승인 경계",
    body: [
      ...(input.testRunFailure?.trim() ? [`테스트 실행 실패 보고: ${input.testRunFailure.trim()} — 환경 문제와 기능 오류를 구분하세요. 환경 문제가 해결되지 않은 상태에서는 기능 오류로 단정하지 마세요.`] : []),
      "검증 자료가 부족한 항목은 확인 사실과 미확정 원인을 구분해 보고하고, AI가 실행 결과를 창작하지 마세요.",
      "업무 규칙이 미확정인 항목은 사용자 확인 필요 항목으로 분류하고 임의로 확정하지 마세요.",
      "코드 접근이 불가한 경우 구체적인 코드 수정이 완료됐다고 주장하지 마세요. 저장소에서 확인할 사항을 포함해 보고하세요.",
      "수정으로 새로운 오류가 발생하면 관련 정상 기능을 다시 검증하고, 회귀 오류가 있는 상태에서는 해결 완료로 판정하지 마세요.",
      ...(stateNames ? [`확정 결과 상태 목록(D4): ${stateNames.join(" · ")}`] : []),
      ...(d5Invalid ? ["D5에 적힌 판정 불가 상태명은 D4 확정 목록에 없는 상태명이므로 유효하지 않습니다. 미확정 규칙 행을 해당 상태로 임의 전송하지 말고, 판정 불가 행은 보류로 두고 사유와 함께 보고하세요."] : []),
      ...(d5State ? [`판정 불가 행은 D5 확정 상태 '${d5State}'로 보내세요. 확정 가능 행까지 해당 상태로 보내는 구현은 완료가 아닙니다.`] : []),
      ...(supplements.length ? [`사람 검토 보완 요구사항: ${supplements.map(item => `${item.name} — ${item.content}`).join(" / ")}`] : []),
      ...(approvalLines.length ? [`승인 경계: ${approvalLines.join(" / ")}`] : []),
      ...(model.hitlDetails?.deferred.length ? [`보류 항목: ${model.hitlDetails.deferred.map(item => `${item.name}${item.reason ? ` (사유: ${item.reason})` : ""}${item.resumeCondition ? ` (재개 조건: ${item.resumeCondition})` : ""}`).join(" / ")} — 보류 항목을 임의로 구현하지 마세요.`] : []),
      ...(model.hitlDetails?.excluded.length ? [`제외 항목: ${model.hitlDetails.excluded.map(item => item.name).join(" / ")} — 제외 항목을 임의로 구현하지 마세요.`] : []),
      "AI 테스트 통과와 사용자 최종 승인은 다릅니다. 구현 / AI 검증 완료 / 사용자 검토 / 최종 승인 / 실제 업무 운영 적용은 별개의 단계입니다.",
      "업무 규칙 확정, 보류·제외 변경, 운영 배포 승인, 실제 업무 적용 승인은 사용자가 수행하며, AI가 대신 확정·승인하지 마세요.",
      "1차 MVP나 일부 검증 성공을 운영 가능 상태로 자동 변경하지 마세요. 사용자 승인 없이 운영 배포하지 마세요.",
    ].join("\n"),
  });
  const body = sections.filter(section => section.body.trim()).map((section, index) => `## ${index + 1}. ${section.title}\n\n${section.body}`).join("\n\n");
  return `${title}\n\n${body}`;
}

/**
 * P1 — 올인원 지시문 + 전달 완전성 검사 래퍼.
 * buildAllInOnePrompt의 본문은 그대로 반환하고, 동일 입력으로 모델을 다시
 * 구성해 확정·미확정·적용 여부 미확정·해당 없음 규칙과 HITL 보류·제외
 * 이름을 checkPromptRuleDelivery에 넘긴다. 본문 텍스트는 변경하지 않는다.
 */
export interface AllInOnePromptDelivery {
  prompt: string;
  delivery: PromptDeliveryReport;
}
export function checkAllInOnePromptDelivery(rawPlan: AxPlan | undefined, tool: AxToolId, options: PromptOptions = {}): AllInOnePromptDelivery {
  const prompt = buildAllInOnePrompt(rawPlan, tool, options);
  const model = buildAgentInstructionModel(rawPlan, options);
  const rules = resolveGenericRules(model.genericRules);
  const hitl = model.hitlDetails;
  const delivery = checkPromptRuleDelivery(prompt, {
    confirmed: confirmedGenericRules(rules),
    pending: pendingGenericRules(rules),
    applicabilityPending: applicabilityPendingGenericRules(rules),
    notApplicable: rules.filter(rule => rule.applicability === "해당 없음"),
    hitlDeferredNames: unique([...(hitl?.deferred.map(entry => entry.name) ?? []), ...(hitl?.deferredStepNames ?? [])]),
    hitlExcludedNames: unique([...(hitl?.excluded.map(entry => entry.name) ?? []), ...(hitl?.excludedStepNames ?? [])]),
  });
  return { prompt, delivery };
}
