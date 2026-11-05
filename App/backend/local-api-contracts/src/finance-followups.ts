import { z } from "zod";
import { ConsistencyReportSchema, ConsistencyRunSchema } from "./finance-consistency.js";
import { FinanceProjectIdSchema } from "./finance-projects.js";

const Sha = z.string().regex(/^[a-f0-9]{64}$/);
const CheckId = z.string().min(1).max(180);
const SingleLine = (limit: number) => z.string().trim().max(limit).regex(/^[^\x00-\x1f\x7f]*$/);
const Owner = SingleLine(100).min(1);
const DueDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const parsed = new Date(value + "T00:00:00Z");
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}, "Invalid calendar date").nullable();
const Entered = {
  owner: Owner,
  due_date: DueDate,
  evidence_reference: SingleLine(1000),
  note: z.string().trim().max(2000).regex(/^[^\x00-\x08\x0b\x0c\x0e-\x1f\x7f]*$/),
};
const Context = { project_id: FinanceProjectIdSchema, version_id: z.string().regex(/^[a-f0-9]{32}$/), run_id: ConsistencyRunSchema };
const Expected = { expected_revision: z.number().int().nonnegative(), expected_binding_sha256: Sha };
export const ConsistencyFollowupStatusSchema = z.enum(["awaiting", "received_pending_review", "verified", "reopened"]);
export const ConsistencyFollowupOperationSchema = z.enum(["save", "receive", "verify", "reopen"]);
export const ConsistencyFollowupRecordSchema = z.object({
  check_id: CheckId, issue_sha256: Sha, ...Entered, status: ConsistencyFollowupStatusSchema,
  reviewer: Owner.nullable(), verified_at: z.string().datetime().nullable(), updated_at: z.string().datetime(),
}).strict().refine(value => value.status !== "verified" || !!(value.reviewer && value.verified_at && value.evidence_reference), "Verification requires evidence, reviewer and server time")
  .refine(value => value.status !== "received_pending_review" || !!value.evidence_reference, "Evidence receipt requires a reference");
const Ref = ConsistencyReportSchema.shape.checks.element.shape.refs.element.omit({ highlight_texts: true }).extend({ source_sha256: Sha });
export const ConsistencyFollowupIssueSchema = z.object({ check_id: CheckId, issue_sha256: Sha, title: z.string(), category: z.string(), refs: z.array(Ref) });
export const ConsistencyFollowupsSchema = z.object({
  schema_version: z.literal("financebuddy-followups-1"), ...Context,
  binding_status: z.enum(["current", "historical_unvalidated"]), binding_sha256: Sha,
  base_report_sha256: Sha, review_sha256: Sha, source_sha256: z.record(z.string(), Sha), revision: z.number().int().nonnegative(),
  issues: z.record(CheckId, ConsistencyFollowupIssueSchema), records: z.record(CheckId, ConsistencyFollowupRecordSchema),
  history: z.array(z.object({ revision: z.number().int().positive(), check_id: CheckId, operation: ConsistencyFollowupOperationSchema,
    at: z.string().datetime(), previous: ConsistencyFollowupRecordSchema.nullable(), record: ConsistencyFollowupRecordSchema }).strict()),
}).strict().superRefine((value, ctx) => {
  for (const [key, issue] of Object.entries(value.issues)) {
    if (key !== issue.check_id || issue.refs.some(ref => value.source_sha256[ref.slot] !== ref.source_sha256))
      ctx.addIssue({ code: "custom", path: ["issues", key], message: "Issue key or source binding mismatch" });
  }
  for (const [key, record] of Object.entries(value.records)) {
    if (key !== record.check_id || value.issues[key]?.issue_sha256 !== record.issue_sha256)
      ctx.addIssue({ code: "custom", path: ["records", key], message: "Record issue binding mismatch" });
  }
  if (value.history.length !== value.revision || value.history.some((event, index) => event.revision !== index + 1 || event.check_id !== event.record.check_id || value.issues[event.check_id]?.issue_sha256 !== event.record.issue_sha256))
    ctx.addIssue({ code: "custom", path: ["history"], message: "History revision or issue binding mismatch" });
});
export const ConsistencyFollowupsReadRequestSchema = z.object({ action: z.literal("consistency-followups"), ...Context, history_only: z.literal(true).optional() }).strict();
export const ConsistencyFollowupUpdateRequestSchema = z.object({
  action: z.literal("consistency-followup-update"), ...Context, ...Expected, check_id: CheckId,
  operation: ConsistencyFollowupOperationSchema, ...Entered, reviewer: Owner.optional(),
}).strict().superRefine((value, ctx) => {
  if (value.operation === "verify" ? !value.reviewer : value.reviewer !== undefined) ctx.addIssue({ code: "custom", path: ["reviewer"], message: "Reviewer is required only for explicit verification" });
  if ((value.operation === "receive" || value.operation === "verify") && !value.evidence_reference) ctx.addIssue({ code: "custom", path: ["evidence_reference"], message: "Evidence reference required" });
});
export const ConsistencyFollowupsExportRequestSchema = z.object({ action: z.literal("consistency-followups-export"), ...Context, ...Expected, check_ids: z.array(CheckId).max(1000).optional() }).strict();
export const ConsistencyFollowupsExportSchema = z.object({ file_name: z.string().regex(/^FinanceBuddy-followups-\d{4}-\d{2}\.csv$/), mime: z.literal("text/csv;charset=utf-8"), text: z.string().max(8 * 1024 * 1024), revision: z.number().int().nonnegative(), binding_sha256: Sha }).strict();
export type ConsistencyFollowups = z.infer<typeof ConsistencyFollowupsSchema>;
export type ConsistencyFollowupRecord = z.infer<typeof ConsistencyFollowupRecordSchema>;
export type ConsistencyFollowupOperation = z.infer<typeof ConsistencyFollowupOperationSchema>;
