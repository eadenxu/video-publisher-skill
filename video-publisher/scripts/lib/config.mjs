import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { normalizeAccountBinding } from "../v2/lib/account-binding.mjs";

export const CONFIG_SCHEMA_VERSION = 2;
const LEGACY_CONFIG_SCHEMA_VERSION = 1;
export const CONFIG_PLATFORMS = ["xiaohongshu", "douyin", "bilibili", "wechat_channels", "youtube"];
export const ORIGINALITY_POLICIES = ["ask_each_run", "all_videos_original"];
export const MAINTENANCE_CONFIG_PURPOSE = "maintenance-account-observation";
const MAINTENANCE_CONFIG_KEYS = ["schemaVersion", "purpose", "locale", "accounts"];

function cleanList(values = []) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    const item = String(value || "").trim().replace(/^#+\s*/, "").trim();
    if (!item || seen.has(item)) continue;
    seen.add(item);
    result.push(item);
  }
  return result;
}

export function resolveConfigPath() {
  if (process.env.VIDEO_PUBLISHER_CONFIG) return path.resolve(process.env.VIDEO_PUBLISHER_CONFIG);
  const configHome = process.env.XDG_CONFIG_HOME
    ? path.resolve(process.env.XDG_CONFIG_HOME)
    : path.join(os.homedir(), ".config");
  return path.join(configHome, "video-publisher", "config.json");
}

export function defaultConfig() {
  return {
    schemaVersion: CONFIG_SCHEMA_VERSION,
    onboarding: {
      completed: false,
      completedAt: "",
      updatedAt: "",
    },
    locale: "zh-CN",
    sourceDirectory: path.join(os.homedir(), "Movies"),
    availablePlatforms: [],
    defaultPlatforms: [],
    contentProfile: {
      copyStyle: "clear, conversational, specific, non-hype",
      recurringTags: [],
    },
    declarations: {
      originalityPolicy: "ask_each_run",
    },
    platforms: {
      douyin: { defaultTopics: [] },
      bilibili: { allowedAutoTags: [] },
      youtube: {
        defaultCategory: "",
        defaultLanguage: "",
        defaultVisibility: "private",
      },
    },
    execution: {
      checkConcurrency: 4,
      uploadConcurrency: 4,
    },
    cover: {
      uploadExistingByDefault: false,
    },
    accounts: {
      xiaohongshu: null,
    },
  };
}

export function normalizeConfig(raw = {}) {
  const fallback = defaultConfig();
  const binding = normalizeAccountBinding(raw.accounts?.xiaohongshu);
  const accountKeys = raw.accounts && typeof raw.accounts === "object" && !Array.isArray(raw.accounts)
    ? Object.keys(raw.accounts).filter(key => key !== "xiaohongshu" && key !== "bindingErrors")
    : [];
  const rawSchemaVersion = Number(raw.schemaVersion ?? fallback.schemaVersion);
  const defaultPlatforms = Array.isArray(raw.defaultPlatforms)
    ? cleanList(raw.defaultPlatforms)
    : fallback.defaultPlatforms;
  const availablePlatforms = Array.isArray(raw.availablePlatforms)
    ? cleanList(raw.availablePlatforms)
    : rawSchemaVersion === LEGACY_CONFIG_SCHEMA_VERSION && Array.isArray(raw.defaultPlatforms)
      ? [...defaultPlatforms]
      : Object.keys(raw).length === 0
        ? fallback.availablePlatforms
        : [];
  return {
    schemaVersion: rawSchemaVersion === LEGACY_CONFIG_SCHEMA_VERSION
      ? CONFIG_SCHEMA_VERSION
      : rawSchemaVersion,
    onboarding: {
      completed: raw.onboarding?.completed === true,
      completedAt: String(raw.onboarding?.completedAt || ""),
      updatedAt: String(raw.onboarding?.updatedAt || ""),
    },
    locale: String(raw.locale || fallback.locale).trim(),
    sourceDirectory: String(raw.sourceDirectory || fallback.sourceDirectory).trim(),
    availablePlatforms,
    defaultPlatforms,
    contentProfile: {
      copyStyle: String(raw.contentProfile?.copyStyle || fallback.contentProfile.copyStyle).trim(),
      recurringTags: cleanList(raw.contentProfile?.recurringTags || []),
    },
    declarations: {
      originalityPolicy: String(raw.declarations?.originalityPolicy || fallback.declarations.originalityPolicy).trim(),
    },
    platforms: {
      douyin: {
        defaultTopics: cleanList(raw.platforms?.douyin?.defaultTopics || []),
      },
      bilibili: {
        allowedAutoTags: cleanList(raw.platforms?.bilibili?.allowedAutoTags || []),
      },
      youtube: {
        defaultCategory: String(raw.platforms?.youtube?.defaultCategory || "").trim(),
        defaultLanguage: String(raw.platforms?.youtube?.defaultLanguage || "").trim(),
        defaultVisibility: String(raw.platforms?.youtube?.defaultVisibility || fallback.platforms.youtube.defaultVisibility).trim(),
      },
    },
    execution: {
      checkConcurrency: Number(raw.execution?.checkConcurrency ?? fallback.execution.checkConcurrency),
      uploadConcurrency: Number(raw.execution?.uploadConcurrency ?? fallback.execution.uploadConcurrency),
    },
    cover: {
      uploadExistingByDefault: raw.cover?.uploadExistingByDefault === true,
    },
    accounts: {
      xiaohongshu: binding.ok ? binding.binding : null,
      bindingErrors: [
        ...(binding.ok ? [] : binding.errors),
        ...(accountKeys.length ? [`accounts only supports xiaohongshu: ${accountKeys.join(", ")}`] : []),
      ],
    },
  };
}

