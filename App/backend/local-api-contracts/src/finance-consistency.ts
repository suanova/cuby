import { z } from "zod";
export const ConsistencySlotSchema = z.enum(["esg_zh", "esg_en", "annual_zh", "annual_en"]);
export const ConsistencySourceSlotSchema = z.enum(["esg_zh", "esg_en", "annual_zh", "annual_en", "prior_esg_zh", "prior_esg_en", "prior_annual_zh", "prior_annual_en"]);
export const ConsistencyComparisonSchema = z.enum(["bilingual", "cross_report", "internal", "restatement"]);
export const ConsistencyRunSchema = z.string().regex(/^\d{8}T\d{6}-[a-f0-9]{8}$/);
export const ConsistencyReportSchema = z.object({
  schema_version: z.literal("financebuddy-consistency-1"),
  run_id: ConsistencyRunSchema,
  fiscal_year: z.string(),
  created_at: z.string(),
  documents: z.array(z.object({
    slot: ConsistencySourceSlotSchema, label: z.string(), file_name: z.string(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/), page_count: z.number().int().positive(),
    cover_year_found: z.boolean(), identity_confirmed: z.boolean(), textless_pages: z.array(z.number().int()),
    source_id:z.string().optional(),source_url:z.string().optional(),authority:z.string().optional(),fiscal_year:z.string().optional(),
  })).min(4).max(8),
  comparisons:z.array(ConsistencyComparisonSchema),
  history:z.object({status:z.enum(["ready","unavailable","not_requested"]),fiscal_year:z.string(),source:z.string(),reason:z.string().optional(),catalog_revision:z.string().optional()}),
  checks: z.array(z.object({
    id: z.string(), category: z.enum(["metric", "page_numbers", "basis", "cross_report", "internal", "restatement"]),
    status: z.enum(["matched", "difference", "pending"]), title: z.string(), reason: z.string(),
    refs: z.array(z.object({slot: ConsistencySourceSlotSchema, page: z.number().int().positive(),
      quote: z.string(), value: z.string().optional(), unit: z.string().optional(),unit_basis:z.string().optional()})),
    left_only: z.array(z.string()).optional(), right_only: z.array(z.string()).optional(),
  })),
  coverage: z.object({scanned_pages:z.number(),page_pairs:z.number(),same_numeric_inventory_pages:z.number(),
    metric_checks:z.number(),numeric_facts:z.number(),matched:z.number(),differences:z.number(),pending:z.number(),
    historical_pages:z.number(),internal_checks:z.number(),restatement_checks:z.number()}),
  all_numbers_confirmed: z.literal(false), all_basis_confirmed: z.literal(false), limits: z.array(z.string()),
});
export type ConsistencyReport = z.infer<typeof ConsistencyReportSchema>;
export type ConsistencySlot = z.infer<typeof ConsistencySlotSchema>;
export type ConsistencySourceSlot = z.infer<typeof ConsistencySourceSlotSchema>;
export type ConsistencyComparison = z.infer<typeof ConsistencyComparisonSchema>;
