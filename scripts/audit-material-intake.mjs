import { runMaterialIntakeCalibration } from "../src/lib/material-intake-calibration.ts";

const { passed, results } = await runMaterialIntakeCalibration();

console.table(
  results.map((result) => ({
    id: result.id,
    category: result.category,
    expected: result.expectedReady ? "ready" : "ask",
    actual: result.actualReady ? "ready" : "ask",
    chars: result.charCount,
    specificity: result.specificityScore,
    passed: result.passed ? "yes" : "no"
  }))
);

const failed = results.filter((result) => !result.passed);

if (failed.length) {
  console.error(`\nMaterial intake calibration failed: ${failed.length}/${results.length}`);
  for (const result of failed) {
    console.error(`\n${result.id} · ${result.title}`);
    for (const failure of result.failures) {
      console.error(`- ${failure}`);
    }
    console.error(`question: ${result.question}`);
    console.error(`missing: ${result.missing.join("、") || "none"}`);
  }
  process.exit(1);
}

console.log(`\nMaterial intake calibration passed: ${results.length}/${results.length}`);