export function normalizeMaintenanceConfig(raw = {}) {
  const source = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const unknownKeys = Object.keys(source).filter(key => !MAINTENANCE_CONFIG_KEYS.includes(key));
  const binding = normalizeAccountBinding(source.accounts?.xiaohongshu);
  const accountKeys = source.accounts && typeof source.accounts === "object" && !Array.isArray(source.accounts)
    ? Object.keys(source.accounts).filter(key => key !== "xiaohongshu")
    : [];
  const bindingErrors = [
    ...(source.accounts?.xiaohongshu == null ? ["accounts.xiaohongshu is required"] : []),
    ...(binding.ok ? [] : binding.errors),
    ...(accountKeys.length ? [`accounts only supports xiaohongshu: ${accountKeys.join(", ")}`] : []),
  ];
  const storedBinding = binding.ok ? binding.binding : null;
  if (storedBinding && source.accounts?.xiaohongshu && Object.prototype.hasOwnProperty.call(source.accounts.xiaohongshu, "labelLikeProfileId")
    && source.accounts.xiaohongshu.labelLikeProfileId !== storedBinding.labelLikeProfileId) {
    bindingErrors.push("accounts.xiaohongshu.labelLikeProfileId does not match profileId; Profile 2 is true, other ids are false");
  }
  if (storedBinding && source.accounts?.xiaohongshu?.platform != null && source.accounts.xiaohongshu.platform !== "xiaohongshu") {
    bindingErrors.push("accounts.xiaohongshu.platform must be xiaohongshu");
  }
  return {
    schemaVersion: Number(source.schemaVersion),
    purpose: source.purpose === MAINTENANCE_CONFIG_PURPOSE ? MAINTENANCE_CONFIG_PURPOSE : String(source.purpose || ""),
    locale: String(source.locale || "").trim(),
    accounts: {
      xiaohongshu: storedBinding,
      bindingErrors,
    },
    unknownKeys,
  };
}

export function validateMaintenanceConfig(config) {
  const errors = [];
  if (config.purpose !== MAINTENANCE_CONFIG_PURPOSE) errors.push(`purpose must be ${MAINTENANCE_CONFIG_PURPOSE}`);
  if (config.schemaVersion !== CONFIG_SCHEMA_VERSION) errors.push(`schemaVersion must be ${CONFIG_SCHEMA_VERSION}`);
  if (!config.locale) errors.push("locale is required");
  if (config.unknownKeys?.length) {
    errors.push(`maintenance config only allows ${MAINTENANCE_CONFIG_KEYS.join(", ")}: ${config.unknownKeys.join(", ")}`);
  }
  const binding = config.accounts?.xiaohongshu;
  if (binding) {
    if (!binding.profileId) errors.push("accounts.xiaohongshu.profileId is required and must be copied from profiles()");
    if (!binding.displayName) errors.push("accounts.xiaohongshu.displayName is required");
    if (!binding.accountId) errors.push("accounts.xiaohongshu.accountId is required");
  } else if (!config.accounts?.bindingErrors?.length) errors.push("accounts.xiaohongshu is required");
  if (config.accounts?.bindingErrors?.length) errors.push(...config.accounts.bindingErrors);
  return errors;
}

