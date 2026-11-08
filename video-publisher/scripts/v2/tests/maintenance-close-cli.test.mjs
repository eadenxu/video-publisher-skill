import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { selectMaintenanceCloseTarget } from "../lib/account-binding.mjs";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const V2_DIR = path.resolve(TEST_DIR, "..");
const ROOT = path.resolve(V2_DIR, "../..");
const CONFIG_SCRIPT = path.join(ROOT, "scripts", "config.mjs");
const PUBLISHER = path.join(V2_DIR, "publisher.mjs");
const STUB_EGO = path.join(TEST_DIR, "maintenance-close-stub-ego.mjs");
const SPACE_NAME = "vp-maint-account-check-585fe53-20261108-1201";
const PROFILES = [
  { id: "Profile 2", name: "AI", isDefault: false },
  { id: "Profile 3", name: "child", isDefault: true },
];
const OWN = { id: 107, name: SPACE_NAME, ownership: "agent", profileId: "Profile 2" };
const OTHER = { id: 104, name: "小红书-只读查重", ownership: "user", profileId: "Profile 3" };

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", code => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

function matched(spaces) {
  return selectMaintenanceCloseTarget({
    spaceName: SPACE_NAME,
    spaceId: 107,
    profileId: "Profile 2",
    profilesPayload: PROFILES,
    spacesPayload: spaces,
  });
}

test("close target selection refuses every inventory mismatch before taskSpace", () => {
  assert.equal(matched([OTHER, OWN]).taskSpaceAllowed, true);
  assert.equal(matched([{ ...OWN, id: 108 }]).code, "SPACE_ID_NAME_MISMATCH");
  assert.equal(matched([{ ...OWN, profileId: "Profile 3" }]).code, "SPACE_PROFILE_MISMATCH");
  assert.equal(matched([{ ...OWN, ownership: "user" }]).code, "SPACE_OWNERSHIP_UNVERIFIED");
  assert.equal(matched([{ id: 107, name: SPACE_NAME, profileId: "Profile 2" }]).code, "SPACE_OWNERSHIP_UNVERIFIED");
  assert.equal(matched([]).code, "SPACE_ABSENT");
  assert.equal(matched([OWN, { id: 107, name: "vp-maint-other", ownership: "agent", profileId: "Profile 2" }]).code, "SPACE_AMBIGUOUS");
  assert.equal(matched([OTHER, OWN]).ok, true);
  for (const result of [
    matched([{ ...OWN, id: 108 }]),
    matched([{ ...OWN, profileId: "Profile 3" }]),
    matched([{ ...OWN, ownership: "user" }]),
    matched([]),
  ]) assert.equal(result.taskSpaceAllowed, false);
});

