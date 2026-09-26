import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, type FileHandle } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import type * as FsExt from "fs-ext-extra-prebuilt";
import { getConfigDirectory } from "../config/paths.js";
import { ContextBridgeError } from "../security/errors.js";
import {
  getAgentLockDirectory,
  getConfigMutationLockPath,
  getProjectWriterLockPath,
} from "./paths.js";

export interface FileLockHandle {
  release(): Promise<void>;
}

const DEFAULT_CONFIG_LOCK_TIMEOUT_MS = 5_000;
const MAX_CONFIG_LOCK_TIMEOUT_MS = 30_000;
const INITIAL_RETRY_DELAY_MS = 20;
const MAX_RETRY_DELAY_MS = 250;
const CONTENDED_CODES = new Set(["EAGAIN", "EWOULDBLOCK", "EBUSY"]);

interface LocalReservation {
  owner: symbol;
  /** Keep uncertain or abandoned handles alive until the process exits. */
  file?: FileHandle;
}

const localReservations = new Map<string, LocalReservation>();

function reserveLocally(filePath: string): symbol | undefined {
  if (localReservations.has(filePath)) return undefined;
  const owner = Symbol();
  localReservations.set(filePath, { owner });
  return owner;
}

function retainLocalHandle(
  filePath: string,
  owner: symbol,
  file: FileHandle,
): void {
  const reservation = localReservations.get(filePath);
  if (reservation?.owner === owner) reservation.file = file;
}

function releaseLocalReservation(filePath: string, owner: symbol): void {
  if (localReservations.get(filePath)?.owner === owner)
    localReservations.delete(filePath);
}

function lockError(
  code:
    "config_busy" | "project_busy" | "locking_unavailable" | "locking_failed",
): ContextBridgeError {
  const message = {
    config_busy: "Context Bridge configuration is busy; retry the command.",
    project_busy:
      "Another agent operation currently holds this project's writer lock.",
    locking_unavailable: "Agent locking is unavailable on this platform.",
    locking_failed: "The lock could not be acquired or released safely.",
  }[code];
  return new ContextBridgeError(code, message);
}

function isExpectedContention(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string" &&
    CONTENDED_CODES.has(error.code)
  );
}

async function loadNativeLock(): Promise<typeof FsExt> {
  try {
    const native = await import("fs-ext-extra-prebuilt");
    if (!native.getNativeModuleSource()) throw lockError("locking_unavailable");
    return native;
  } catch {
    throw lockError("locking_unavailable");
  }
}

