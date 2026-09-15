import type { CheckCode, CheckConfidence, CheckFinding, CheckSeverity } from "@/domain/operations";
import { makeFinding, type TextUnit } from "../types";

const INTERNAL_URL = /https?:\/\/(?:localhost|127(?:\.\d{1,3}){3}|10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}|[^\s/]+\.(?:internal|local))(?::\d+)?(?:\/[^\s]*)?/iu;
const SECRET = /\b(?:api[_ -]?key|access[_ -]?token|auth[_ -]?token|secret|password|passwd)\s*[:=]\s*["']?([A-Za-z0-9_\-./+=]{16,})["']?|\b(?:sk|pk)_(?:live|test)_[A-Za-z0-9]{16,}\b/iu;
const EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/iu;
const PHONE = /(?:\+?\d{1,3}[ .-])?(?:\(?\d{2,4}\)?[ .-])\d{3,4}[ .-]\d{4}\b/u;
const RESIDENT_REGISTRATION = /\b\d{6}\s*[-–]\s*[1-4]\d{6}\b/u;
const ACCOUNT_NUMBER = /(?:계좌(?:번호)?|account)\s*[:：]?\s*(\d{2,6}(?:[- ]\d{2,6}){2,5})/iu;
const EMPLOYEE_ID = /(?:사번|employee\s*id)\s*[:：#]?\s*([A-Z0-9][A-Z0-9_-]{3,11})\b/iu;
const SENSITIVE_ID = /\b\d{3}-\d{2}-\d{5}\b/u;
const IPV4 = /\b(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}\b/u;

/**
 * Privacy patterns are never suppressed by a dictionary: a protected product
 * name in the same sentence does not make a resident registration number safe.
 */
export function privacyFindings(unit: TextUnit): CheckFinding[] {
  const { text, source } = unit;
  const findings: CheckFinding[] = [];
  const add = (
    code: CheckCode,
    ruleId: string,
    severity: CheckSeverity,
    confidence: CheckConfidence,
    issue: string,
    match: string,
    recommendation: string,
  ) => findings.push(makeFinding({
    code,
    ruleId,
    category: "privacy",
    severity,
    confidence,
    issue,
    message: `${issue}: ${match}`,
    reason: "문서 내용이 정의된 민감정보 패턴과 일치합니다.",
    recommendation,
    sources: [source],
    originalText: match,
  }));

  const secret = text.match(SECRET)?.[0];
  if (secret) add("privacy-secret", "privacy/secret", "critical", "high", "인증정보 노출 가능성", secret, "즉시 토큰 또는 비밀번호를 폐기하고 문서에서 삭제하세요.");
  const resident = text.match(RESIDENT_REGISTRATION)?.[0];
  if (resident) add("privacy-resident-registration", "privacy/resident-registration", "critical", "high", "주민등록번호 형태", resident, "즉시 접근을 제한하고 식별번호를 삭제하거나 비식별화하세요.");
  const email = text.match(EMAIL)?.[0];
  if (email) add("privacy-email", "privacy/email", "warning", "high", "이메일 주소", email, "공유 범위를 확인하고 필요하면 이메일 주소를 마스킹하세요.");
  const phone = text.match(PHONE)?.[0];
  if (phone) add("privacy-phone", "privacy/phone", "warning", "high", "전화번호", phone, "업무상 필요 여부를 확인하고 필요하면 전화번호를 마스킹하세요.");
  const account = text.match(ACCOUNT_NUMBER)?.[0];
  if (account) add("privacy-account-number", "privacy/account-number", "warning", "medium", "계좌번호 가능성", account, "계좌번호가 필요한지 확인하고 외부 공유본에서는 마스킹하세요.");
  const employee = text.match(EMPLOYEE_ID)?.[0];
  if (employee) add("privacy-employee-id", "privacy/employee-id", "suggestion", "medium", "사번 가능성", employee, "사번이 개인 식별에 사용되는지 확인하고 필요하면 제거하세요.");
  const internalUrl = text.match(INTERNAL_URL)?.[0];
  if (internalUrl) add("privacy-internal-url", "privacy/internal-url", "warning", "high", "내부 URL", internalUrl, "내부 주소를 제거하거나 외부 공개 가능한 주소로 교체하세요.");
  const ip = !internalUrl ? text.match(IPV4)?.[0] : undefined;
  if (ip) add("privacy-ip-address", "privacy/ip-address", "suggestion", "medium", "IP 주소", ip, "공유 범위를 확인하고 내부 시스템 주소라면 마스킹하세요.");
  const sensitiveId = text.match(SENSITIVE_ID)?.[0];
  if (sensitiveId) add("privacy-sensitive-id", "privacy/sensitive-id", "suggestion", "low", "민감 식별번호 가능성", sensitiveId, "식별번호의 공개 필요성을 확인하고 필요하면 일부를 마스킹하세요.");
  return findings;
}
