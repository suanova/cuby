import { z } from "zod";
import { ConsistencySlotSchema, ConsistencySourceSlotSchema, ConsistencyComparisonSchema, ConsistencyRunSchema } from "./finance-consistency.js";

export const FinanceReviewPathSchema = z
  .string()
  .max(240)
  .regex(/^outputs\/c2-reviews\/[A-Za-z0-9_-]+\/review\.json$/);
const ShaSchema = z.string().regex(/^[a-f0-9]{64}$/);
const PeriodSchema = z.object({
  fiscal_year: z.string(),
  start: z.string(),
  end: z.string(),
  scenario_assumption: z.boolean(),
});
const SourceSchema = z.object({
  file_name: z.string(),
  report_fiscal_year: z.string(),
  sha256: ShaSchema,
  language: z.string(),
  synthetic: z.boolean().optional(),
});
export const FinanceCatalogSchema = z.object({
  reviews: z.array(
    z.object({
      label: z.string(),
      review_path: FinanceReviewPathSchema,
      review_sha256: ShaSchema,
      source: SourceSchema,
      mode: z.enum(["same_year", "next_year_readiness"]),
      target_period: PeriodSchema,
      check_count: z.number().int(),
    }),
  ),
  unavailable: z.array(z.string()),
  scope: z.string(),
});
export const FinanceReaderSchema = z.object({
  schema_version: z.literal("financebuddy-reader-1"),
  review_sha256: ShaSchema,
  source: SourceSchema,
  mode: z.enum(["same_year", "next_year_readiness"]),
  target_period: PeriodSchema,
  rules: z.object({
    status: z.string(),
    checked_at: z.string(),
    scope: z.string(),
  }),
  status_counts: z.record(z.string(), z.number()),
  checks: z.array(
    z.object({
      id: z.string(),
      label: z.string(),
      status: z.string(),
      reason: z.string(),
      next_action: z.string(),
      clause: z.string(),
      rule_quote: z.string(),
      actual_pdf_page: z.number().int().positive(),
      kind: z.string(),
      finding: z
        .object({
          level: z.enum(["error", "review", "suggestion", "evidence"]),
          title: z.string(),
          summary: z.string(),
          marks: z.array(
            z.object({
              page: z.number().int().positive(),
              rects: z.array(
                z.tuple([z.number(), z.number(), z.number(), z.number()]),
              ),
              empty: z.boolean().optional(),
            }),
          ),
          edit: z
            .object({
              kind: z.enum(["replace", "insert"]),
              page: z.number().int().positive(),
              evidence_id: z.string(),
              original: z.string(),
              suggested: z.string(),
              requires_confirmation: z.boolean(),
            })
            .nullable(),
        })
        .optional(),
    }),
  ),
  anchors: z.record(
    z.string(),
    z.array(
      z.object({
        id: z.string(),
        page: z.number().int().positive(),
        quote: z.string(),
        evidence_id: z.string(),
        rects: z.array(
          z.tuple([z.number(), z.number(), z.number(), z.number()]),
        ),
        occurrences: z.number().int().nonnegative(),
        location_status: z.string(),
        context_only: z.boolean(),
      }),
    ),
  ),
  pages: z.array(
    z.object({
      number: z.number().int().positive(),
      width: z.number().positive(),
      height: z.number().positive(),
    }),
  ),
  rule_url: z.string().url().startsWith("https://"),
  exclusions: z.array(z.string()),
  human_review_notice: z.string(),
});
export const FinanceDecisionSchema = z.enum([
  "open",
  "confirmed_gap",
  "needs_data",
  "not_an_issue",
  "resolved",
]);
const NoteEntrySchema = z.object({
  check_id: z.string(),
  decision: FinanceDecisionSchema,
  note: z.string().max(2000),
  updated_at: z.string(),
});
export const FinanceNotesSchema = z.object({
  review_sha256: ShaSchema,
  revision: z.number().int().nonnegative(),
  decisions: z.record(z.string(), NoteEntrySchema),
  history: z.array(
    NoteEntrySchema.extend({ revision: z.number().int().positive() }),
  ),
});
export const FinanceNoteWriteSchema = z
  .object({
    expected_revision: z.number().int().nonnegative(),
    check_id: z.string().max(100),
    decision: FinanceDecisionSchema,
    note: z.string().max(2000),
  })
  .strict();
