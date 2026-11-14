import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { StudioApp } from "./app.js";
import { prepareFoundationComparison } from "./quality/prepare.js";

const require = createRequire(import.meta.url);
const command = process.argv[2];
const app = await StudioApp.open();
try {
  switch (command) {
    case "skills-check":
      console.log(JSON.stringify(app.registry.list(), null, 2)); break;
    case "quality-prepare":
      await prepareFoundationComparison(app.store, app.root);
      console.log("Fetched the pinned reference and prepared anonymous procedure packets. No critic win has been recorded.");
      break;
    case "fixture":
      await app.loadFixture();
      console.log("Engineering fixture created as drafts. Open the local review UI and approve the exact fixture inputs; no real pilot decisions were selected.");
      break;
    case "render-fixture":
      console.log(`Queued local fixture job ${app.renderFixture()}. Final fixture review is separate.`);
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
