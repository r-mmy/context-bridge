import { createInterface } from "node:readline";
import process from "node:process";
import {
  acquireConfigMutationLock,
  acquireProjectWriterLock,
  tryAcquireConfigMutationLock,
  tryAcquireProjectWriterLock,
} from "../../src/locks/file-lock.ts";
import { addAgentProfile } from "../../src/agents/policy.ts";
import { addProject } from "../../src/projects/registry.ts";

const [mode, ...args] = process.argv.slice(2);

function send(event, fields = {}) {
  process.stdout.write(`${JSON.stringify({ event, ...fields })}\n`);
}

function waitForRelease() {
  const input = createInterface({ input: process.stdin });
  return new Promise((resolve) => {
    input.once("line", () => {
      input.close();
      process.stdin.pause();
      process.stdin.destroy();
      resolve();
    });
  });
}

async function hold(lock) {
  send("acquired");
  await waitForRelease();
  await lock.release();
  send("released");
}

try {
  if (mode === "config-holder") {
    await hold(await acquireConfigMutationLock());
  } else if (mode === "config-try") {
    const lock = await tryAcquireConfigMutationLock();
    if (!lock) send("busy");
    else await hold(lock);
  } else if (mode === "config-wait") {
    send("waiting");
    const lock = await acquireConfigMutationLock(Number(args[0]));
    await hold(lock);
  } else if (mode === "project-holder") {
    await hold(await acquireProjectWriterLock(args[0]));
  } else if (mode === "project-try") {
    const lock = await tryAcquireProjectWriterLock(args[0]);
    if (!lock) send("busy");
    else await hold(lock);
  } else if (mode === "policy-add") {
    await addAgentProfile(args[0], {
      model_id: "gpt-6-sol",
      reasoning_effort: "high",
    });
    send("profile-added", { name: args[0] });
  } else if (mode === "registry-add") {
    const project = await addProject(args[0]);
    send("project-added", { id: project.id });
  } else {
    throw new Error("unsupported test fixture mode");
  }
} catch (error) {
  send("failed", {
    code:
      error && typeof error === "object" && "code" in error
        ? error.code
        : "unknown",
  });
  process.exitCode = 1;
}
