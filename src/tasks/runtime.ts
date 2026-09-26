import {
  tryAcquireTaskRuntimeLock,
  type FileLockHandle,
} from "../locks/file-lock.js";
import { ContextBridgeError } from "../security/errors.js";
import { TaskError, isTaskError } from "./errors.js";
import {
  appendTaskEventToRecord,
  assertUniquePersistedIdempotency,
  TaskManager,
} from "./manager.js";
import { TaskSignals } from "./signals.js";
import { TaskStore, serializedTaskByteLength } from "./store.js";
import {
  MAX_TASKS,
  MAX_TOTAL_TASK_BYTES,
  TaskRecordSchema,
  type TaskRecord,
} from "./types.js";

function isActive(record: TaskRecord): boolean {
  return (
    record.state === "queued" ||
    record.state === "running" ||
    record.state === "waiting_for_input"
  );
}

function recoveryRecord(record: TaskRecord, now: string): TaskRecord {
  const recovered = structuredClone(record);
  const turn = recovered.turns.at(-1);
  if (!turn || turn.state !== recovered.state || !isActive(recovered)) {
    throw new TaskError("task_store_error");
  }
  turn.state = "interrupted";
  turn.completed_at = now;
  turn.safe_error = { code: "task_interrupted" };
  recovered.state = "interrupted";
  recovered.updated_at = now;
  recovered.pending_input = null;
  recovered.safe_error = { code: "task_interrupted" };
  appendTaskEventToRecord(
    recovered,
    {
      turn_number: turn.turn_number,
      category: "recovery",
      kind: "recovered",
      status: "interrupted",
    },
    now,
  );
  const parsed = TaskRecordSchema.safeParse(recovered);
  if (!parsed.success) throw new TaskError("task_store_error");
  return parsed.data;
}

function safeLockError(error: unknown): TaskError {
  if (
    error instanceof ContextBridgeError &&
    (error.code === "locking_unavailable" || error.code === "locking_failed")
  ) {
    return new TaskError("agent_runtime_unavailable");
  }
  return new TaskError("agent_runtime_unavailable");
}

export class TaskRuntime {
  private readonly signals = new TaskSignals();
  private managerInstance: TaskManager | undefined;
  private closing = false;
  private closed = false;

  private constructor(
    private readonly store: TaskStore,
    private readonly ownership: FileLockHandle,
  ) {}

  static async start(
    options: { store?: TaskStore } = {},
  ): Promise<TaskRuntime> {
    const store = options.store ?? new TaskStore();
    let ownership: FileLockHandle | undefined;
    try {
      ownership = await tryAcquireTaskRuntimeLock();
    } catch (error) {
      throw safeLockError(error);
    }
    if (!ownership) throw new TaskError("agent_runtime_busy");

    const runtime = new TaskRuntime(store, ownership);
    try {
      await store.initialize();
      const records = await store.list();
      if (records.length > MAX_TASKS) {
        throw new TaskError("task_store_capacity");
      }
      assertUniquePersistedIdempotency(records);
      const originalBytes = records.reduce(
        (sum, record) => sum + serializedTaskByteLength(record),
        0,
      );
      if (originalBytes > MAX_TOTAL_TASK_BYTES) {
        throw new TaskError("task_store_capacity");
      }

      const recoveryUpdates: Array<{
        previous: TaskRecord;
        recovered: TaskRecord;
      }> = [];
      let projectedBytes = originalBytes;
      const now = new Date().toISOString();
      for (const record of records) {
        if (!isActive(record)) continue;
        const recovered = recoveryRecord(record, now);
        projectedBytes +=
          serializedTaskByteLength(recovered) -
          serializedTaskByteLength(record);
        if (projectedBytes > MAX_TOTAL_TASK_BYTES) {
          throw new TaskError("task_store_capacity");
        }
        recoveryUpdates.push({ previous: record, recovered });
      }

      for (const update of recoveryUpdates) {
        await store.replace(update.recovered);
        const index = records.findIndex(
          (record) => record.task_id === update.previous.task_id,
        );
        if (index < 0) throw new TaskError("task_store_error");
        records[index] = update.recovered;
      }

      runtime.managerInstance = new TaskManager(
        store,
        runtime.signals,
        () => runtime.assertOpen(),
        records,
      );
      return runtime;
    } catch (error) {
      await ownership.release().catch(() => undefined);
      if (isTaskError(error)) throw error;
      throw new TaskError("task_store_error");
    }
  }

  get manager(): TaskManager {
    this.assertOpen();
    if (!this.managerInstance) throw new TaskError("task_runtime_closed");
    return this.managerInstance;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    if (this.closing) throw new TaskError("task_runtime_closed");
    this.closing = true;
    this.signals.notifyAll();
    try {
      await this.managerInstance?.drainMutations();
      await this.ownership.release();
      this.closed = true;
    } catch {
      // The OS lock may have been released ambiguously. Never let this
      // manager resume mutations after close reports a failure.
      this.closed = true;
      throw new TaskError("agent_runtime_unavailable");
    } finally {
      this.closing = false;
    }
  }

  private assertOpen(): void {
    if (this.closed || this.closing) throw new TaskError("task_runtime_closed");
  }
}
