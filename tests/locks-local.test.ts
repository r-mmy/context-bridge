import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FileHandle } from "node:fs/promises";
import {
  acquireConfigMutationLock,
  acquireProjectWriterLock,
  tryAcquireConfigMutationLock,
  tryAcquireProjectWriterLock,
  withConfigMutationLock,
  type FileLockHandle,
} from "../src/locks/file-lock.js";

type FlockCallback = (error: NodeJS.ErrnoException | null) => void;
type OpenFile = (
  filePath: string,
  flags: string | number,
  mode?: number,
) => Promise<FileHandle>;

const nativeMock = vi.hoisted(() => ({
  flock:
    vi.fn<(fd: number, operation: string, callback: FlockCallback) => void>(),
}));
const closeFailure = vi.hoisted(() => ({ next: false }));

vi.mock("fs-ext-extra-prebuilt", () => ({
  flock: nativeMock.flock,
  getNativeModuleSource: () => "prebuilt",
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown> & {
    open: OpenFile;
  };
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      const originalClose = handle.close.bind(handle);
      handle.close = async () => {
        if (closeFailure.next) {
          closeFailure.next = false;
          throw new Error("injected close failure");
        }
        return originalClose();
      };
      return handle;
    },
  };
});

const heldHandles: FileLockHandle[] = [];
const temporaryRoots: string[] = [];
const oldAppData = process.env.APPDATA;
const oldXdg = process.env.XDG_CONFIG_HOME;
const oldHome = process.env.HOME;

function track(handle: FileLockHandle | undefined): FileLockHandle {
  if (!handle) throw new Error("Expected a lock handle.");
  heldHandles.push(handle);
  return handle;
}

async function useTemporaryConfig(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "ctxbridge-local-locks-"));
  temporaryRoots.push(root);
  process.env.APPDATA = path.join(root, "appdata");
  process.env.XDG_CONFIG_HOME = path.join(root, "xdg");
  process.env.HOME = root;
  return root;
}

beforeEach(() => {
  nativeMock.flock.mockImplementation((_fd, _operation, callback) =>
    callback(null),
  );
  closeFailure.next = false;
});

afterEach(async () => {
  closeFailure.next = false;
  nativeMock.flock.mockImplementation((_fd, _operation, callback) =>
    callback(null),
  );
  await Promise.all(
    heldHandles.splice(0).map((handle) => handle.release().catch(() => {})),
  );
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
  if (oldAppData === undefined) delete process.env.APPDATA;
  else process.env.APPDATA = oldAppData;
  if (oldXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = oldXdg;
  if (oldHome === undefined) delete process.env.HOME;
  else process.env.HOME = oldHome;
});

describe.sequential("same-process lock reservations", () => {
  it("reserves the config path locally and retries bounded contention", async () => {
    await useTemporaryConfig();
    const first = track(await acquireConfigMutationLock());
    const nativeCallsWhileHeld = nativeMock.flock.mock.calls.length;

    await expect(tryAcquireConfigMutationLock()).resolves.toBeUndefined();
    await expect(acquireConfigMutationLock(60)).rejects.toMatchObject({
      code: "config_busy",
    });
    expect(nativeMock.flock).toHaveBeenCalledTimes(nativeCallsWhileHeld);

    await first.release();
    const next = track(await tryAcquireConfigMutationLock());
    expect(next).toBeDefined();
    await next.release();
  });

  it("reserves project paths independently and makes same-project acquisition fail busy", async () => {
    const config = await useTemporaryConfig();
    const rootA = path.join(config, "project-a");
    const rootB = path.join(config, "project-b");
    const first = track(await acquireProjectWriterLock(rootA));
    const nativeCallsWhileHeld = nativeMock.flock.mock.calls.length;

    await expect(tryAcquireProjectWriterLock(rootA)).resolves.toBeUndefined();
    await expect(acquireProjectWriterLock(rootA)).rejects.toMatchObject({
      code: "project_busy",
    });
    expect(nativeMock.flock).toHaveBeenCalledTimes(nativeCallsWhileHeld);

    const otherProject = track(await acquireProjectWriterLock(rootB));
    await otherProject.release();
    await first.release();

    const afterRelease = track(await acquireProjectWriterLock(rootA));
    await afterRelease.release();
  });

  it("keeps concurrent config critical sections from overlapping", async () => {
    await useTemporaryConfig();
    let active = 0;
    let maximumActive = 0;
    const order: string[] = [];
    const operation = (name: string): Promise<void> =>
      withConfigMutationLock(async () => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        order.push(`start-${name}`);
        await new Promise((resolve) => setTimeout(resolve, 30));
        order.push(`end-${name}`);
        active -= 1;
      });

    await Promise.all([operation("first"), operation("second")]);

    expect(maximumActive).toBe(1);
    expect(order.filter((entry) => entry.startsWith("start-"))).toHaveLength(2);
    expect(order.filter((entry) => entry.startsWith("end-"))).toHaveLength(2);
  });

  it("releases reservation only after close resolves uncertain ownership", async () => {
    await useTemporaryConfig();
    let failNextUnlock = true;
    nativeMock.flock.mockImplementation((_fd, operation, callback) => {
      if (operation === "un" && failNextUnlock) {
        failNextUnlock = false;
        callback(
          Object.assign(new Error("injected unlock failure"), {
            code: "EINVAL",
          }),
        );
      } else {
        callback(null);
      }
    });

    const unlockFailure = track(await acquireConfigMutationLock());
    await expect(unlockFailure.release()).rejects.toMatchObject({
      code: "locking_failed",
    });
    await expect(unlockFailure.release()).resolves.toBeUndefined();

    const closeFailureLock = track(await acquireConfigMutationLock());
    closeFailure.next = true;
    await expect(closeFailureLock.release()).rejects.toMatchObject({
      code: "locking_failed",
    });
    await expect(tryAcquireConfigMutationLock()).resolves.toBeUndefined();

    await closeFailureLock.release();
    const afterClose = track(await tryAcquireConfigMutationLock());
    expect(afterClose).toBeDefined();
    await afterClose.release();
  });
});
