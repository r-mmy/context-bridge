import { constants } from "node:fs";
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  opendir,
  rename,
  rm,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  getConfigDirectory,
  getTaskPath,
  getTasksDirectory,
} from "../config/paths.js";
import { TaskError, isTaskError } from "./errors.js";
import {
  MAX_TASK_FILE_BYTES,
  MAX_TASKS,
  MAX_TOTAL_TASK_BYTES,
  TaskRecordSchema,
  isTaskUuid,
  type TaskRecord,
} from "./types.js";

const TASK_FILENAME =
  /^([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.json$/;
const WINDOWS_RENAME_RETRY_DELAYS_MS = [10, 25, 50, 100, 200] as const;
const WINDOWS_RENAME_RETRYABLE_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);

interface TaskStoreOptions {
  platform?: NodeJS.Platform;
  renameFile?: (source: string, destination: string) => Promise<void>;
}

function codeIs(error: unknown, code: string): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    error.code === code
  );
}

function sameFile(
  opened: Awaited<ReturnType<FileHandle["stat"]>>,
  entry: Awaited<ReturnType<typeof lstat>>,
): boolean {
  return (
    opened.isFile() &&
    entry.isFile() &&
    !entry.isSymbolicLink() &&
    opened.dev === entry.dev &&
    (opened.ino === 0 || entry.ino === 0 || opened.ino === entry.ino)
  );
}

function validateRecord(record: unknown): TaskRecord {
  const parsed = TaskRecordSchema.safeParse(record);
  if (!parsed.success) throw new TaskError("task_store_error");
  return parsed.data;
}

function encodeRecord(record: TaskRecord): Buffer {
  const bytes = Buffer.from(`${JSON.stringify(record)}\n`, "utf8");
  if (bytes.byteLength > MAX_TASK_FILE_BYTES) {
    throw new TaskError("task_store_capacity");
  }
  return bytes;
}

export function serializedTaskByteLength(record: TaskRecord): number {
  return encodeRecord(validateRecord(record)).byteLength;
}