function flock(
  native: typeof FsExt,
  fd: number,
  operation: "exnb" | "un",
): Promise<void> {
  return new Promise((resolve, reject) => {
    native.flock(fd, operation, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function sameOpenedFile(
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

async function openStableLockFile(filePath: string): Promise<FileHandle> {
  const directory = getAgentLockDirectory();
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") await chmod(getConfigDirectory(), 0o700);
  if (process.platform !== "win32") await chmod(directory, 0o700);

  const noFollow =
    process.platform === "win32" ? 0 : (constants.O_NOFOLLOW ?? 0);
  const handle = await open(
    filePath,
    constants.O_CREAT | constants.O_RDWR | noFollow,
    0o600,
  );
  try {
    const [opened, entry] = await Promise.all([handle.stat(), lstat(filePath)]);
    if (!sameOpenedFile(opened, entry)) throw lockError("locking_failed");
    if (process.platform !== "win32") await handle.chmod(0o600);
    return handle;
  } catch {
    await handle.close().catch(() => undefined);
    throw lockError("locking_failed");
  }
}

async function tryAcquire(
  filePath: string,
): Promise<FileLockHandle | undefined> {
  // This check and insert happen synchronously before native loading or any
  // filesystem await, so same-process callers cannot race through the gate.
  const owner = reserveLocally(filePath);
  if (!owner) return undefined;

  let file: FileHandle | undefined;
  let reservationTransferred = false;
  try {
    const native = await loadNativeLock();
    file = await openStableLockFile(filePath);
    try {
      await flock(native, file.fd, "exnb");
    } catch (error) {
      const contended = isExpectedContention(error);
      let closed = false;
      try {
        await file.close();
        closed = true;
      } catch {
        // Keep both the reservation and a strong handle reference: acquisition
        // may be ambiguous, and another local caller must fail closed.
      }
      if (closed) {
        file = undefined;
        releaseLocalReservation(filePath, owner);
        reservationTransferred = true;
        if (contended) return undefined;
        throw lockError("locking_failed");
      }
      retainLocalHandle(filePath, owner, file);
      reservationTransferred = true;
      throw lockError("locking_failed");
    }

    const acquiredFile = file;
    retainLocalHandle(filePath, owner, acquiredFile);
    let released = false;
    let releaseInFlight: Promise<void> | undefined;
    const releaseOwnership = async (): Promise<void> => {
      if (released) return;
      let failed = false;
      try {
        await flock(native, acquiredFile.fd, "un");
      } catch {
        failed = true;
      }
      let closed = false;
      try {
        await acquiredFile.close();
        closed = true;
      } catch {
        failed = true;
      }
      // A successful close releases the OS lock even if explicit unlock failed.
      // If close itself fails, leave this handle retryable instead of claiming
      // ownership was safely released.
      if (closed) {
        released = true;
        releaseLocalReservation(filePath, owner);
      }
      if (failed) throw lockError("locking_failed");
    };
    reservationTransferred = true;
    return {
      release(): Promise<void> {
        if (released) return Promise.resolve();
        if (releaseInFlight) return releaseInFlight;
        const pending = releaseOwnership();
        releaseInFlight = pending;
        void pending.then(
          () => {
            if (releaseInFlight === pending) releaseInFlight = undefined;
          },
          () => {
            if (releaseInFlight === pending) releaseInFlight = undefined;
          },
        );
        return pending;
      },
    };
  } catch (error) {
    if (!reservationTransferred) {
      if (file) {
        try {
          await file.close();
          releaseLocalReservation(filePath, owner);
        } catch {
          // A failed close leaves ownership uncertain. Retain the reservation
          // and handle instead of letting another operation enter locally.
          retainLocalHandle(filePath, owner, file);
        }
      } else {
        releaseLocalReservation(filePath, owner);
      }
    }
    if (error instanceof ContextBridgeError) throw error;
    throw lockError("locking_failed");
  }
}

function sleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

export async function acquireConfigMutationLock(
  timeoutMs = DEFAULT_CONFIG_LOCK_TIMEOUT_MS,
): Promise<FileLockHandle> {
  if (
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 0 ||
    timeoutMs > MAX_CONFIG_LOCK_TIMEOUT_MS
  ) {
    throw lockError("locking_failed");
  }

  const start = performance.now();
  let delay = INITIAL_RETRY_DELAY_MS;
  while (true) {
    const lock = await tryAcquireConfigMutationLock();
    if (lock) return lock;

    const remaining = timeoutMs - (performance.now() - start);
    if (remaining <= 0) throw lockError("config_busy");
    await sleep(Math.min(delay, remaining));
    delay = Math.min(delay * 2, MAX_RETRY_DELAY_MS);
  }
}

export async function tryAcquireConfigMutationLock(): Promise<
  FileLockHandle | undefined
> {
  return tryAcquire(getConfigMutationLockPath());
}

export async function tryAcquireProjectWriterLock(
  canonicalRoot: string,
): Promise<FileLockHandle | undefined> {
  const lock = await tryAcquire(getProjectWriterLockPath(canonicalRoot));
  return lock;
}

export async function acquireProjectWriterLock(
  canonicalRoot: string,
): Promise<FileLockHandle> {
  const lock = await tryAcquireProjectWriterLock(canonicalRoot);
  if (!lock) throw lockError("project_busy");
  return lock;
}

export async function withConfigMutationLock<T>(
  operation: () => Promise<T> | T,
): Promise<T> {
  const lock = await acquireConfigMutationLock();
  try {
    return await operation();
  } finally {
    await lock.release();
  }
}
