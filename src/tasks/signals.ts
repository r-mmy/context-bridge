import { MAX_TASK_WAIT_MS, type TaskState } from "./types.js";
import { TaskError } from "./errors.js";

export interface TaskSignalSnapshot {
  event_seq: number;
  state: TaskState;
}

interface Waiter {
  resolve(): void;
  reject(error: unknown): void;
}

interface Subscription {
  promise: Promise<void>;
  dispose(): void;
}

function isImmediateWake(
  snapshot: TaskSignalSnapshot,
  afterSeq: number,
): boolean {
  return (
    snapshot.event_seq > afterSeq ||
    snapshot.state === "waiting_for_input" ||
    snapshot.state === "completed" ||
    snapshot.state === "failed" ||
    snapshot.state === "cancelled" ||
    snapshot.state === "interrupted"
  );
}

export class TaskSignals {
  private readonly waiters = new Map<string, Set<Waiter>>();

  notify(taskId: string): void {
    const taskWaiters = this.waiters.get(taskId);
    if (!taskWaiters) return;
    this.waiters.delete(taskId);
    for (const waiter of taskWaiters) waiter.resolve();
  }

  notifyAll(): void {
    for (const taskId of this.waiters.keys()) this.notify(taskId);
  }

  get listenerCount(): number {
    let count = 0;
    for (const listeners of this.waiters.values()) count += listeners.size;
    return count;
  }

  async waitForChange<T extends TaskSignalSnapshot>(
    taskId: string,
    afterSeq: number,
    waitMs: number,
    readDurable: () => Promise<T>,
    abortSignal?: AbortSignal,
  ): Promise<T> {
    if (
      !Number.isSafeInteger(afterSeq) ||
      afterSeq < 0 ||
      !Number.isInteger(waitMs) ||
      waitMs < 0 ||
      waitMs > MAX_TASK_WAIT_MS
    ) {
      throw new TaskError("task_store_error");
    }

    const initial = await readDurable();
    if (isImmediateWake(initial, afterSeq) || waitMs === 0) return initial;
    if (abortSignal?.aborted) throw new TaskError("task_wait_aborted");

    const subscription = this.subscribe(taskId, waitMs, abortSignal);
    try {
      // Close the lost-wakeup window between the first durable read and
      // listener registration. Writers notify only after their atomic write.
      const afterSubscribe = await readDurable();
      if (isImmediateWake(afterSubscribe, afterSeq)) return afterSubscribe;

      await subscription.promise;
      return await readDurable();
    } finally {
      subscription.dispose();
    }
  }

  private subscribe(
    taskId: string,
    waitMs: number,
    abortSignal?: AbortSignal,
  ): Subscription {
    let resolvePromise!: () => void;
    let rejectPromise!: (error: unknown) => void;
    let settled = false;
    const waiter: Waiter = {
      resolve: () => {
        if (settled) return;
        settled = true;
        resolvePromise();
      },
      reject: (error) => {
        if (settled) return;
        settled = true;
        rejectPromise(error);
      },
    };
    const promise = new Promise<void>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });
    let taskWaiters = this.waiters.get(taskId);
    if (!taskWaiters) {
      taskWaiters = new Set<Waiter>();
      this.waiters.set(taskId, taskWaiters);
    }
    taskWaiters.add(waiter);
    const onAbort = (): void =>
      waiter.reject(new TaskError("task_wait_aborted"));
    abortSignal?.addEventListener("abort", onAbort, { once: true });
    if (abortSignal?.aborted) onAbort();
    const timer = setTimeout(() => waiter.resolve(), waitMs);

    return {
      promise,
      dispose: () => {
        if (timer) clearTimeout(timer);
        abortSignal?.removeEventListener("abort", onAbort);
        const current = this.waiters.get(taskId);
        current?.delete(waiter);
        if (current?.size === 0) this.waiters.delete(taskId);
      },
    };
  }
}
