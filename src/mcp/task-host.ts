import type { AgentExecutionAdapter } from "../agents/adapter.js";
import { getCodexAgentAdapter } from "../agents/codex/adapter.js";
import {
  AgentExecutionService,
  type StartExecutionInput,
} from "../agents/execution.js";
import { TaskError } from "../tasks/errors.js";
import { TaskRuntime } from "../tasks/runtime.js";
import type { TaskRecord } from "../tasks/types.js";

export interface TaskRecordPage {
  records: TaskRecord[];
  truncated: boolean;
}

/** Internal operations required by the public task MCP façade. */
export interface TaskToolHost {
  startTask(input: StartExecutionInput): Promise<TaskRecord>;
  getTask(taskId: string): Promise<TaskRecord>;
  waitForTask(
    taskId: string,
    afterSeq: number,
    waitMs: number,
    abortSignal?: AbortSignal,
  ): Promise<TaskRecord>;
  listTasks(options: {
    project_id?: string;
    limit: number;
  }): Promise<TaskRecordPage>;
  cancelTask(taskId: string): Promise<TaskRecord>;
  close(): Promise<void>;
}

export interface LazyTaskToolHostOptions {
  runtimeFactory?: () => Promise<TaskRuntime>;
  adapterFactory?: () => AgentExecutionAdapter | Promise<AgentExecutionAdapter>;
}

function isTerminal(record: TaskRecord): boolean {
  return (
    record.state === "completed" ||
    record.state === "failed" ||
    record.state === "cancelled" ||
    record.state === "interrupted"
  );
}

/** One lazily acquired runtime and execution service for a single stdio process. */
export class LazyTaskToolHost implements TaskToolHost {
  private readonly runtimeFactory: () => Promise<TaskRuntime>;
  private readonly adapterFactory: () =>
    AgentExecutionAdapter | Promise<AgentExecutionAdapter>;
  private runtimePromise: Promise<TaskRuntime> | undefined;
  private executionPromise: Promise<AgentExecutionService> | undefined;
  private executionService: AgentExecutionService | undefined;
  private readonly executionOperations = new Set<Promise<unknown>>();
  private closing = false;
  private closePromise: Promise<void> | undefined;

  constructor(options: LazyTaskToolHostOptions = {}) {
    this.runtimeFactory = options.runtimeFactory ?? (() => TaskRuntime.start());
    this.adapterFactory =
      options.adapterFactory ?? (() => getCodexAgentAdapter());
  }

  startTask(input: StartExecutionInput): Promise<TaskRecord> {
    return this.trackExecutionOperation(async () => {
      const service = await this.getExecutionService();
      const allocation = await service.startTask(input);
      // Authorization was checked atomically by startTask; return its durable
      // accepted record even if registration changes immediately afterward.
      return (await this.getRuntime()).manager.getTask(allocation.task_id);
    });
  }

  async getTask(taskId: string): Promise<TaskRecord> {
    return (
      await this.getRuntime()
    ).manager.getTaskRecordForCurrentRegistration(taskId);
  }

  async waitForTask(
    taskId: string,
    afterSeq: number,
    waitMs: number,
    abortSignal?: AbortSignal,
  ): Promise<TaskRecord> {
    return (await this.getRuntime()).manager.waitForTask(
      taskId,
      afterSeq,
      waitMs,
      abortSignal,
    );
  }

  async listTasks(options: {
    project_id?: string;
    limit: number;
  }): Promise<TaskRecordPage> {
    return (await this.getRuntime()).manager.listRegisteredTaskRecordsPage(
      options,
    );
  }

  cancelTask(taskId: string): Promise<TaskRecord> {
    return this.trackExecutionOperation(async () => {
      const current = await this.getTask(taskId);
      if (isTerminal(current)) return current;
      const service = await this.getExecutionService();
      await service.cancelTask(taskId);
      return this.getTask(taskId);
    });
  }

  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    this.closePromise = this.closeOwnedResources();
    return this.closePromise;
  }

  private trackExecutionOperation<T>(operation: () => Promise<T>): Promise<T> {
    this.assertOpen();
    const pending = operation();
    this.executionOperations.add(pending);
    void pending
      .finally(() => this.executionOperations.delete(pending))
      .catch(() => undefined);
    return pending;
  }

  private getRuntime(): Promise<TaskRuntime> {
    this.assertOpen();
    if (!this.runtimePromise) {
      const pending = Promise.resolve().then(this.runtimeFactory);
      this.runtimePromise = pending;
      void pending.catch(() => {
        if (this.runtimePromise === pending) this.runtimePromise = undefined;
      });
    }
    return this.runtimePromise;
  }

  private getExecutionService(): Promise<AgentExecutionService> {
    this.assertOpen();
    if (!this.executionPromise) {
      const pending = Promise.resolve().then(() =>
        this.createExecutionService(),
      );
      this.executionPromise = pending;
      void pending.catch(() => {
        if (!this.executionService && this.executionPromise === pending) {
          this.executionPromise = undefined;
        }
      });
    }
    return this.executionPromise;
  }

  private async createExecutionService(): Promise<AgentExecutionService> {
    const runtime = await this.getRuntime();
    const adapter = await this.adapterFactory();
    const service = new AgentExecutionService(runtime, adapter);
    this.executionService = service;
    return service;
  }

  private async closeOwnedResources(): Promise<void> {
    // Wait for lazy construction before deciding which resources need closing.
    await this.executionPromise?.catch(() => undefined);
    if (this.executionService) {
      // If this is uncertain, retain runtime ownership and refuse further calls.
      await this.executionService.close();
    }
    await Promise.allSettled([...this.executionOperations]);
    if (this.runtimePromise) {
      const runtime = await this.runtimePromise;
      await runtime.close();
    }
  }

  private assertOpen(): void {
    if (this.closing) throw new TaskError("task_runtime_closed");
  }
}
