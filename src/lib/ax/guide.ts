import type { AxDiagnosis, AxPlan } from "./types";
import { automationLevel, axes, executionProfile, type ExecutionGate, type ExecutionProfile, type StepScope } from "./policy";
import { FACTOR_KEYS } from "./schema";
import { extractPlanReviewableItems, extractReviewableItems, getValidConfirmedReviews, buildPlanReviewKeyMap } from "./hitl";

export type AxToolId = "codex" | "claude";

export const TOOL_GUIDES: Record<AxToolId, {
  name: string; versionCommand: string; installCommand: string; runCommand: string; doctorCommand: string; loginNote: string;
}> = {
  codex: { name: "Codex", versionCommand: "codex --version", installCommand: 'powershell -ExecutionPolicy ByPass -c "irm https://chatgpt.com/codex/install.ps1 | iex"', runCommand: "codex", doctorCommand: "codex --help", loginNote: "첫 실행 시 ChatGPT 로그인 등 사용 가능한 인증 방식을 선택" },
  claude: { name: "Claude Code", versionCommand: "claude --version", installCommand: "irm https://claude.ai/install.ps1 | iex", runCommand: "claude", doctorCommand: "claude doctor", loginNote: "첫 실행 시 계정 인증 안내를 따릅니다" },
};

/** Inline text marks commands with backticks; `code` blocks default to PowerShell unless labeled as examples. */
export type AxGuideBlock = { kind: "text"; text: string } | { kind: "code"; lines: string[]; notes?: string[]; label?: "PowerShell" | ".gitignore" | "예시"; singleLine?: boolean } | { kind: "steps"; items: string[] } | { kind: "table"; headers: string[]; rows: string[][] };
export interface AxGuideSection { title: string; when?: string; collapsed?: boolean; listStyle?: "bullets"; brand?: "vercel" | "cloudflare"; blocks: AxGuideBlock[] }
export interface AxGuideStep { title: string; purpose: string; sections: AxGuideSection[] }

