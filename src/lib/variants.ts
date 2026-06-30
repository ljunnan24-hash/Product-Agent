import type { ProductVariantId } from "./types";

export type ProductVariantConfig = {
  id: ProductVariantId;
  path: string;
  navLabel: string;
  title: string;
  subtitle: string;
  cta: string;
  tone: "sharp" | "warm" | "curatorial" | "practical";
  reportEmphasis: "problems" | "growth" | "references" | "fixes";
  shareCardTitle: string;
};

export const variants: Record<ProductVariantId, ProductVariantConfig> = {
  roast: {
    id: "roast",
    path: "/roast",
    navLabel: "诊断",
    title: "Product Agent",
    subtitle: "上传材料，判断产品潜力。",
    cta: "开始诊断",
    tone: "sharp",
    reportEmphasis: "problems",
    shareCardTitle: "Product Diagnosis"
  },
  coach: {
    id: "coach",
    path: "/coach",
    navLabel: "诊断",
    title: "Product Agent",
    subtitle: "上传材料，判断产品潜力。",
    cta: "开始诊断",
    tone: "warm",
    reportEmphasis: "growth",
    shareCardTitle: "Product Diagnosis"
  },
  "reference-finder": {
    id: "reference-finder",
    path: "/reference-finder",
    navLabel: "诊断",
    title: "Product Agent",
    subtitle: "上传材料，判断产品潜力。",
    cta: "开始诊断",
    tone: "curatorial",
    reportEmphasis: "references",
    shareCardTitle: "Product Diagnosis"
  },
  "redesign-advisor": {
    id: "redesign-advisor",
    path: "/redesign-advisor",
    navLabel: "诊断",
    title: "Product Agent",
    subtitle: "上传材料，判断产品潜力。",
    cta: "开始诊断",
    tone: "practical",
    reportEmphasis: "fixes",
    shareCardTitle: "Product Diagnosis"
  }
};

export const defaultVariant = variants.coach;

export function getVariant(id?: string | null) {
  if (id && id in variants) {
    return variants[id as ProductVariantId];
  }

  return defaultVariant;
}

export const workTypeOptions = [
  { value: "landing_page", label: "Landing page" },
  { value: "app_screen", label: "App 截图" },
  { value: "brand_visual", label: "Logo / Brand" },
  { value: "poster_social", label: "海报 / 社媒图" },
  { value: "ai_image", label: "AI 生成图" },
  { value: "pitch_deck", label: "Pitch deck" },
  { value: "product_brief_pdf", label: "产品介绍 PDF" },
  { value: "readme", label: "README" },
  { value: "other", label: "其他" }
] as const;
