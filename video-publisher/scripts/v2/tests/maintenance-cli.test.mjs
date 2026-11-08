import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const V2_DIR = path.resolve(TEST_DIR, "..");
const ROOT = path.resolve(V2_DIR, "../..");
const CONFIG_SCRIPT = path.join(ROOT, "scripts", "config.mjs");
const PUBLISHER = path.join(V2_DIR, "publisher.mjs");
const SHELL_ENTRY = path.join(ROOT, "scripts", "run-safe-platforms.sh");
const STUB_EGO = path.join(TEST_DIR, "maintenance-stub-ego.mjs");
const SPACE_NAME = "vp-maint-account-check-585fe53-20261108-1201";
const PROFILES = [
  { id: "Profile 2", name: "AI", isDefault: false },
  { id: "Profile 3", name: "child", isDefault: true },
];

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

test("public maintenance CLI accepts the maintenance config through status and diagnose", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "video-publisher-maintenance-cli-"));
  const configPath = path.join(root, "config", "config.json");
  const stateRoot = path.join(root, "state");
  const callsPath = path.join(root, "calls.json");
  const configEnv = { ...process.env, VIDEO_PUBLISHER_CONFIG: configPath };
  const initialized = await run(process.execPath, [
    CONFIG_SCRIPT,
    "init-maintenance-account",
    "--profile-id", "Profile 2",
    "--profile-label", "AI",
    "--display-name", "GrokBot看AI",
    "--account-id", "4221066816",
  ], { env: configEnv });
  assert.equal(initialized.code, 0, `${initialized.stderr}\n${initialized.stdout}`);
  const checked = await run(process.execPath, [CONFIG_SCRIPT, "validate-maintenance"], { env: configEnv });
  assert.equal(checked.code, 0, checked.stdout);
  const checkedBody = JSON.parse(checked.stdout);
  assert.equal(checkedBody.maintenanceReady, true);
  assert.equal(checkedBody.productionReady, false);
  const production = await run(process.execPath, [CONFIG_SCRIPT, "validate"], { env: configEnv });
  assert.equal(production.code, 1);
  assert.equal(JSON.parse(production.stdout).productionReady, false);
  const baseEnv = {
    ...configEnv,
    VIDEO_PUBLISHER_V2_EGO_COMMAND: STUB_EGO,
    VIDEO_PUBLISHER_V2_LOCK_ROOT: path.join(root, "locks"),
    STUB_PROFILES: JSON.stringify(PROFILES),
    STUB_CALLS: callsPath,
    HOME_TEXT: "GrokBot看AI 小红书账号：4221066816",
    NOTES_TEXT: "笔记管理 全部 34",
  };
  const statusArgs = [
    "--operation", "maintenance-space-status",
    "--profile-id", "Profile 2",
    "--profile-label", "AI",
    "--display-name", "GrokBot看AI",
    "--account-id", "4221066816",
    "--maintenance-space-name", SPACE_NAME,
  ];
  const present = await run(process.execPath, [PUBLISHER, ...statusArgs], {
    env: {
      ...baseEnv,
      STUB_SPACES: JSON.stringify([
        { id: 104, name: "小红书-只读查重", ownership: "user" },
        { id: 200, name: SPACE_NAME, ownership: "agent", profileId: "Profile 2" },
      ]),
    },
  });
  assert.equal(present.code, 0, `${present.stderr}\n${present.stdout}`);
  const presentBody = JSON.parse(present.stdout);
  assert.equal(presentBody.found, true);
  assert.equal(presentBody.spaceId, 200);
  assert.equal(presentBody.closeConfirmed, false);
  assert.equal(presentBody.taskSpaceCalled, false);
  assert.equal(present.stdout.includes("Profile 3"), false);
  assert.equal(present.stdout.includes("小红书-只读查重"), false);
  const absent = await run(SHELL_ENTRY, statusArgs, { env: { ...baseEnv, STUB_SPACES: "[]" } });
  assert.equal(absent.code, 0, `${absent.stderr}\n${absent.stdout}`);
  const absentBody = JSON.parse(absent.stdout);
  assert.equal(absentBody.found, false);
  assert.equal(absentBody.spaceId, null);
  assert.equal(absentBody.closeConfirmed, false);
  const unknown = await run(process.execPath, [PUBLISHER, ...statusArgs], { env: { ...baseEnv, STUB_SPACES: "null" } });
  assert.equal(unknown.code, 0, `${unknown.stderr}\n${unknown.stdout}`);
  assert.equal(JSON.parse(unknown.stdout).found, "unknown");
  assert.equal(JSON.parse(unknown.stdout).spaceIdState, "unknown");
  const mismatch = await run(process.execPath, [PUBLISHER, ...statusArgs.map(item => item === "GrokBot看AI" ? "Other Creator" : item)], {
    env: { ...baseEnv, STUB_SPACES: "[]" },
  });
  assert.notEqual(mismatch.code, 0);
  assert.match(`${mismatch.stderr}\n${mismatch.stdout}`, /does not match accounts.xiaohongshu/);
  assert.equal(fs.existsSync(callsPath), false);
  for (const operation of ["create", "resume", "inspect"]) {
    const refused = await run(process.execPath, [
      PUBLISHER,
      "--operation", operation,
      "--package", path.join(root, "missing-package.json"),
      "--platform", "xiaohongshu",
      "--job-id", "job-1",
    ], { env: baseEnv });
    assert.equal(refused.code, 1, refused.stderr);
    assert.match(refused.stderr, /maintenance-account-observation and productionReady is false/);
    assert.doesNotMatch(`${refused.stderr}\n${refused.stdout}`, /Package JSON not found|video file not found/);
  }
  assert.equal(fs.existsSync(callsPath), false);
  const diagnoseRoot = path.join(stateRoot, "diagnose");
  const diagnosed = await run(process.execPath, [
    PUBLISHER,
    "--operation", "maintenance-diagnose",
    "--profile-id", "Profile 2",
    "--profile-label", "AI",
    "--display-name", "GrokBot看AI",
    "--account-id", "4221066816",
    "--maintenance-space-name", "vp-maint-cli-synthetic",
    "--maintenance-root", diagnoseRoot,
    "--close-maintenance-space",
  ], { env: { ...baseEnv, STUB_SPACES: "[]" } });
  assert.equal(diagnosed.code, 0, `${diagnosed.stderr}\n${diagnosed.stdout}`);
  const diagnosedBody = JSON.parse(diagnosed.stdout);
  assert.equal(diagnosedBody.spaceId, 321);
  assert.equal(diagnosedBody.homeIdentityMatched, true);
  assert.equal(diagnosedBody.noteManagerOpened, true);
  assert.equal(diagnosedBody.closeResult.closed, true);
  assert.equal(diagnosedBody.closeResult.reason, "finish-returned");
  assert.equal(diagnosedBody.publishable, false);
  const calls = JSON.parse(fs.readFileSync(callsPath, "utf8"));
  assert.equal(calls.filter(call => call[0] === "taskSpace").length, 1);
  assert.deepEqual(calls.filter(call => call[0] === "goto").map(call => call[1]), [
    "https://creator.xiaohongshu.com/new/home",
    "https://creator.xiaohongshu.com/new/note-manager",
  ]);
  assert.equal(calls.some(call => call[0] === "finish" && call[1] === '{"keep":[]}'), true);
  const checkpoint = JSON.parse(fs.readFileSync(path.join(diagnoseRoot, "vp-maint-cli-synthetic.checkpoint.json"), "utf8"));
  assert.equal(checkpoint.spaceId, 321);
  assert.equal(checkpoint.closeResult.closed, true);
  assert.match(fs.readFileSync(diagnosedBody.egoOutput.path, "utf8"), /VIDEO_PUBLISHER_MAINTENANCE:/);
  await fs.promises.rm(root, { recursive: true, force: true });
});