async function syncDirectory(directory: string): Promise<void> {
  if (process.platform === "win32") return;
  const handle = await open(directory, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export class TaskStore {
  private readonly platform: NodeJS.Platform;
  private readonly renameFile: (
    source: string,
    destination: string,
  ) => Promise<void>;

  constructor(options: TaskStoreOptions = {}) {
    this.platform = options.platform ?? process.platform;
    this.renameFile = options.renameFile ?? rename;
  }

  async initialize(): Promise<void> {
    try {
      const configDirectory = getConfigDirectory();
      const tasksDirectory = getTasksDirectory();
      await mkdir(tasksDirectory, { recursive: true, mode: 0o700 });
      const [configStat, tasksStat] = await Promise.all([
        lstat(configDirectory),
        lstat(tasksDirectory),
      ]);
      if (
        !configStat.isDirectory() ||
        configStat.isSymbolicLink() ||
        !tasksStat.isDirectory() ||
        tasksStat.isSymbolicLink()
      ) {
        throw new TaskError("task_store_error");
      }
      if (process.platform !== "win32") {
        await chmod(configDirectory, 0o700);
        await chmod(tasksDirectory, 0o700);
      }
    } catch (error) {
      if (isTaskError(error)) throw error;
      throw new TaskError("task_store_error");
    }
  }

  async read(taskId: string): Promise<TaskRecord> {
    if (!isTaskUuid(taskId)) throw new TaskError("task_not_found");
    try {
      const { record } = await this.readOne(taskId.toLowerCase());
      return record;
    } catch (error) {
      if (isTaskError(error)) throw error;
      if (codeIs(error, "ENOENT")) throw new TaskError("task_not_found");
      throw new TaskError("task_store_error");
    }
  }

  async list(): Promise<TaskRecord[]> {
    await this.initialize();
    const tasksDirectory = getTasksDirectory();
    const records: TaskRecord[] = [];
    let totalBytes = 0;
    try {
      const directory = await opendir(tasksDirectory);
      for await (const entry of directory) {
        const match = TASK_FILENAME.exec(entry.name);
        if (!match || !entry.isFile()) {
          throw new TaskError("task_store_error");
        }
        const taskId = match[1];
        if (!taskId || !isTaskUuid(taskId)) {
          throw new TaskError("task_store_error");
        }
        if (records.length >= MAX_TASKS) {
          throw new TaskError("task_store_capacity");
        }
        const result = await this.readOne(taskId);
        totalBytes += result.byteLength;
        if (totalBytes > MAX_TOTAL_TASK_BYTES) {
          throw new TaskError("task_store_capacity");
        }
        records.push(result.record);
      }
      return records;
    } catch (error) {
      if (isTaskError(error)) throw error;
      throw new TaskError("task_store_error");
    }
  }

  async create(recordInput: TaskRecord): Promise<void> {
    const record = validateRecord(recordInput);
    const bytes = encodeRecord(record);
    const target = getTaskPath(record.task_id);
    await this.initialize();
    const temporary = path.join(
      getTasksDirectory(),
      `${record.task_id}.${randomUUID()}.tmp`,
    );
    let handle: FileHandle | undefined;
    try {
      handle = await open(temporary, "wx", 0o600);
      await handle.writeFile(bytes);
      await handle.sync();
      await handle.close();
      handle = undefined;
      try {
        await link(temporary, target);
      } catch (error) {
        if (codeIs(error, "EEXIST")) throw new TaskError("task_id_conflict");
        throw error;
      }
      await unlink(temporary);
      await syncDirectory(getTasksDirectory());
    } catch (error) {
      if (handle) await handle.close().catch(() => undefined);
      await rm(temporary, { force: true }).catch(() => undefined);
      if (isTaskError(error)) throw error;
      throw new TaskError("task_store_error");
    }
  }

  async replace(recordInput: TaskRecord): Promise<void> {
    const record = validateRecord(recordInput);
    const bytes = encodeRecord(record);
    const target = getTaskPath(record.task_id);
    await this.initialize();
    // Re-read the current record so updates cannot create a missing task or
    // cross a schema/task identity boundary.
    const current = await this.read(record.task_id);
    if (
      current.schema_version !== record.schema_version ||
      current.task_id !== record.task_id
    ) {
      throw new TaskError("task_store_error");
    }
    const temporary = path.join(
      getTasksDirectory(),
      `${record.task_id}.${randomUUID()}.tmp`,
    );
    let handle: FileHandle | undefined;
    try {
      handle = await open(temporary, "wx", 0o600);
      await handle.writeFile(bytes);
      await handle.sync();
      await handle.close();
      handle = undefined;
      await this.renameReplacement(temporary, target);
      await syncDirectory(getTasksDirectory());
    } catch (error) {
      if (handle) await handle.close().catch(() => undefined);
      await rm(temporary, { force: true }).catch(() => undefined);
      if (isTaskError(error)) throw error;
      throw new TaskError("task_store_error");
    }
  }

  private async renameReplacement(
    source: string,
    destination: string,
  ): Promise<void> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        await this.renameFile(source, destination);
        return;
      } catch (error) {
        const delayMs =
          this.platform === "win32"
            ? WINDOWS_RENAME_RETRY_DELAYS_MS[attempt]
            : undefined;
        const retryable = [...WINDOWS_RENAME_RETRYABLE_CODES].some((code) =>
          codeIs(error, code),
        );
        if (delayMs === undefined || !retryable) throw error;
        await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }

  private async readOne(taskId: string): Promise<{
    record: TaskRecord;
    byteLength: number;
  }> {
    const filePath = getTaskPath(taskId);
    const noFollow =
      process.platform === "win32" ? 0 : (constants.O_NOFOLLOW ?? 0);
    const handle = await open(filePath, constants.O_RDONLY | noFollow);
    try {
      const [opened, entry] = await Promise.all([
        handle.stat(),
        lstat(filePath),
      ]);
      if (!sameFile(opened, entry) || opened.size > MAX_TASK_FILE_BYTES) {
        throw new TaskError(
          opened.size > MAX_TASK_FILE_BYTES
            ? "task_store_capacity"
            : "task_store_error",
        );
      }
      const bytes = await handle.readFile();
      if (bytes.byteLength > MAX_TASK_FILE_BYTES) {
        throw new TaskError("task_store_capacity");
      }
      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(bytes),
        );
      } catch {
        throw new TaskError("task_store_error");
      }
      const record = validateRecord(parsedJson);
      if (record.task_id !== taskId) throw new TaskError("task_store_error");
      return { record, byteLength: bytes.byteLength };
    } finally {
      await handle.close().catch(() => undefined);
    }
  }
}
