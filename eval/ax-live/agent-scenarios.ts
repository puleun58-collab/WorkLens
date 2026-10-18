// Input specifications for independent, isolated Codex and Claude implementation runs.
// No WorkLens source, user data, production endpoint or credentials are copied into the projects.
export interface AgentScenario {
  id: string;
  name: string;
  description: string;
  details: { cycle: string; minutesPerRun: number; runsPerMonth: number; systems: string; inputs: string; outputs: string; humanSteps: string };
  files: Record<string, string>;
}

export const AGENT_SCENARIOS: AgentScenario[] = [
  {
    id: "csv", name: "CSV 업로드 집계와 보고서",
    description: "브라우저에서 동작하는 CSV 업로드·집계 앱을 만드세요. node server.mjs 실행, PORT 환경변수 포트(기본 3900)의 127.0.0.1에서 HTTP 서비스를 제공합니다. 홈 화면 <input id='csv-file' type='file'>, <button id='run-csv'>, <pre id='report'>, <div id='error'>를 제공합니다. 사용자가 업로드한 실제 CSV 바이트를 파싱하고 열 order_id,amount,quantity의 순서 변화에 대응한 다음 각 행의 정수 amount*quantity와 합계를 #report에 JSON {rows:[{order_id,total}],grandTotal}로 표시합니다. 정상 파일 두 건을 각각 업로드하면 서로 다른 결과가 즉시 나와야 합니다. 잘못된 숫자/누락된 열은 #error에 표시하고 이전 정상 보고서를 지워야 합니다. HTML/JS 및 Node.js 내장 모듈만, 새 라이브러리 설치 금지. fixture 파일을 수정하지 마세요. 배포·Git push 금지.",
    details: { cycle: "사용자 요청 시", minutesPerRun: 10, runsPerMonth: 5, systems: "로컬 HTTP 웹 앱, 브라우저 CSV 파일 업로드", inputs: "file input으로 올린 실제 CSV 파일 바이트; 헤더 order_id,amount,quantity", outputs: "행별 total 및 grandTotal JSON 화면 보고서; 오류 화면", humanSteps: "보고서 확인·확정은 담당자; 자동 게시하지 않음" },
    files: { "input-a.csv": "order_id,amount,quantity\nA,12,3\nB,7,2\n", "input-b.csv": "quantity,order_id,amount\n2,C,9\n5,D,4\n", "input-bad.csv": "order_id,amount,quantity\nA,hello,2\n", "contract.json": JSON.stringify({ server: "PORT=<port> node server.mjs", page: "http://127.0.0.1:<port>/", controls: ["#csv-file", "#run-csv", "#report", "#error"], report: "JSON {rows:[{order_id,total}],grandTotal}", framework: "Node.js built-ins only" }, null, 2) },
  },
  {
    id: "crud", name: "담당자 요청형 CRUD 대장",
    description: "브라우저에서 동작하는 CRUD 대장을 만드세요. node server.mjs 실행, PORT 환경변수 포트(기본 3900)의 127.0.0.1에서 HTTP 서비스를 제공합니다. 홈 화면에는 <input id='item-id'>, <input id='item-title'>, 버튼 #create/#update/#delete, <pre id='items'>, 오류 표시 <div id='error'>가 있습니다. 담당자 직접 클릭에 따라 작업 항목 {id,title} 생성·수정·삭제·목록 표시. 서버는 프로젝트의 local-state.json 파일에 변경을 저장하므로 브라우저 새로고침뿐 아니라 서버 재시작 이후에도 목록이 복원되어야 합니다. 중복 ID 생성/없는 ID 변경·삭제는 #error에 오류 표시하고 기존 목록은 유지합니다. 사용자 삭제 클릭 없이 자동 삭제는 금지. Node.js 내장 모듈과 HTML/JS만 사용하고 새 패키지·배포·Git push 금지.",
    details: { cycle: "담당자 요청 시", minutesPerRun: 5, runsPerMonth: 10, systems: "로컬 HTTP 웹 앱, 로컬 JSON 영속 파일", inputs: "화면에 직접 입력한 id/title/클릭", outputs: "브라우저 목록 및 서버 재시작 후 유지되는 JSON 저장", humanSteps: "삭제는 담당자 클릭으로만 수행; 자동 삭제·승인 제외" },
    files: { "contract.json": JSON.stringify({ server: "PORT=<port> node server.mjs", page: "http://127.0.0.1:<port>/", controls: ["#item-id", "#item-title", "#create", "#update", "#delete", "#items", "#error"], data: "persistent local-state.json, JSON array {id,title}", framework: "Node.js built-ins only" }, null, 2) },
  },
  {
    id: "api", name: "격리 HTTP API 데이터 변환",
    description: "브라우저에서 격리 로컬 HTTP fixture의 실제 데이터를 읽어 화면에 표시하는 앱을 만드세요. node server.mjs 실행, PORT 환경변수 포트(기본 3900)의 127.0.0.1에서 HTTP 서비스를 제공합니다. 홈 화면 <input id='api-url'>, <button id='load-api'>, <pre id='records'>, <div id='error'>를 제공합니다. 사용자가 입력한 완전한 fixture URL의 GET 응답 {records:[{id,priceCents}]}에서 id와 priceCents/100의 숫자 price로 변환해 JSON 배열을 #records에 표시합니다. 다른 /other URL이면 화면 값이 달라야 합니다. HTTP 오류/응답 구조 이상/비정수 가격에서는 #error에 오류를 표시하고 오래된 정상 목록을 지웁니다. 브라우저의 CORS 제약 시 앱 서버에서 해당 127.0.0.1 fixture 주소에 요청을 중계하되 외부 주소를 허용하지 마세요. evaluator가 별도로 실행하는 api-fixture.mjs가 진짜 HTTP 서버이며 소비자에 응답을 하드코딩하지 마세요. Node.js 내장 모듈과 HTML/JS만, 배포·Git push 금지.",
    details: { cycle: "사용자 요청 시", minutesPerRun: 5, runsPerMonth: 8, systems: "로컬 HTTP 웹 앱과 별도 127.0.0.1 fixture API", inputs: "사용자가 화면에서 입력한 실제 fixture GET URL", outputs: "브라우저 변환 배열 [{id,price}]과 오류 화면", humanSteps: "결과 확인·운영 반영은 담당자; 외부 전송 금지" },
    files: { "contract.json": JSON.stringify({ server: "PORT=<port> node server.mjs", page: "http://127.0.0.1:<port>/", controls: ["#api-url", "#load-api", "#records", "#error"], output: "JSON array [{id,price}]", fixture: "api-fixture.mjs; evaluator starts separate local server", framework: "Node.js built-ins only" }, null, 2), "api-fixture.mjs": "import { createServer } from 'node:http';\nexport function startFixture() {\n  const server = createServer((req, res) => {\n    const entries = { '/records': { records: [{ id: 'R1', priceCents: 1250 }, { id: 'R2', priceCents: 99 }] }, '/other': { records: [{ id: 'R3', priceCents: 3075 }] }, '/invalid': { records: [{ id: 'BAD', priceCents: 'oops' }] } };\n    const data = entries[req.url];\n    res.writeHead(data ? 200 : 503, { 'Content-Type': 'application/json' });\n    res.end(JSON.stringify(data ?? { error: 'upstream unavailable' }));\n  });\n  const { promise, resolve } = Promise.withResolvers();\n  server.listen(0, '127.0.0.1', () => resolve(server));\n  return promise;\n}\n" },
  },
  {
    id: "pipeline", name: "단계 분기·결과 전달 작업",
    description: "격리 Node.js CLI에서 node main.mjs pipeline <입력파일경로> <출력파일경로>를 구현합니다. 입력은 JSON 배열 {id,quantity,unitPrice,approved}입니다. 순서: 입력 읽기→각 필수 필드·정수 검증→quantity*unitPrice 계산→approved true인 건만 output의 approved에 {id,total}로 전달하고 false인 건은 held에 {id,total}로 보류→결과 JSON {approved,held}를 출력 파일에 쓰고 stdout에도 같은 JSON을 반환합니다. 입력 잘못되면 nonzero exit이며 기존 출력 파일을 덮지 않습니다. 다른 입력으로 재실행 시 이전 결과를 재사용하지 않고 갱신합니다. 보류 건을 임의 승인하지 않습니다. Node.js 내장 모듈만, 실제 샘플·계약 확인, Git push·배포 금지.",
    details: { cycle: "담당자 요청 시", minutesPerRun: 5, runsPerMonth: 5, systems: "로컬 Node.js CLI, JSON 파일", inputs: "id,quantity,unitPrice,approved가 있는 JSON 배열", outputs: "approved/held로 분기된 계산 결과 JSON 파일과 stdout", humanSteps: "approved=false인 건은 담당자가 승인 판단; 자동 승인 제외" },
    files: { "input-a.json": JSON.stringify([{ id: "X", quantity: 3, unitPrice: 4, approved: true }, { id: "Y", quantity: 2, unitPrice: 7, approved: false }]), "input-b.json": JSON.stringify([{ id: "Z", quantity: 5, unitPrice: 8, approved: true }]), "input-bad.json": JSON.stringify([{ id: "ERR", quantity: "?", unitPrice: 8, approved: true }]), "contract.json": JSON.stringify({ command: "node main.mjs pipeline <input> <output>", output: "JSON {approved:[{id,total}],held:[{id,total}]} on stdout and output file", framework: "Node.js built-ins only" }, null, 2) },
  },
  {
    id: "hitl", name: "확정 범위만 적용하는 복합 검토 대장",
    description: "격리 Node.js CLI에서 node main.mjs hitl <입력파일경로>로 JSON 배열을 읽어 {candidates,held} JSON을 stdout에 표시합니다. 입력 records는 {id,amount,decision}이며 decision enum은 keep,hold,exclude,amend,unconfirmed-essential입니다. keep은 원본 금액의 후보만 생성; amend는 confirmedAmount 정수가 있는 경우에만 수정된 금액 후보를 생성; hold·unconfirmed-essential은 held로 표시; exclude는 후보에서 제외합니다. 중복 id와 불법값은 nonzero exit; 후보는 아직 확정·게시·전송하지 않습니다. WorkLens의 실제 HITL 검토는 진단·계획 원본에 연결된 keep/defer/exclude/supplement 및 pending/confirmed 상태로 별도 저장됩니다. 평가기가 생성한 실제 HITL 검토 결과 중 확인된 항목만 적용하고 미확정 필수 항목은 확정된 것으로 주장하지 마세요. 이 decision 데이터는 격리 업무의 개별 기록에 대한 입력이지 WorkLens HITL review action의 이름을 바꾸는 것이 아닙니다. 원본 fixture 확인, Node.js 내장 모듈만, 배포·Git push 금지.",
    details: { cycle: "담당자 요청 시", minutesPerRun: 5, runsPerMonth: 5, systems: "로컬 Node.js CLI, 검토 JSON 파일", inputs: "id,amount,decision; amend의 confirmedAmount", outputs: "승인 전 candidates 및 보류 held JSON", humanSteps: "hold/unconfirmed-essential은 담당자 확인 전 반영 금지; exclude 제외; 수정값은 담당자 확정한 값만 사용; 후보 최종 확정은 담당자" },
    files: { "input-a.json": JSON.stringify([{ id: "K", amount: 10, decision: "keep" }, { id: "H", amount: 20, decision: "hold" }, { id: "E", amount: 30, decision: "exclude" }, { id: "A", amount: 40, confirmedAmount: 45, decision: "amend" }, { id: "U", amount: 50, decision: "unconfirmed-essential" }]), "input-b.json": JSON.stringify([{ id: "T", amount: 72, decision: "keep" }, { id: "B", amount: 12, decision: "amend", confirmedAmount: 7 }]), "input-bad.json": JSON.stringify([{ id: "A", amount: 12, decision: "amend" }]), "contract.json": JSON.stringify({ command: "node main.mjs hitl <input>", output: "JSON {candidates:[{id,amount}],held:[{id,amount}]} (held decisions hold/unconfirmed-essential)", framework: "Node.js built-ins only" }, null, 2) },
  },
];
