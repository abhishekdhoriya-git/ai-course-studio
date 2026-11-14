import { hashJson, sha256 } from "../domain/hash.js";
import { jsonSchema, keySchema } from "../domain/schemas.js";
import type { Json } from "../domain/schemas.js";
import { MissingInputError, PolicyError, StudioError, TransientError } from "../domain/errors.js";
import type { ProviderOperation } from "../domain/runtime.js";
import type { StudioStore } from "../storage/store.js";

export interface TestProviderAdapter {
  readonly id: string;
  readonly version: string;
  readonly mode: "test";
  dispatch(request: Json, idempotencyKey: string): Promise<{ remoteJobId: string }>;
  reconcile(idempotencyKey: string): Promise<{ remoteJobId: string } | { unknown: true }>;
  poll(remoteJobId: string): Promise<
    { status: "pending" } | { status: "completed"; result: Json } | { status: "failed"; reason: string }
  >;
}

/**
 * There is intentionally no production provider implementation. Even an approved
 * provider-policy artifact cannot turn this test seam into an enrollment adapter.
 */
export class ProviderOperationRunner {
  constructor(private readonly store: StudioStore, private readonly adapter?: TestProviderAdapter) {
    if (adapter && adapter.mode !== "test") throw new PolicyError("PROVIDERS_DISABLED", "Production providers are disabled");
  }

  async execute(key: string, request: Json): Promise<ProviderOperation> {
    keySchema.parse(key);
    if (!this.adapter) throw new PolicyError("PROVIDERS_DISABLED", "Provider dispatch, identity uploads, purchases and publishing are disabled");
    const adapter = this.adapter;
    const provider = `${adapter.id}@${adapter.version}`;
    const parsedRequest = jsonSchema.parse(request);
    const idempotencyKey = `studio-${sha256(`${provider}:${key}`)}`;
    let operation = this.store.prepareProviderOperation({
      key, provider, idempotencyKey, requestHash: hashJson(parsedRequest), mode: "test",
    });
    if (operation.state === "completed") return operation;
    if (operation.state === "failed") throw new StudioError("PROVIDER_FAILED", operation.error ?? "Provider operation failed");

    if (!operation.remoteJobId && (operation.state === "dispatching" || operation.state === "uncertain")) {
      const reconciliation = await adapter.reconcile(idempotencyKey);
      if (!("remoteJobId" in reconciliation)) {
        this.store.updateProviderOperation(key, { state: "uncertain", error: "Dispatch requires reconciliation; resubmission is forbidden" });
        throw new MissingInputError("PROVIDER_RECONCILIATION_REQUIRED", "Dispatch may have happened. Reconcile the original idempotency key; do not submit again");
      }
      operation = this.store.updateProviderOperation(key, {
        state: "submitted", remoteJobId: keySchema.parse(reconciliation.remoteJobId),
      });
    }

    if (operation.state === "prepared") {
      const claimed = this.store.atomic(() => {
        const current = this.store.getProviderOperation(key)!;
        if (current.state !== "prepared") return false;
        this.store.updateProviderOperation(key, { state: "dispatching" });
        return true;
      });
      if (!claimed) throw new TransientError("PROVIDER_BUSY", "Another worker is reconciling this provider operation");
      try {
        const submitted = await adapter.dispatch(parsedRequest, idempotencyKey);
        operation = this.store.updateProviderOperation(key, {
          state: "submitted", remoteJobId: keySchema.parse(submitted.remoteJobId),
        });
      } catch (error) {
        this.store.updateProviderOperation(key, {
          state: "uncertain", error: error instanceof Error ? error.message : "Dispatch outcome unknown",
        });
        throw new TransientError("DISPATCH_UNCERTAIN", "Dispatch outcome is uncertain; the next attempt must reconcile, not resubmit");
      }
    }

    if (!operation.remoteJobId) throw new MissingInputError("PROVIDER_RECONCILIATION_REQUIRED", "No confirmed remote job ID; polling and redispatch are forbidden");
    // The remote ID is durable before polling, including when polling throws.
    const status = await adapter.poll(operation.remoteJobId);
    if (status.status === "pending") throw new TransientError("PROVIDER_PENDING", "The existing provider job is still pending");
    if (status.status === "failed") {
      this.store.updateProviderOperation(key, { state: "failed", error: status.reason });
      throw new StudioError("PROVIDER_FAILED", status.reason);
    }
    return this.store.updateProviderOperation(key, { state: "completed", result: jsonSchema.parse(status.result) });
  }
}
