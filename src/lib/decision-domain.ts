export const DECISION_DOMAINS = [
  { value: "precedent", label: "판례" },
  { value: "constitutional", label: "헌재 결정례" },
  { value: "admin_appeal", label: "행정심판례" },
  { value: "interpretation", label: "법령해석례" },
  { value: "tax_tribunal", label: "조세심판원 재결례" },
  { value: "customs", label: "관세청 법령해석" },
  { value: "nts", label: "국세청 법령해석" },
  { value: "ftc", label: "공정위 결정문" },
  { value: "pipc", label: "개인정보위 결정문" },
  { value: "nlrc", label: "노동위 결정문" },
  { value: "acr", label: "권익위 결정문" },
  { value: "appeal_review", label: "소청심사 재결례" },
  { value: "acr_special", label: "권익위 특별행정심판" },
] as const;

export type DecisionDomain = (typeof DECISION_DOMAINS)[number]["value"];
