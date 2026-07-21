/**
 * Plain-JS model of the boolean check the "gate" job in
 * .github/workflows/ci.yml runs against `needs.<job>.result` for every job
 * it depends on: every one of those results has to be the literal string
 * "success" - a job that got skipped or cancelled does not count, even
 * though neither of those is a "failure" either (GitHub Actions has
 * historically treated a skipped required check as passing, which is
 * exactly the hole this closes).
 *
 * This mirrors, in a form a fast local test can drive with synthetic
 * inputs, the same equality-only-on-"success" logic the workflow's own
 * GitHub Actions expression performs. The two have to be kept in sync by
 * hand; scripts/verify-workflow-topology.mjs is what checks the workflow
 * file itself still contains that literal equality check for every
 * dependency.
 *
 * @param {Record<string, string>} results job id -> its `needs.*.result`
 * @returns {boolean} true only if every result is literally "success"
 */
export function allJobsSucceeded(results) {
  const values = Object.values(results);
  if (values.length === 0) {
    return false;
  }
  return values.every((result) => result === "success");
}
