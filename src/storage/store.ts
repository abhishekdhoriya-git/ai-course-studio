import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  approvalGateSchema, artifactLineage, artifactReferenceKinds, artifactRefSchema, artifactSchemas, collectArtifactRefs, keySchema,
} from "../domain/schemas.js";
import type {
  ApprovalGate, ArtifactContent, ArtifactKind, ArtifactRecord, ArtifactRef, Json, SaveArtifactInput,
} from "../domain/schemas.js";
import {
  jobInputSchema, skillPinSchema, workflowDefinitionSchema,
} from "../domain/runtime.js";
import type {
  JobInput, JobRecord, JobStatus, ProviderOperation, ProviderOperationState, SkillPin,
  StageStatus, WorkflowDefinition,
} from "../domain/runtime.js";
import { canonicalJson, hashJson } from "../domain/hash.js";
import { LeaseLostError, SkillExtractionRequired, StaleInputError, StudioError } from "../domain/errors.js";

type Row = Record<string, unknown>;
const decode = <T>(value: unknown): T => JSON.parse(String(value)) as T;
const nullableString = (value: unknown): string | null => value == null ? null : String(value);
const nullableNumber = (value: unknown): number | null => value == null ? null : Number(value);
const refKey = (ref: ArtifactRef): string => `${ref.id}@${ref.version}`;

export interface SkillSnapshot {
  pin: SkillPin; document: string; metadata: Json; files: Record<string, string>;
}
export interface SkillInvocation {
  id: string; jobId: string; stageId: string; invocationKey: string; attempt: number;
  pin: SkillPin; input: Json; output: Json | null;
  outcome: "running" | "succeeded" | "failed"; error: string | null;
}
export type ActivityEventKind = "work-item" | "retry" | "poll" | "frame" | "controller" | "resume";

export class StudioStore {
  private readonly db: DatabaseSync;
  private depth = 0;

