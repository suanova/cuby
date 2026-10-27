import type { FinanceReader } from "@memmy/local-api-contracts";
export const FINDING_LABELS = {
  error: "明確問題",
  review: "待確認",
  suggestion: "改善建議",
  evidence: "已有資料",
};
export type FindingLevel = keyof typeof FINDING_LABELS;
export type Check = FinanceReader["checks"][number];
export function findingOf(check: Check) {
  return (
    check.finding ?? {
      level: ([
        "evidence_present",
        "evidence_found_pending_review",
        "explanation_claim_pending_review",
      ].includes(check.status)
        ? "evidence"
        : "review") as FindingLevel,
      title: check.label,
      summary:
        check.status === "partially_disclosed"
          ? "已有部分披露，仍需確認。"
          : "請核對原文及適用條款。",
      marks: [],
      edit: null,
    }
  );
}
export const findingOrder = (check: Check) =>
  ({ error: 0, review: 1, suggestion: 2, evidence: 3 })[findingOf(check).level];
export function canAdopt(text: string, confirmed: boolean) {
  return (
    confirmed &&
    text.trim().length >= 12 &&
    text.length <= 3000 &&
    !/【|】|\[\s*(TODO|TBC)|待確認|待填|待補/i.test(text)
  );
}
