/**
 * Documents that differ in type, structure and wording from tests/fixtures/contracts.ts,
 * used to check classification and detection across document kinds.
 */

/** Remote work and attendance rules, numbered with `제1조.` and no markdown. */
export const REMOTE_WORK_GUIDELINE = [
  "재택근무 및 근태관리 지침",
  "제1조. 목적",
  "이 지침은 직원의 재택근무와 근태관리 기준을 정한다.",
  "제2조. 근무시간",
  "재택근무 직원의 근무시간은 오전 9시부터 오후 6시까지로 하며 휴게시간은 1시간으로 한다.",
  "회사가 허가하지 아니한 초과근무는 근무시간으로 보지 아니하며 초과근무 수당 지급 대상에서 제외한다.",
  "제3조. 근태 확인",
  "회사는 근태 확인을 위하여 업무용 PC의 로그인 기록과 화면 캡처를 수집하고 이를 인사평가에 반영할 수 있다.",
  "제4조. 휴가",
  "직원이 신청한 연차는 부서 사정에 따라 사용이 제한될 수 있으며, 연말까지 사용하지 않은 연차는 자동으로 소멸한다.",
  "제5조. 지침의 개정",
  "회사는 필요한 경우 이 지침을 변경할 수 있으며, 게시 후 7일 이내에 이의를 제기하지 않으면 변경에 동의한 것으로 본다.",
].join("\n");

/** Staff privacy and CCTV rules written as bulleted sections without article numbers. */
export const PRIVACY_CCTV_GUIDELINE = [
  "임직원 개인정보 및 영상정보 운영 규정",
  "적용 범위",
  "이 규정은 회사의 전 임직원에게 적용한다.",
  "영상정보처리기기",
  "회사는 출입구와 사무실에 CCTV를 설치하여 직원의 근무태도를 확인할 수 있다.",
  "영상정보처리기기에는 음성 녹음 기능을 함께 사용할 수 있다.",
  "개인정보의 처리",
  "회사는 직원의 개인정보를 계열사 및 협력업체에 제공할 수 있다.",
  "직원의 개인정보는 해외 데이터센터에 보관될 수 있다.",
  "퇴직자의 개인정보는 회사가 필요하다고 판단하는 기간 동안 보관한다.",
  "징계",
  "개인정보를 무단으로 반출한 직원은 소명 기회 없이 징계할 수 있다.",
].join("\n");

/** An employment contract phrased differently from EMPLOYMENT_CONTRACT. */
export const EMPLOYMENT_CONTRACT_2 = [
  "표준 근로계약서(기간의 정함이 없는 경우)",
  "㈜가상유통(이하 \"사용자\")과 김근로(이하 \"근로자\")는 아래와 같이 근로계약을 체결한다.",
  "제1조(근무장소 및 업무) 근무장소는 본사 물류센터로 하며 업무는 재고관리로 한다.",
  "제2조(소정근로시간) 소정근로시간은 1일 8시간, 1주 40시간으로 한다.",
  "제3조(임금) 월 기본급은 2,600,000원으로 하며 매월 25일에 지급한다.",
  "제4조(연장근로) 사용자의 승인 없이 한 연장근로에 대하여는 연장근로수당을 지급하지 않는다.",
  "제5조(해고) 근로자가 회사 자산을 무단 반출한 경우 사용자는 예고 없이 즉시 해고할 수 있다.",
].join("\n");

/** Ordinary work rules with no clause worth a review point. */
export const CLEAN_WORK_RULES = [
  "복무규정",
  "제1조(목적) 이 규정은 직원의 복무에 관한 기본 사항을 정한다.",
  "제2조(근무시간) 직원의 근무시간과 휴게시간은 근로기준법 및 취업규칙에 따른다.",
  "제3조(연차휴가) 연차휴가는 근로기준법에 따라 부여하며 미사용 연차에 대하여는 법령에 따라 수당을 지급한다.",
  "제4조(개인정보) 회사는 직원의 개인정보 보호를 위해 접근권한을 최소화한다.",
  "제5조(징계) 징계는 인사위원회의 심의와 소명 절차를 거쳐 결정한다.",
].join("\n");

/** A general notice that is neither a contract nor staff rules. */
export const AMBIGUOUS_NOTICE = [
  "사무실 이전 안내",
  "제1조(일정) 사무실은 2026년 11월 2일에 새 건물로 이전한다.",
  "제2조(준비) 각 부서는 이전 전날까지 개인 물품을 정리한다.",
  "제3조(문의) 이전과 관련한 문의는 총무팀으로 한다.",
].join("\n");