export function maintenanceAccountFile(input = {}) {
  const normalized = normalizeMaintenanceConfig({
    schemaVersion: CONFIG_SCHEMA_VERSION,
    purpose: MAINTENANCE_CONFIG_PURPOSE,
    locale: input.locale || "zh-CN",
    accounts: {
      xiaohongshu: {
        profileId: input.profileId,
        profileLabel: input.profileLabel || "",
        displayName: input.displayName,
        accountId: input.accountId,
      },
    },
  });
  const errors = validateMaintenanceConfig(normalized);
  if (errors.length) throw new Error(errors.join("; "));
  return {
    schemaVersion: normalized.schemaVersion,
    purpose: normalized.purpose,
    locale: normalized.locale,
    accounts: { xiaohongshu: normalized.accounts.xiaohongshu },
  };
}

export function validateConfig(config) {
  const errors = [];
  if (config.schemaVersion !== CONFIG_SCHEMA_VERSION) {
    errors.push(`schemaVersion must be ${CONFIG_SCHEMA_VERSION}`);
  }
  if (!config.locale) errors.push("locale is required");
  if (!path.isAbsolute(config.sourceDirectory)) errors.push("sourceDirectory must be an absolute path");
  if (!config.availablePlatforms.length) errors.push("availablePlatforms must not be empty");
  const unsupportedAvailable = config.availablePlatforms.filter(platform => !CONFIG_PLATFORMS.includes(platform));
  if (unsupportedAvailable.length) errors.push(`unsupported availablePlatforms: ${unsupportedAvailable.join(", ")}`);
  if (!config.defaultPlatforms.length) errors.push("defaultPlatforms must not be empty");
  const unsupported = config.defaultPlatforms.filter(platform => !CONFIG_PLATFORMS.includes(platform));
  if (unsupported.length) errors.push(`unsupported defaultPlatforms: ${unsupported.join(", ")}`);
  const unavailableDefaults = config.defaultPlatforms.filter(platform => !config.availablePlatforms.includes(platform));
  if (unavailableDefaults.length) {
    errors.push(`defaultPlatforms must be a subset of availablePlatforms: ${unavailableDefaults.join(", ")}`);
  }
  if (config.platforms.douyin.defaultTopics.length > 5) {
    errors.push("platforms.douyin.defaultTopics supports at most 5 topics");
  }
  if (!["private", "unlisted", "public"].includes(config.platforms.youtube.defaultVisibility)) {
    errors.push("platforms.youtube.defaultVisibility must be one of: private, unlisted, public");
  }
  if (!ORIGINALITY_POLICIES.includes(config.declarations.originalityPolicy)) {
    errors.push(`declarations.originalityPolicy must be one of: ${ORIGINALITY_POLICIES.join(", ")}`);
  }
  if (config.accounts?.bindingErrors?.length) errors.push(...config.accounts.bindingErrors);
  if (config.accounts?.xiaohongshu && !config.availablePlatforms.includes("xiaohongshu")) {
    errors.push("accounts.xiaohongshu requires xiaohongshu in availablePlatforms");
  }
  for (const key of ["checkConcurrency", "uploadConcurrency"]) {
    const value = config.execution[key];
    if (!Number.isInteger(value) || value < 1) errors.push(`execution.${key} must be a positive integer`);
  }
  return errors;
}

export function configStatus(configPath = resolveConfigPath()) {
  const absolutePath = path.resolve(configPath);
  const exists = fs.existsSync(absolutePath);
  let raw = {};
  let parseError = "";
  if (exists) {
    try {
      const text = fs.readFileSync(absolutePath, "utf8");
      raw = text.trim() ? JSON.parse(text) : {};
    } catch (error) {
      parseError = String(error?.message || error);
    }
  }
  const empty = !raw || typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).length === 0;
  if (!empty && raw.purpose === MAINTENANCE_CONFIG_PURPOSE) {
    const config = normalizeMaintenanceConfig(raw);
    const errors = [...(parseError ? [`invalid JSON: ${parseError}`] : []), ...validateMaintenanceConfig(config)];
    if (config.accounts) delete config.accounts.bindingErrors;
    delete config.unknownKeys;
    return {
      path: absolutePath,
      exists,
      empty: false,
      purpose: MAINTENANCE_CONFIG_PURPOSE,
      productionReady: false,
      maintenanceReady: errors.length === 0,
      onboardingRequired: true,
      errors,
      warnings: [],
      config,
    };
  }
  const config = normalizeConfig(empty ? {} : raw);
  const errors = [...(parseError ? [`invalid JSON: ${parseError}`] : []), ...validateConfig(config)];
  if (!empty && Object.prototype.hasOwnProperty.call(raw, "purpose")) {
    errors.push(`unsupported purpose: ${String(raw.purpose)}`);
  }
  if (config.accounts) delete config.accounts.bindingErrors;
  const warnings = [];
  if (path.isAbsolute(config.sourceDirectory)) {
    if (!fs.existsSync(config.sourceDirectory)) warnings.push(`sourceDirectory does not exist: ${config.sourceDirectory}`);
    else if (!fs.statSync(config.sourceDirectory).isDirectory()) warnings.push(`sourceDirectory is not a directory: ${config.sourceDirectory}`);
  }
  const onboardingRequired = !exists || empty || config.onboarding.completed !== true || errors.length > 0;
  return {
    path: absolutePath,
    exists,
    empty,
    purpose: "production",
    productionReady: !onboardingRequired && warnings.length === 0,
    maintenanceReady: false,
    onboardingRequired,
    errors,
    warnings,
    config,
  };
}

