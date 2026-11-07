import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  accountSnapshotExpression,
  bindingDiagnosticScript,
  compareAccountObservation,
  describeProfileInventory,
  explainDiscoveryConfig,
  normalizeAccountBinding,
  planTaskSpace,
} from "../lib/account-binding.mjs";
import { BLOCKER, classifyVerdict, evaluateObservation, requiredGates } from "../lib/model.mjs";
import {
  evaluateCollection,
  evaluateLabeledSwitch,
  evaluatePlatformDedup,
  evaluateScheduleControl,
  parseScheduleInput,
  scheduleAuthorizesFinalPublish,
} from "../lib/xhs-fields.mjs";
import { createOnboardedConfig, writeConfig } from "../../lib/config.mjs";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const V2_DIR = path.dirname(DIR);
const ROOT = path.resolve(V2_DIR, "../..");
process.env.VIDEO_PUBLISHER_V2_LOCK_ROOT = path.join(os.tmpdir(), `video-publisher-xhs-binding-${process.pid}`);

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

const binding = {
  profileId: "prof-real",
  profileLabel: "Profile 2",
  displayName: "Example Creator",
  accountId: "1000000001",
};

test("profile labels are not accepted as a substitute for profiles() ids", () => {
  const listed = { profiles: [{ profileId: "prof-real", label: "Profile 2" }] };
  const wrong = planTaskSpace({
    binding: { ...binding, profileId: "Profile 2" },
    taskName: "space-a",
    taskSpaceRef: "",
    profilesPayload: listed,
    spacesPayload: [],
  });
  assert.equal(wrong.ok, false);
  assert.equal(wrong.code, "PROFILE_NOT_LISTED");
  assert.equal(wrong.evidence.labelLikeProfileId, true);

  const create = planTaskSpace({
    binding,
    taskName: "space-a",
    taskSpaceRef: "",
    profilesPayload: listed,
    spacesPayload: [],
  });
  assert.equal(create.ok, true);
  assert.equal(create.action, "create");
  assert.equal(create.passProfileId, true);
  assert.equal(create.profileId, "prof-real");
  assert.equal(create.profileProof, "create-option-only");
});

test("an existing space is not opened when its profile cannot be proven", () => {
  const profilesPayload = [{ profileId: "prof-real", name: "Profile 2" }];
  const unnamed = planTaskSpace({
    binding,
    taskName: "space-a",
    taskSpaceRef: "41",
    profilesPayload,
    spacesPayload: [{ id: 41, name: "space-a", ownership: "agent" }],
  });
  assert.equal(unnamed.code, "SPACE_PROFILE_UNVERIFIED");
  assert.notEqual(unnamed.openPage, true);

  const mismatch = planTaskSpace({
    binding,
    taskName: "space-a",
    taskSpaceRef: "41",
    profilesPayload,
    spacesPayload: [{ id: 41, name: "space-a", profileId: "other-profile" }],
  });
  assert.equal(mismatch.code, "ACCOUNT_MISMATCH");

  const resume = planTaskSpace({
    binding,
    taskName: "space-a",
    taskSpaceRef: "41",
    profilesPayload,
    spacesPayload: [{ id: 41, name: "space-a", profileId: "prof-real" }],
  });
  assert.equal(resume.ok, true);
  assert.equal(resume.action, "resume");
  assert.equal(resume.passProfileId, false);
  assert.equal(resume.nameOrId, 41);
});

test("unrecognized profile payloads fail closed before a space is planned", () => {
  const planned = planTaskSpace({
    binding,
    taskName: "space-a",
    taskSpaceRef: "",
    profilesPayload: { browsers: [{ directory: "Profile 2" }] },
    spacesPayload: [],
  });
  assert.equal(planned.code, "PROFILE_LIST_UNVERIFIED");
  assert.equal(planned.evidence.livePageAcceptance, "pending");
});

