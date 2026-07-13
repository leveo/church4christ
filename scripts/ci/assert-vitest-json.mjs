import { readFileSync } from 'node:fs';

const [, , reportPath, minimumArg = '1'] = process.argv;
if (!reportPath) throw new Error('usage: assert-vitest-json.mjs <report.json> [minimum-passes]');

const minimum = Number(minimumArg);
if (!Number.isSafeInteger(minimum) || minimum < 1) {
  throw new Error(`minimum-passes must be a positive integer, received ${JSON.stringify(minimumArg)}`);
}

const report = JSON.parse(readFileSync(reportPath, 'utf8'));
const passed = Number(report.numPassedTests ?? 0);
const failed = Number(report.numFailedTests ?? 0);
const pending = Number(report.numPendingTests ?? 0);
const todo = Number(report.numTodoTests ?? 0);

if (report.success !== true || failed !== 0) {
  throw new Error(`Vitest report is unsuccessful or contains ${failed} failed tests`);
}
if (!Number.isSafeInteger(passed) || passed < minimum) {
  throw new Error(`Vitest report executed ${passed} passing tests; ${minimum} required`);
}
if (pending !== 0 || todo !== 0) {
  throw new Error(`Vitest report contains ${pending} skipped and ${todo} todo tests`);
}

console.log(`verified ${passed} passing tests and zero skips`);