const text = (value: string): AxGuideBlock => ({ kind: "text", text: value });
const code = (lines: string[], notes: string[], label?: Extract<AxGuideBlock, { kind: "code" }>["label"]): AxGuideBlock => ({ kind: "code", lines, notes, ...(label ? { label } : {}) });

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
    { title: "시작하기 전에 · 전체 흐름", purpose: "업무·진단·담당자 검토 → 구현·테스트 → 배포 → 실제 기능 확인", sections: [
      { title: "처음 시작할 때", blocks: [
        text(`Windows 11 PowerShell 5.1 기준입니다. STEP 01에서 필요한 설치만 확인하세요. 이미 설치된 것은 건너뜁니다. ${guide.name} 하나면 충분하며, 원하면 Codex·Claude Code 둘 다 사용할 수 있습니다.`),
      ] },
      { title: "이후 작업할 때", blocks: [
        text("STEP 02부터 시작하고 설치를 반복하지 않습니다. 실제 업무와 승인·금지 범위를 확인한 후 구현합니다. 웹 배포가 필요 없는 업무는 실행·납품·운영 확인으로 완료할 수 있습니다."),
      ] },
      { title: "용어 알아보기", collapsed: true, blocks: [{ kind: "steps", items: [
        "저장소/클론: GitHub의 프로젝트 파일·이력 / 로컬 PC로 복제",
        "브랜치/PR/CI: 변경 갈래 / 검토 요청 / 자동 검사",
        "Preview/Production: 미리보기 / 사용자가 사용하는 운영 환경",
        "HITL: AI 제안을 사람이 검토·수정·승인하는 단계",
        "Secret: Git이나 로그에 공개해서는 안 되는 인증 키·비밀번호",
        "PASS/FAIL/NOT_RUN/BLOCKED: 통과 / 실패 / 미실행 / 조건 미충족으로 차단",
      ] }] },
    ] },
    { title: "STEP 01 · 개발 환경 준비", purpose: "Git·필요한 Node.js·선택적 gh·선택한 코딩 에이전트 설치와 확인", sections: [
      { title: "현재 설치 여부", blocks: [
        text("Git은 코드 이력 관리에 필수, Node.js/npm은 프로젝트의 Node 도구 사용 시 필요, GitHub CLI(gh)는 GitHub 로그인·PR에 편리하지만 선택 사항입니다. 아래에서 사용하는 프로그램만 확인하고 버전이 나오면 해당 설치를 건너뜁니다."),
        code(["git --version", "node --version", "npm --version", "gh --version", guide.versionCommand], []),
      ] },
      { title: "Git 설치", when: "git --version이 실패한 경우에만", blocks: [
        text("공식 Git for Windows 최신 릴리스의 x64/arm64 설치 파일 하나를 선택하고 API의 SHA-256 digest와 실제 파일 해시를 대조한 뒤 설치합니다. 한 줄 전체를 복사하세요. 설치 창을 끝까지 완료하고 새 PowerShell을 여세요."),
        installCode([gitInstall], []),
        code(["git --version"], ["설치 후 새 PowerShell에서 실행. 실패하면 설치를 성공으로 간주하지 마세요."]),
        text("출처: https://git-scm.com/downloads/win · https://github.com/git-for-windows/git/releases/latest"),
      ] },
      { title: "Node.js LTS 설치", when: "프로젝트가 Node.js를 요구하고 호환 버전이 없을 때만", blocks: [
        text("package.json engines, .nvmrc, .node-version의 버전 요구가 일반 LTS보다 우선합니다. 충돌하면 명령을 실행하지 말고 요구 버전을 공식 배포 목록에서 확인하세요. 명시된 요구가 없을 때 공식 목록에서 최신 호환 LTS 하나만 고릅니다. MSI 파일이 해당 릴리스에 없거나 HTTP 오류라면 즉시 멈춥니다."),
        installCode([nodeInstall], []),
        code(["node --version", "npm --version"], ["설치 후 새 PowerShell에서 실행. MSI가 재시작을 요청했다면 먼저 재시작합니다."]),
        text("출처: https://nodejs.org/en/download · https://nodejs.org/dist/index.json"),
      ] },
      { title: "GitHub CLI 설치", when: "gh를 사용하고 gh --version이 실패할 때만", blocks: [
        text("GitHub 공식 릴리스에서 x64/arm64 Windows MSI 하나를 고르고 SHA-256을 확인합니다. 기존 Git 인증/웹 작업이 정상이면 설치를 생략하세요."),
        installCode([ghInstall], []),
        code(["gh --version"], ["설치 후 새 PowerShell에서 실행. 재시작을 요청했다면 먼저 재시작합니다."]),
        text("출처: https://github.com/cli/cli/releases/latest · https://cli.github.com/manual/gh_auth_login"),
      ] },
      { title: `${guide.name} 설치`, when: `${guide.versionCommand}이 실패할 때만`, blocks: [
        text(`${guide.name}은 선택한 코딩 에이전트입니다. 공식 네이티브 설치 스크립트의 출처와 내용을 먼저 확인하세요. 다른 에이전트까지 설치할 필요는 없습니다.`),
        installCode([guide.installCommand], []),
        code([guide.versionCommand], ["새 PowerShell에서 버전을 확인하세요."]),
        ...(tool === "codex" ? [text("Node/npm이 이미 필요해 설치되어 있다면 네이티브 설치 대신 `npm install -g @openai/codex`를 사용할 수 있습니다. 둘을 동시에 설치하지 마세요. 출처: https://learn.chatgpt.com/docs/codex/cli")] : [text("출처: https://code.claude.com/docs/en/setup")]),
      ] },
      { title: "Git 정보·로그인", when: "첫 커밋이나 GitHub 인증이 필요할 때만", blocks: [
        code(["git config user.name", "git config user.email"], ["비어 있을 때만 실제 이름·이메일을 아래 명령으로 설정합니다."]),
        code(['git config --global user.name "본인 이름"', 'git config --global user.email "me@example.com"'], ["이미 설정된 값은 덮어쓰지 않습니다."]),
        code(["gh auth status", "gh auth login"], ["gh 설치 시에만 인증 상태를 확인하고 미인증이면 로그인하세요. gh 없이 기존 GitHub 인증 방식을 사용해도 됩니다."]),
        code([guide.runCommand], [guide.loginNote, "GitHub 로그인과 코딩 에이전트 로그인은 별개입니다."]),
      ] },
      { title: "설치 오류 확인", collapsed: true, blocks: [
        text(`네트워크·권한·아키텍처·SHA-256·종료 코드를 확인하고 파일/버전 확인 실패 시 중단하세요. 기존 임시 파일을 실패한 다운로드의 대안으로 실행하지 않습니다. ${tool === "codex" ? "Codex의 지원 명령은" : "Claude의 설치 진단은"} \`${guide.doctorCommand}\`으로 확인할 수 있습니다. 해당 도구의 공식 설치 문서를 우선합니다.`),
      ] },
    ] },
    { title: "STEP 02 · 프로젝트 준비", purpose: "GitHub 클론 / 기존 로컬 프로젝트 / 새 프로젝트 중 하나", sections: [
      { title: "A. GitHub에 있는 기존 프로젝트", when: "PC에 아직 없는 경우", blocks: [
        code(['mkdir "C:\\Work"', 'cd "C:\\Work"', 'git clone "https://github.com/owner/repository.git"', 'cd "C:\\Work\\repository"', "git status"], ["URL·폴더명은 실제 값으로 바꾸세요. 이미 폴더가 있으면 mkdir을 건너뛰고 저장소를 중복 클론하지 마세요."]),
      ] },
      { title: "B. PC에 이미 있는 프로젝트", when: "PC에 프로젝트 폴더가 있는 경우", blocks: [
        code(['cd "C:\\Work\\repository"', "git status", "git branch --show-current", "git remote -v"], ["실제 경로·브랜치·원격 저장소를 확인하세요."]),
        text("미커밋 변경이 있으면 git pull을 실행하지 말고 AI 도구에 현재 상태를 먼저 확인시킵니다. 기존 파일·설정·데이터를 보존합니다."),
      ] },
      { title: "C. 새 프로젝트", when: "새 폴더에서 시작하는 경우", blocks: [
        code(['mkdir "C:\\Work\\MyProject"', 'cd "C:\\Work\\MyProject"'], ["예시 경로를 실제 값으로 바꾸세요. 폴더가 이미 있으면 먼저 내용을 확인하고 mkdir은 건너뜁니다."]),
        text("특정 프레임워크를 임의로 정하지 않습니다. Git 저장 전 Git 저장소인지, remote가 연결됐는지, 대상 GitHub 저장소가 맞는지 확인합니다. Git 저장소가 아닌 경우에만 초기화하고 기존 저장소를 재초기화하거나 기존 remote를 덮어쓰지 않습니다. branch 이름을 main으로 강제하지 않습니다."),
        code(["git init", 'git remote add origin "https://github.com/owner/repository.git"', "git remote -v"], ["git init은 저장소가 아닐 때만, remote add는 저장소를 만들고 remote가 없을 때만 실행합니다. 원격에 초기 커밋이 있으면 먼저 이력을 확인하고 충돌 없이 연결합니다. 첫 push 전에 대상 원격을 다시 확인하세요."]),
      ] },
    ] },
    { title: "STEP 03 · 올인원 지시문 준비", purpose: "WorkLens의 업무·진단·HITL 판단을 지시문에 연결", sections: [
      { title: "WorkLens에서 확인", blocks: [
        text("WorkLens에서 올인원 지시문을 복사해 Codex 또는 Claude Code에 전달하세요. 이 지시문을 이용해 실제 프로그램을 만드는 과정이 1차 MVP 구현입니다."),
        text("업무 선택 → 진단과 판단 근거 확인 → 단계별 자동화 판단의 HITL 검토(유지·보류·제외·보완)와 확인된 기술 조건을 반영합니다. 보류·제외 항목을 AI가 임의로 구현하거나 승인하지 않습니다. 실제 화면의 ‘04 올인원 지시문’에서 Codex 또는 Claude Code를 선택하고 ‘전체 보기’로 확인한 뒤 ‘올인원 지시문 복사’를 누릅니다."),
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
      { title: "Cloudflare의 Wrangler", when: "프로젝트가 Wrangler를 실제 사용하는 경우만", collapsed: true, blocks: [
        text("기존 packageManager·lockfile·Wrangler 버전·스크립트를 유지합니다. 새 npm Cloudflare 프로젝트에 Wrangler CLI가 필요하고 없을 때에만 다음 명령으로 로컬 devDependency에 설치합니다. 기존 Pages/Git 자동 배포에 CLI를 추가하지 않습니다."),
        code(["npm i -D wrangler@latest", "npx wrangler --version"], ["새 npm Cloudflare 프로젝트에만 적용; 다른 매니저·기존 프로젝트에는 해당 설정을 우선합니다."]),
        text("출처: https://developers.cloudflare.com/workers/wrangler/install-and-update/"),
      ] },
      { title: "요금·정책 확인", collapsed: true, blocks: [
        text("Vercel Hobby의 개인·비상업적 용도 및 월별 Function·트래픽 한도를 검토하세요. Cloudflare Workers Free의 일별 요청·CPU 제한과 D1/KV 일별 작업 제한, R2의 저장·작업 무료 제공량 초과 시 결제 조건은 각각 다릅니다. 한도 초과 방식과 리소스 생성 권한을 확인한 뒤 필요한 서비스만 선택하세요."),
        text("공식 정책: https://vercel.com/docs/plans/hobby · https://developers.cloudflare.com/workers/platform/pricing/ · https://developers.cloudflare.com/r2/pricing/"),
      ] },
    ] },
    { title: "STEP 06 · 데이터 저장 방식", purpose: "기존 데이터를 보호하고 꼭 필요한 서비스만 선택·연결", sections: [
      { title: "필요한 저장만 선택", blocks: [
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
      { title: "Cloudflare 저장소 연결", when: "D1·R2·KV 중 실제로 필요한 서비스가 있을 때만", collapsed: true, blocks: [
        text("Workers/Pages 환경, 계정 권한, 기존 리소스 ID, 개발/Preview/Production 구분, 기존 wrangler 설정을 먼저 확인합니다. 없을 때 새 리소스 생성 여부는 담당자 승인 후 결정합니다. 연결할 서비스의 binding을 기존 설정 파일의 해당 환경에만 추가하고 실제 저장·조회·권한·오류를 점검합니다."),
        text("민감 정보는 플랫폼 Secret에 보관하세요. 마이그레이션이나 운영 데이터 삭제·덮어쓰기·초기화는 자동으로 진행하지 않습니다. 백업과 복원 가능성을 확인하고 사용자 승인을 받아야 합니다."),
      ] },
      { title: "D1 · 구조화된 기록", when: "D1이 실제로 필요한 경우만", collapsed: true, blocks: [
        text("Cloudflare D1에서 기존 DB와 스키마·database_id를 확인하세요. 새 DB가 승인되고 꼭 필요할 때만 프로젝트의 기존 매니저로 공식 `wrangler d1 create`를 실행합니다. 기존 wrangler 구성의 d1_databases에 binding·database_name·database_id를 실제 리소스 값으로 설정하고 Worker의 env binding으로 연결합니다. 로컬과 운영 DB는 구분하고 마이그레이션은 별도 승인·백업·검증 후 적용합니다."),
        text("출처: https://developers.cloudflare.com/d1/get-started/ · https://developers.cloudflare.com/d1/worker-api/"),
      ] },
      { title: "R2 · 파일과 첨부", when: "R2가 실제로 필요한 경우만", collapsed: true, blocks: [
        text("R2 사용 전 계정 활성화·결제 조건을 확인합니다. 기존 bucket을 재사용하고 새 bucket이 승인되었을 때만 생성합니다. wrangler의 r2_buckets binding·bucket_name을 실제 값으로 설정한 뒤 업로드·조회와 미승인 접근 차단을 검증하세요. 비공개 파일을 임의로 공개하지 않습니다."),
        text("출처: https://developers.cloudflare.com/r2/api/workers/workers-api-usage/"),
      ] },
      { title: "KV · 조회 중심 값", when: "KV가 실제로 필요한 경우만", collapsed: true, blocks: [
        text("기존 namespace ID를 재사용하고 새 namespace가 승인되었을 때만 생성합니다. wrangler의 kv_namespaces binding·id를 연결하고 조회·변경·전파 지연을 검증합니다. 로컬 개발 데이터와 운영 데이터가 섞이지 않도록 확인합니다."),
        text("출처: https://developers.cloudflare.com/kv/concepts/kv-bindings/"),
      ] },
    ] },
    { title: "STEP 07 · GitHub 저장과 배포", purpose: "Secret 점검 → 정책에 맞는 commit/push → PR·CI → 실제 배포", sections: [
      { title: "안전하게 Git에 저장", blocks: [
        text(".gitignore를 덮어쓰지 말고 실제 스택에 필요한 규칙만 추가합니다. .env.example은 값 없이 변수 이름을 공유할 수 있습니다. 이미 추적 중인 Secret은 .gitignore만으로 보호되지 않습니다. AI 대화·터미널 로그·스크린샷에도 Secret을 붙여넣지 않습니다."),
        text("이미 노출된 키는 폐기 → 재발급 → 플랫폼 설정 교체 순서로 대응하고 기록 재작성은 자동 실행하지 않습니다."),
        code(["git status", "git diff", "git diff --cached --stat", "git branch --show-current", "git remote -v"], ["현재 브랜치·원격 대상·변경 파일·스테이지 내용을 확인합니다."]),
        code(['git add -- "src/changed-file.ts"', "git status", "git diff --cached", 'git commit -m "첫 MVP 구현과 검증"', "git push"], ["파일 경로는 실제 파일로 교체하고 예상한 파일만 추가합니다. Secret이나 관계없는 변경이면 커밋을 중단하세요."]),
      ] },
      { title: "PR·CI와 배포 경로", blocks: [
        text("PR·리뷰·CI·merge는 저장소 정책상 필요한 경우에만 진행합니다. CI 실패를 해결하고 Preview/Production 배포 브랜치와 버전을 확인하세요. git push는 곧 Production 배포가 아닙니다."),
        text("Vercel Git 연동 또는 Cloudflare Workers/Pages Git 자동 배포라면 수동 명령을 중복 실행하지 않습니다. CLI 방식이라면 현재 프로젝트의 실제 스크립트만 사용하고 모든 Cloudflare 앱에 wrangler deploy를 강제하지 않습니다. 플랫폼 Secret·환경변수는 Preview/Production을 구분합니다."),
        code(["현재 프로젝트의 변경 사항과 테스트 결과를 확인하고 GitHub 저장 및 배포를 준비해 줘. 기존 브랜치와 배포 방식을 유지하고, 민감 정보나 운영 데이터 변경이 있으면 먼저 알려줘."], ["코딩 에이전트에게 요청할 때 복사해서 사용하세요."]),
        text("실패 로그의 API Key·Token·Password·개인정보를 [REDACTED]로 가린 필요한 부분만 AI 도구에 전달하고 로그 전체를 무조건 복사하지 않습니다."),
      ] },
      { title: "운영 데이터 보호", when: "운영 DB/스토리지 변경이 필요한 경우만", collapsed: true, blocks: [
        text("기존 데이터·스키마·백업과 실제 복구 가능성을 먼저 확인합니다. 파괴적 마이그레이션·삭제·데이터 이전은 사전 승인 없이 실행하지 않습니다. 배포 롤백과 데이터 복원은 다르므로 실패 직후 무작정 반복 실행하지 마세요."),
      ] },
    ] },
    { title: "STEP 08 · 기능 검증과 MVP 완료", purpose: "웹은 Production 실동작, 비웹은 실행·납품 환경에서 실제 결과 확인", sections: [
      { title: "배포 후 실제 기능 확인", blocks: [
        text("프로그램을 만들거나 배포한 뒤 실제 데이터를 입력해 원하는 결과가 나오는지 확인합니다. 화면이 보이는 것만으로 기능이 완성된 것은 아닙니다."),
        text("웹 배포가 필요한 업무는 실제 Production URL, 버전·브랜치, Desktop/Mobile·첫 화면·직접 URL·Console을 확인하고 핵심 입력 → 처리 → 출력 흐름을 실행합니다. 로그인·API·환경변수·데이터 읽기/쓰기·권한은 사용하는 기능에 한해서만 실제 환경에서 검증합니다."),
        text("실제 업무 데이터를 입력해 처리 결과가 요구사항과 일치하는지 확인합니다. 잘못된 입력, 처리 실패 및 예외 상황도 검증하고, 데이터 저장 기능이 있다면 새로고침·재조회 후에도 필요한 데이터가 정상적으로 유지되는지 확인하세요."),
        code(["완성한 프로그램을 실제 사용 상황처럼 테스트해 줘. 정상 입력과 잘못된 입력을 확인하고, 저장 기능이 있다면 새로고침 후에도 데이터가 유지되는지 검증해 줘. 실제 실행한 결과와 미검증 항목을 구분해서 보고해 줘."], ["코딩 에이전트에게 요청할 때 복사해서 사용하세요."]),
        text("웹 배포가 필요 없는 CLI·Excel·로컬 자동화는 Production URL 대신 대상 사용자의 실행 환경·파일 입출력·오류·반복 실행을 검사하고 운영 적용 방법과 결과를 인계합니다."),
      ] },
      { title: "완료 판정", blocks: [
        text("요구사항 → WorkLens 진단/HITL 결정 → 올인원 지시문 → 실제 코드 → 테스트 결과 → 배포/운영 기능이 같은 범위인지 대조합니다. 구현 완료, 테스트 통과, 배포 완료, 운영 기능 확인을 각각 구분하세요. 각 기준에 PASS/FAIL/NOT_RUN/BLOCKED와 실행 환경·증거·실행 시각을 적고, 실행하지 않은 것은 PASS가 아닙니다."),
        text("FAIL은 수정 후 재검증·재배포하고 BLOCKED는 담당자·해제 조건을 기록합니다. 로그의 API Key·Token·Password·개인정보는 [REDACTED]로 가린 필요한 부분만 AI 도구에 전달하며 로그 전체를 무조건 복사하지 않습니다. 운영 장애는 승인된 롤백 방법과 데이터 영향을 먼저 확인하세요."),
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
/** Card tone for one technical check; `future` only when the check is explicitly linked to a step outside the current Level scope. */
export type AxCheckTone = "required" | "future" | "done" | "blocked";
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
  /** Prerequisites not already shown as a check card; blocked gates list block reasons as `current`. */
  conditions: { current: string[]; future: string[] };
  /** Existing structured human/exclusion fields, with their source retained. */
  constraints: string[];
  /** Constraints whose item is not already listed in `humanKept` or `excluded`. */
  approvals: string[];
  data: { label: string; items: string[] }[];
  tests: string[]; success: string[]; failure: string[]; exceptions: string[];
  /** Common notice when all tests share the same unconfirmed scope; individual prefixes are stripped. */
  testsNotice?: string;
  /** Common notice when all criteria share the same unconfirmed status; individual prefixes are stripped. */
  criteriaNotice?: string;
}

export function planSummary(diagnosis: AxDiagnosis, rawPlan?: AxPlan, context = ""): AxPlanSummary {
  const model = buildAgentInstructionModel(rawPlan, { diagnosis, context });
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
  const checks = technicalChecks.map(check => {
    const text = `${check.topic}${check.note ? ` — ${check.note}` : ""}`;
    const linked = model.classified.find(item => item.sources.includes("diagnosis.technicalChecks") && item.text === text);
    const tone: AxCheckTone = check.status === "확인됨" ? "done" : check.status === "불가" ? "blocked" : linked?.scope === "future" ? "future" : "required";
    return { topic: check.topic, status: check.status, note: check.note, tone };
  });
  const additionalChecks = buildAdditionalChecks(model, technicalChecks, checkTexts,
    new Set((model.gate === "blocked" ? profile?.blockReasons ?? [] : []).map(normalizedItem)));
  const excluded = mergeDistinct(restricted, without([
    ...(profile?.poc.outOfScope ?? []), ...model.classified.filter(item => item.role === "excluded").map(item => item.original ?? item.text),
  ], [...manualAutomation, ...humanKept]));
  const shownScope = new Set([...humanKept, ...excluded].map(normalizedItem));
  const pocTests = model.classified.filter(item => item.role === "tests");
  const criteria = (source: string) => unique(model.classified.filter(item => item.sources.includes(source) && !model.scoped.validationMethods.includes(item)).map(item => model.scoped.criteria.includes(item)
    ? item.text : `${item.scope === "future" ? "향후 판정" : "기준 확인 필요"}: ${item.text}`));
  return {
    include: unique((profile?.poc.inScope ?? []).flatMap(line => {
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
    ...completionCriteria(model, pocTests, criteria, diagnosis),
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
): Pick<AxPlanSummary, "tests" | "success" | "failure" | "exceptions" | "testsNotice" | "criteriaNotice"> {
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
  return {
    tests: dedupCriteria(tests),
    success: dedupCriteria(success),
    failure: dedupCriteria(failure),
    exceptions: dedupCriteria(unique([...(diagnosis.asIs?.exceptions ?? []), ...(diagnosis.risks ?? []), ...model.classified.filter(item => item.role === "exception").map(item => item.text)])),
    ...(testsNotice ? { testsNotice } : {}),
    ...(criteriaNotice ? { criteriaNotice } : {}),
  };
}

/** Comparative targets need an expected result before they can pass or fail. */
const VAGUE_CRITERION = /감소|증가|개선|단축|향상|최소화|최대화/u;
const SCOPE_TITLES = { implement: "이번 구현", "after-check": "확인 후 구현", verify: "검토·검증만" } as const;
const stripEnumerator = (item: string) => item.replace(/^\s*(?:\d+[.)]|[①-⑳])\s*/u, "").trim();
/** An explicit test label in a feature field marks a scenario, not a feature. */
const TEST_LABEL = /^(?:테스트(?:\s*시나리오)?|(?:정상|경계|경계값|실패|예외|오류)\s*(?:케이스|사례|시나리오)?)\s*:/u;
/** Level 1 never runs unattended; a proposal describing that method needs confirmation, not authorization. */
const UNATTENDED_METHOD = /(무인|자동\s*(?:생성|작성|실행|전송|발행|승인|확정|수집|계산))/u;
const REQUESTED = /(담당자 요청|담당자 확인 후|수동 요청|요청 시)/u;
const RULE_NOTE = /(규칙\s*기반|확정된 규칙|정해진 규칙|알고리즘|계산식(?:을|에 따라))/u;
const SCRIPT_NOTE = /(?:스크립트|프로그램|시스템).*(?:파일|데이터|자료).*(?:읽|병합|취합|추출)|(?:API|SDK)\s*(?:호출|연동)/iu;
const CANDIDATE_NOTE = /(?:AI(?:로|가|는|은|을|를|와|과)?(?:\s+\S+){0,3}?\s*(?:후보|초안|생성|모델|처리)|인공지능|언어\s*모델|LLM|(?:후보|초안)(?:\s*·\s*(?:후보|초안))?\s*(?:생성|제안|검토)|후보와 변환 결과)/iu;
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
  /** HITL 3차: 적용된 검토 상세 */
  hitlDetails?: {
    appliedReviews: Array<{ id: string; action: string; targetKey: string }>;
    deferred: Array<{ key: string; reason?: string; resumeCondition?: string }>;
    supplements: Array<{ key: string; content: string }>;
    /** Priority 5: 유효성 검증된 step-type exclude/defer 검토의 단계명 집합 (PoC 기준 demote용) */
    validatedExcludedStepNames?: string[];
  };
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
  const evidence = [
    ...(s.note ? [{ source: "diagnosis.stepAssessments.note", text: s.note }] : []),
    ...(diagnosis?.toBe ?? []).filter(item => normalizedStepText(item.step) === normalizedStepText(s.step))
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
    return "처리 방식 미확정 · 확인 후 진행\n처리 방식의 구체적 근거가 확인되지 않았습니다. 실제 처리 규칙·입력 형식을 먼저 확인하고, 확인 전에는 해당 처리만 보류하세요. 확인과 무관한 독립 단계는 계속 진행할 수 있습니다.";
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
export function stepIoSpec(model: AgentInstructionModel, index: number): StepIoSpec {
  const step = model.steps[index];
  if (!step) return { inputs: [], process: [], outputs: [], overallOutputs: [] };
  const d = model.diagnosis;
  const flowItems = model.classified.filter(item => item.role === "flow" && item.step === step.step);
  const featureItems = model.scoped.features.filter(item => item.step === step.step);
  const inputs = flowItems.length ? flowItems.map(item => item.text)
    : (d?.asIs?.inputs?.length ? d.asIs.inputs.map(text => `${text} (업무 전체 입력)`) : []);
  const methodIdx = model.steps.indexOf(step);
  const process = [
    ...(step.treatment ? [`처리 방식: ${step.treatment}`] : []),
    `판정: ${stepMethodLabel(model, methodIdx)}`,
    ...featureItems.map(item => `구현: ${item.text}`),
  ];
  const outputs = model.scoped.outputs.filter(item => item.step === step.step).map(item => item.text);
  // Overall PoC outputs are references, not permission to reintroduce a
  // future, human or HITL-excluded step into the current feature.
  const excludedStepNames = model.hitlDetails?.validatedExcludedStepNames ?? [];
  const pocOutputs = unique(model.classified.filter(item => item.role === "outputs"
    && item.sources.includes("diagnosis.poc.outputs") && !["future", "human", "excluded"].includes(item.scope)
    && !excludedStepNames.some(name => normalizedStepText(item.text).startsWith(`${normalizedStepText(name)} `)))
    .map(item => item.text));
  const stepKeywords = new Set(step.step.replace(/[^\uAC00-\uD7A3A-Za-z0-9]/gu, " ").split(/\s+/u).filter(w => w.length >= 2));
  // 2개 이상 핵심어 일치, 또는 3자 이상 핵심어 1개 일치가 필요 ("가격" 같은 일반 명사 1개만으로는 연결하지 않음).
  const relatedOutputs = !outputs.length ? pocOutputs.filter(out => {
    const outWords = out.replace(/[^\uAC00-\uD7A3A-Za-z0-9]/gu, " ").split(/\s+/u).filter(w => w.length >= 2);
    const overlap = outWords.filter(w => stepKeywords.has(w));
    return overlap.length >= 2 || overlap.some(w => w.length >= 3);
  }) : [];
  const overallOutputs = !outputs.length && !relatedOutputs.length ? pocOutputs : [];
  const reviewPoint = step.scope === "after-check" ? "관련 선행 조건 확인 후 진행"
    : model.methods[methodIdx] === "assist" ? "AI 결과는 담당자 확정 전 운영 반영 금지" : undefined;
  return { inputs, process, outputs: [...outputs, ...relatedOutputs.map(t => `${t} (관련 산출물)`)], overallOutputs, reviewPoint };
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
        [check.topic, `${check.topic} 확인`, `${check.topic}${check.note ? ` — ${check.note}` : ""}`].some(value => normalizedItem(value) === normalizedItem(text)));
      if (checks.length === 1) {
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
    if (d?.stepAssessments) {
      const reviewableSteps = extractReviewableItems(d).filter(i => i.type === "step");
      for (const r of validReviews) {
        if (r.action !== "exclude" && r.action !== "defer") continue;
        if (r.target.type !== "step") continue;
        const matched = reviewableSteps.find(i => i.key === r.target.key);
        if (matched) {
          const name = matched.text.split(":")[0].trim();
          if (name && !validatedExcludedStepNames.includes(name)) validatedExcludedStepNames.push(name);
        }
      }
    }
    hitlDetails = {
      appliedReviews: applied.appliedReviews,
      deferred: applied.deferred,
      supplements: applied.supplements,
      validatedExcludedStepNames,
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
    hitlApplied: hitlActuallyApplied, hitlDetails };
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
    return { classified, scoped, steps, methodEvidence, appliedCount: 0, appliedReviews, deferred: [], supplements: [] };
  }

  // 검토 대상 키와 classified 항목 매칭
  // Plan reviews match occurrence-aware keys. A diagnosis risk review can only
  // affect its own technical-check item, never unrelated plan/security text.
  const normalizeForMatch = (text: string) => text.trim().replace(/\s+/g, " ").toLowerCase();
  const matchReview = (item: AgentInstructionItem): string | null => {
    if (item.reviewKey) return relevant.find(r => r.status === "confirmed" && r.target.key === item.reviewKey)?.target.key ?? null;
    if (item.source !== "diagnosis.technicalChecks") return null;
    const itemTexts = new Set([item.text, item.original, ...item.originals].filter((text): text is string => !!text).map(normalizeForMatch));
    for (const r of relevant) {
      if (r.status !== "confirmed" || r.target.source !== "diagnosis" || r.target.type !== "risk") continue;
      if (itemTexts.has(normalizeForMatch(r.target.sourceText))) return r.target.key;
    }
    return null;
  };

  const isExcluded = (item: AgentInstructionItem) => {
    const key = matchReview(item);
    return key && (excludeKeys.has(key) || deferKeys.has(key));
  };

  // A review that removes a risk card cannot grant access denied by diagnosis.
  // Keep denied permission evidence in the generated instructions.
  const deniedChecks = new Set((diagnosis?.technicalChecks ?? []).filter(check => check.status === "불가")
    .map(check => normalizeForMatch(`${check.topic}: ${check.status} - ${check.note}`)));
  const filterReview = (item: AgentInstructionItem) =>
    item.source === "diagnosis.technicalChecks" && item.originals.some(text => deniedChecks.has(normalizeForMatch(text)))
      || !isExcluded(item);
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
          break;
        }
      }
    }
  }
  // diagnosis가 없을 경우: 안전을 위해 단계 제외하지 않음 (오적용 방지)

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
    filteredClassified = filteredClassified.filter(item => !removed(item));
    filteredScoped = {
      features: filteredScoped.features.filter(item => !removed(item)),
      tests: filteredScoped.tests.filter(item => !removed(item)),
      criteria: filteredScoped.criteria.filter(item => !removed(item)),
      validationMethods: filteredScoped.validationMethods.filter(item => !removed(item)),
      outputs: filteredScoped.outputs.filter(item => !removed(item)),
      conditions: filteredScoped.conditions.filter(item => !removed(item)),
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
  };
}

/** One coding-agent instruction for any supported tool; the model is computed once. */
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
  // Proposals linked to a future step are listed beneath that step, not as separate work.
  const relatedFuture = (step: string) => unique(model.classified.filter(item => item.scope === "future" && item.step === step && proposal(item)).map(item => item.text));
  const outside = unique(model.classified.filter(item => item.scope === "future" && proposal(item) && !future.some(s => s.step === item.step)).map(item => `생성 계획 제안: ${item.text} — ${item.reason}`));
  const outsideHuman = unique(model.classified.filter(item => item.scope === "human" && proposal(item)).map(item => `생성 계획 제안: ${item.text} — ${item.reason}`));
  // Only generated proposals are labelled as plan proposals; raw diagnosis PoC scope is superseded by the policy scope above.
  const unlinked = unique(model.ambiguous.filter(item => item.role === "features" && proposal(item)).map(item => `${item.text} — ${item.reason}`));
  const goals = model.classified.filter(item => item.role === "goal");
  // PART C: goal은 업무 전체 목표이므로 "어느 업무 단계에 적용되는지 확인되지 않았습니다" 같은
  // 단계 연결 문구를 표시하지 않는다. 내부 추적용 reason은 model에 보존된다.
  const GOAL_LINK_REASON = "어느 업무 단계에 적용되는지 확인되지 않았습니다.";
  const evidenceLine = (item: AgentInstructionItem) => `${item.text}${item.step ? ` (관련 단계: ${item.step})` : ""}${item.reason && !(item.role === "goal" && item.reason === GOAL_LINK_REASON) ? ` — ${item.reason}` : ""}${item.originals.some(text => normalizedItem(text) !== normalizedItem(item.text)) ? `; 원문: ${item.originals.join(" / ")}` : ""}`;
  const conditions = model.conditions.current.map(evidenceLine);
  const futureConditions = model.conditions.future.map(evidenceLine);
  const unassignedConditions = model.conditions.confirm.map(evidenceLine);
  const exceptions = unique([...model.classified.filter(item => item.role === "exception").map(item => item.text), ...(d?.asIs?.exceptions ?? []), ...(d?.risks ?? [])]);
  const constraints = approvalConstraints(model);
  const humanConstraints = model.classified.some(item => item.role === "human"
    && item.sources.some(source => source === "diagnosis.humanInLoop" || source === "plan.humanInLoop" || source === "policy.manualSteps"));
  const method = (s: StepScope) => model.methods[steps.indexOf(s)] ?? "confirm";
  const methodLabel = (s: StepScope) => stepMethodLabel(model, steps.indexOf(s));
  const methodOrder = (s: StepScope) => model.methodOrders[steps.indexOf(s)];
  const doneWhen = (s: StepScope) => {
    // PART B: Level 1 사용자 실행형 — 담당자 실행 기반이며 무인 자동화가 아니다.
    if (s.treatment === "사용자 실행 결과 생성")
      return "담당자가 실행을 요청하면 실제 입력으로 처리하고 결과를 화면·파일로 제공합니다. 스케줄러·정기 무인 실행은 구현하지 않으며, 담당자 확정 전 결과를 운영에 반영하지 않습니다. 실행할 때마다 입력 검증과 결과 대조 기록이 남습니다.";
    // method가 confirm인 경우, 단계 표기(stepMethodLabel)와 동일한 확정 판정을 사용한다.
    // stepMethodLabel이 "확인된 처리 기준에 따라 구현"이라고 하면서 doneWhen이
    // "구현을 시작하지 마세요"라고 하면 지시문 내부 모순이 되므로 단일 판정원을 유지한다.
    const confirmIdx = steps.indexOf(s);
    return method(s) === "assist"
    ? "실제 입력으로 후보·초안이 생성되고, 담당자 확정 전에는 운영 결과로 반영되지 않으며, 생성할 수 없는 건은 검토 필요·실패로 표시됩니다."
    : method(s) === "composite" && methodOrder(s) === "parallel"
    ? "병행 처리가 확인되었으나 실행 순서와 의존성이 확정되지 않았습니다. 실제 실행 전 처리 순서를 담당자에게 확인하고, 각 역할의 완료 기준을 모두 만족할 때 완료로 인정합니다. 확인 전에는 순차 실행을 가정하지 마세요."
    : method(s) === "composite"
    ? "확인된 처리 순서대로 각 역할이 실제 입력으로 동작하고, AI 결과는 담당자 확정 전 운영 결과로 반영되지 않으며, 규칙·스크립트는 확인된 기준만 적용되고, 담당자 확인이 유지됩니다. 각 단계의 완료는 해당 역할의 완료 기준을 모두 만족할 때 인정됩니다."
    : method(s) === "rule" || method(s) === "script" ? "확인된 형식·키·업무 규칙으로 실제 입력이 처리되고, 담당자가 확정한 기대 결과와 대조한 기록 및 원본 대응 관계가 남습니다. 기대 결과·판정 기준이 없으면 '기준 확인 필요'로 보고하고 합격으로 단정하지 마세요."
    : method(s) === "manual" ? "담당자가 수행할 작업과 시스템이 보조할 범위를 확인하고, 담당자 수행 결과와 미확인 조건만 기록합니다. 수동 업무를 신규 자동화 기능으로 바꾸지 마세요."
    : isConflictingMethodEvidence(model, confirmIdx)
    ? "처리 방식 근거가 충돌합니다. 충돌을 해결하기 전에는 처리 방식을 임의로 선택·구현하지 마세요. 충돌 해결 후 재개 조건을 보고하세요."
    : isConfirmedMethodEvidence(model, confirmIdx)
    ? "위 '확인된 기준'에 명시된 처리 방식을 실제 입력으로 구현하고, 기준에 없는 처리 방식은 담당자에게 확인하기 전에는 선택·구현하지 않습니다. 각 단계의 완료는 해당 기준의 완료 조건을 모두 만족할 때 인정됩니다."
    : "처리 방식이 확정되지 않았습니다. 처리 방식의 근거·충돌 내용·필수 기준을 먼저 확인하고, 미확정 사항과 재개 조건을 보고하세요. 방식이 확정되기 전에는 구현을 시작하지 마세요.";
  };
  const stepLine = (s: StepScope) => `${s.step} — ${methodLabel(s)}`;
  const sections: { title: string; body: string }[] = [];
  const section = (title: string, ...content: string[]) => sections.push({ title, body: content.filter(Boolean).join("\n\n") });
  const objective = !profile ? "진단 결과가 없어 실행 범위를 확정할 수 없습니다. 진단 결과를 확인하기 전에는 아래 제안을 구현하지 말고 확인할 항목을 보고하세요."
    : scopeLevel === 0 ? gate === "blocked"
      ? `${GATE_CONSTRAINTS.blocked} 아래 검토·검증 결과와 다음 진단에 필요한 정보를 보고하세요.`
      : "검토·검증 범위입니다. 운영 기능을 구현하지 말고 아래 검토·검증 결과와 다음 진단에 필요한 정보를 보고하세요."
    : !work.length ? "현재 실행 범위에 구현할 업무 단계가 없습니다. 아래 확인 작업과 보고만 수행하세요."
    : gate === "ready" ? "'이번 구현' 단계를 실제 입력으로 동작하고 검증된 기능으로 완성하세요."
    : "선행 조건을 각 단계의 실제 의존 관계에 대조해 확인된 '확인 후 구현' 단계부터 실제로 동작하고 검증된 기능으로 완성하세요. 미확인 조건에 의존하는 부분만 보류 사유와 함께 보고하세요.";
  const scopeGroups = (["implement", "after-check", "verify"] as const).map(kind => {
    const items = steps.filter(s => s.scope === kind);
    return items.length ? `### ${SCOPE_TITLES[kind]}\n\n${numbered(items.map(stepLine))}` : "";
  });
  const a = profile && d ? axes(d) : undefined;
  const inputs = d ? unique([...(d.asIs?.inputs ?? []), ...without(d.poc?.inputs ?? [], d.asIs?.inputs ?? []).map(item => `검증용: ${item}`)]) : [];
  const linkedTo = (step: string) => model.scoped.features.filter(item => item.step === step && item.sources.some(source => source.startsWith("plan."))).map(item => item.text);
  const currentOutputs = unique(model.scoped.outputs.map(item => item.text));
  const minimalFlow = work.length ? numbered([
    `입력: ${d?.asIs?.inputs?.length ? d.asIs.inputs.join(", ") : "입력 자료 확인 필요"} — 실제 입력을 받아 형식·필수 항목을 파싱·검증${scopeLevel === 1 ? "하고 담당자가 실행을 요청" : ""}`,
    ...work.map(s => `${s.step}: ${methodLabel(s)}`),
    "결과 구분: 확정된 처리와 필요한 담당자 확인 후 정상·검토 필요·확인 불가·처리 실패를 분리하고 원본 출처 유지",
    `담당자 확인: ${human.length ? human.map(s => s.step).join(", ") : "진단상 담당자 확인이 필요한 지점"} — 승인 전 확정·전송 금지`,
    `출력: ${currentOutputs.length ? currentOutputs.join(", ") : d?.asIs?.outputs?.length ? `${d.asIs.outputs.join(", ")} 중 허용 단계의 결과물 형식만 확인해 사용` : "구현 단계와 연결된 출력 형식 확인 필요"} — 실제 결과를 생성하고 필요한 경우 기존 저장·재조회 흐름 연결`,
    "실행 방법: 확인된 실행 명령·화면에서 서로 다른 입력으로 처리 결과를 재현할 수 있게 제공",
  ]) : "";
  const fallback = unique([...(d?.operation?.fallback ? [d.operation.fallback] : []), ...model.classified.filter(item => (item.role === "fallback" || item.role === "operation") && ["implement", "after-check", "verify"].includes(item.scope)).map(item => item.text)]);
  const tests = unique(model.scoped.tests.map(item => item.text));
  const criteria = unique(model.scoped.criteria.map(evidenceLine));
  // PART B: PoC 성공·실패 기준은 업무 전체의 완료 기준이므로 단계 연결이 없어도 격하하지 않음.
  // 단계 연결 근거가 없는 다른 criteria만 "참고 판정"으로 구분한다.
  const isPocCriterion = (item: AgentInstructionItem) =>
    item.sources.some(s => s === "diagnosis.poc.success" || s === "diagnosis.poc.failure");
  // PART A-5: PoC 기준 안전성 — 제외된 단계나 차단 상태에서 필수 완료 조건으로 승격 금지.
  // Priority 5: 모델에서 유효성 검증된 제외 단계명 집합 사용 (중복 검증 방지, 검증 기준 단일화)
  // buildAgentInstructionModel에서 getValidConfirmedReviews로 검증된 결과만 사용
  const excludedStepNames = new Set<string>(model.hitlDetails?.validatedExcludedStepNames ?? []);
  // PoC 기준이 제외된 단계와만 관련되고 활성 작업 단계와는 무관하면 필수 조건에서 제외.
  const criterionRelatesOnlyToExcluded = (text: string): boolean => {
    if (excludedStepNames.size === 0) return false;
    const words = text.replace(/[^\uAC00-\uD7A3A-Za-z0-9]/gu, " ").split(/\s+/u).filter(w => w.length >= 2);
    const matchesExcluded = [...excludedStepNames].some(name => {
      const nameWords = name.replace(/[^\uAC00-\uD7A3A-Za-z0-9]/gu, " ").split(/\s+/u).filter(w => w.length >= 2);
      return words.some(w => nameWords.includes(w)) || nameWords.some(w => words.includes(w));
    });
    if (!matchesExcluded) return false;
    // 활성 작업 단계와도 관련되면 제외하지 않음 (보수적: 제외 단계와만 관련될 때만 demote)
    const activeStepNames = work.map(s => s.step);
    const matchesActive = activeStepNames.some(name => {
      const nameWords = name.replace(/[^\uAC00-\uD7A3A-Za-z0-9]/gu, " ").split(/\s+/u).filter(w => w.length >= 2);
      return words.some(w => nameWords.includes(w)) || nameWords.some(w => words.includes(w));
    });
    return !matchesActive;
  };
  // 차단 상태에서는 PoC 기준을 구현 가능한 완료 조건으로 제시하지 않음.
  const pocCriteriaBlocked = gate === "blocked";
  const pocCriteriaItems = model.classified.filter(item => item.role === "criteria" && isPocCriterion(item) && !model.scoped.criteria.includes(item));
  const overallCriteria = unique(pocCriteriaItems
    .filter(item => !pocCriteriaBlocked && !criterionRelatesOnlyToExcluded(item.text))
    .map(item => item.text));
  const demotedPocCriteria = pocCriteriaItems
    .filter(item => pocCriteriaBlocked || criterionRelatesOnlyToExcluded(item.text))
    .map(item => `${item.text} — 현재 필수 완료 조건 아님${pocCriteriaBlocked ? " (실행 차단 상태)" : " (관련 단계 제외됨)"}`);
  // 업무 전체 완료 기준은 단계 연결 reason을 표시하지 않음 (전체 기준으로 명시하므로).
  const deferredCriteria = [
    ...model.classified.filter(item => item.role === "criteria" && !isPocCriterion(item) && !model.scoped.criteria.includes(item) && !model.scoped.validationMethods.includes(item))
      .map(item => `${evidenceLine(item)} — 현재 필수 완료 조건 아님`),
    ...demotedPocCriteria,
  ];
  const hitl = model.hitlDetails;
  // 1. 개발 목표: 무엇을·왜·어디까지 만드는가
  section("개발 목표",
    d && level && gate && a ? `### 실행 조건\n\n${bullets([
      ...(d.asIs?.purpose ? [`업무 목적: ${d.asIs.purpose}`] : []),
      LEVEL_CONSTRAINTS_OUTPUT[level.level],
      GATE_CONSTRAINTS[gate],
    ])}\n\n실제 실행 범위는 현재 허용 범위를 따르며, TO-BE·생성 계획·매트릭스 위치는 이 범위를 넓히지 않습니다.` : "",
    `### 이번 작업 목표\n\n${objective}`,
    options.context?.trim() ? `### 업무 등록 원문\n\n${bullets([...(options.taskName ? [`업무명: ${options.taskName}`] : []), `업무 설명·추가 정보: ${options.context.trim()}`])}\n\n진단과 충돌하는 내용은 임의로 덮어쓰지 말고 해당 부분의 확정 범위를 확인하세요.` : "",
    goals.some(item => item.scope !== "future") ? `### 생성 계획 목표\n\n${bullets(goals.filter(item => item.scope !== "future").map(evidenceLine))}` : "",
    ...scopeGroups,
    profile?.scopeSupport.length ? `### 함께 수행할 확인\n\n${bullets(profile.scopeSupport)}` : "",
    humanKept.length ? `### 담당자 수행 유지 (자동화로 대체하지 않음)\n\n${bullets(humanKept)}` : "",
    excluded.length || outsideHuman.length ? `### 현재 자동화 제외\n\n${bullets([...excluded, ...outsideHuman])}` : "",
    future.length || outside.length ? `### 향후 확장 (이번 작업에서 구현하지 않음)\n\n${bullets([...future.map(s => s.step), ...outside])}` : "",
    hitl && (hitl.deferred.length > 0 || hitl.supplements.length > 0) ? `### 사람 검토 반영\n\n${[
      hitl.deferred.length > 0 ? `보류된 작업 (현재 구현하지 않음):\n${hitl.deferred.map(x => `- ${x.key}${x.reason ? `\n  - 보류 사유: ${x.reason}` : ""}${x.resumeCondition ? `\n  - 재개 조건: ${x.resumeCondition}` : ""}`).join("\n")}\n위 작업은 현재 구현 범위에서 제외됩니다. 재개 조건이 충족되어도 자동으로 재개하지 말고 담당자에게 확인하세요.` : "",
      hitl.supplements.length > 0 ? `보완 요구사항·검증 기준:\n${hitl.supplements.map(x => `- ${x.key}\n  - 보완 내용: ${x.content}`).join("\n")}\n위 보완 내용은 원본 범위에 추가하여 관련 구현·검증 기준에 반영하세요. 단, 담당자 유지·제외·보류 범위를 넘어서는 부분은 구현하지 말고 사유를 보고하세요. 확인되지 않은 API·권한·DB를 임의로 추가하지 마세요.` : "",
    ].filter(Boolean).join("\n\n")}` : "",
  );
  // 2. INPUT·PROCESS·OUTPUT: 실제 데이터 흐름 중심
  const ioBlocks = work.map((s, i) => {
    const spec = stepIoSpec(model, steps.indexOf(s));
    return `### 기능 ${i + 1}. ${s.step}\n\n${bullets([
      `목적: ${methodLabel(s)}`,
      spec.inputs.length ? `입력: ${spec.inputs.join("; ")}` : "입력: 확인 필요 — 실제 입력 자료의 형식과 필수 항목을 확인하세요.",
      `처리: ${spec.process.join(" → ")}`,
      spec.outputs.length ? `출력: ${spec.outputs.join("; ")}`
        : spec.overallOutputs.length ? `출력 (업무 전체 산출물): ${spec.overallOutputs.join("; ")} — 이 단계의 처리 결과와 연결되는 최종 산출물입니다.`
        : "출력: 확인 필요 — 이 단계의 결과물 형식을 확인하세요.",
      ...(spec.reviewPoint ? [`검토 지점: ${spec.reviewPoint}`] : []),
      `완료 기준: ${doneWhen(s)}`,
    ])}`;
  }).join("\n\n");
  section("INPUT·PROCESS·OUTPUT",
    inputs.length || d?.asIs?.trigger || d?.asIs?.systems?.length ? `### 업무 입력\n\n${bullets([
      ...inputs, ...(d?.asIs?.trigger ? [`업무 발생 주기·시점: ${d.asIs.trigger} (자동 실행 요구사항 아님)`] : []), ...(d?.asIs?.systems?.length ? [`사용 시스템: ${d.asIs.systems.join(", ")}`] : []),
    ])}\n\n실제 입력 자료의 형식과 필수 필드를 확인하고 파싱·검증한 뒤 처리하세요. 확인 전에는 항목명·경로·값을 하드코딩하지 마세요.` : "",
    work.length ? `${ioBlocks}\n\n### 전체 흐름\n\n${minimalFlow}` : "",
    "### 계산·판정 기준\n\n업무에 계산·판정이 있으면 확인된 계산식·입력·순서·반올림·누락 처리 기준만 사용하세요. 정의되지 않은 기준은 해당 처리만 보류하고 '확인 필요'로 보고하세요. 독립적으로 확인된 입력 검증·후보 생성은 계속할 수 있습니다.",
    "### 추적\n\n원본 추적이 필요한 업무라면 결과에서 원본 출처·처리 단계·오류 위치·담당자 확인 결과를 확인할 수 있게 유지하세요. 업무와 관계없는 식별 정보를 강제하지 마세요.",
    `### 실행 방식\n\n${scopeLevel === 1 ? "담당자 요청 기반 실행만 허용합니다. 스케줄러·폴더 감시 등 정기 무인 실행을 구현하지 마세요." : scopeLevel === 0 ? "검토·검증만 허용하며 업무 자동 실행을 추가하지 마세요." : "업무 발생 주기와 시스템 자동 실행은 별개입니다. 실제 자동 실행 요청·근거·정책 허용 여부가 확인되지 않았다면 실행 방식 확인 필요로 보고하세요."}`,
  );
  // 3. 구현 요구사항: 단계별 실제 구현 내용
  section("구현 요구사항",
    work.length ? work.map((s, i) => `### 요구사항 ${i + 1}. ${s.step} — ${methodLabel(s)}\n\n${bullets([
      `처리 상태: ${s.scope === "implement" ? SCOPE_TITLES.implement : `${SCOPE_TITLES["after-check"]} (이 단계가 의존하는 조건 확인 전에는 해당 처리만 보류)`}`,
      ...(s.treatment === "사용자 실행 결과 생성" ? ["실행 조건: 담당자가 실행을 요청할 때만 동작합니다. 무인·정기 자동 실행으로 구현하지 마세요."] : []),
      `담당자 확인: ${method(s) === "assist" ? "AI 결과는 제안값으로 표시하고 담당자가 확정한 값과 구분하세요. 규칙으로 판정할 부분에 별도 AI 호출을 추가하지 마세요." : method(s) === "composite" && methodOrder(s) === "parallel" ? "병행 처리 관계가 확인되었으므로 순차 실행을 가정하지 말고, 실제 실행 순서와 의존성을 담당자에게 먼저 확인하세요." : method(s) === "composite" ? "확인된 복합 처리 순서를 유지하고, 각 역할을 담당자 확인·승인 단계로 승격하거나 무인 실행으로 바꾸지 마세요." : method(s) === "rule" || method(s) === "script" ? "파일 형식·병합 키·계산식·예외 규칙 등 이 단계에 필요한 실제 기준을 확인한 뒤 적용하세요. 규칙 미확인 건은 담당자 확인으로 넘기고 AI 호출을 추가하지 마세요." : method(s) === "manual" ? "담당자 수동 수행을 유지하고 자동화 구현으로 대체하지 마세요." : isConflictingMethodEvidence(model, steps.indexOf(s)) ? "처리 방식 근거가 충돌합니다. 충돌을 해결하기 전에는 처리 방식을 임의로 선택·구현하지 마세요." : isConfirmedMethodEvidence(model, steps.indexOf(s)) ? "위 '확인된 기준'에 명시된 처리 방식을 그대로 구현하세요. 기준에 없는 처리 방식은 담당자에게 확인하기 전에는 선택·구현하지 마세요." : "처리 방식의 구체적 근거가 확인되지 않았습니다. 해당 처리만 보류하고, 확인과 무관한 독립 단계는 계속 진행하세요."}`,
      ...linkedTo(s.step).map(item => `세부 제안 (생성 계획): ${item}`),
      `완료 기준: ${doneWhen(s)}`,
    ])}`).join("\n\n") : "",
    review.length ? `### 검토·검증 작업\n\n${bullets([...review.map(s => `${s.step} ${methodLabel(s)}`), ...(profile?.scopeSupport ?? [])])}\n\n샘플과 업무 규칙으로 확인한 결과를 보고하는 범위입니다. ${gate === "blocked" ? "운영 기능·자동 실행 코드·스캐폴딩을" : "운영 기능이나 자동 실행 코드를"} 만들지 마세요.` : "",
    work.length ? "### 실제 동작하는 기본 토대\n\n실제 입력 수신→형식 파싱·필수값 검증→확정된 처리·담당자 확인→예외 분리→실제 출력으로 연결하세요. 업무상 필요한 저장·재조회는 기존 방식을 사용하고, 외부 API가 필요하면 권한과 실패 응답을 처리하세요. 독립적으로 허용된 단계는 다른 단계의 미확정 규칙 때문에 일괄 중단하지 마세요.\n\n처리 없는 화면, 읽지 못하는 업로드, 입력이 달라도 같은 고정 결과, 더미 데이터 결과, 가짜 API 응답, TODO만 있는 핵심 함수, 실행되지 않는 샘플 코드, 검증하지 않은 계산, 승인 없이 확정되는 AI 결과는 완료가 아닙니다. 허용된 독립 단계가 없으면 코드를 만들지 말고 선행 확인사항을 보고하세요." : "",
    "기존 구현을 우선 재사용하고 요청 범위 안에서 최소한으로 수정하세요. 요청하지 않은 기능·라이브러리, 하드코딩 값, 실제 로직에 남은 테스트용 임시 데이터, 근거 없는 수치 목표, 확인되지 않은 담당 조직·승인 주체를 만들지 마세요.",
  );
  // 4. 구현 순서: 6단계
  section("구현 순서",
    numbered([
      "기존 프로젝트 확인: 저장소 지침(AGENTS.md 등)과 현재 branch·미커밋 변경을 확인하고, 프로젝트 구조·실행 환경·패키지 스크립트의 테스트·빌드 명령을 파악하세요. 이 업무가 웹앱인지 CLI·스크립트·Excel 자동화인지 확인하고 해당 환경의 기존 구현을 재사용하세요. 확인한 사실과 추정을 구분해 기록하고, 추정은 '확인 필요'로 남기세요.",
      work.length ? `입력 기능 구현: ${work.map(s => s.step).join(", ")} 단계에 필요한 입력 수집·검증 기능을 먼저 구현하세요. 실제 샘플로 형식을 확인하기 전에는 항목명·경로를 하드코딩하지 마세요.` : "입력 기능 구현: 이번 범위에서 구현할 단계가 없습니다. 입력 자료의 형식 확인과 보고만 수행하세요.",
      work.length ? `핵심 처리 로직 구현: ${work.map(s => `${s.step} (${methodLabel(s)})`).join(" → ")} 순서로 처리 로직을 구현하세요. 확인된 계산식·규칙만 적용하고, 미확정 규칙은 해당 처리만 '확인 필요'로 남기세요. 관련 없는 독립 기능까지 중단하지 마세요.` : "핵심 처리 로직 구현: 해당 없음.",
      work.length ? `실제 출력 연결: 처리 결과를 ${currentOutputs.length ? currentOutputs.join(", ") : "확인된 출력 형식"}으로 연결하고, 업무에 필요한 저장·재조회가 있으면 기존 저장소·인증 방식으로 동작을 확인하세요. 정적 UI나 임시·고정 값은 완료가 아닙니다.` : "실제 출력 연결: 해당 없음.",
      `예외·검토·승인 처리: ${exceptions.length ? exceptions.slice(0, 5).join("; ") : "업무 예외"} 처리를 구현하고, 담당자 확인·승인 지점을 유지하세요. 실패·미매칭·확인 불가 데이터는 정상 결과와 분리하세요.`,
      "실행 및 검증: 저장소의 실제 테스트·빌드 명령으로 검증하고, '검증·완료 조건' 섹션의 기준을 만족하는지 확인하세요. 실행하지 않은 검증은 완료로 보고하지 마세요.",
    ]),
    "위 순서를 지키되 의존성이 없는 독립 단계는 병렬로 진행할 수 있습니다. 선행 확인이 필요한 단계는 실제 의존 관계를 확인하고 해당 부분만 '확인·승인 대기'로 보고하세요. 미확인 권한·보안 조건을 독립이라고 단정하거나 우회하지 마세요.",
  );
  // 5. 예외·유지 조건
  section("예외·유지 조건",
    gate ? (gate === "conditional" && scopeLevel === 0
      ? "검토·검증만 허용됩니다. 각 검토 작업이 의존하는 항목이 확인되지 않았으면 그 검토만 보류하고 '확인·승인 대기'로 보고하세요. 의존하지 않는 검토(프로젝트 구조·기존 자료 확인 등)는 진행할 수 있습니다."
      : GATE_CONSTRAINTS[gate]) : "",
    gate === "blocked" && profile?.blockReasons.length ? `### 차단 사유\n\n${bullets(profile.blockReasons)}` : "",
    conditions.length ? `### 현재 필수 조건\n\n${bullets(conditions)}` : "",
    unassignedConditions.length || gaps.length ? `### 적용 단계 확인 필요\n\n${bullets([...unassignedConditions, ...gaps])}` : "",
    humanConstraints ? HUMAN_DECISION_CHECK : "",
    constraints.length ? `### 기존 담당자·제외 제약\n\n${bullets(constraints)}` : "",
    unassignedConditions.length ? "미연결 조건의 적용 대상과 의존 관계를 실제 자료로 확인하세요. 무관하다고 임의로 해제하지 말고, 영향 가능성이 있는 작업은 확인·승인 대기로 두세요. 해당 조건과 독립적이라는 근거가 확인된 허용 작업만 계속 진행할 수 있습니다." : "",
    "확인되지 않은 API·권한·파일 형식·연동 방식·계산식·반올림·중복 기준·승인 주체를 가정해 구현하지 마세요. 특히 '불가'·거부된 접근 권한은 검토에서 제외해도 허용으로 바뀌지 않습니다.",
    exceptions.length ? `### 예외\n\n${bullets(exceptions)}` : "",
    "실패·미매칭·확인 불가 데이터는 정상 결과와 분리해 원인과 대상을 확인할 수 있게 하세요. 자동 삭제·자동 보정은 업무 규칙에 명시된 경우에만 적용하고, 아니면 대상 건을 표시만 하세요.",
    work.length ? "### 반복 실행\n\n같은 입력 재처리, 같은 이름의 다른 파일, 일부 성공 후 실패, 처리 중단·재시도, 이전 요청의 뒤늦은 완료, 입력 변경 후 기존 결과 재사용 중 이 업무에 해당하는 경우를 확인하세요. 기존 처리 정책을 먼저 따르고, 중복 반영·기존 데이터 삭제·미검증 데이터의 정상 집계가 없게 하되 필요 없는 작업 큐·트랜잭션 구조는 추가하지 마세요." : "",
    `### 담당자 확인·승인\n\n${constraints.length ? "'위 기존 담당자·제외 제약을 그대로 지키세요. " : ""}담당자 판단·확정이 필요한 결과는 확인되지 않은 승인으로 확정·시스템 반영·외부 전송하거나 담당자 판단을 대체하지 마세요. 허용된 후보·초안·규칙 검토는 각 단계의 선행 조건 내에서 진행할 수 있습니다. 승인 주체·권한이 확인되지 않았으면 지정하지 마세요.`,
    `### 보안\n\n${bullets([
      ...model.conditions.global.filter(item => item.role === "security").map(evidenceLine),
      "secret은 코드에 하드코딩하지 말고 저장소의 기존 secret 관리 방식을 사용하세요.",
      "기존 인증·권한 구조와 최소 권한 원칙을 유지하고, 민감한 데이터를 불필요하게 로그에 남기지 마세요.",
      "외부 AI 서비스로 업무 자료를 보내기 전에 보안 조건을 확인하고, 확인되지 않은 연동은 자동 실행하지 마세요.",
    ])}`,
    `### 수동 전환\n\n${fallback.length ? `${bullets(fallback)}\n\n` : ""}자동화가 실패해도 기존 수동 업무를 계속할 수 있게 유지하세요. 실제 수동 절차와 운영 담당이 확인되지 않았으면 새로 정하지 마세요.`,
  );
  // 6. 검증·완료 조건
  section("검증·완료 조건",
    "저장소에 실제로 존재하는 검증 명령과 도구를 확인한 뒤 실행하세요. 없는 테스트 framework나 명령을 임의로 설치하지 마세요.",
    work.length ? `### 정상 케이스\n\n${tests.length ? `${bullets(tests)}\n\n` : ""}실제 입력으로 처리·출력과 필요한 저장·재조회를 확정된 기대 결과와 대조하세요. 서로 다른 입력으로 다시 실행해 각 입력에 맞게 출력이 달라지는지 확인하고 고정 결과를 배제하세요. 기대 결과·허용 오차가 정의되지 않았다면 '확인 필요'로 보고하세요.`
      : `### 현재 검토·검증\n\n${tests.length ? `${bullets(tests)}\n\n` : ""}확보한 샘플과 기존 자료로 확인할 수 있는 범위만 검증하세요. 검증을 위해 새 기능·자동 생성 코드를 만들지 말고, 비교 자료가 없으면 '검증 불가'와 사유를 기록하세요.`,
    model.scoped.validationMethods.length ? `### 검증 방법·기록 (합격 조건 아님)\n\n${bullets(model.scoped.validationMethods.map(evidenceLine))}` : "",
    work.length ? "### 경계값\n\n입력 1건·빈 입력·같은 기준값 여러 건·선택 항목 누락·확정된 업무 경계값 중 해당하는 상황을 확인하세요." : "",
    work.length ? "### 실패·예외 케이스\n\n현재 구현 단계의 잘못된 형식·파싱 오류·필수 항목 누락과 외부 API가 필요한 경우 응답 오류·권한 거부·연결 실패가 정상 결과나 성공한 저장으로 표시되지 않는지 확인하세요." : "",
    "### 범위·승인\n\n담당자 확인 전 결과가 확정·전송되지 않는지, 제외·보류된 단계와 검증 기준이 다시 필수 작업으로 나타나지 않는지, 거부된 권한에 의존하는 처리가 실행되지 않는지 확인하세요.",
    "### 회귀 검증\n\n이 작업과 관련된 기존 기능이 이전과 동일하게 동작하는지 확인하세요. 웹 UI를 포함하면 기존 브라우저/E2E 도구가 있을 때 주요 화면을 Desktop과 Mobile에서 확인하세요.",
    work.length ? `### 단계별 완료 기준\n\n${bullets(work.map(s => s.scope === "implement" ? `${s.step}: ${doneWhen(s)}` : `${s.step}: 확인 항목이 확인되어 구현했다면 ${doneWhen(s)} 확인하지 못했다면 '확인·승인 대기'로 보고합니다.`))}` : "",
    review.length ? `### 검토·검증 완료 기준\n\n${bullets([
      "확인한 프로젝트 구조와 재사용 가능한 기존 구현이 정리됩니다.",
      ...review.map(s => `${s.step}: 처리 가능성과 기술적 제약이 근거 자료와 함께 정리됩니다.`),
      "다음 진단에 필요한 정보가 보고됩니다.",
    ])}` : "",
    criteria.length ? `### 판정 기준\n\n${bullets(criteria)}` : "",
    overallCriteria.length ? `### 업무 전체 완료 기준\n\n${bullets(overallCriteria)}\n\n위 기준은 업무 전체 산출물에 대한 완료 조건입니다. 단계별 검증과 함께 확인하세요.` : "",
    deferredCriteria.length ? `### 참고 판정 (필수 완료 조건 아님)\n\n${bullets(deferredCriteria)}` : "",
    `### 공통\n\n${bullets([
      "기존 기능과 데이터가 유지됩니다.",
      ...(humanKept.length ? ["담당자 검토·승인 단계가 유지됩니다."] : []),
      "'향후 확장'·'제외' 항목이 구현되거나 실행되지 않습니다.",
      ...(gate === "blocked" || !profile ? ["운영 구현과 실행은 차단되고 검토·검증 결과와 차단 해제 조건만 기록됩니다."] : work.length ? ["정상·경계·실패 케이스 검증이 통과하고, 실패 건이 정상 결과와 구분됩니다."] : ["운영 기능·자동 실행 코드 없이 검토·검증 결과가 근거와 함께 보고됩니다."]),
      work.length ? "타입 오류와 빌드 오류가 없습니다." : "코드를 변경했다면 타입 오류와 빌드 오류가 없습니다.",
      "실행하지 않은 검증은 완료로 보고하지 말고 미실행으로 명시합니다.",
    ])}`,
    `### 완료 상태 구분\n\n${bullets(work.length ? [
      "구현·검증 완료: 실제 구현 후 검증 통과", "구현 완료·검증 미완료: 구현했지만 정상 동작 확인 부족", "부분 구현: 허용된 일부 기능만 구현",
      "확인·승인 대기: 필수 정보 또는 승인 부족", "정책상 제외·차단: 현재 실행 대상 아님", "구현 실패: 구현 또는 검증 실패",
    ] : [
      "검토 완료: 확인한 자료로 검토를 마침", "검증 완료: 실제 자료로 검증을 마침", "일부 확인: 일부 자료만 확인", "확인 필요: 근거 자료 부족",
      "확인·승인 대기: 필수 정보 또는 승인 부족", "정책상 제외·차단: 현재 실행 대상 아님", "검증 실패: 검증했지만 기준 미충족", "미실행: 수행하지 않음",
    ])}\n\n${work.length ? "올인원 지시문 생성만으로 첫 MVP가 완료되지는 않습니다. 실제 구현·테스트·허가된 GitHub 반영·배포·Production 기능 검증을 수행한 범위에서만 완료로 보고하세요. 스캐폴딩·TODO·모의 구현만 있는 기능은 완료가 아닙니다." : "수행하지 않은 검토·검증을 완료로 보고하지 마세요."}`,
  );
  // 7. Git·배포·완료 보고
  section("Git·배포·완료 보고", bullets([
    "작업 전후로 `git status`, 현재 branch, `git diff`를 확인하고 기존 작업을 덮어쓰지 마세요.",
    "의도한 파일만 `git add <파일>`로 stage하세요. `git add .`로 전체를 추가하지 마세요.",
    "force push, `git reset --hard` 같은 파괴적인 명령을 사용하지 마세요.",
    "stage·commit·push·PR은 사용자 요청 범위, 도구 권한, 저장소 branch/PR 정책이 모두 허용할 때만 진행하세요.",
    "웹 애플리케이션이면 저장소의 기존 CI/CD·배포 설정에서 배포 방식을 먼저 확인하세요. 배포 플랫폼을 임의로 선택하지 마세요.",
    "로컬 스크립트·CLI·Excel 자동화처럼 웹 배포가 필요 없으면 배포 대신 실행 환경 구성과 운영 적용 방법을 정리하세요.",
    "배포 방식을 확인할 수 없으면 '배포 방식 확인 필요'로 보고하세요.",
    "구현을 마쳤다는 이유만으로 배포하지 마세요. Production 배포는 사용자가 요청했고 권한이 확인된 경우에만 기존 방식으로 실행하세요.",
    "배포 또는 운영 적용을 수행했다면 실제 환경에서 서로 다른 입력 → 파싱·처리 → 실제 출력·필요한 저장·재조회, 오류와 권한·승인 경계를 확인하세요. 배포하지 않았다면 운영 검증 완료로 보고하지 마세요.",
    ...(gate === "blocked" || !profile ? ["실행 범위가 차단·미확정 상태에서는 배포·운영 적용·연결을 수행하지 마세요. 차단 해제에 필요한 조건만 보고하세요."] : []),
  ]),
  "작업이 끝나면 다음 형식으로 보고하세요.",
  numbered([
    "확인한 프로젝트 구조", "현재 허용 범위", "단계별 완료 상태 (위 완료 상태 구분 사용)", "수정·생성한 파일", "입력·처리·출력 구조",
    "실제로 확인한 실행 방법과 명령", "검증 결과 (실행하지 않은 검증은 미실행)", "담당자 확인이 필요한 항목", "미구현·보류·차단된 기능과 해결 조건",
    "다음 개발 단계", "Git 상태", "배포·운영 적용 상태",
  ]),
  "올인원 지시문 생성·실제 구현·테스트·GitHub 반영·배포·운영 확인·첫 MVP 완료 여부를 각각 구분하세요. 확인하지 않은 환경변수·API·파일 경로를 적지 말고, 계획이나 미구현 기능을 실행 가능한 코드와 구분하세요. 실제로 수행하지 않은 작업을 완료했다고 보고하지 마세요.",
  );
  return [
    axPromptTitle(options.taskName),
    "WorkLens 업무 자동화 진단 결과로 만든 올인원 지시문입니다. 이 지시문이나 설치·시작 가이드 자체는 구현·완료의 증거가 아닙니다. Codex·Claude Code·OMP 등 어떤 코딩 에이전트에서도 같은 실행 범위와 완료 기준을 따르세요. 대상 저장소를 먼저 확인한 뒤 '개발 목표' 안에서 첫 MVP를 구현하세요.",
    ...sections.filter(s => s.body).map((s, i) => `## ${i + 1}. ${s.title}\n\n${s.body}`),
  ].join("\n\n");
}