test("page identity requires the display name and account id outside the editor", () => {
  function element(text, { editor = false } = {}) {
    return {
      children: [],
      childNodes: editor ? [] : [{ nodeType: 3, textContent: text }],
      innerText: text,
      textContent: text,
      getBoundingClientRect: () => ({ width: 20, height: 10 }),
      closest: () => (editor ? {} : null),
    };
  }
  const document = {
    querySelectorAll: () => [
      element("Example Creator"),
      element("1000000001"),
      element("Example Creator appears in the draft body", { editor: true }),
    ],
  };
  const expression = accountSnapshotExpression("Example Creator", "1000000001");
  const observation = vm.runInNewContext(expression, {
    document,
    getComputedStyle: () => ({ display: "block", visibility: "visible" }),
  });
  const matched = compareAccountObservation(binding, observation);
  assert.equal(matched.ok, true);
  assert.equal(matched.evidence.freshRead, true);
  assert.equal(matched.evidence.livePageAcceptance, "pending");

  const wrong = vm.runInNewContext(accountSnapshotExpression("Example Creator", "1000000001"), {
    document: { querySelectorAll: () => [element("Someone Else"), element("2000000002")] },
    getComputedStyle: () => ({ display: "block", visibility: "visible" }),
  });
  assert.equal(compareAccountObservation(binding, wrong).code, "ACCOUNT_UNVERIFIED");

  const embedded = vm.runInNewContext(accountSnapshotExpression("Example Creator", "1000000001"), {
    document: { querySelectorAll: () => [element("Example Creator"), element("10000000012")] },
    getComputedStyle: () => ({ display: "block", visibility: "visible" }),
  });
  assert.equal(compareAccountObservation(binding, embedded).ok, false);
});

test("Shanghai schedule validation does not authorize final publish", () => {
  const local = parseScheduleInput({ publishAt: "2026-11-08 19:00", timeZone: "Asia/Shanghai" });
  assert.equal(local.ok, true);
  assert.equal(local.value.local, "2026-11-08 19:00");
  assert.equal(local.value.authorizesFinalPublish, false);
  const sameInstant = parseScheduleInput({ publishAt: "2026-11-08T11:00:00Z", timeZone: "Asia/Shanghai" });
  assert.equal(sameInstant.value.local, "2026-11-08 19:00");
  const notShanghaiEvening = parseScheduleInput({ publishAt: "2026-11-08T19:00:00Z", timeZone: "Asia/Shanghai" });
  assert.notEqual(notShanghaiEvening.value.local, "2026-11-08 19:00");
  assert.equal(parseScheduleInput({ publishAt: "2026-11-08", timeZone: "Asia/Shanghai" }).ok, false);
  assert.equal(parseScheduleInput({ publishAt: "2026-11-08T19:00:00+08:00", timeZone: "UTC" }).ok, false);
  assert.equal(scheduleAuthorizesFinalPublish(), false);
  const readback = evaluateScheduleControl({ ...local.value, required: true }, {
    values: ["2026-11-08 19:00"],
    matchedCount: 1,
    freshRead: true,
    finalControlClicked: false,
  });
  assert.equal(readback.ok, true);
  assert.equal(readback.evidence.authorizesFinalPublish, false);
  assert.equal(readback.evidence.livePageAcceptance, "pending");
  assert.equal(evaluateScheduleControl({ ...local.value, required: true }, { values: [], matchedCount: 0, freshRead: true }).code, "SCHEDULE_CONTROL_UNVERIFIED");
});

test("fresh field readback is required and job dedup is not platform dedup", () => {
  assert.equal(evaluateLabeledSwitch(
    { required: true, label: "笔记含AI合成内容" },
    { found: true, unique: true, enabled: true, freshRead: false },
  ).ok, false);
  const proven = evaluateLabeledSwitch(
    { required: true, label: "笔记含AI合成内容" },
    { found: true, unique: true, enabled: true, freshRead: true },
  );
  assert.equal(proven.ok, true);
  assert.equal(proven.evidence.clickAccepted, false);
  assert.equal(evaluateCollection({ required: true, name: "示例合集" }, { selectedExactHits: 1, freshRead: false }).ok, false);
  assert.equal(evaluatePlatformDedup({ required: true, queries: ["示例"] }, { source: "job", jobDedupUsed: true }).code, "PLATFORM_HISTORY_UNVERIFIED");
  assert.equal(evaluatePlatformDedup({ required: true, queries: ["示例"] }, { liveVerified: false, source: "not-queried" }).ok, false);
  const duplicate = evaluatePlatformDedup(
    { required: true, queries: ["示例"] },
    { liveVerified: true, source: "note-management", matches: [{ state: "scheduled" }], observedAt: "2026-11-07T00:00:00.000Z" },
  );
  assert.equal(duplicate.code, "PLATFORM_DUPLICATE");
  assert.equal(duplicate.evidence.jobDedupUsed, false);
});

