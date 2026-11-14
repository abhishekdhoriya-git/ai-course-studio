import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { StudioStore } from "../src/storage/store.js";
import { ProviderOperationRunner } from "../src/workflows/provider-operations.js";
import type { TestProviderAdapter } from "../src/workflows/provider-operations.js";

function fixture(t: TestContext) {
  const directory = join(process.cwd(), ".studio", "foundation-tests", randomUUID());
  mkdirSync(directory, { recursive: true });
  const path = join(directory, "studio.sqlite");
  let store = new StudioStore(path);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return {
    get store() { return store; },
    reopen() { store.close(); store = new StudioStore(path); },
  };
}

test("default provider adapter is hard-disabled and creates no success-shaped operation", async (t) => {
  const f = fixture(t);
  await assert.rejects(new ProviderOperationRunner(f.store).execute("enrollment", { ownerApproved: true }), /disabled/);
  assert.equal(f.store.getProviderOperation("enrollment"), undefined);
});

test("dispatch uncertainty reconciles after file-backed reopen, never duplicate-submits, and saves remote ID before polling", async (t) => {
  const f = fixture(t);
  let dispatches = 0;
  let reconciliations = 0;
  let polls = 0;
  let originalKey = "";
  const adapter: TestProviderAdapter = {
    id: "fake-provider", version: "1.0.0", mode: "test",
    async dispatch(_request, key) {
      dispatches++; originalKey = key;
      throw new Error("Remote accepted; process died before saving the remote ID");
    },
    async reconcile(key) {
      reconciliations++;
      assert.equal(key, originalKey);
      return { remoteJobId: "already-created-remote-job" };
    },
    async poll(remoteJobId) {
      polls++;
      assert.equal(remoteJobId, "already-created-remote-job");
      assert.equal(f.store.getProviderOperation("stable-scene-operation")?.remoteJobId, remoteJobId);
      return { status: "completed", result: { syntheticTestOnly: true } };
    },
  };
  await assert.rejects(new ProviderOperationRunner(f.store, adapter).execute("stable-scene-operation", { scene: "one" }), /uncertain/);
  assert.equal(f.store.getProviderOperation("stable-scene-operation")?.state, "uncertain");
  f.reopen();
  const runner = new ProviderOperationRunner(f.store, adapter);
  const result = await runner.execute("stable-scene-operation", { scene: "one" });
  assert.equal(result.state, "completed");
  assert.equal(result.mode, "test");
  assert.equal(dispatches, 1);
  assert.equal(reconciliations, 1);
  assert.equal(polls, 1);
  await runner.execute("stable-scene-operation", { scene: "one" });
  assert.equal(dispatches, 1);
  assert.equal(polls, 1);
  await assert.rejects(runner.execute("stable-scene-operation", { scene: "different" }), /cannot be reused/);
});

test("unresolved reconciliation pauses indefinitely without blindly submitting again", async (t) => {
  const f = fixture(t);
  let dispatches = 0;
  const adapter: TestProviderAdapter = {
    id: "uncertain-fake", version: "1.0.0", mode: "test",
    async dispatch() { dispatches++; throw new Error("connection lost after dispatch"); },
    async reconcile() { return { unknown: true }; },
    async poll() { assert.fail("Cannot poll without a durable remote ID"); },
  };
  const runner = new ProviderOperationRunner(f.store, adapter);
  await assert.rejects(runner.execute("op", {}), /uncertain/);
  await assert.rejects(runner.execute("op", {}), /do not submit again/);
  await assert.rejects(runner.execute("op", {}), /do not submit again/);
  assert.equal(dispatches, 1);
  assert.equal(f.store.getProviderOperation("op")?.state, "uncertain");
});

test("poll retries reuse the saved remote ID after reopen and permanent failures never redispatch", async (t) => {
  const f = fixture(t);
  let dispatches = 0;
  let polls = 0;
  const adapter: TestProviderAdapter = {
    id: "pending-fake", version: "1.0.0", mode: "test",
    async dispatch() { dispatches++; return { remoteJobId: "remote" }; },
    async reconcile() { assert.fail("An already saved ID needs polling, not reconciliation"); },
    async poll() { return ++polls === 1 ? { status: "pending" } : { status: "failed", reason: "Permanent moderation rejection" }; },
  };
  await assert.rejects(new ProviderOperationRunner(f.store, adapter).execute("op", {}), /pending/);
  assert.equal(f.store.getProviderOperation("op")?.remoteJobId, "remote");
  f.reopen();
  const runner = new ProviderOperationRunner(f.store, adapter);
  await assert.rejects(runner.execute("op", {}), /Permanent moderation rejection/);
  await assert.rejects(runner.execute("op", {}), /Permanent moderation rejection/);
  assert.equal(dispatches, 1);
  assert.equal(polls, 2);
});
