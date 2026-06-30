import { z } from "zod";

export const productDiagnosisReportSchema = z.object({
  diagnosis_score: z.number().int().min(0).max(100),
  potential_score: z.number().int().min(0).max(100),
  potential_verdict: z.string().min(12),
  first_impression: z.string().min(20),
  diagnosis_tags: z.array(z.string().min(1)).min(3).max(6),
  market_evidence: z
    .array(
      z.object({
        signal: z.string().min(2),
        evidence: z.string().min(6),
        interpretation: z.string().min(4)
      })
    )
    .min(3)
    .max(6),
  top_issues: z
    .array(
      z.object({
        title: z.string().min(3),
        why_it_matters: z.string().min(20),
        how_to_fix: z.string().min(20)
      })
    )
    .min(3)
    .max(5),
  references: z
    .array(
      z.object({
        name: z.string().min(1),
        category: z.string().min(1),
        why_relevant: z.string().min(8),
        what_to_learn: z.string().min(8)
      })
    )
    .min(3)
    .max(5),
  actionable_suggestions: z.array(z.string().min(12)).min(5).max(10),
  share_summary: z.object({
    current_style: z.string().min(2),
    main_problem: z.string().min(6),
    recommended_references: z.string().min(2),
    one_line_diagnosis: z.string().min(12)
  }),
  limitations: z.array(z.string()).default([])
});

export const tasteReportSchema = productDiagnosisReportSchema;