test("account and platform-history blockers stop before another upload", () => {
  const gates = Object.fromEntries(requiredGates("xiaohongshu").map(name => [name, { ok: true, evidence: {} }]));
  gates.accountIdentity = { ok: false, evidence: { required: true, code: BLOCKER.ACCOUNT_MISMATCH, message: "wrong account" } };
  gates.video = { ok: false, evidence: {} };
  const mismatch = evaluateObservation({ platform: "xiaohongshu", phase: "inspect", gates });
  assert.equal(mismatch.blocker.code, BLOCKER.ACCOUNT_MISMATCH);
  assert.equal(classifyVerdict(mismatch), "blocked");

  gates.accountIdentity = { ok: true, evidence: { required: false } };
  gates.platformDedup = { ok: false, evidence: { required: true, code: BLOCKER.PLATFORM_HISTORY_UNVERIFIED, message: "no note history" } };
  const dedup = evaluateObservation({ platform: "xiaohongshu", phase: "inspect", gates });
  assert.equal(dedup.blocker.code, BLOCKER.PLATFORM_HISTORY_UNVERIFIED);
  assert.equal(classifyVerdict(dedup), "blocked");
});

test("binding config rejects a label copied into profileId and keeps other platforms unchanged", () => {
  const same = normalizeAccountBinding({
    profileId: "Profile 2",
    profileLabel: "Profile 2",
    displayName: "Example Creator",
    accountId: "1000000001",
  });
  assert.equal(same.ok, false);
  const config = createOnboardedConfig({
    sourceDirectory: ROOT,
    availablePlatforms: ["xiaohongshu", "douyin"],
    defaultPlatforms: ["douyin"],
    accounts: { xiaohongshu: binding },
  });
  assert.equal(config.accounts.xiaohongshu.profileId, "prof-real");
  assert.deepEqual(config.defaultPlatforms, ["douyin"]);
  assert.equal(config.accounts.xiaohongshu.profileLabel, "Profile 2");
});

test("the binding diagnostic script is read-only and does not inherit an env profile", () => {
  const script = bindingDiagnosticScript();
  assert.match(script, /await profiles\(\)/);
  assert.match(script, /await listTaskSpaces\(\)/);
  assert.doesNotMatch(script, /taskSpace\s*\(/);
  assert.doesNotMatch(script, /openOrReuseTab|process\.env|--profile/);
});

test("generated Ego script inlines the profile id and never reads it from the environment", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "video-publisher-binding-script-"));
  const videoPath = path.join(root, "video.mp4");
  const packagePath = path.join(root, "package.json");
  const configPath = path.join(root, "config.json");
  const scriptPath = path.join(root, "script.mjs");
  const fakeEgoPath = path.join(root, "fake-ego.mjs");
  await fs.promises.writeFile(videoPath, "video");
  await fs.promises.writeFile(packagePath, JSON.stringify({
    videoPath, title: "绑定", xhsTopics: ["示例"], cover: { uploadCustomCover: false },
  }));
  writeConfig(createOnboardedConfig({
    sourceDirectory: root,
    availablePlatforms: ["xiaohongshu"],
    defaultPlatforms: ["xiaohongshu"],
    accounts: { xiaohongshu: binding },
  }), configPath);
  await fs.promises.writeFile(fakeEgoPath, 'import fs from "node:fs"; let script=""; for await (const chunk of process.stdin) script+=chunk; fs.writeFileSync(process.env.VIDEO_PUBLISHER_TEST_SCRIPT, script); process.exit(1);');
  const result = await run(process.execPath, [path.join(V2_DIR, "run-platform.mjs"), "xiaohongshu", packagePath, "inspect"], {
    env: {
      ...process.env,
      VIDEO_PUBLISHER_CONFIG: configPath,
      VIDEO_PUBLISHER_V2_EGO_COMMAND: fakeEgoPath,
      VIDEO_PUBLISHER_TEST_SCRIPT: scriptPath,
      VIDEO_PUBLISHER_V2_LOCK_ROOT: path.join(root, "locks"),
    },
  });
  assert.equal(result.code, 0, result.stderr);
  const script = await fs.promises.readFile(scriptPath, "utf8");
  assert.match(script, /const accountBinding = \{"platform":"xiaohongshu","profileId":"prof-real"/);
  assert.doesNotMatch(script, /"profileId":"Profile 2"/);
  assert.match(script, /plan\.passProfileId\s*\?\s*await taskSpace\(plan\.nameOrId, \{ profileId: plan\.profileId \}\)/);
  assert.doesNotMatch(script, /process\.env/);
  assert.doesNotMatch(script, /--profile/);
  await fs.promises.rm(root, { recursive: true, force: true });
});

