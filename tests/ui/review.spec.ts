import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { startStudioServer } from "../../src/server.js";
import type { ReviewState } from "../../src/review-contract.js";
import { createFixtureAdapters } from "../../src/media/pipeline.js";
import { currentFixture, fixtureGates } from "../../src/fixture.js";

let studio: Awaited<ReturnType<typeof startStudioServer>>;
let directory: string;
test.beforeEach(async () => {
  directory = `.studio\\ui-tests\\${randomUUID()}`;
  studio = await startStudioServer({ port: 0, dataDirectory: directory, fixtureAdapters: createFixtureAdapters });
});
test.afterEach(async () => {
  await studio.close();
  rmSync(join(process.cwd(), directory), { recursive: true, force: true });
});

test("brief editor saves explicit owner inputs without inventing a curriculum", async ({ page }) => {
  await page.goto(`${studio.url}/?tab=brief`);
  await expect(page.getByRole("heading", { name: "Describe the course." })).toBeVisible();
  await page.getByLabel("Course title", { exact: true }).fill("UI test brief");
  await page.getByLabel("Subject or niche").fill("Explicit test subject");
  await page.getByLabel("Audience", { exact: true }).fill("Test reviewers");
  await page.getByLabel("Language", { exact: true }).fill("en-US");
  await page.getByLabel("Learning objectives").fill("Observe a durable saved brief.");
  await page.getByRole("button", { name: "Save course brief" }).click();
  await expect(page.getByRole("status")).toContainText("Saved your brief privately");
  const state = (await (await page.request.get(`${studio.url}/api/state`)).json()) as ReviewState;
  expect(state.artifacts.filter((artifact) => artifact.kind === "course-brief")).toHaveLength(1);
  expect(state.artifacts.filter((artifact) => artifact.kind === "curriculum")).toHaveLength(0);
  await expect(page.getByRole("heading", { name: "UI test brief" })).toBeVisible();
});

test("fixture review and scene edit preserve exact versions and revoke affected approval", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(studio.url);
  await expect(page.getByText("Artifact versions", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Load engineering fixture", exact: true }).click();
  await expect(page.getByText("Required input reviews", { exact: true })).toBeVisible();
  await expect(page.getByText("0 / 5 reviewed", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Render approved fixture" })).toBeDisabled();
  mkdirSync(join(process.cwd(), ".studio", "quality"), { recursive: true });
  await page.screenshot({ path: join(process.cwd(), ".studio", "quality", "review-ui-1440x960.png"), fullPage: false });
  await page.getByLabel("Artifact and version").selectOption("fixture:storyboard@1");
  await page.getByRole("button", { name: "Approve v1", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Recorded approved for fixture:storyboard@1");
  await page.getByLabel("Artifact and version").selectOption("fixture:scene:gates@1");
  await page.getByRole("button", { name: "Edit typed manifest" }).click();
  const state = (await (await page.request.get(`${studio.url}/api/state`)).json()) as ReviewState;
  const scene = state.artifacts.find((artifact) => artifact.id === "fixture:scene:gates")!;
  await page.getByLabel("Artifact content (JSON)").fill(JSON.stringify({ ...scene.content, script: "An explicitly changed fixture scene." }, null, 2));
  await page.getByRole("button", { name: "Save new artifact version" }).click();
  await expect(page.getByRole("status")).toContainText("Affected approvals and downstream artifacts were invalidated");
  await page.getByLabel("Artifact and version").selectOption("fixture:storyboard@1");
  await expect(page.getByRole("button", { name: "Approve v1", exact: true })).toBeDisabled();
  await page.getByLabel("Artifact and version").selectOption("fixture:storyboard@2");
  await expect(page.getByRole("button", { name: "Approve v2", exact: true })).toBeEnabled();
  const after = (await (await page.request.get(`${studio.url}/api/state`)).json()) as ReviewState;
  expect(after.fixture?.gates.find((gate) => gate.gate === "script-storyboard")?.approved).toBe(false);
  expect(studio.app.store.latestArtifact("fixture:scene:disclosure")?.version).toBe(1);
  expect(errors).toEqual([]);
});

test("a curriculum title edit retains recovery controls and guides the lesson/storyboard review before enabling render", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await studio.app.loadFixture();
  for (const gate of fixtureGates(studio.app.store, currentFixture(studio.app.store)!)) studio.app.store.recordDecision({
    artifactId: gate.ref.id, version: gate.ref.version, gate: gate.gate, decision: "approved",
  });
  await page.goto(`${studio.url}/?tab=review&artifact=fixture%3Acurriculum&version=1`);
  await page.getByRole("button", { name: "Edit typed manifest" }).click();
  const curriculum = studio.app.store.latestArtifact("fixture:curriculum")!;
  await page.getByLabel("Artifact content (JSON)").fill(JSON.stringify({ ...curriculum.content, title: "An authored UI-test outline title" }, null, 2));
  await page.getByRole("button", { name: "Save new artifact version" }).click();
  await expect(page.getByRole("button", { name: "Rebuild review drafts", exact: true })).toBeEnabled();
  await expect(page.getByText("Required input reviews", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Render approved fixture", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Approve v2", exact: true }).click();
  await page.getByRole("button", { name: "Rebuild review drafts", exact: true }).click();
  await expect(page.getByLabel("Artifact and version")).toHaveValue("fixture:lesson@2");
  await expect(page.getByRole("status")).toContainText("without changing authored content or copying approvals");
  await expect(page.getByRole("button", { name: "Render approved fixture", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Approve v2", exact: true }).click();
  await page.getByRole("button", { name: "Next review: script storyboard v2", exact: true }).click();
  await expect(page.getByLabel("Artifact and version")).toHaveValue("fixture:storyboard@2");
  await expect(page.getByText("From brief to reviewed lesson", { exact: true }).first()).toBeVisible();
  await page.getByRole("button", { name: "Approve v2", exact: true }).click();
  await expect(page.getByRole("button", { name: "Render approved fixture", exact: true })).toBeEnabled();
  expect(studio.app.store.listArtifacts({ kind: "audio" })).toHaveLength(0);
  expect(studio.app.store.listArtifacts({ kind: "lesson-output" })).toHaveLength(0);
  expect(studio.app.store.latestArtifact("fixture:curriculum")?.content).toMatchObject({ title: "An authored UI-test outline title" });
  expect(errors).toEqual([]);
});
