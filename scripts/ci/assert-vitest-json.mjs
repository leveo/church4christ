import { readFileSync } from 'node:fs';

const [, , reportPath, minimumArg = '1'] = process.argv;
if (!reportPath) throw new Error('usage: assert-vitest-json.mjs <report.json> [minimum-passes]');

const minimum = Number(minimumArg);
if (!Number.isSafeInteger(minimum) || minimum < 1) {
  throw new Error(`minimum-passes must be a positive integer, received ${JSON.stringify(minimumArg)}`);
}

const report = JSON.parse(readFileSync(reportPath, 'utf8'));
if (
  report === null ||
  typeof report !== 'object' ||
  Array.isArray(report) ||
  Object.getPrototypeOf(report) !== Object.prototype
) {
  throw new Error('Vitest report must be a plain JSON object');
}

function nonNegativeInteger(field, { optional = false } = {}) {
  if (!Object.hasOwn(report, field)) {
    if (optional) return 0;
    throw new Error(`Vitest report is missing required counter ${field}`);
  }
  const value = report[field];
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Vitest report counter ${field} must be a non-negative integer`);
  }
  return value;
}

const passed = nonNegativeInteger('numPassedTests');
const failed = nonNegativeInteger('numFailedTests');
const pending = nonNegativeInteger('numPendingTests');
const todo = nonNegativeInteger('numTodoTests', { optional: true });
const total = nonNegativeInteger('numTotalTests');

if (total !== passed + failed + pending + todo) {
  throw new Error(
    `Vitest report total ${total} does not equal passed + failed + pending + todo (${passed + failed + pending + todo})`,
  );
}

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