test("a mismatched account stops the production entry before upload", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "video-publisher-binding-stop-"));
  const videoPath = path.join(root, "video.mp4");
  const packagePath = path.join(root, "package.json");
  const configPath = path.join(root, "config.json");
  const log = path.join(root, "events.ndjson");
  await fs.promises.writeFile(videoPath, "video");
  await fs.promises.writeFile(packagePath, JSON.stringify({
    videoPath, title: "绑定", xhsTopics: ["示例"], cover: { uploadCustomCover: false },
  }));
  writeConfig(createOnboardedConfig({
    sourceDirectory: root,
    availablePlatforms: ["xiaohongshu"],
    defaultPlatforms: ["xiaohongshu"],
    declarations: { originalityPolicy: "all_videos_original" },
    accounts: { xiaohongshu: binding },
  }), configPath);
  const result = await run(process.execPath, [
    path.join(V2_DIR, "publisher.mjs"), packagePath, "stop-test", "xiaohongshu",
    "--job-id", "bound-job", "--state-root", root, "--no-cleanup-stale-spaces",
  ], {
    env: {
      ...process.env,
      VIDEO_PUBLISHER_CONFIG: configPath,
      VIDEO_PUBLISHER_V2_RUNNER: path.join(DIR, "mock-runner.mjs"),
      VIDEO_PUBLISHER_V2_MOCK_LOG: log,
      VIDEO_PUBLISHER_V2_MOCK_ACCOUNT: "mismatch",
      VIDEO_PUBLISHER_V2_LOCK_ROOT: path.join(root, "locks"),
      VIDEO_PUBLISHER_V2_EGO_COMMAND: path.join(DIR, "mock-ego-cleanup.mjs"),
    },
  });
  assert.equal(result.code, 10, `${result.stderr}\n${result.stdout}`);
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.ready, false);
  assert.equal(summary.finalPublishAuthorized, false);
  assert.equal(summary.platforms.xiaohongshu.blocker.code, "ACCOUNT_MISMATCH");
  const phases = (await fs.promises.readFile(log, "utf8")).trim().split("\n").map(line => JSON.parse(line))
    .filter(event => event.event === "start").map(event => event.phase);
  assert.deepEqual(phases, ["inspect"]);
  await fs.promises.rm(root, { recursive: true, force: true });
});

test("profile inventory separates ids from display labels", () => {
  const described = describeProfileInventory({
    profiles: [{ profileId: "prof-real", label: "Profile 2" }],
  });
  assert.equal(described.accountVerified, false);
  assert.equal(described.ready, false);
  assert.equal(described.profiles[0].profileId, "prof-real");
  assert.equal(described.profiles[0].label, "Profile 2");
  assert.equal(described.profiles[0].idEqualsLabel, false);
  assert.equal(described.profiles[0].bindUsing, "profileId");
  const notes = explainDiscoveryConfig({
    exists: true,
    warnings: ["sourceDirectory does not exist: /absolute/path/to/videos"],
    binding: { profileId: "PASTE_PROFILE_ID", labelLikeProfileId: false, displayName: "Example", accountId: "1" },
  });
  assert.equal(notes.blocksThisDiagnostic, false);
  assert.equal(notes.bindingUsed, false);
  assert.match(notes.notes.join("\n"), /sourceDirectory does not exist/);
  assert.match(notes.notes.join("\n"), /placeholder/);
});