export function loadConfig({ configPath = resolveConfigPath(), requireOnboarded = false } = {}) {
  const status = configStatus(configPath);
  if (status.purpose === MAINTENANCE_CONFIG_PURPOSE && status.maintenanceReady !== true) {
    throw new Error(`maintenance config is not ready: ${status.errors.join("; ")}`);
  }
  if (requireOnboarded && status.purpose === MAINTENANCE_CONFIG_PURPOSE) {
    throw new Error("This config purpose is maintenance-account-observation and productionReady is false. Refusing create, resume, inspect, and every other production command.");
  }
  if (requireOnboarded && status.onboardingRequired) {
    const detail = status.errors.length ? ` ${status.errors.join("; ")}` : "";
    throw new Error(`Video Publisher onboarding is incomplete. Run: node scripts/config.mjs status.${detail}`);
  }
  return status.config;
}

export function createOnboardedConfig(input = {}) {
  const now = new Date().toISOString();
  const config = normalizeConfig({
    schemaVersion: CONFIG_SCHEMA_VERSION,
    onboarding: {
      completed: true,
      completedAt: input.completedAt || now,
      updatedAt: now,
    },
    locale: input.locale,
    sourceDirectory: input.sourceDirectory,
    availablePlatforms: input.availablePlatforms,
    defaultPlatforms: input.defaultPlatforms,
    contentProfile: input.contentProfile,
    declarations: input.declarations,
    platforms: input.platforms,
    execution: input.execution,
    cover: input.cover,
    accounts: input.accounts,
  });
  const errors = validateConfig(config);
  if (errors.length) throw new Error(errors.join("; "));
  if (config.accounts) delete config.accounts.bindingErrors;
  return config;
}

export function writeMaintenanceConfig(config, configPath = resolveConfigPath()) {
  const normalized = normalizeMaintenanceConfig(config);
  const errors = validateMaintenanceConfig(normalized);
  if (errors.length) throw new Error(errors.join("; "));
  const stored = {
    schemaVersion: normalized.schemaVersion,
    purpose: normalized.purpose,
    locale: normalized.locale,
    accounts: { xiaohongshu: normalized.accounts.xiaohongshu },
  };
  const absolutePath = path.resolve(configPath);
  if (fs.existsSync(absolutePath)) throw new Error(`refusing to overwrite existing config: ${absolutePath}`);
  const parent = path.dirname(absolutePath);
  const parentExisted = fs.existsSync(parent);
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  if (!parentExisted) fs.chmodSync(parent, 0o700);
  const temporaryPath = `${absolutePath}.tmp-${process.pid}`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(stored, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporaryPath, absolutePath);
  fs.chmodSync(absolutePath, 0o600);
  return absolutePath;
}

export function writeConfig(config, configPath = resolveConfigPath()) {
  if (config?.purpose === MAINTENANCE_CONFIG_PURPOSE) {
    throw new Error("writeConfig refuses a maintenance-account-observation config. Use init-maintenance-account.");
  }
  const normalized = normalizeConfig(config);
  const errors = validateConfig(normalized);
  if (normalized.onboarding.completed !== true) errors.push("onboarding.completed must be true");
  if (errors.length) throw new Error(errors.join("; "));
  const stored = {
    ...normalized,
    accounts: { xiaohongshu: normalized.accounts?.xiaohongshu || null },
  };
  const absolutePath = path.resolve(configPath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  const temporaryPath = `${absolutePath}.tmp-${process.pid}`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(stored, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporaryPath, absolutePath);
  fs.chmodSync(absolutePath, 0o600);
  return absolutePath;
}
