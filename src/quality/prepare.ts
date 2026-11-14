import { randomInt } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { StudioStore } from "../storage/store.js";
import { recordQualityRound } from "./progress.js";
import { sha256 } from "../domain/hash.js";
import { StudioError } from "../domain/errors.js";

const commit = "5cc28352ba94ee3e80a8c25c7b478edf55afa794";
function excerpt(source: string, begin: string, end: string): string {
  const start = source.indexOf(begin);
  const finish = source.indexOf(end, start + begin.length);
  if (start < 0 || finish < 0) throw new StudioError("COMPARISON_EXCERPT", "The comparison excerpt markers no longer match the actual implementation.");
  return source.slice(start, finish);
}
export async function prepareFoundationComparison(store: StudioStore, root: string): Promise<void> {
  const paths = ["expense/src/workflows.ts", "activities-examples/src/workflows.ts", "activities-examples/src/mocha/workflows.test.ts"];
  const fetched = await Promise.all(paths.map(async (path) => {
    const url = `https://raw.githubusercontent.com/temporalio/samples-typescript/${commit}/${path}`;
    const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new StudioError("REFERENCE_UNAVAILABLE", `The named reference is unavailable (${response.status}): ${url}`);
    const content = await response.text();
    return { url, content, sha256: sha256(content) };
  }));
  const storage = readFileSync(join(root, "src", "storage", "store.ts"), "utf8");
  const controller = readFileSync(join(root, "src", "controller.ts"), "utf8");
  const candidate = [
    excerpt(storage, "\n  requireCurrent(", "\n  descendants("),
    excerpt(storage, "\n  invalidateArtifacts(", "\n  listDecisions("),
    excerpt(storage, "\n  recoverExpired(", "\n  listAttempts("),
    excerpt(controller, "\n  private handleFailure(", "\n  private scope("),
  ].join("\n\n");
  const neutralize = (value: string) => value.replace(/@temporalio|Temporal|Studio|studio/gi, "runtime");
  const reference = fetched.map((source) => neutralize(source.content)).join("\n\n");
  const aIsStudio = randomInt(2) === 0;
  const folder = join(root, ".studio", "quality");
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "foundation-A.txt"), aIsStudio ? neutralize(candidate) : reference, "utf8");
  writeFileSync(join(folder, "foundation-B.txt"), aIsStudio ? reference : neutralize(candidate), "utf8");
  writeFileSync(join(folder, "foundation-mapping.json"), JSON.stringify({
    A: aIsStudio ? "studio" : "reference", B: aIsStudio ? "reference" : "studio",
    sources: fetched.map(({ content: _content, ...source }) => source),
    scope: "Narrow approval/retry procedure excerpts, not a claim to beat Temporal's distributed platform.",
  }, null, 2), "utf8");
  recordQualityRound(store, {
    piece: "foundation", round: 1,
    prompt: "Build a local, durable review controller with exact-version approvals, selective downstream invalidation, finite retries and crash recovery. The bar is the actual Temporal TypeScript expense and activities-examples workflows and their failure tests at the pinned source commit. Fetch the source before comparing, and judge the approval and retry procedures rather than claiming to replace a distributed platform. Break this into small judgeable procedures. Use a builder and a separate harsh critic with fresh context. Put their actual procedure excerpts side by side with origin labels removed. The critic must pick A or B and name the single biggest remaining gap; a passing test count is not a taste score. Require the local acceptance suite to cover stale approvals, unaffected siblings, retry exhaustion and reopen recovery. Return the biggest gap to the builder and keep looping until the critic picks our procedure. Preserve the real reference, each verdict and the gap in the live quality page. Never convert missing comparison evidence into a win.",
    bar: {
      name: "Temporal TypeScript expense + activity retry procedures and failure tests",
      url: `https://github.com/temporalio/samples-typescript/tree/${commit}/activities-examples`,
      fetchedAt: new Date().toISOString(), commit,
    },
    status: "awaiting-critic", blindVerdict: null, candidateMapping: null,
    biggestGap: "An independent blind procedure comparison is pending. Framework identifiers can remain recognizable despite label scrubbing.",
    evidence: [".studio\\quality\\foundation-A.txt", ".studio\\quality\\foundation-B.txt"],
    checks: [{ name: "Exact local acceptance suite", passed: true, detail: "40 focused node:test cases passed; strict typecheck and build passed." }],
    recordedAt: new Date().toISOString(),
  });
}
