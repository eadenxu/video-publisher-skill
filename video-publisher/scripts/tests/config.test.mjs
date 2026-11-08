import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  configStatus,
  createOnboardedConfig,
  maintenanceAccountFile,
  validateMaintenanceConfig,
  writeConfig,
  writeMaintenanceConfig,
} from "../lib/config.mjs";

const SCRIPT_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "config.mjs");

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", code => resolve({ code, stdout, stderr }));
  });
}

test("missing or empty configuration requires onboarding", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "video-publisher-config-empty-"));
  const configPath = path.join(root, "config.json");
  assert.equal(configStatus(configPath).onboardingRequired, true);
  await fs.promises.writeFile(configPath, "{}\n");
  const empty = configStatus(configPath);
  assert.equal(empty.empty, true);
  assert.equal(empty.onboardingRequired, true);
  assert.deepEqual(empty.config.availablePlatforms, []);
  assert.deepEqual(empty.config.defaultPlatforms, []);
  assert.equal(empty.config.declarations.originalityPolicy, "ask_each_run");
  await fs.promises.rm(root, { recursive: true, force: true });
});

test("completed onboarding writes a valid private per-user configuration", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "video-publisher-config-ready-"));
  const configPath = path.join(root, "nested", "config.json");
  const config = createOnboardedConfig({
    locale: "zh-CN",
    sourceDirectory: root,
    availablePlatforms: ["xiaohongshu", "douyin", "bilibili"],
    defaultPlatforms: ["douyin", "bilibili"],
    contentProfile: { recurringTags: ["Tutorial"] },
    declarations: { originalityPolicy: "all_videos_original" },
    platforms: {
      douyin: { defaultTopics: ["Tutorial"] },
      bilibili: { allowedAutoTags: [] },
    },
  });
  writeConfig(config, configPath);
  const ready = configStatus(configPath);
  assert.equal(ready.onboardingRequired, false);
  assert.equal(ready.purpose, "production");
  assert.equal(ready.productionReady, true);
  assert.equal(ready.maintenanceReady, false);
  assert.deepEqual(ready.config.availablePlatforms, ["xiaohongshu", "douyin", "bilibili"]);
  assert.deepEqual(ready.config.defaultPlatforms, ["douyin", "bilibili"]);
  assert.deepEqual(ready.config.platforms.douyin.defaultTopics, ["Tutorial"]);
  assert.equal(ready.config.declarations.originalityPolicy, "all_videos_original");
  if (process.platform !== "win32") assert.equal(fs.statSync(configPath).mode & 0o777, 0o600);
  await fs.promises.rm(root, { recursive: true, force: true });
});

test("onboarding CLI persists repeated platform and topic options", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "video-publisher-config-cli-"));
  const configPath = path.join(root, "profile", "config.json");
  const result = await run(process.execPath, [
    SCRIPT_PATH,
    "onboard",
    "--source-dir", root,
    "--available-platform", "xiaohongshu",
    "--available-platform", "douyin",
    "--available-platform", "bilibili",
    "--platform", "douyin",
    "--platform", "bilibili",
    "--recurring-tag", "Tutorial",
    "--douyin-topic", "Tutorial",
    "--bilibili-auto-tag", "Platform tag",
    "--originality-policy", "all_videos_original",
  ], { env: { ...process.env, VIDEO_PUBLISHER_CONFIG: configPath } });
  assert.equal(result.code, 0, `${result.stderr}\n${result.stdout}`);
  const output = JSON.parse(result.stdout);
  assert.equal(output.onboardingRequired, false);
  assert.deepEqual(output.config.availablePlatforms, ["xiaohongshu", "douyin", "bilibili"]);
  assert.deepEqual(output.config.defaultPlatforms, ["douyin", "bilibili"]);
  assert.deepEqual(output.config.platforms.douyin.defaultTopics, ["Tutorial"]);
  assert.deepEqual(output.config.platforms.bilibili.allowedAutoTags, ["Platform tag"]);
  assert.equal(output.config.declarations.originalityPolicy, "all_videos_original");
  await fs.promises.rm(root, { recursive: true, force: true });
});

test("onboarding defaults to every available platform when no default subset is supplied", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "video-publisher-config-available-defaults-"));
  const configPath = path.join(root, "config.json");
  const result = await run(process.execPath, [
    SCRIPT_PATH,
    "onboard",
    "--source-dir", root,
    "--available-platform", "xiaohongshu",
    "--available-platform", "wechat_channels",
  ], { env: { ...process.env, VIDEO_PUBLISHER_CONFIG: configPath } });
  assert.equal(result.code, 0, `${result.stderr}\n${result.stdout}`);
  const output = JSON.parse(result.stdout);
  assert.deepEqual(output.config.availablePlatforms, ["xiaohongshu", "wechat_channels"]);
  assert.deepEqual(output.config.defaultPlatforms, ["xiaohongshu", "wechat_channels"]);
  await fs.promises.rm(root, { recursive: true, force: true });
});