  constructor(dbPath: string) {
    if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;");
    const version = Number(this.db.prepare("PRAGMA user_version").get()?.["user_version"] ?? 0);
    if (version > 1) throw new StudioError("DATABASE_VERSION", "This database was created by a newer studio");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS artifacts (
        id TEXT NOT NULL, version INTEGER NOT NULL, hash TEXT NOT NULL, kind TEXT NOT NULL,
        content_json TEXT NOT NULL, dependencies_json TEXT NOT NULL, created_at INTEGER NOT NULL,
        invalidated_at INTEGER, invalidation_reason TEXT, PRIMARY KEY (id, version)
      );
      CREATE TABLE IF NOT EXISTS artifact_edges (
        child_id TEXT NOT NULL, child_version INTEGER NOT NULL,
        parent_id TEXT NOT NULL, parent_version INTEGER NOT NULL,
        PRIMARY KEY (child_id, child_version, parent_id, parent_version),
        FOREIGN KEY (child_id, child_version) REFERENCES artifacts(id, version),
        FOREIGN KEY (parent_id, parent_version) REFERENCES artifacts(id, version)
      );
      CREATE INDEX IF NOT EXISTS edge_parents ON artifact_edges(parent_id,parent_version);
      CREATE TABLE IF NOT EXISTS decisions (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT, artifact_id TEXT NOT NULL, version INTEGER NOT NULL,
        hash TEXT NOT NULL, gate TEXT NOT NULL, decision TEXT NOT NULL, note TEXT,
        created_at INTEGER NOT NULL, invalidated_at INTEGER,
        FOREIGN KEY (artifact_id,version) REFERENCES artifacts(id,version)
      );
      CREATE INDEX IF NOT EXISTS decisions_lookup ON decisions(artifact_id,version,gate,sequence);
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL, workflow_version TEXT NOT NULL,
        definition_hash TEXT NOT NULL, definition_json TEXT NOT NULL, input_json TEXT NOT NULL,
        skill_pins_json TEXT NOT NULL, status TEXT NOT NULL, reason TEXT,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        lease_token TEXT, lease_until INTEGER, next_attempt_at INTEGER,
        parent_job_id TEXT REFERENCES jobs(id), batch_key TEXT,
        UNIQUE(parent_job_id,batch_key)
      );
      CREATE INDEX IF NOT EXISTS runnable_jobs ON jobs(status,next_attempt_at,created_at);
      CREATE TABLE IF NOT EXISTS job_input_revisions (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT NOT NULL REFERENCES jobs(id),
        input_json TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS job_skill_additions (
        job_id TEXT NOT NULL REFERENCES jobs(id), name TEXT NOT NULL,
        pin_json TEXT NOT NULL, review_ref_json TEXT NOT NULL, created_at INTEGER NOT NULL,
        PRIMARY KEY(job_id,name)
      );
      CREATE TABLE IF NOT EXISTS stages (
        job_id TEXT NOT NULL REFERENCES jobs(id), id TEXT NOT NULL, ordinal INTEGER NOT NULL,
        status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER,
        outputs_json TEXT NOT NULL DEFAULT '[]', error TEXT, error_code TEXT,
        PRIMARY KEY (job_id,id)
      );
      CREATE TABLE IF NOT EXISTS stage_attempts (
        job_id TEXT NOT NULL, stage_id TEXT NOT NULL, attempt INTEGER NOT NULL,
        started_at INTEGER NOT NULL, finished_at INTEGER, outcome TEXT NOT NULL,
        classification TEXT, error_code TEXT, error TEXT,
        PRIMARY KEY (job_id,stage_id,attempt),
        FOREIGN KEY (job_id,stage_id) REFERENCES stages(job_id,id)
      );
      CREATE TABLE IF NOT EXISTS skill_snapshots (
        name TEXT NOT NULL, version TEXT NOT NULL, document_hash TEXT NOT NULL,
        package_hash TEXT NOT NULL, pin_json TEXT NOT NULL, document TEXT NOT NULL,
        metadata_json TEXT NOT NULL, files_json TEXT NOT NULL, PRIMARY KEY(name,version)
      );
      CREATE TABLE IF NOT EXISTS skill_invocations (
        id TEXT PRIMARY KEY, job_id TEXT NOT NULL, stage_id TEXT NOT NULL,
        invocation_key TEXT NOT NULL, attempt INTEGER NOT NULL, pin_json TEXT NOT NULL,
        input_json TEXT NOT NULL, output_json TEXT, outcome TEXT NOT NULL, error TEXT,
        created_at INTEGER NOT NULL, finished_at INTEGER,
        UNIQUE(job_id,stage_id,invocation_key,attempt)
      );
      CREATE TABLE IF NOT EXISTS activity_items (
        video_id TEXT NOT NULL, activity_key TEXT NOT NULL, work_item_id TEXT NOT NULL,
        started INTEGER NOT NULL DEFAULT 0, skill_pin_json TEXT, created_at INTEGER NOT NULL,
        PRIMARY KEY(video_id,activity_key,work_item_id)
      );
      CREATE TABLE IF NOT EXISTS activity_events (
        event_id TEXT PRIMARY KEY, video_id TEXT NOT NULL, activity_key TEXT NOT NULL,
        work_item_id TEXT NOT NULL, kind TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS provider_operations (
        key TEXT PRIMARY KEY, provider TEXT NOT NULL, idempotency_key TEXT NOT NULL,
        request_hash TEXT NOT NULL, mode TEXT NOT NULL, state TEXT NOT NULL,
        remote_job_id TEXT, result_json TEXT, error TEXT,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        UNIQUE(provider,idempotency_key)
      );
      PRAGMA user_version=1;
    `);
  }

  close(): void { this.db.close(); }

  atomic<T>(action: () => T): T {
    if (this.depth > 0) return action();
    this.db.exec("BEGIN IMMEDIATE");
    this.depth++;
    try {
      const result = action();
      if (result instanceof Promise) throw new StudioError("ASYNC_TRANSACTION", "SQLite transactions must not cross an await");
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    } finally { this.depth--; }
  }

  saveArtifact<K extends ArtifactKind>(input: SaveArtifactInput<K>, now = Date.now()): ArtifactRef {
    return this.atomic(() => {
      const id = keySchema.parse(input.id);
      const validator = artifactSchemas[input.kind];
      if (!validator) throw new StudioError("ARTIFACT_KIND", "Unknown artifact kind");
      const content = validator.parse(input.content) as ArtifactContent<K>;
      for (const [field, expectedKind] of Object.entries(artifactReferenceKinds[input.kind] ?? {})) {
        const value = (content as unknown as Record<string, unknown>)[field];
        for (const ref of collectArtifactRefs(value)) {
          if (this.requireCurrent(ref).kind !== expectedKind) {
            throw new StudioError("REFERENCE_KIND", `${input.kind}.${field} must reference ${expectedKind}`);
          }
        }
      }
      const lineage = artifactLineage(input.kind, content);
      for (const historical of lineage.historical) this.getArtifact(historical);
      const dependencies = this.uniqueRefs([...(input.dependencies ?? []), ...lineage.dependencies]);
      for (const dependency of dependencies) {
        if (dependency.id === id) throw new StudioError("CYCLIC_LINEAGE", "An artifact cannot depend on another version of itself");
        this.requireCurrent(dependency);
      }
      dependencies.sort((a, b) => a.id.localeCompare(b.id) || a.version - b.version);
      const hash = hashJson({ kind: input.kind, content, dependencies });
      const previous = this.latestArtifact(id);
      if (previous && previous.kind !== input.kind) throw new StudioError("ARTIFACT_KIND_CHANGED", "An artifact ID cannot change kind");
      if (previous?.hash === hash && previous.invalidatedAt === null) return this.ref(previous);
      if (previous) this.invalidateArtifacts([previous], `Replaced by ${id}@${previous.version + 1}`, now);
      const version = (previous?.version ?? 0) + 1;
      this.db.prepare(`INSERT INTO artifacts
        (id,version,hash,kind,content_json,dependencies_json,created_at) VALUES (?,?,?,?,?,?,?)`)
        .run(id, version, hash, input.kind, canonicalJson(content), canonicalJson(dependencies), now);
      for (const dependency of dependencies) {
        this.db.prepare("INSERT INTO artifact_edges VALUES (?,?,?,?)").run(id, version, dependency.id, dependency.version);
      }
      return { id, version, hash };
    });
  }

  getArtifact<K extends ArtifactKind = ArtifactKind>(ref: ArtifactRef): ArtifactRecord<K> {
    artifactRefSchema.parse(this.ref(ref));
    const row = this.db.prepare("SELECT * FROM artifacts WHERE id=? AND version=?").get(ref.id, ref.version);
    if (!row || row["hash"] !== ref.hash) throw new StaleInputError(`Artifact reference not found or hash mismatch: ${ref.id}@${ref.version}`);
    return this.artifactFromRow(row) as ArtifactRecord<K>;
  }
  latestArtifact(id: string): ArtifactRecord | undefined {
    const row = this.db.prepare("SELECT * FROM artifacts WHERE id=? ORDER BY version DESC LIMIT 1").get(id);
    return row ? this.artifactFromRow(row) : undefined;
  }
  listArtifacts(options: { kind?: ArtifactKind; currentOnly?: boolean } = {}): ArtifactRecord[] {
    const conditions = ["1=1"];
    const values: string[] = [];
    if (options.kind) { conditions.push("a.kind=?"); values.push(options.kind); }
    if (options.currentOnly !== false) {
      conditions.push("a.invalidated_at IS NULL", "a.version=(SELECT max(b.version) FROM artifacts b WHERE b.id=a.id)");
    }
    return this.db.prepare(`SELECT a.* FROM artifacts a WHERE ${conditions.join(" AND ")} ORDER BY a.created_at,a.id,a.version`)
      .all(...values).map((row) => this.artifactFromRow(row));
  }
  requireCurrent(ref: ArtifactRef): ArtifactRecord {
    const artifact = this.getArtifact(ref);
    const latest = this.latestArtifact(ref.id);
    if (artifact.invalidatedAt !== null || latest?.version !== ref.version) {
      throw new StaleInputError(`Artifact is no longer current: ${ref.id}@${ref.version}`);
    }
    return artifact;
  }
  isCurrent(ref: ArtifactRef): boolean {
    try { this.requireCurrent(ref); return true; } catch { return false; }
  }
  descendants(roots: ArtifactRef[], includeRoots = true): ArtifactRef[] {
    const found = new Map<string, ArtifactRef>();
    for (const root of roots) {
      this.getArtifact(root);
      const rows = this.db.prepare(`WITH RECURSIVE affected(id,version) AS (
        SELECT ?,? UNION SELECT e.child_id,e.child_version FROM artifact_edges e
        JOIN affected a ON e.parent_id=a.id AND e.parent_version=a.version
      ) SELECT a.id,a.version,a.hash FROM artifacts a JOIN affected d ON a.id=d.id AND a.version=d.version`)
        .all(root.id, root.version);
      for (const row of rows) {
        const ref = { id: String(row["id"]), version: Number(row["version"]), hash: String(row["hash"]) };
        found.set(refKey(ref), ref);
      }
    }
    if (!includeRoots) for (const root of roots) found.delete(refKey(root));
    return [...found.values()];
  }
  invalidateArtifacts(roots: ArtifactRef[], reason: string, now = Date.now(), includeRoots = true): ArtifactRef[] {
    return this.atomic(() => {
      const affected = this.descendants(roots, includeRoots);
      const keys = new Set(affected.map(refKey));
      for (const ref of affected) {
        this.db.prepare(`UPDATE artifacts SET invalidated_at=COALESCE(invalidated_at,?),
          invalidation_reason=COALESCE(invalidation_reason,?) WHERE id=? AND version=?`)
          .run(now, reason, ref.id, ref.version);
        this.db.prepare("UPDATE decisions SET invalidated_at=COALESCE(invalidated_at,?) WHERE artifact_id=? AND version=?")
          .run(now, ref.id, ref.version);
      }
      const jobs = this.db.prepare("SELECT id,input_json,status FROM jobs").all();
      for (const job of jobs) {
        let touched = decode<JobInput>(job["input_json"]).artifacts.some((ref) => keys.has(refKey(ref)));
        const stages = this.db.prepare("SELECT id,outputs_json FROM stages WHERE job_id=?").all(String(job["id"]));
        for (const stage of stages) {
          if (decode<ArtifactRef[]>(stage["outputs_json"]).some((ref) => keys.has(refKey(ref)))) {
            touched = true;
            this.db.prepare("UPDATE stages SET status='invalidated',error=?,error_code='STALE_INPUT' WHERE job_id=? AND id=?")
              .run(reason, String(job["id"]), String(stage["id"]));
          }
        }
        if (touched) {
          this.db.prepare(`UPDATE jobs SET status=?,reason=?,updated_at=?,lease_token=NULL,lease_until=NULL
            WHERE id=?`).run(job["status"] === "cancelled" ? "cancelled" : "paused", `STALE_INPUT: ${reason}`, now, String(job["id"]));
        }
      }
      return affected;
    });
  }

  recordDecision(input: {
    artifactId: string; version: number; gate: ApprovalGate; decision: "approved" | "rejected"; note?: string;
  }, now = Date.now()): void {
    this.atomic(() => {
      const gate = approvalGateSchema.parse(input.gate);
      if (input.decision !== "approved" && input.decision !== "rejected") throw new StudioError("DECISION", "Unknown decision");
      const artifact = this.latestArtifact(input.artifactId);
      if (!artifact || artifact.version !== input.version) throw new StaleInputError("Cannot decide on a superseded artifact version");
      this.requireCurrent(artifact);
      const wasApproved = this.isApproved(artifact, gate);
      if (wasApproved && input.decision === "rejected") {
        this.invalidateArtifacts([artifact], `Approval revoked: ${gate}`, now, false);
      }
      this.db.prepare(`INSERT INTO decisions
        (artifact_id,version,hash,gate,decision,note,created_at) VALUES (?,?,?,?,?,?,?)`)
        .run(artifact.id, artifact.version, artifact.hash, gate, input.decision, input.note ?? null, now);
    });
  }
  isApproved(ref: ArtifactRef, gate: ApprovalGate): boolean {
    if (!this.isCurrent(ref)) return false;
    const row = this.db.prepare(`SELECT decision FROM decisions
      WHERE artifact_id=? AND version=? AND hash=? AND gate=? AND invalidated_at IS NULL
      ORDER BY sequence DESC LIMIT 1`).get(ref.id, ref.version, ref.hash, gate);
    return row?.["decision"] === "approved";
  }
  listDecisions(artifactId?: string): Row[] {
    return artifactId
      ? this.db.prepare("SELECT * FROM decisions WHERE artifact_id=? ORDER BY sequence").all(artifactId)
      : this.db.prepare("SELECT * FROM decisions ORDER BY sequence").all();
  }

  createJob(input: {
    id?: string; definition: WorkflowDefinition; input: JobInput; skillPins: SkillPin[];
    parentJobId?: string; batchKey?: string;
  }, now = Date.now()): JobRecord {
    return this.atomic(() => {
      const definition = workflowDefinitionSchema.parse(input.definition);
      const parsedInput = jobInputSchema.parse(input.input);
      for (const ref of parsedInput.artifacts) this.requireCurrent(ref);
      const pins = input.skillPins.map((pin) => skillPinSchema.parse(pin));
      const id = input.id ?? randomUUID();
      this.db.prepare(`INSERT INTO jobs
        (id,workflow_id,workflow_version,definition_hash,definition_json,input_json,skill_pins_json,
        status,created_at,updated_at,parent_job_id,batch_key) VALUES (?,?,?,?,?,?,?,'queued',?,?,?,?)`)
        .run(id, definition.id, definition.version, hashJson(definition), canonicalJson(definition),
          canonicalJson(parsedInput), canonicalJson(pins), now, now, input.parentJobId ?? null, input.batchKey ?? null);
      for (const [ordinal, stage] of definition.stages.entries()) {
        this.db.prepare("INSERT INTO stages(job_id,id,ordinal,status) VALUES (?,?,?,'pending')").run(id, stage.id, ordinal);
      }
      return this.getJob(id)!;
    });
  }
  getJob(id: string): JobRecord | undefined {
    const row = this.db.prepare("SELECT * FROM jobs WHERE id=?").get(id);
    if (!row) return undefined;
    return {
      id: String(row["id"]), workflowId: String(row["workflow_id"]), workflowVersion: String(row["workflow_version"]),
      definitionHash: String(row["definition_hash"]), definition: decode<WorkflowDefinition>(row["definition_json"]),
      input: decode<JobInput>(row["input_json"]), skillPins: decode<SkillPin[]>(row["skill_pins_json"]),
      status: String(row["status"]) as JobStatus, reason: nullableString(row["reason"]),
      createdAt: Number(row["created_at"]), updatedAt: Number(row["updated_at"]),
      leaseToken: nullableString(row["lease_token"]), leaseUntil: nullableNumber(row["lease_until"]),
      nextAttemptAt: nullableNumber(row["next_attempt_at"]), parentJobId: nullableString(row["parent_job_id"]),
      stages: this.db.prepare("SELECT * FROM stages WHERE job_id=? ORDER BY ordinal").all(id).map((stage) => ({
        id: String(stage["id"]), status: String(stage["status"]) as StageStatus, attempts: Number(stage["attempts"]),
        nextAttemptAt: nullableNumber(stage["next_attempt_at"]), outputs: decode<ArtifactRef[]>(stage["outputs_json"]),
        error: nullableString(stage["error"]), errorCode: nullableString(stage["error_code"]),
      })),
    };
  }
  listJobs(options: { status?: JobStatus; parentJobId?: string; limit?: number } = {}): JobRecord[] {
    const conditions = ["1=1"];
    const values: (string | number)[] = [];
    if (options.status) { conditions.push("status=?"); values.push(options.status); }
    if (options.parentJobId) { conditions.push("parent_job_id=?"); values.push(options.parentJobId); }
    values.push(Math.max(1, Math.min(options.limit ?? 100, 1000)));
    return this.db.prepare(`SELECT id FROM jobs WHERE ${conditions.join(" AND ")} ORDER BY created_at,id LIMIT ?`)
      .all(...values).map((row) => this.getJob(String(row["id"]))!);
  }
  runnableJobIds(limit: number, now = Date.now()): string[] {
    return this.db.prepare(`SELECT id FROM jobs
      WHERE status IN ('queued','retry-wait') AND (next_attempt_at IS NULL OR next_attempt_at<=?)
      ORDER BY created_at,id LIMIT ?`).all(now, Math.max(1, Math.min(limit, 100))).map((row) => String(row["id"]));
  }
  activeJobCount(): number {
    return Number(this.db.prepare("SELECT count(*) AS total FROM jobs WHERE status IN ('queued','running','retry-wait')").get()?.["total"] ?? 0);
  }
  claimJob(id: string, leaseMs: number, now = Date.now(), maxConcurrency = 4): string | null {
    return this.atomic(() => {
      const active = Number(this.db.prepare("SELECT count(*) AS total FROM jobs WHERE status='running' AND lease_until>?").get(now)?.["total"] ?? 0);
      if (active >= maxConcurrency) return null;
      const token = randomUUID();
      const result = this.db.prepare(`UPDATE jobs SET status='running',reason=NULL,lease_token=?,lease_until=?,updated_at=?
        WHERE id=? AND status IN ('queued','retry-wait') AND (next_attempt_at IS NULL OR next_attempt_at<=?)`)
        .run(token, now + leaseMs, now, id, now);
      return result.changes === 1 ? token : null;
    });
  }
  assertClaim(id: string, token: string, now = Date.now()): void {
    const row = this.db.prepare("SELECT status,lease_token,lease_until FROM jobs WHERE id=?").get(id);
    if (row?.["status"] !== "running" || row["lease_token"] !== token || Number(row["lease_until"]) <= now) throw new LeaseLostError();
  }
  heartbeat(id: string, token: string, leaseMs: number, now = Date.now()): void {
    this.atomic(() => {
      this.assertClaim(id, token, now);
      this.db.prepare("UPDATE jobs SET lease_until=?,updated_at=? WHERE id=? AND lease_token=?")
        .run(now + leaseMs, now, id, token);
    });
  }
  beginStage(jobId: string, token: string, stageId: string, now = Date.now()): number {
    return this.atomic(() => {
      this.assertClaim(jobId, token, now);
      const job = this.getJob(jobId)!;
      const stage = job.stages.find((item) => item.id === stageId);
      const definition = job.definition.stages.find((item) => item.id === stageId);
      if (!stage || !definition || stage.status === "completed" || stage.attempts >= definition.retry.maxAttempts) {
        throw new StudioError("ATTEMPTS_EXHAUSTED", `No attempts remain for ${stageId}`);
      }
      const attempt = Number(this.db.prepare("SELECT COALESCE(max(attempt),0)+1 AS next FROM stage_attempts WHERE job_id=? AND stage_id=?")
        .get(jobId, stageId)?.["next"] ?? 1);
      this.db.prepare("UPDATE stages SET status='running',attempts=?,next_attempt_at=NULL,error=NULL,error_code=NULL WHERE job_id=? AND id=?")
        .run(stage.attempts + 1, jobId, stageId);
      this.db.prepare("INSERT INTO stage_attempts(job_id,stage_id,attempt,started_at,outcome) VALUES (?,?,?,?,'running')")
        .run(jobId, stageId, attempt, now);
      return attempt;
    });
  }
  completeStage(jobId: string, token: string, stageId: string, outputs: ArtifactRef[], now = Date.now()): void {
    this.atomic(() => {
      this.assertClaim(jobId, token, now);
      for (const ref of outputs) this.requireCurrent(ref);
      this.db.prepare("UPDATE stages SET status='completed',outputs_json=?,error=NULL,error_code=NULL WHERE job_id=? AND id=?")
        .run(canonicalJson(this.uniqueRefs(outputs)), jobId, stageId);
      this.db.prepare(`UPDATE stage_attempts SET finished_at=?,outcome='completed'
        WHERE job_id=? AND stage_id=? AND outcome='running'`).run(now, jobId, stageId);
    });
  }
  stopStage(input: {
    jobId: string; token: string; stageId: string; status: "paused" | "retry-wait" | "failed";
    code: string; message: string; classification: string; nextAttemptAt?: number;
  }, now = Date.now()): void {
    this.atomic(() => {
      this.assertClaim(input.jobId, input.token, now);
      this.db.prepare("UPDATE stages SET status=?,error=?,error_code=?,next_attempt_at=? WHERE job_id=? AND id=?")
        .run(input.status, input.message, input.code, input.nextAttemptAt ?? null, input.jobId, input.stageId);
      if (input.classification === "missing-input") {
        this.db.prepare("UPDATE stages SET attempts=max(0,attempts-1) WHERE job_id=? AND id=? AND EXISTS (SELECT 1 FROM stage_attempts WHERE job_id=? AND stage_id=? AND outcome='running')")
          .run(input.jobId, input.stageId, input.jobId, input.stageId);
      }
      this.db.prepare(`UPDATE stage_attempts SET finished_at=?,outcome=?,classification=?,error_code=?,error=?
        WHERE job_id=? AND stage_id=? AND outcome='running'`)
        .run(now, input.status, input.classification, input.code, input.message, input.jobId, input.stageId);
      this.finishJob(input.jobId, input.token, input.status, `${input.code}: ${input.message}`, input.nextAttemptAt, now);
    });
  }
  finishJob(id: string, token: string, status: "completed" | "paused" | "retry-wait" | "failed", reason: string | null, nextAttemptAt?: number, now = Date.now()): void {
    this.assertClaim(id, token, now);
    this.db.prepare(`UPDATE jobs SET status=?,reason=?,updated_at=?,lease_token=NULL,lease_until=NULL,next_attempt_at=?
      WHERE id=? AND lease_token=?`).run(status, reason, now, nextAttemptAt ?? null, id, token);
  }
  resumeJob(id: string, now = Date.now()): JobRecord {
    return this.atomic(() => {
      const job = this.getJob(id);
      if (!job) throw new StudioError("JOB_NOT_FOUND", "Job not found");
      for (const ref of job.input.artifacts) this.requireCurrent(ref);
      if (job.stages.some((stage) => stage.status === "invalidated")) throw new StaleInputError("Invalidated work needs a new job with explicit current inputs");
      if (job.status === "running") throw new StudioError("JOB_RUNNING", "Do not resume a leased job");
      if (job.status === "failed" || job.status === "completed") return job;
      if (job.nextAttemptAt !== null && job.nextAttemptAt > now) return job;
      this.db.prepare(`UPDATE stages SET status='pending',next_attempt_at=NULL
        WHERE job_id=? AND status IN ('paused','cancelled','retry-wait')`).run(id);
      this.db.prepare("UPDATE jobs SET status='queued',reason=NULL,updated_at=?,next_attempt_at=NULL WHERE id=?").run(now, id);
      return this.getJob(id)!;
    });
  }
  cancelJob(id: string, now = Date.now()): void {
    this.atomic(() => {
      const pending = [id];
      const visited = new Set<string>();
      for (let index = 0; index < pending.length; index++) {
        const jobId = pending[index]!;
        if (visited.has(jobId)) continue;
        visited.add(jobId);
        const job = this.getJob(jobId);
        if (!job || job.status === "completed" || job.status === "failed") continue;
        this.db.prepare("UPDATE jobs SET status='cancelled',reason='Cancelled',updated_at=?,lease_token=NULL,lease_until=NULL WHERE id=?")
          .run(now, jobId);
        this.db.prepare("UPDATE stages SET status='cancelled' WHERE job_id=? AND status='running'").run(jobId);
        this.db.prepare(`UPDATE stage_attempts SET finished_at=?,outcome='cancelled',classification='cancelled'
          WHERE job_id=? AND outcome='running'`).run(now, jobId);
        pending.push(...this.listJobs({ parentJobId: jobId, limit: 1000 }).map((child) => child.id));
      }
    });
  }
  recoverExpired(now = Date.now()): string[] {
    return this.atomic(() => {
      const expired = this.db.prepare("SELECT id FROM jobs WHERE status='running' AND lease_until<=?").all(now);
      for (const row of expired) {
        const id = String(row["id"]);
        this.db.prepare("UPDATE stages SET status='pending' WHERE job_id=? AND status='running'").run(id);
        this.db.prepare(`UPDATE stage_attempts SET finished_at=?,outcome='interrupted',classification='transient'
          WHERE job_id=? AND outcome='running'`).run(now, id);
        this.db.prepare("UPDATE jobs SET status='queued',reason='Recovered expired lease',updated_at=?,lease_token=NULL,lease_until=NULL WHERE id=?")
          .run(now, id);
      }
      return expired.map((row) => String(row["id"]));
    });
  }
  listAttempts(jobId: string): Row[] {
    return this.db.prepare("SELECT * FROM stage_attempts WHERE job_id=? ORDER BY started_at,stage_id,attempt").all(jobId);
  }
  addJobInputs(jobId: string, additions: ArtifactRef[], now = Date.now()): void {
    this.atomic(() => {
      const job = this.getJob(jobId);
      if (!job || (job.status !== "paused" && job.status !== "cancelled")) {
        throw new StudioError("INPUT_UPDATE_STATE", "Add missing inputs only to a paused or cancelled job");
      }
      for (const ref of job.input.artifacts) this.requireCurrent(ref);
      for (const ref of additions) {
        const record = this.requireCurrent(ref);
        const existing = job.input.artifacts.find((item) => item.id === ref.id);
        if (existing && (existing.version !== ref.version || existing.hash !== ref.hash)) {
          throw new StaleInputError("Replacing pinned job inputs requires a new job");
        }
        if (!existing && job.definition.stages.some((stage) => stage.requirements.some((requirement) => requirement.kind === record.kind)
          && job.stages.find((item) => item.id === stage.id)?.status === "completed")) {
          throw new StaleInputError("New input would affect completed work; start a job with explicit current inputs");
        }
      }
      this.db.prepare("INSERT INTO job_input_revisions(job_id,input_json,created_at) VALUES (?,?,?)")
        .run(jobId, canonicalJson(job.input), now);
      const next = { ...job.input, artifacts: this.uniqueRefs([...job.input.artifacts, ...additions]) };
      this.db.prepare("UPDATE jobs SET input_json=?,updated_at=? WHERE id=?").run(canonicalJson(next), now, jobId);
    });
  }

  addReviewedJobSkill(jobId: string, token: string, pin: SkillPin, reviewRef: ArtifactRef, now = Date.now()): void {
    this.atomic(() => {
      this.assertClaim(jobId, token, now);
      const draft = artifactSchemas["skill-draft"].parse(this.requireCurrent(reviewRef).content);
      if (!this.isApproved(reviewRef, "skill-review") || draft.name !== pin.name
        || draft.version !== pin.version || draft.documentHash !== pin.documentHash) {
        throw new StudioError("SKILL_REVIEW_REQUIRED", "An exact reviewed draft is required to add a new job capability");
      }
      const job = this.getJob(jobId)!;
      const previous = job.skillPins.find((candidate) => candidate.name === pin.name);
      if (previous) {
        if (canonicalJson(previous) !== canonicalJson(pin)) throw new StudioError("JOB_SKILL_PINNED", "An existing job skill version cannot be upgraded");
        return;
      }
      const snapshot = this.getSkillSnapshot(pin.name, pin.version);
      if (!snapshot || canonicalJson(snapshot.pin) !== canonicalJson(pin)) throw new StudioError("SKILL_PIN_MISMATCH", "Skill has not been admitted to the registry");
      this.db.prepare("INSERT INTO job_skill_additions VALUES (?,?,?,?,?)")
        .run(jobId, pin.name, canonicalJson(pin), canonicalJson(this.ref(reviewRef)), now);
      this.db.prepare("UPDATE jobs SET skill_pins_json=?,updated_at=? WHERE id=?")
        .run(canonicalJson([...job.skillPins, pin]), now, jobId);
    });
  }

  archiveSkill(snapshot: SkillSnapshot): SkillPin {
    return this.atomic(() => {
      const pin = skillPinSchema.parse(snapshot.pin);
      const previous = this.getSkillSnapshot(pin.name, pin.version);
      if (previous) {
        if (previous.pin.packageHash !== pin.packageHash || previous.pin.documentHash !== pin.documentHash) {
          throw new StudioError("SKILL_VERSION_MUTATED", `Skill ${pin.name}@${pin.version} changed without a version bump`);
        }
        return previous.pin;
      }
      this.db.prepare("INSERT INTO skill_snapshots VALUES (?,?,?,?,?,?,?,?)")
        .run(pin.name, pin.version, pin.documentHash, pin.packageHash, canonicalJson(pin),
          snapshot.document, canonicalJson(snapshot.metadata), canonicalJson(snapshot.files));
      return pin;
    });
  }
  getSkillSnapshot(name: string, version: string): SkillSnapshot | undefined {
    const row = this.db.prepare("SELECT * FROM skill_snapshots WHERE name=? AND version=?").get(name, version);
    return row ? {
      pin: decode<SkillPin>(row["pin_json"]), document: String(row["document"]),
      metadata: decode<Json>(row["metadata_json"]), files: decode<Record<string, string>>(row["files_json"]),
    } : undefined;
  }
  beginSkillInvocation(input: Omit<SkillInvocation, "id" | "outcome" | "output" | "error">, now = Date.now()): string {
    const id = randomUUID();
    this.db.prepare(`INSERT INTO skill_invocations
      (id,job_id,stage_id,invocation_key,attempt,pin_json,input_json,outcome,created_at) VALUES (?,?,?,?,?,?,?,'running',?)`)
      .run(id, input.jobId, input.stageId, input.invocationKey, input.attempt, canonicalJson(input.pin), canonicalJson(input.input), now);
    return id;
  }
  finishSkillInvocation(id: string, output: Json | null, error: string | null, now = Date.now()): void {
    this.db.prepare("UPDATE skill_invocations SET output_json=?,outcome=?,error=?,finished_at=? WHERE id=?")
      .run(output === null ? null : canonicalJson(output), error ? "failed" : "succeeded", error, now, id);
  }
  listSkillInvocations(jobId?: string): SkillInvocation[] {
    const rows = jobId ? this.db.prepare("SELECT * FROM skill_invocations WHERE job_id=? ORDER BY created_at").all(jobId)
      : this.db.prepare("SELECT * FROM skill_invocations ORDER BY created_at").all();
    return rows.map((row) => ({
      id: String(row["id"]), jobId: String(row["job_id"]), stageId: String(row["stage_id"]),
      invocationKey: String(row["invocation_key"]), attempt: Number(row["attempt"]),
      pin: decode<SkillPin>(row["pin_json"]), input: decode<Json>(row["input_json"]),
      output: row["output_json"] == null ? null : decode<Json>(row["output_json"]),
      outcome: String(row["outcome"]) as SkillInvocation["outcome"], error: nullableString(row["error"]),
    }));
  }

  reserveActivity(input: {
    videoId: string; activityKey: string; workItemIds: string[]; pin?: SkillPin; started?: boolean;
  }, now = Date.now()): number {
    return this.atomic(() => {
      keySchema.parse(input.videoId); keySchema.parse(input.activityKey);
      const existing = this.activityItems(input.videoId, input.activityKey);
      const union = new Set([...existing.map((item) => item.workItemId), ...input.workItemIds.map((id) => keySchema.parse(id))]);
      if (union.size >= 4 && !input.pin) throw new SkillExtractionRequired(input.videoId, input.activityKey, union.size);
      for (const id of input.workItemIds) {
        this.db.prepare(`INSERT INTO activity_items(video_id,activity_key,work_item_id,started,skill_pin_json,created_at)
          VALUES (?,?,?,?,?,?) ON CONFLICT(video_id,activity_key,work_item_id) DO UPDATE SET
          started=max(started,excluded.started),skill_pin_json=COALESCE(excluded.skill_pin_json,skill_pin_json)`)
          .run(input.videoId, input.activityKey, id, input.started ? 1 : 0, input.pin ? canonicalJson(input.pin) : null, now);
      }
      return union.size;
    });
  }
  recordActivityEvent(input: {
    eventId: string; videoId: string; activityKey: string; workItemId: string; kind: ActivityEventKind; pin?: SkillPin;
  }, now = Date.now()): void {
    this.atomic(() => {
      const eventId = hashJson([input.videoId, input.activityKey, input.workItemId, input.kind, input.eventId]);
      if (this.db.prepare("SELECT event_id FROM activity_events WHERE event_id=?").get(eventId)) return;
      if (input.kind === "work-item") this.reserveActivity({
        videoId: input.videoId, activityKey: input.activityKey, workItemIds: [input.workItemId],
        started: true, ...(input.pin ? { pin: input.pin } : {}),
      }, now);
      this.db.prepare("INSERT INTO activity_events VALUES (?,?,?,?,?,?)")
        .run(eventId, input.videoId, input.activityKey, input.workItemId, input.kind, now);
    });
  }
  activityItems(videoId: string, activityKey: string): { workItemId: string; started: boolean }[] {
    return this.db.prepare("SELECT work_item_id,started FROM activity_items WHERE video_id=? AND activity_key=? ORDER BY work_item_id")
      .all(videoId, activityKey).map((row) => ({ workItemId: String(row["work_item_id"]), started: Boolean(row["started"]) }));
  }

  prepareProviderOperation(input: {
    key: string; provider: string; idempotencyKey: string; requestHash: string;
    mode: ProviderOperation["mode"];
  }, now = Date.now()): ProviderOperation {
    return this.atomic(() => {
      const previous = this.getProviderOperation(input.key);
      if (previous) {
        if (previous.provider !== input.provider || previous.requestHash !== input.requestHash
          || previous.idempotencyKey !== input.idempotencyKey || previous.mode !== input.mode) {
          throw new StudioError("OPERATION_KEY_REUSED", "An idempotency key cannot be reused with different inputs or provider versions");
        }
        return previous;
      }
      this.db.prepare(`INSERT INTO provider_operations
        (key,provider,idempotency_key,request_hash,mode,state,created_at,updated_at) VALUES (?,?,?,?,?,'prepared',?,?)`)
        .run(input.key, input.provider, input.idempotencyKey, input.requestHash, input.mode, now, now);
      return this.getProviderOperation(input.key)!;
    });
  }
  getProviderOperation(key: string): ProviderOperation | undefined {
    const row = this.db.prepare("SELECT * FROM provider_operations WHERE key=?").get(key);
    return row ? {
      key: String(row["key"]), provider: String(row["provider"]), idempotencyKey: String(row["idempotency_key"]),
      requestHash: String(row["request_hash"]), mode: String(row["mode"]) as ProviderOperation["mode"],
      state: String(row["state"]) as ProviderOperationState, remoteJobId: nullableString(row["remote_job_id"]),
      result: row["result_json"] == null ? null : decode<Json>(row["result_json"]), error: nullableString(row["error"]),
      createdAt: Number(row["created_at"]), updatedAt: Number(row["updated_at"]),
    } : undefined;
  }
  updateProviderOperation(key: string, update: {
    state: ProviderOperationState; remoteJobId?: string; result?: Json; error?: string;
  }, now = Date.now()): ProviderOperation {
    return this.atomic(() => {
      const previous = this.getProviderOperation(key);
      if (!previous) throw new StudioError("OPERATION_NOT_FOUND", "Provider operation not found");
      if (previous.remoteJobId && update.remoteJobId && previous.remoteJobId !== update.remoteJobId) {
        throw new StudioError("REMOTE_ID_CHANGED", "A provider operation cannot acquire a second remote job ID");
      }
      this.db.prepare(`UPDATE provider_operations SET state=?,remote_job_id=?,result_json=?,error=?,updated_at=? WHERE key=?`)
        .run(update.state, update.remoteJobId ?? previous.remoteJobId,
          update.result === undefined ? (previous.result === null ? null : canonicalJson(previous.result)) : canonicalJson(update.result),
          update.error ?? null, now, key);
      return this.getProviderOperation(key)!;
    });
  }

  private uniqueRefs(refs: ArtifactRef[]): ArtifactRef[] {
    const unique = new Map<string, ArtifactRef>();
    for (const ref of refs) {
      const parsed = artifactRefSchema.parse(this.ref(ref));
      const previous = unique.get(refKey(parsed));
      if (previous && previous.hash !== parsed.hash) throw new StaleInputError("Conflicting hashes for the same artifact version");
      unique.set(refKey(parsed), parsed);
    }
    return [...unique.values()];
  }
  private ref(record: ArtifactRef): ArtifactRef { return { id: record.id, version: record.version, hash: record.hash }; }
  private artifactFromRow(row: Row): ArtifactRecord {
    return {
      id: String(row["id"]), version: Number(row["version"]), hash: String(row["hash"]),
      kind: String(row["kind"]) as ArtifactKind, content: decode<ArtifactRecord["content"]>(row["content_json"]),
      dependencies: decode<ArtifactRef[]>(row["dependencies_json"]), createdAt: Number(row["created_at"]),
      invalidatedAt: nullableNumber(row["invalidated_at"]), invalidationReason: nullableString(row["invalidation_reason"]),
    };
  }
}