test("public close CLI finishes only the matched own handle and records inventory separately", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "video-publisher-maintenance-close-"));
  const configPath = path.join(root, "config", "config.json");
  const callsPath = path.join(root, "calls.json");
  const initialized = await run(process.execPath, [
    CONFIG_SCRIPT, "init-maintenance-account",
    "--profile-id", "Profile 2",
    "--profile-label", "AI",
    "--display-name", "GrokBot看AI",
    "--account-id", "4221066816",
  ], { env: { ...process.env, VIDEO_PUBLISHER_CONFIG: configPath } });
  assert.equal(initialized.code, 0, initialized.stdout);
  const checked = await run(process.execPath, [CONFIG_SCRIPT, "validate-maintenance"], {
    env: { ...process.env, VIDEO_PUBLISHER_CONFIG: configPath },
  });
  assert.equal(checked.code, 0, checked.stdout);
  const baseEnv = {
    ...process.env,
    VIDEO_PUBLISHER_CONFIG: configPath,
    VIDEO_PUBLISHER_V2_EGO_COMMAND: STUB_EGO,
    VIDEO_PUBLISHER_V2_LOCK_ROOT: path.join(root, "locks"),
    STUB_PROFILES: JSON.stringify(PROFILES),
    STUB_CALLS: callsPath,
    STUB_HANDLE: JSON.stringify({ spaceId: 107, name: SPACE_NAME, ownership: "agent" }),
    STUB_TASK: "",
    STUB_FINISH: "",
  };
  const args = [
    PUBLISHER,
    "--operation", "maintenance-close-space",
    "--profile-id", "Profile 2",
    "--profile-label", "AI",
    "--display-name", "GrokBot看AI",
    "--account-id", "4221066816",
    "--maintenance-space-name", SPACE_NAME,
    "--maintenance-space-id", "107",
  ];
  const closeOnce = async (label, env) => {
    await fs.promises.rm(callsPath, { force: true });
    const maintenanceRoot = path.join(root, label);
    return run(process.execPath, [...args, "--maintenance-root", maintenanceRoot], { env: { ...baseEnv, ...env } });
  };
  const present = JSON.stringify([OTHER, OWN]);
  const absent = JSON.stringify([OTHER]);
  const closed = await closeOnce("closed", { STUB_SPACES: present, STUB_SPACES_AFTER: absent });
  assert.equal(closed.code, 0, `${closed.stderr}\n${closed.stdout}`);
  const closedBody = JSON.parse(closed.stdout);
  assert.equal(closedBody.spaceId, 107);
  assert.equal(closedBody.handleMatched, true);
  assert.equal(closedBody.closeResult.closed, true);
  assert.equal(closedBody.closeResult.reason, "finish-returned");
  assert.equal(closedBody.inventoryCleared, true);
  assert.equal(closedBody.inventoryAfter.code, "SPACE_ABSENT");
  assert.equal(closedBody.pageOpened, false);
  assert.equal(closedBody.publishable, false);
  assert.equal(closedBody.pureReadOnly, false);
  assert.equal(closed.stdout.includes("小红书-只读查重"), false);
  const calls = JSON.parse(fs.readFileSync(callsPath, "utf8"));
  assert.deepEqual(calls.filter(call => call[0] === "taskSpace"), [["taskSpace", 107, true]]);
  assert.equal(calls.filter(call => call[0] === "finish").length, 1);
  assert.match(calls.find(call => call[0] === "finish")[1], /"keep":false/);
  const checkpoint = JSON.parse(fs.readFileSync(path.join(root, "closed", `${SPACE_NAME}.close.checkpoint.json`), "utf8"));
  assert.equal(checkpoint.closeResult.closed, true);
  assert.match(fs.readFileSync(closedBody.egoOutput.path, "utf8"), /VIDEO_PUBLISHER_MAINTENANCE:/);

  const refused = await closeOnce("id-mismatch", {
    STUB_SPACES: JSON.stringify([OTHER, { ...OWN, id: 108 }]),
    STUB_SPACES_AFTER: absent,
  });
  assert.equal(refused.code, 10);
  assert.equal(JSON.parse(refused.stdout).taskSpaceCalled, false);
  assert.equal(JSON.parse(refused.stdout).decisionCode, "SPACE_ID_NAME_MISMATCH");
  assert.deepEqual(JSON.parse(fs.readFileSync(callsPath, "utf8")).filter(call => call[0] === "taskSpace"), []);

  const profile = await closeOnce("profile-mismatch", {
    STUB_SPACES: JSON.stringify([OTHER, { ...OWN, profileId: "Profile 3" }]),
    STUB_SPACES_AFTER: absent,
  });
  assert.equal(JSON.parse(profile.stdout).decisionCode, "SPACE_PROFILE_MISMATCH");
  assert.equal(JSON.parse(profile.stdout).taskSpaceCalled, false);

  const owner = await closeOnce("ownership-mismatch", {
    STUB_SPACES: JSON.stringify([OTHER, { ...OWN, ownership: "user" }]),
    STUB_SPACES_AFTER: absent,
  });
  assert.equal(JSON.parse(owner.stdout).decisionCode, "SPACE_OWNERSHIP_UNVERIFIED");
  assert.equal(JSON.parse(owner.stdout).taskSpaceCalled, false);

  const gone = await closeOnce("absent", { STUB_SPACES: JSON.stringify([OTHER]), STUB_SPACES_AFTER: absent });
  assert.equal(JSON.parse(gone.stdout).decisionCode, "SPACE_ABSENT");
  assert.equal(JSON.parse(gone.stdout).taskSpaceCalled, false);

  const handle = await closeOnce("handle-mismatch", {
    STUB_SPACES: present,
    STUB_SPACES_AFTER: present,
    STUB_HANDLE: JSON.stringify({ spaceId: 999, name: "vp-maint-other", ownership: "agent" }),
  });
  const handleBody = JSON.parse(handle.stdout);
  assert.equal(handle.code, 10);
  assert.equal(handleBody.handleMatched, false);
  assert.equal(handleBody.closeResult.reason, "handle-mismatch");
  assert.equal(handleBody.spaceId, null);
  assert.equal(handleBody.substituteCreated, "unknown");
  assert.deepEqual(JSON.parse(fs.readFileSync(callsPath, "utf8")).filter(call => call[0] === "finish"), []);
  assert.equal(JSON.parse(fs.readFileSync(callsPath, "utf8")).filter(call => call[0] === "taskSpace").length, 1);

  const threw = await closeOnce("finish-threw", {
    STUB_SPACES: present,
    STUB_SPACES_AFTER: present,
    STUB_FINISH: "throw",
  });
  const threwBody = JSON.parse(threw.stdout);
  assert.equal(threw.code, 10);
  assert.equal(threwBody.closeResult.closed, false);
  assert.equal(threwBody.closeResult.reason, "finish-threw");
  assert.equal(threwBody.inventoryCleared, "unknown");
  assert.equal(JSON.parse(fs.readFileSync(callsPath, "utf8")).filter(call => call[0] === "taskSpace").length, 1);

  const dropped = await closeOnce("marker-dropped", {
    STUB_SPACES: present,
    STUB_SPACES_AFTER: absent,
    STUB_FINISH: "drop",
  });
  const droppedBody = JSON.parse(dropped.stdout);
  assert.equal(dropped.code, 10);
  assert.notEqual(droppedBody.closeResult.closed, true);
  assert.equal(droppedBody.publisherRetried, false);

  const userControl = await closeOnce("user-control", {
    STUB_SPACES: present,
    STUB_SPACES_AFTER: present,
    STUB_TASK: "throw",
    STUB_TASK_ERROR: "USER_CONTROL",
  });
  const userBody = JSON.parse(userControl.stdout);
  assert.equal(userBody.closeResult.reason, "user-control");
  assert.equal(userBody.closeResult.closed, false);
  assert.deepEqual(JSON.parse(fs.readFileSync(callsPath, "utf8")).filter(call => call[0] === "finish"), []);

  const mismatch = await run(process.execPath, [
    ...args.map((item, index) => index === args.indexOf("--display-name") + 1 ? "Other Creator" : item),
    "--maintenance-root", path.join(root, "mismatch"),
  ], { env: { ...baseEnv, STUB_SPACES: present, STUB_SPACES_AFTER: absent } });
  assert.notEqual(mismatch.code, 0);
  assert.match(`${mismatch.stderr}\n${mismatch.stdout}`, /does not match accounts.xiaohongshu/);
  const created = await run(process.execPath, [
    PUBLISHER, "--operation", "create",
    "--package", path.join(root, "missing.json"),
    "--platform", "xiaohongshu",
  ], { env: baseEnv });
  assert.equal(created.code, 1);
  assert.match(created.stderr, /productionReady is false/);
  await fs.promises.rm(root, { recursive: true, force: true });
});