test("add-platform preserves existing onboarding preferences", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "video-publisher-config-add-platform-"));
  const configPath = path.join(root, "config.json");
  const initial = createOnboardedConfig({
    sourceDirectory: root,
    availablePlatforms: ["xiaohongshu"],
    defaultPlatforms: ["xiaohongshu"],
    contentProfile: { copyStyle: "Personal style", recurringTags: ["Existing"] },
    declarations: { originalityPolicy: "all_videos_original" },
    execution: { checkConcurrency: 2, uploadConcurrency: 3 },
  });
  writeConfig(initial, configPath);
  const result = await run(process.execPath, [
    SCRIPT_PATH,
    "add-platform",
    "douyin",
    "--default",
    "--douyin-topic", "New topic",
  ], { env: { ...process.env, VIDEO_PUBLISHER_CONFIG: configPath } });
  assert.equal(result.code, 0, `${result.stderr}\n${result.stdout}`);
  const updated = JSON.parse(result.stdout).config;
  assert.deepEqual(updated.availablePlatforms, ["xiaohongshu", "douyin"]);
  assert.deepEqual(updated.defaultPlatforms, ["xiaohongshu", "douyin"]);
  assert.deepEqual(updated.contentProfile, { copyStyle: "Personal style", recurringTags: ["Existing"] });
  assert.deepEqual(updated.platforms.douyin.defaultTopics, ["New topic"]);
  assert.equal(updated.declarations.originalityPolicy, "all_videos_original");
  assert.deepEqual(updated.execution, { checkConcurrency: 2, uploadConcurrency: 3 });
  await fs.promises.rm(root, { recursive: true, force: true });
});

test("schema 1 configurations conservatively migrate available platforms from old defaults", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "video-publisher-config-legacy-"));
  const configPath = path.join(root, "config.json");
  await fs.promises.writeFile(configPath, JSON.stringify({
    schemaVersion: 1,
    onboarding: { completed: true },
    sourceDirectory: root,
    defaultPlatforms: ["douyin", "bilibili"],
  }));
  const migrated = configStatus(configPath);
  assert.equal(migrated.onboardingRequired, false);
  assert.equal(migrated.config.schemaVersion, 2);
  assert.deepEqual(migrated.config.availablePlatforms, ["douyin", "bilibili"]);
  assert.deepEqual(migrated.config.defaultPlatforms, ["douyin", "bilibili"]);
  await fs.promises.rm(root, { recursive: true, force: true });
});

test("default platforms must be selected from available creator accounts", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "video-publisher-config-subset-"));
  assert.throws(() => createOnboardedConfig({
    sourceDirectory: root,
    availablePlatforms: ["xiaohongshu"],
    defaultPlatforms: ["douyin"],
  }), /defaultPlatforms must be a subset of availablePlatforms: douyin/);
  await fs.promises.rm(root, { recursive: true, force: true });
});

test("YouTube can be added non-destructively with private publishing defaults", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "video-publisher-config-youtube-"));
  const configPath = path.join(root, "config.json");
  const initial = createOnboardedConfig({
    sourceDirectory: root,
    availablePlatforms: ["bilibili"],
    defaultPlatforms: ["bilibili"],
    contentProfile: { copyStyle: "Personal style", recurringTags: ["AI"] },
  });
  writeConfig(initial, configPath);
  const result = await run(process.execPath, [
    SCRIPT_PATH,
    "add-platform",
    "youtube",
    "--default",
    "--youtube-category", "科学与技术",
    "--youtube-language", "中文（简体）",
    "--youtube-visibility", "private",
  ], { env: { ...process.env, VIDEO_PUBLISHER_CONFIG: configPath } });
  assert.equal(result.code, 0, `${result.stderr}\n${result.stdout}`);
  const updated = JSON.parse(result.stdout).config;
  assert.deepEqual(updated.availablePlatforms, ["bilibili", "youtube"]);
  assert.deepEqual(updated.defaultPlatforms, ["bilibili", "youtube"]);
  assert.deepEqual(updated.platforms.youtube, {
    defaultCategory: "科学与技术",
    defaultLanguage: "中文（简体）",
    defaultVisibility: "private",
  });
  assert.deepEqual(updated.contentProfile, { copyStyle: "Personal style", recurringTags: ["AI"] });
  await fs.promises.rm(root, { recursive: true, force: true });
});