test("diagnose-binding captures profiles without calling taskSpace and does not accept the binding", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "video-publisher-binding-diagnose-"));
  const videoPath = path.join(root, "video.mp4");
  const packagePath = path.join(root, "package.json");
  const configPath = path.join(root, "config.json");
  const scriptPath = path.join(root, "diagnostic.mjs");
  const fakeEgoPath = path.join(root, "fake-ego.mjs");
  await fs.promises.writeFile(videoPath, "video");
  await fs.promises.writeFile(packagePath, JSON.stringify({
    videoPath, title: "绑定", xhsTopics: ["示例"], cover: { uploadCustomCover: false },
  }));
  writeConfig(createOnboardedConfig({
    sourceDirectory: root,
    availablePlatforms: ["xiaohongshu"],
    defaultPlatforms: ["xiaohongshu"],
    accounts: { xiaohongshu: binding },
  }), configPath);
  await fs.promises.writeFile(fakeEgoPath, `
    import fs from "node:fs";
    let script = "";
    for await (const chunk of process.stdin) script += chunk;
    fs.writeFileSync(process.env.VIDEO_PUBLISHER_TEST_SCRIPT, script);
    console.log("VIDEO_PUBLISHER_BINDING_DIAGNOSTIC:" + JSON.stringify({
      profiles: [{ profileId: "prof-real", label: "Profile 2" }],
      spaces: [],
      taskSpaceCalled: false,
      pageOpened: false
    }));
  `);
  const result = await run(process.execPath, [
    path.join(V2_DIR, "publisher.mjs"),
    "--package", packagePath,
    "--platforms", "xiaohongshu",
    "--job-id", "diagnose-job",
    "--state-root", root,
    "--operation", "diagnose-binding",
    "--no-cleanup-stale-spaces",
  ], {
    env: {
      ...process.env,
      VIDEO_PUBLISHER_CONFIG: configPath,
      VIDEO_PUBLISHER_V2_EGO_COMMAND: fakeEgoPath,
      VIDEO_PUBLISHER_TEST_SCRIPT: scriptPath,
      VIDEO_PUBLISHER_V2_LOCK_ROOT: path.join(root, "locks"),
    },
  });
  assert.equal(result.code, 0, `${result.stderr}\n${result.stdout}`);
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.accepted, false);
  assert.equal(summary.ready, false);
  assert.equal(summary.diagnostic.captured, true);
  assert.equal(summary.diagnostic.pageOpened, false);
  assert.equal(summary.diagnostic.taskSpaceCalled, false);
  assert.equal(summary.diagnostic.livePageAcceptance, "pending");
  assert.equal(summary.accountVerified, false);
  assert.equal(summary.stateWritten, false);
  assert.equal(summary.diagnostic.profileInventory.profiles[0].label, "Profile 2");
  assert.equal(summary.diagnostic.profileInventory.profiles[0].idEqualsLabel, false);
  assert.equal(summary.diagnostic.profileInventory.accountVerified, false);
  const script = await fs.promises.readFile(scriptPath, "utf8");
  assert.doesNotMatch(script, /taskSpace\s*\(/);
  const dedup = await run(process.execPath, [
    path.join(V2_DIR, "publisher.mjs"),
    "--package", packagePath,
    "--platforms", "xiaohongshu",
    "--job-id", "diagnose-job",
    "--state-root", root,
    "--operation", "diagnose-dedup",
    "--no-cleanup-stale-spaces",
  ], {
    env: {
      ...process.env,
      VIDEO_PUBLISHER_CONFIG: configPath,
      VIDEO_PUBLISHER_V2_LOCK_ROOT: path.join(root, "locks"),
      VIDEO_PUBLISHER_V2_EGO_COMMAND: fakeEgoPath,
    },
  });
  assert.equal(dedup.code, 10, dedup.stderr);
  const dedupSummary = JSON.parse(dedup.stdout);
  assert.equal(dedupSummary.accepted, false);
  assert.equal(dedupSummary.diagnostic.judgement.code, "PLATFORM_HISTORY_UNVERIFIED");
  assert.equal(dedupSummary.diagnostic.jobDedupSatisfiesPlatformDedup, false);
  assert.equal(dedupSummary.diagnostic.judgement.evidence.jobDedupUsed, false);
  await fs.promises.rm(root, { recursive: true, force: true });
});

