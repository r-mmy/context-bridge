import { mkdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getRegistryPath } from "../src/config/paths.js";
import {
  addProject,
  ensureRegistry,
  getProject,
  readRegistry,
  removeProject,
  writeRegistry,
} from "../src/projects/registry.js";
import { makeTempDirectory, removeTree } from "./helpers.js";

const temporary: string[] = [];
const oldAppData = process.env.APPDATA;
const oldXdg = process.env.XDG_CONFIG_HOME;
const oldHome = process.env.HOME;
let configRoot: string;

afterEach(async () => {
  await Promise.all(temporary.splice(0).map(removeTree));
  if (oldAppData === undefined) delete process.env.APPDATA;
  else process.env.APPDATA = oldAppData;
  if (oldXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = oldXdg;
  if (oldHome === undefined) delete process.env.HOME;
  else process.env.HOME = oldHome;
});

describe.sequential("project registry", () => {
  it("reads legacy projects.json v1 entries without registration IDs", async () => {
    const config = await makeTempDirectory("ctxbridge-config-legacy-v1-");
    temporary.push(config);
    process.env.APPDATA = path.join(config, "appdata");
    process.env.XDG_CONFIG_HOME = path.join(config, "xdg");
    process.env.HOME = config;
    await mkdir(path.dirname(getRegistryPath()), { recursive: true });
    const legacy = {
      version: 1,
      projects: [
        {
          id: "legacy-project",
          name: "legacy-project",
          root: path.resolve(config),
          addedAt: new Date(0).toISOString(),
        },
      ],
    };
    await writeFile(getRegistryPath(), JSON.stringify(legacy), "utf8");

    const registry = await readRegistry();
    expect(registry.version).toBe(1);
    expect(registry.projects).toEqual(legacy.projects);
  });

  it("initializes, generates stable unique IDs, rejects duplicates, and removes registrations only", async () => {
    configRoot = await makeTempDirectory("ctxbridge-config-");
    temporary.push(configRoot);
    process.env.APPDATA = path.join(configRoot, "appdata");
    process.env.XDG_CONFIG_HOME = path.join(configRoot, "xdg");
    process.env.HOME = configRoot;
    await ensureRegistry();

    const parentA = await makeTempDirectory("ctxbridge-a-");
    const parentB = await makeTempDirectory("ctxbridge-b-");
    temporary.push(parentA, parentB);
    const one = path.join(parentA, "anime-swarm");
    const two = path.join(parentB, "anime-swarm");
    await mkdir(one);
    await mkdir(two);
    const first = await addProject(one);
    const second = await addProject(two);
    expect(first.id).toBe("anime-swarm");
    expect(second.id).toBe("anime-swarm-2");
    expect(first.registrationId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(second.registrationId).not.toBe(first.registrationId);
    await expect(addProject(one)).rejects.toMatchObject({
      code: "project_already_registered",
    });
    expect(
      (await readRegistry()).projects.map((project) => project.id),
    ).toEqual(["anime-swarm", "anime-swarm-2"]);
    expect(await getProject(first.id)).toMatchObject({
      id: first.id,
      root: first.root,
    });
    await removeProject(first.id);
    expect(
      (await readRegistry()).projects.map((project) => project.id),
    ).toEqual(["anime-swarm-2"]);
  });

  it("reports a root that disappears after registration", async () => {
    const config = await makeTempDirectory("ctxbridge-config-missing-");
    const rootParent = await makeTempDirectory("ctxbridge-root-missing-");
    temporary.push(config, rootParent);
    process.env.APPDATA = path.join(config, "appdata");
    process.env.XDG_CONFIG_HOME = path.join(config, "xdg");
    process.env.HOME = config;
    await ensureRegistry();
    const root = path.join(rootParent, "repo");
    await mkdir(root);
    const project = await addProject(root);
    await removeTree(root);
    await expect(getProject(project.id)).rejects.toMatchObject({
      code: "project_root_missing",
    });
  });

  it("rejects sensitive roots and subtrees without blocking ordinary .config projects", async () => {
    const config = await makeTempDirectory("ctxbridge-config-sensitive-");
    const base = await makeTempDirectory("ctxbridge-sensitive-roots-");
    temporary.push(config, base);
    process.env.APPDATA = path.join(config, "appdata");
    process.env.XDG_CONFIG_HOME = path.join(config, "xdg");
    process.env.HOME = config;
    await ensureRegistry();

    const sshRoot = path.join(base, ".ssh");
    const sshSubtree = path.join(sshRoot, "project");
    const cloudSubtree = path.join(
      base,
      ".config",
      "gcloud",
      "legacy_credentials",
      "account",
    );
    const ordinaryConfigProject = path.join(base, ".config", "my-project");
    await Promise.all([
      mkdir(sshSubtree, { recursive: true }),
      mkdir(cloudSubtree, { recursive: true }),
      mkdir(ordinaryConfigProject, { recursive: true }),
    ]);

    await expect(addProject(sshRoot)).rejects.toMatchObject({
      code: "sensitive_project_root",
      message: expect.stringContaining("built-in sensitive-path policy"),
    });
    await expect(addProject(sshSubtree)).rejects.toMatchObject({
      code: "sensitive_project_root",
    });
    await expect(addProject(cloudSubtree)).rejects.toMatchObject({
      code: "sensitive_project_root",
    });
    const ordinary = await addProject(ordinaryConfigProject);
    expect(ordinary.root).toBe(await realpath(ordinaryConfigProject));

    await writeRegistry({
      version: 1,
      projects: [
        {
          id: "legacy-sensitive",
          name: "account",
          root: await realpath(cloudSubtree),
          addedAt: new Date(0).toISOString(),
        },
      ],
    });
    const unavailable = await getProject("legacy-sensitive").catch(
      (error: unknown) => error,
    );
    expect(unavailable).toMatchObject({
      code: "project_unavailable",
      message: "The registered project is unavailable.",
    });
    expect(JSON.stringify(unavailable)).not.toContain(base);
  });
});
