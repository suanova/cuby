import { z } from "zod";
import { ConsistencySlotSchema, ConsistencyReportSchema } from "./finance-consistency.js";

export const FinanceProjectIdSchema=z.string().regex(/^[a-f0-9]{32}$/);
export const FinanceProjectSchema=z.object({id:FinanceProjectIdSchema,title:z.string(),external_id:z.string().nullable(),revision:z.number().int(),
  active_version:z.string().optional(),latest_run:z.string().nullable(),created_at:z.string(),updated_at:z.string(),
  versions:z.array(z.object({id:z.string(),fiscal_year:z.string(),created_at:z.string(),runs:z.array(z.string()),
    documents:z.array(z.object({slot:ConsistencySlotSchema,file_name:z.string(),sha256:z.string(),bytes:z.number()}))}))});
export const FinanceProjectListSchema=z.object({projects:z.array(FinanceProjectSchema)});
export const FinanceProjectBuildSchema=z.object({project:FinanceProjectSchema,report:ConsistencyReportSchema});
export const FinanceReviewBindingSchema=z.object({project_id:FinanceProjectIdSchema,native_project_id:z.string().min(1),run_id:z.string().regex(/^\d{8}T\d{6}-[a-f0-9]{8}$/),session_key:z.string().regex(/^websocket:fin_[a-f0-9]{32}$/),chat_id:z.string().regex(/^fin_[a-f0-9]{32}$/)});
export const FinanceSessionReviewSchema=z.object({binding:FinanceReviewBindingSchema.nullable()});
export type FinanceReviewBinding=z.infer<typeof FinanceReviewBindingSchema>;
export const ConsistencyEditSchema=z.object({slot:ConsistencySlotSchema,page:z.number().int().positive(),original:z.string().min(12).max(1800),replacement:z.string().min(1).max(3000)}).strict();
export const ConsistencyEditorSchema=z.object({run_id:z.string(),base_sha256:z.string(),revision:z.number().int(),
  proposals:z.record(z.string(),z.object({id:z.string(),status:z.enum(["generating","ready","failed"]),updated_at:z.string(),summary:z.string().optional(),
    requires_confirmation:z.boolean().optional(),confirmation_prompt:z.string().optional(),edits:z.array(ConsistencyEditSchema).optional(),error:z.string().optional(),model:z.string().optional(),reasoning_effort:z.string().optional()})),
  decisions:z.record(z.string(),z.object({status:z.enum(["accepted","dismissed"]),edits:z.array(ConsistencyEditSchema),at:z.string(),proposal_id:z.string().optional(),facts_confirmed:z.boolean().optional()})),
  history:z.array(z.unknown())});
export const ConsistencyExportSchema=z.object({file_name:z.string().regex(/^[A-Za-z0-9_.-]+$/),
  mime:z.enum(["application/zip","application/pdf"]),download_id:z.string().uuid(),bytes:z.number().int().positive().max(128*1024*1024),
  sha256:z.string().regex(/^[a-f0-9]{64}$/),revision:z.number().int().nonnegative(),accepted:z.number().int().nonnegative(),layout_notice:z.string().max(500)});
export type FinanceProject=z.infer<typeof FinanceProjectSchema>;
export type ConsistencyEditor=z.infer<typeof ConsistencyEditorSchema>;
export type ConsistencyEdit=z.infer<typeof ConsistencyEditSchema>;
