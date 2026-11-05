import { z } from "zod";
import { ConsistencySlotSchema } from "./finance-consistency.js";

export const InputEvidenceSchema=z.object({page:z.number().int().min(1).max(300),quote:z.string().min(1).max(2000)});
export const InputFieldSchema=z.object({status:z.enum(["identified","ambiguous","unknown","unsupported"]),value:z.string().max(200).nullable(),evidence:z.array(InputEvidenceSchema).max(12),candidates:z.array(z.string().max(200)).max(12).optional()});
export const InputInspectionSchema=z.object({sha256:z.string().regex(/^[a-f0-9]{64}$/),bytes:z.number().int().positive().max(30*1024*1024),pages:z.number().int().min(0).max(300),file_name:z.string().max(200),
  fields:z.object({issuer:InputFieldSchema,fiscal_year:InputFieldSchema,kind:InputFieldSchema,language:InputFieldSchema}),slot:ConsistencySlotSchema.optional(),supported:z.boolean(),test_only:z.boolean(),scan_pages:z.array(z.number().int().min(1).max(300)).max(32),limits:z.array(z.string().max(1000)).max(20),period_start:z.string().optional(),period_end:z.string().optional(),inspection_id:z.string().uuid().optional()});
export const KnowledgeDocumentSchema=z.object({source_id:z.string().max(100),file_name:z.string().max(200),sha256:z.string().regex(/^[a-f0-9]{64}$/),fiscal_year:z.string().regex(/^20\d{2}\/\d{2}$/),kind:z.enum(["esg","annual"]),language:z.enum(["en","zh-Hant"]),original_status:z.enum(["verified","missing","hash_mismatch","unreadable","unavailable"]),indexed_status:z.enum(["verified","local_verified","not_checked","unavailable"]),reason:z.string().max(1000).optional()});
export const InputKnowledgeSchema=z.object({entity_id:z.literal("yeebo"),entity_name:z.string().max(200),observed_at:z.string().max(100),source_mode:z.literal("public_snapshot").optional(),catalog_revision:z.string().max(100),documents:z.array(KnowledgeDocumentSchema).max(64),error:z.string().max(1000).optional(),previous_year:z.string().optional()});
export type InputEvidence=z.infer<typeof InputEvidenceSchema>;
export type InputField=z.infer<typeof InputFieldSchema>;
export type InputInspection=z.infer<typeof InputInspectionSchema>;
export type KnowledgeDocument=z.infer<typeof KnowledgeDocumentSchema>;
export type InputKnowledge=z.infer<typeof InputKnowledgeSchema>;