export const FinanceDraftSchema = z.object({
  review_sha256: ShaSchema,
  revision: z.number().int().nonnegative(),
  edits: z.array(
    z.object({
      id: z.string(),
      check_id: z.string(),
      kind: z.enum(["replace", "insert"]),
      page: z.number().int().positive(),
      original: z.string(),
      replacement: z.string(),
      active: z.boolean(),
      facts_confirmed: z.boolean(),
      accepted_at: z.string(),
      evidence_id: z.string(),
      rule: z.string(),
      review_sha256: ShaSchema,
      source_sha256: ShaSchema,
    }),
  ),
  history: z.array(
    z.object({
      revision: z.number().int().positive(),
      operation: z.enum(["accept", "undo"]),
      check_id: z.string(),
      at: z.string(),
    }),
  ),
});
export const FinanceDraftExportSchema = z.object({
  review_sha256: ShaSchema,
  draft: FinanceDraftSchema,
  text: z.string(),
  pages: z.array(
    z.object({ number: z.number().int().positive(), text: z.string() }),
  ),
});
export const FinanceRequestSchema = z.discriminatedUnion("action", [
  z.object({action:z.literal("consistency-build"),fiscal_year:z.string().regex(/^20\d{2}\/\d{2}$/),
    comparisons:z.array(ConsistencyComparisonSchema).min(1).max(4).optional(),
    documents:z.array(z.object({slot:ConsistencySlotSchema,path:z.string().max(4096)}).strict()).length(4).optional()}).strict(),
  z.object({action:z.literal("consistency-read"),run_id:ConsistencyRunSchema}).strict(),
  z.object({action:z.literal("consistency-semantic-start"),run_id:ConsistencyRunSchema}).strict(),
  z.object({action:z.literal("consistency-page"),run_id:ConsistencyRunSchema,slot:ConsistencySourceSlotSchema,
    page:z.number().int().min(1).max(300),check_id:z.string().max(180).optional()}).strict(),
  z
    .object({
      action: z.literal("open"),
      review_path: FinanceReviewPathSchema,
      artifact_path: z.string().min(1).max(4096).optional(),
    })
    .strict(),
  z
    .object({
      action: z.enum([
        "review",
        "decisions",
        "notes-export",
        "checklist-export",
        "requests-export",
        "drafts",
        "draft-export",
      ]),
      handle: z.string().uuid(),
    })
    .strict(),
  z
    .object({
      action: z.literal("draft-save"),
      handle: z.string().uuid(),
      value: z
        .object({
          expected_revision: z.number().int().nonnegative(),
          check_id: z.string().max(100),
          operation: z.enum(["accept", "undo"]),
          replacement: z.string().max(3000).optional(),
          facts_confirmed: z.boolean().optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      action: z.enum(["page", "rule"]),
      handle: z.string().uuid(),
      page: z.number().int().min(1).max(999),
    })
    .strict(),
  z
    .object({
      action: z.literal("save"),
      handle: z.string().uuid(),
      value: FinanceNoteWriteSchema,
    })
    .strict(),
]);
export const FinanceOpenSchema = z.object({
  handle: z.string().uuid(),
  review: FinanceReaderSchema,
  notes: FinanceNotesSchema,
});
export type FinanceReader = z.infer<typeof FinanceReaderSchema>;
export type FinanceCatalog = z.infer<typeof FinanceCatalogSchema>;
export type FinanceNotes = z.infer<typeof FinanceNotesSchema>;
export type FinanceRequest = z.infer<typeof FinanceRequestSchema>;
export type FinanceNoteWrite = z.infer<typeof FinanceNoteWriteSchema>;
export type FinanceOpen = z.infer<typeof FinanceOpenSchema>;
export type FinanceDraft = z.infer<typeof FinanceDraftSchema>;
