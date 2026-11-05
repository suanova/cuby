import { consistencyCheckState, type ConsistencyEditor, type ConsistencyReport } from "@memmy/local-api-contracts";

export type ReviewAction = "edit" | "verify" | "supplement";
export const REVIEW_ACTIONS: readonly ReviewAction[] = ["edit", "verify", "supplement"];
export const REVIEW_ACTION_LABELS: Record<ReviewAction, string> = {
  edit: "修改文字", verify: "核實資料", supplement: "補充說明"
};
type Check = ConsistencyReport["checks"][number];
type Proposal = ConsistencyEditor["proposals"][string];

/** User actions are separate from the review verdict and never approve an edit. */
export function reviewAction(check: Check, proposal?: Proposal): ReviewAction | null {
  const outcome = check.regulatory?.outcome;
  if (outcome ? ["disclosed", "not_applicable", "not_reviewed"].includes(outcome)
    : !["difference", "needs_confirmation"].includes(consistencyCheckState(check))) return null;

  const preferred = check.reader_copy?.action_kind;
  // A conditional replacement must not be offered as a factually settled fix.
  if (preferred === "edit" && proposal?.status === "ready" && proposal.edits?.length && proposal.requires_confirmation) return "verify";
  if (preferred) return preferred;
  if (proposal?.status === "ready" && proposal.edits?.length) return proposal.requires_confirmation ? "verify" : "edit";
  if (outcome && ["not_located", "partially_disclosed", "external_evidence_needed"].includes(outcome)) return "supplement";
  if (outcome && ["applicability_pending", "explanation_claim"].includes(outcome)) return "verify";
  const next = check.reader_copy?.next_step || proposal?.confirmation_prompt || check.recommendation?.confirmation_prompt
    || check.regulatory?.action || check.reason;
  if (/請確認|請核實|請核對.*(?:是否|哪|正確)/.test(next)) return "verify";
  if (/補充|補上|請提供|請列明|請列出|換算依據|對賬/.test(next)) return "supplement";
  return "verify";
}
