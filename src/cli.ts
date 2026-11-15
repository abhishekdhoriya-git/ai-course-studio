import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { StudioApp } from "./app.js";
import { prepareFoundationComparison } from "./quality/prepare.js";
import { qualityRounds } from "./quality/progress.js";
import { createFixtureAdapters } from "./media/pipeline.js";
import { currentFixture, fixtureGates } from "./fixture.js";
import { artifactSchemas } from "./domain/schemas.js";
import { mediaCheckSchema } from "./media/contracts.js";

const require = createRequire(import.meta.url);
const command = process.argv[2];
const verification = process.argv.includes("--verification");
if (verification && command !== "render-fixture") throw new Error("Verification mode is only for the isolated engineering-fixture render.");
const app = await StudioApp.open({
  fixtureAdapters: createFixtureAdapters, ...(verification ? { dataDirectory: ".studio\\verification" } : {}),
});
try {
  switch (command) {
    case "skills-check":
      console.log(JSON.stringify(app.registry.list(), null, 2)); break;
    case "quality-prepare":
      await prepareFoundationComparison(app.store, app.root, Math.max(0, ...qualityRounds(app.store)
        .filter((round) => round.piece === "foundation").map((round) => round.round)) + 1);
      console.log("Fetched the pinned reference and prepared anonymous procedure packets. No critic win has been recorded.");
      break;
    case "fixture":
      await app.loadFixture();
      console.log("Engineering fixture created/updated as drafts. Review the current style/template and other exact input versions in the local UI; no approvals or pilot decisions were inferred.");
      break;
    case "render-fixture":
      if (verification) {
        await app.loadFixture();
        const plan = currentFixture(app.store)!;
        for (const gate of fixtureGates(app.store, plan).filter((item) => !item.approved)) app.store.recordDecision({
          artifactId: gate.ref.id, version: gate.ref.version, gate: gate.gate, decision: "approved",
          note: "ISOLATED TEST HARNESS ONLY: simulated fixture preflight; not owner approval of a real pilot or final lesson.",
        });
        console.log("Isolated fixture verification uses visibly marked test preflight decisions. No real pilot or final lesson is approved.");
      }
      {
        const id = app.renderFixture();
        await app.drain();
        const job = app.store.getJob(id)!;
        if (job.status === "failed" || !app.store.latestArtifact("fixture:output")) throw new Error(job.reason ?? "The fixture produced no actual verified output.");
        const report = app.store.latestArtifact("fixture:media-checks");
        if (!report || !app.store.isCurrent(report)) throw new Error("The fixture has no current media measurements.");
        const check = mediaCheckSchema.parse(artifactSchemas["workflow-report"].parse(report.content).data["mediaCheck"]);
        console.log(JSON.stringify({ jobId: id, status: job.status, finalReview: job.reason, media: check }, null, 2));
      }
      break;
    case "doctor": {
      const ffmpeg: string | null = require("ffmpeg-static");
      const ffprobe = require("ffprobe-static") as { path: string };
      const ffmpegReady = Boolean(ffmpeg && existsSync(ffmpeg));
      const ffprobeReady = existsSync(ffprobe.path);
      console.log(JSON.stringify({
        node: process.version, sqlite: "Node built-in; file-backed transactions",
        ffmpegReady, ffprobeReady, skills: app.registry.list().map((pin) => `${pin.name}@${pin.version}`),
        providerEffects: "disabled", copilotIntegration: "Not installed; local skill discovery only",
        accountAllowance: "Not verified; no programmatic model calls were made",
        pilotSubject: "Owner decision", provider: "Owner decision", budget: "Owner decision",
        licenseGate: "Verify Remotion individual/team eligibility and media rights before commercial production",
      }, null, 2));
      if (!ffmpegReady || !ffprobeReady) throw new Error("Missing declared media binaries. Review and approve the pinned npm install scripts.");
      if (ffmpeg) execFileSync(ffmpeg, ["-version"], { stdio: "pipe", timeout: 10000 });
      execFileSync(ffprobe.path, ["-version"], { stdio: "pipe", timeout: 10000 });
      break;
    }
    default: throw new Error("Use fixture, render-fixture, skills-check, quality-prepare or doctor.");
  }
} finally { await app.close(); }