test("maintenance account config validates without media or production onboarding", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "video-publisher-maintenance-config-"));
  const configPath = path.join(root, "maintenance", "config.json");
  const examplePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "examples", "maintenance-config.example.json");
  const example = JSON.parse(await fs.promises.readFile(examplePath, "utf8"));
  assert.equal(example.purpose, "maintenance-account-observation");
  assert.equal(Object.hasOwn(example, "sourceDirectory"), false);
  assert.equal(Object.hasOwn(example, "onboarding"), false);
  assert.equal(Object.hasOwn(example, "declarations"), false);
  const exampleStatus = configStatus(examplePath);
  assert.equal(exampleStatus.maintenanceReady, true);
  assert.equal(exampleStatus.productionReady, false);
  const created = await run(process.execPath, [
    SCRIPT_PATH,
    "init-maintenance-account",
    "--profile-id", "Profile 2",
    "--profile-label", "AI",
    "--display-name", "Example Creator",
    "--account-id", "1000000001",
  ], { env: { ...process.env, VIDEO_PUBLISHER_CONFIG: configPath } });
  assert.equal(created.code, 0, `${created.stderr}\n${created.stdout}`);
  const status = JSON.parse(created.stdout);
  assert.equal(status.maintenanceReady, true);
  assert.equal(status.productionReady, false);
  assert.equal(status.onboardingRequired, true);
  assert.deepEqual(status.errors, []);
  const stored = JSON.parse(await fs.promises.readFile(configPath, "utf8"));
  assert.deepEqual(Object.keys(stored).sort(), ["accounts", "locale", "purpose", "schemaVersion"]);
  assert.equal(stored.accounts.xiaohongshu.labelLikeProfileId, true);
  assert.equal(stored.accounts.xiaohongshu.profileId, "Profile 2");
  const checked = await run(process.execPath, [SCRIPT_PATH, "validate-maintenance"], {
    env: { ...process.env, VIDEO_PUBLISHER_CONFIG: configPath },
  });
  assert.equal(checked.code, 0, checked.stdout);
  const production = await run(process.execPath, [SCRIPT_PATH, "validate"], {
    env: { ...process.env, VIDEO_PUBLISHER_CONFIG: configPath },
  });
  assert.equal(production.code, 1);
  assert.equal(JSON.parse(production.stdout).productionReady, false);
  const again = await run(process.execPath, [
    SCRIPT_PATH,
    "init-maintenance-account",
    "--profile-id", "Profile 2",
    "--display-name", "Example Creator",
    "--account-id", "1000000001",
  ], { env: { ...process.env, VIDEO_PUBLISHER_CONFIG: configPath } });
  assert.equal(again.code, 1);
  assert.match(again.stdout, /refusing to overwrite/);
  const missing = path.join(root, "missing", "config.json");
  const noIdentity = await run(process.execPath, [
    SCRIPT_PATH,
    "init-maintenance-account",
    "--profile-id", "Profile 2",
    "--display-name", "Example Creator",
  ], { env: { ...process.env, VIDEO_PUBLISHER_CONFIG: missing } });
  assert.equal(noIdentity.code, 1);
  assert.equal(fs.existsSync(missing), false);
  const withMedia = await run(process.execPath, [
    SCRIPT_PATH,
    "init-maintenance-account",
    "--profile-id", "Profile 2",
    "--display-name", "Example Creator",
    "--account-id", "1000000001",
    "--source-dir", root,
  ], { env: { ...process.env, VIDEO_PUBLISHER_CONFIG: path.join(root, "other.json") } });
  assert.equal(withMedia.code, 1);
  assert.equal(fs.existsSync(path.join(root, "other.json")), false);
  const unset = await run(process.execPath, [
    SCRIPT_PATH,
    "init-maintenance-account",
    "--profile-id", "Profile 2",
    "--display-name", "Example Creator",
    "--account-id", "1000000001",
  ], { env: { ...process.env, VIDEO_PUBLISHER_CONFIG: "" } });
  assert.equal(unset.code, 1);
  assert.match(unset.stdout, /VIDEO_PUBLISHER_CONFIG/);
  await fs.promises.writeFile(path.join(root, "bad.json"), `${JSON.stringify({
    ...maintenanceAccountFile({ profileId: "Profile 2", displayName: "Example Creator", accountId: "1000000001" }),
    sourceDirectory: "/absolute/path/to/videos",
    onboarding: { completed: true },
    declarations: { originalityPolicy: "ask_each_run" },
  }, null, 2)}\n`);
  const bad = configStatus(path.join(root, "bad.json"));
  assert.equal(bad.maintenanceReady, false);
  assert.equal(bad.productionReady, false);
  assert.match(bad.errors.join("\n"), /sourceDirectory/);
  assert.throws(() => writeConfig(maintenanceAccountFile({
    profileId: "Profile 2",
    displayName: "Example Creator",
    accountId: "1000000001",
  }), path.join(root, "laundered.json")), /refuses a maintenance-account-observation config/);
  assert.equal(validateMaintenanceConfig(configStatus(configPath).config).length, 0);
  await fs.promises.rm(root, { recursive: true, force: true });
});