test("profile discovery runs without media or a writable job and create still rejects that package", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "video-publisher-binding-bootstrap-"));
  const stateRoot = path.join(root, "state");
  const configPath = path.join(root, "config.json");
  const packagePath = path.join(root, "package.json");
  const scriptPath = path.join(root, "script.mjs");
  const fakeEgoPath = path.join(root, "fake-ego.mjs");
  await fs.promises.writeFile(packagePath, JSON.stringify({
    videoPath: "/absolute/path/to/video.mp4",
    title: "placeholder",
    xhsTopics: ["示例"],
    cover: { uploadCustomCover: true, vertical3x4Path: "/absolute/path/to/cover-3x4.png" },
  }));
  writeConfig(createOnboardedConfig({
    sourceDirectory: "/absolute/path/to/videos",
    availablePlatforms: ["xiaohongshu"],
    defaultPlatforms: ["xiaohongshu"],
    accounts: {
      xiaohongshu: {
        profileId: "PASTE_PROFILE_ID",
        profileLabel: "Profile 2",
        displayName: "PASTE_ACCOUNT_DISPLAY_NAME",
        accountId: "PASTE_ACCOUNT_ID",
      },
    },
  }), configPath);
  await fs.promises.writeFile(fakeEgoPath, `
    import fs from "node:fs";
    let script = "";
    for await (const chunk of process.stdin) script += chunk;
    fs.writeFileSync(process.env.VIDEO_PUBLISHER_TEST_SCRIPT, script);
    console.log("VIDEO_PUBLISHER_BINDING_DIAGNOSTIC:" + JSON.stringify({
      profiles: [{ profileId: "prof-real", label: "Profile 2" }],
      spaces: [{ id: 7, name: "existing", profileId: "prof-real" }],
      taskSpaceCalled: false,
      pageOpened: false
    }));
  `);
  const env = {
    ...process.env,
    VIDEO_PUBLISHER_CONFIG: configPath,
    VIDEO_PUBLISHER_V2_EGO_COMMAND: fakeEgoPath,
    VIDEO_PUBLISHER_TEST_SCRIPT: scriptPath,
    VIDEO_PUBLISHER_V2_LOCK_ROOT: path.join(root, "locks"),
  };
  const discovered = await run(process.execPath, [
    path.join(V2_DIR, "publisher.mjs"),
    "--operation", "diagnose-binding",
    "--package", packagePath,
    "--platforms", "xiaohongshu",
    "--job-id", "binding-diagnostic-20261107",
    "--state-root", stateRoot,
    "--no-cleanup-stale-spaces",
  ], { env });
  assert.equal(discovered.code, 0, `${discovered.stderr}\n${discovered.stdout}`);
  assert.equal(fs.existsSync(stateRoot), false);
  assert.equal(fs.existsSync(path.join(root, "video.mp4")), false);
  assert.equal(fs.existsSync("/absolute/path/to/video.mp4"), false);
  const summary = JSON.parse(discovered.stdout);
  assert.equal(summary.ready, false);
  assert.equal(summary.accepted, false);
  assert.equal(summary.accountVerified, false);
  assert.equal(summary.stateWritten, false);
  assert.deepEqual(summary.pathsWritten, []);
  assert.equal(summary.package.read, false);
  assert.equal(summary.package.mediaPreflight, "not-run");
  assert.equal(summary.config.blocksThisDiagnostic, false);
  assert.equal(summary.config.bindingUsed, false);
  assert.match(summary.config.notes.join("\n"), /sourceDirectory does not exist/);
  assert.match(summary.config.notes.join("\n"), /placeholder/);
  assert.equal(summary.diagnostic.profileInventory.profiles[0].profileId, "prof-real");
  assert.equal(summary.diagnostic.profileInventory.profiles[0].label, "Profile 2");
  assert.equal(summary.diagnostic.spaceInventory.created, false);
  assert.equal(summary.diagnostic.spaceInventory.opened, false);
  assert.equal(summary.diagnostic.defaultProfileChanged, false);
  const script = await fs.promises.readFile(scriptPath, "utf8");
  assert.match(script, /await profiles\(\)/);
  assert.match(script, /await listTaskSpaces\(\)/);
  assert.doesNotMatch(script, /taskSpace\s*\(|openOrReuseTab|uploadFile|completeTaskSpace|goto\(|\bclick\s*\(/);
  const bare = await run(process.execPath, [
    path.join(V2_DIR, "publisher.mjs"),
    "--operation", "diagnose-binding",
  ], {
    env: {
      ...env,
      VIDEO_PUBLISHER_CONFIG: path.join(root, "missing-config.json"),
      VIDEO_PUBLISHER_TEST_SCRIPT: path.join(root, "bare-script.mjs"),
    },
  });
  assert.equal(bare.code, 0, `${bare.stderr}\n${bare.stdout}`);
  const bareSummary = JSON.parse(bare.stdout);
  assert.equal(bareSummary.package.supplied, false);
  assert.equal(bareSummary.config.configPresent, false);
  assert.equal(bareSummary.accountVerified, false);
  const created = await run(process.execPath, [
    path.join(V2_DIR, "publisher.mjs"),
    packagePath,
    "xiaohongshu",
    "--operation", "create",
    "--job-id", "real-job",
    "--state-root", path.join(root, "jobs"),
  ], { env });
  assert.notEqual(created.code, 0);
  assert.match(`${created.stderr}\n${created.stdout}`, /Package preflight failed/);
  assert.match(`${created.stderr}\n${created.stdout}`, /video file not found/);
  assert.match(`${created.stderr}\n${created.stdout}`, /custom cover file not found/);
  assert.equal(fs.existsSync(path.join(root, "jobs")), false);
  await fs.promises.rm(root, { recursive: true, force: true });
});

test("resume refuses to retarget a job onto another account", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "video-publisher-binding-retarget-"));
  const videoPath = path.join(root, "video.mp4");
  const packagePath = path.join(root, "package.json");
  const configPath = path.join(root, "config.json");
  await fs.promises.writeFile(videoPath, "video");
  await fs.promises.writeFile(packagePath, JSON.stringify({
    videoPath, title: "绑定", xhsTopics: ["示例"], cover: { uploadCustomCover: false },
  }));
  const base = {
    sourceDirectory: root,
    availablePlatforms: ["xiaohongshu"],
    defaultPlatforms: ["xiaohongshu"],
    declarations: { originalityPolicy: "all_videos_original" },
  };
  writeConfig(createOnboardedConfig({ ...base, accounts: { xiaohongshu: binding } }), configPath);
  const env = {
    ...process.env,
    VIDEO_PUBLISHER_CONFIG: configPath,
    VIDEO_PUBLISHER_V2_RUNNER: path.join(DIR, "mock-runner.mjs"),
    VIDEO_PUBLISHER_V2_LOCK_ROOT: path.join(root, "locks"),
    VIDEO_PUBLISHER_V2_EGO_COMMAND: path.join(DIR, "mock-ego-cleanup.mjs"),
  };
  const created = await run(process.execPath, [
    path.join(V2_DIR, "publisher.mjs"), packagePath, "retarget", "xiaohongshu",
    "--job-id", "same-job", "--state-root", root, "--operation", "create", "--no-cleanup-stale-spaces",
  ], { env });
  assert.equal(created.code, 0, `${created.stderr}\n${created.stdout}`);
  writeConfig(createOnboardedConfig({
    ...base,
    accounts: { xiaohongshu: { ...binding, accountId: "2000000002", displayName: "Other Creator" } },
  }), configPath);
  const resumed = await run(process.execPath, [
    path.join(V2_DIR, "publisher.mjs"), packagePath, "retarget", "xiaohongshu",
    "--job-id", "same-job", "--state-root", root, "--operation", "resume", "--reuse-space", "--no-cleanup-stale-spaces",
  ], { env });
  assert.notEqual(resumed.code, 0);
  assert.match(`${resumed.stderr}\n${resumed.stdout}`, /Refusing to retarget this job/);
  await fs.promises.rm(root, { recursive: true, force: true });
});
