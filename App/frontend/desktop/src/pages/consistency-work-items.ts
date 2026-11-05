import type { ConsistencyEditor, ConsistencyReport } from "@memmy/local-api-contracts";
import { reviewAction } from "./consistency-actions.js";

type Check = ConsistencyReport["checks"][number];
const normalized = (text: string) => text.replace(/\s+/g, " ").trim();
function sameEvidence(left: Check, right: Check) {
  const covered = (a: Check, b: Check) => a.refs.every(ref => b.refs.some(other => {
    if (ref.slot !== other.slot || ref.page !== other.page) return false;
    const x = ref.quote.replace(/\s+/g, ""), y = other.quote.replace(/\s+/g, "");
    return !!x && !!y && (x === y || Math.min(x.length, y.length) >= 12 && (x.includes(y) || y.includes(x)));
  }));
  return covered(left, right) && covered(right, left);
}

/** Merge only identical issue wording at the same sources. Original verdicts stay intact. */
export function consistencyWorkItems(checks: Check[], editor: ConsistencyEditor | null) {
  const groups = new Map<string, Check[][]>();
  for (const check of checks) {
    const copy = check.reader_copy;
    const key = !reviewAction(check, editor?.proposals[check.id]) || !check.refs.length ? check.id : JSON.stringify([
      normalized(copy?.title ?? check.title), normalized(copy?.problem ?? check.reason),
      check.regulatory?.clause ?? "", copy ? "" : check.refs.map(r => normalized(r.quote)).sort(),
      [...new Set(check.refs.map(r => `${r.slot}:${r.page}`))].sort()
    ]);
    const candidates = groups.get(key) ?? [];
    const group = candidates.find(members => sameEvidence(members[0]!, check));
    if (group) group.push(check); else candidates.push([check]);
    groups.set(key, candidates);
  }
  return [...groups.values()].flat().map(members => {
    // Reuse the real decision owner, so undo never targets an alias. Apply one
    // proposal only; accepting duplicate replacements would overlap in the PDF.
    const decided = members.filter(c => editor?.decisions[c.id]).sort((a, b) =>
      editor!.decisions[b.id]!.at.localeCompare(editor!.decisions[a.id]!.at));
    const check = decided[0] ?? members.find(c => {
      const p = editor?.proposals[c.id]; return p?.status === "ready" && !!p.edits?.length;
    }) ?? members.find(c => editor?.proposals[c.id]?.status === "ready") ?? members[0]!;
    return { check, members };
  });
}
