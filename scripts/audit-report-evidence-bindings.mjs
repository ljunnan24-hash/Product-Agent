import fs from "fs";
import path from "path";
import { buildReportEvidenceBindings } from "../src/lib/report-evidence-binding.ts";

const projectRoot = process.cwd();
const analysesDir = path.join(projectRoot, ".taste-data", "analyses");
const detailLimit = Number(process.env.DETAIL_LIMIT ?? 8);

if (!fs.existsSync(analysesDir)) {
  console.error(`No analyses directory found: ${analysesDir}`);
  process.exit(1);
}

const files = fs.readdirSync(analysesDir).filter((file) => file.endsWith(".json"));
const rows = [];
const findings = [];

for (const file of files) {
  const record = JSON.parse(fs.readFileSync(path.join(analysesDir, file), "utf8"));
  if (!record.report || !record.evidenceBrief?.evidenceCards?.length) continue;

  const evidenceCards = record.evidenceBrief.evidenceCards;
  const bindings = buildReportEvidenceBindings({
    report: record.report,
    evidenceBrief: record.evidenceBrief
  });
  const counts = { bound: 0, weak: 0, missing: 0 };
  for (const binding of bindings) counts[binding.status] += 1;

  const externalEvidenceCount = evidenceCards.filter(
    (card) => card.sourceType !== "uploaded_material"
  ).length;
  const gapBindingsMarkedBound = bindings.filter(
    (binding) => binding.status === "bound" && isGapClaim(binding.claimText)
  );
  const lowConfidenceBound = bindings.filter(
    (binding) => binding.status === "bound" && binding.confidence < 35
  );
  const overBound =
    counts.bound > 0 &&
    externalEvidenceCount <= 2 &&
    counts.bound > externalEvidenceCount + 1;

  rows.push({
    id: record.id.slice(0, 8),
    product: record.productName || record.evidenceBrief.productName || "Untitled",
    cards: evidenceCards.length,
    external: externalEvidenceCount,
    sections: bindings.length,
    bound: counts.bound,
    weak: counts.weak,
    missing: counts.missing,
    avgBindingConfidence: average(bindings.map((binding) => binding.confidence)),
    evidenceConfidence: record.evidenceBrief.confidenceScore ?? 0
  });

  if (overBound || gapBindingsMarkedBound.length || lowConfidenceBound.length) {
    findings.push({
      id: record.id,
      product: record.productName || record.evidenceBrief.productName || "Untitled",
      overBound,
      gapBindingsMarkedBound,
      lowConfidenceBound,
      bindings,
      cardsById: Object.fromEntries(evidenceCards.map((card) => [card.id, card]))
    });
  }
}

rows.sort((a, b) => b.bound - a.bound || b.missing - a.missing || b.cards - a.cards);
console.table(rows);

if (!findings.length) {
  console.log("\nNo suspicious evidence binding patterns found.");
  process.exit(0);
}

console.log(`\nSuspicious binding patterns (${findings.length} records):`);
for (const finding of findings.slice(0, detailLimit)) {
  console.log(`\n== ${finding.id} · ${finding.product} ==`);
  if (finding.overBound) {
    console.log("- possible over-binding: too many bound sections for very little external evidence");
  }
  for (const binding of [
    ...finding.gapBindingsMarkedBound,
    ...finding.lowConfidenceBound
  ].slice(0, detailLimit)) {
    console.log(`- [${binding.status} ${binding.confidence}] ${binding.targetLabel}`);
    console.log(`  claim: ${squash(binding.claimText, 180)}`);
    const evidenceIds = [
      ...binding.supportEvidenceIds,
      ...binding.oppositionEvidenceIds,
      ...binding.neutralEvidenceIds
    ];
    for (const evidenceId of evidenceIds.slice(0, 4)) {
      const card = finding.cardsById[evidenceId];
      if (!card) continue;
      console.log(
        `  evidence: ${card.assumptionId}/${card.direction}/${card.confidence} · ${card.sourceType} · ${squash(card.sourceTitle, 120)}`
      );
    }
  }
}

function isGapClaim(text) {
  return /缺失|未找到|没有|无外部|不足|失败|跳过|无法|缺少|待验证|unknown|insufficient|missing|failed|skipped/i.test(
    text
  );
}

function average(values) {
  if (!values.length) return 0;
  return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function squash(text, maxLength) {
  const value = String(text ?? "").replace(/\s+/g, " ").trim();
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}...` : value;
}
