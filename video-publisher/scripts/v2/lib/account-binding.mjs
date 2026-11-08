const LABEL_LIKE_PROFILE_ID = /^profile\s+\d+$/i;
const SECRET_KEY = /cookie|token|password|secret|authorization|credential/i;

export function normalizeAccountBinding(raw) {
  if (raw == null || raw === false) return { ok: true, binding: null };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, errors: ["accounts.xiaohongshu must be an object"] };
  }
  const profileId = String(raw.profileId || "").trim();
  const profileLabel = String(raw.profileLabel || "").trim();
  const displayName = String(raw.displayName || "").trim();
  const accountId = String(raw.accountId || "").trim();
  const errors = [];
  if (!profileId) errors.push("accounts.xiaohongshu.profileId is required and must be copied from profiles()");
  if (profileId.length > 128) errors.push("accounts.xiaohongshu.profileId must be at most 128 characters");
  if (/[\r\n]/.test(profileId)) errors.push("accounts.xiaohongshu.profileId must be a single line");
  if (profileLabel && profileId === profileLabel) {
    errors.push("accounts.xiaohongshu.profileId must be the id from profiles(), not the human profile label");
  }
  if (!displayName) errors.push("accounts.xiaohongshu.displayName is required");
  if (displayName.length > 80) errors.push("accounts.xiaohongshu.displayName is too long");
  if (!accountId) errors.push("accounts.xiaohongshu.accountId is required");
  if (/\s/.test(accountId) || accountId.length > 64) errors.push("accounts.xiaohongshu.accountId must be a single token");
  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    binding: {
      platform: "xiaohongshu",
      profileId,
      profileLabel,
      displayName,
      accountId,
      labelLikeProfileId: LABEL_LIKE_PROFILE_ID.test(profileId),
    },
  };
}

function walk(node, depth, visit) {
  if (node == null || depth > 6) return;
  if (Array.isArray(node)) {
    node.slice(0, 80).forEach(item => walk(item, depth + 1, visit));
    return;
  }
  if (typeof node !== "object") return;
  visit(node);
  for (const value of Object.values(node)) {
    if (value && typeof value === "object") walk(value, depth + 1, visit);
  }
}

function isRuntimeProfile(node) {
  return Boolean(node)
    && typeof node === "object"
    && !Array.isArray(node)
    && typeof node.id === "string"
    && node.id.trim()
    && typeof node.name === "string"
    && typeof node.isDefault === "boolean";
}

function uniqueRecords(records) {
  const unique = [];
  const seen = new Set();
  for (const record of records) {
    if (!record.profileId || seen.has(record.profileId)) continue;
    seen.add(record.profileId);
    unique.push(record);
  }
  return unique;
}

export function extractProfileRecords(payload) {
  if (Array.isArray(payload) && payload.length === 0) {
    return { records: [], keys: [], shape: "array" };
  }
  if (Array.isArray(payload) && payload.every(item => typeof item === "string")) {
    return {
      records: payload.filter(Boolean).map(profileId => ({
        profileId: String(profileId),
        label: "",
        sourceField: "string",
        labelField: "",
      })),
      keys: [],
      shape: "string-array",
    };
  }
  const keys = new Set();
  const nodes = [];
  walk(payload, 0, node => {
    for (const key of Object.keys(node)) keys.add(key);
    nodes.push(node);
  });
  const runtime = nodes.filter(isRuntimeProfile).map(node => ({
    profileId: node.id.trim(),
    label: node.name.trim(),
    sourceField: "id",
    labelField: "name",
    isDefault: node.isDefault,
  }));
  if (runtime.length) {
    return { records: uniqueRecords(runtime), keys: [...keys], shape: "ego-profile-id-name" };
  }
  const explicit = nodes.filter(node => node.profileId != null && String(node.profileId).trim()).map(node => ({
    profileId: String(node.profileId).trim(),
    label: String(node.label || node.name || node.title || "").trim(),
    sourceField: "profileId",
    labelField: node.label != null ? "label" : (node.name != null ? "name" : ""),
  }));
  if (explicit.length) {
    return { records: uniqueRecords(explicit), keys: [...keys], shape: "profileId-field" };
  }
  return { records: [], keys: [...keys], shape: "unrecognized" };
}

export function extractSpaceRecords(payload) {
  if (Array.isArray(payload) && payload.length === 0) {
    return { records: [], keys: [], shape: "array" };
  }
  const records = [];
  const keys = new Set();
  walk(payload, 0, node => {
    for (const key of Object.keys(node)) keys.add(key);
    if (isRuntimeProfile(node)) return;
    const name = node.name == null ? "" : String(node.name);
    const id = node.spaceId != null ? node.spaceId : node.id;
    if (!name && id == null) return;
    const profileFieldPresent = Object.prototype.hasOwnProperty.call(node, "profileId");
    records.push({
      id: id == null ? null : id,
      name,
      profileId: profileFieldPresent && node.profileId != null ? String(node.profileId) : null,
      profileFieldPresent,
      ownership: Object.prototype.hasOwnProperty.call(node, "ownership") && node.ownership != null ? String(node.ownership) : null,
      ownershipKnown: Object.prototype.hasOwnProperty.call(node, "ownership") && node.ownership != null,
    });
  });
  const unique = [];
  const seen = new Set();
  for (const record of records) {
    const key = `${record.id ?? ""}::${record.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(record);
  }
  const shape = Array.isArray(payload) ? "array" : (unique.length ? "object" : "unrecognized");
  return { records: unique, keys: [...keys], shape };
}

export function planTaskSpace({ binding, taskName, taskSpaceRef, profilesPayload, spacesPayload }) {
  if (!binding?.profileId || !binding.displayName || !binding.accountId) {
    return {
      ok: false,
      code: "ACCOUNT_BINDING_INVALID",
      message: "小红书账号绑定不完整。未创建空间，也未打开页面。",
      evidence: { liveVerified: false },
    };
  }
  const profiles = extractProfileRecords(profilesPayload);
  if (!profiles.records.length) {
    return {
      ok: false,
      code: "PROFILE_LIST_UNVERIFIED",
      message: "profiles() 没有可识别的 id，或返回空库存。未创建空间，未打开页面。空库存不允许创建。",
      evidence: { keys: profiles.keys, shape: profiles.shape, liveVerified: false, livePageAcceptance: "pending" },
    };
  }
  const listed = profiles.records.find(record => record.profileId === binding.profileId);
  if (!listed) {
    return {
      ok: false,
      code: "PROFILE_NOT_LISTED",
      message: "配置的 profileId 不在 profiles() 的 id 列表中。显示 name 不会代替 id；已列出的 id 不会因为看起来像标签而被拒绝。未切换默认 Profile。",
      evidence: {
        configuredProfileId: binding.profileId,
        labelLikeProfileId: LABEL_LIKE_PROFILE_ID.test(binding.profileId),
        listedProfileIds: profiles.records.map(record => record.profileId),
        liveVerified: false,
      },
    };
  }
  const spaces = extractSpaceRecords(spacesPayload);
  const raw = String(taskSpaceRef || "").trim();
  const numeric = /^\d+$/.test(raw) ? Number(raw) : null;
  const wantedName = String(taskName || "");
  const existing = spaces.records.find(record => (
    (numeric != null && String(record.id) === String(numeric))
    || (wantedName && record.name === wantedName)
  ));
  if (numeric != null && !existing) {
    return {
      ok: false,
      code: "SPACE_PROFILE_UNVERIFIED",
      message: "记录的空间 id 无法在 listTaskSpaces() 中证明 Profile。不会按名称另建空间。",
      evidence: { taskSpaceRef: numeric, observedKeys: spaces.keys, liveVerified: false, livePageAcceptance: "pending" },
    };
  }
  if (existing) {
    if (!existing.profileFieldPresent || existing.profileId == null) {
      return {
        ok: false,
        code: "SPACE_PROFILE_UNVERIFIED",
        message: "已有空间没有可读的 profileId。不能凭空间名称认定目标 Profile，也不会打开页面。",
        evidence: {
          spaceId: existing.id,
          spaceName: existing.name,
          profileFieldPresent: existing.profileFieldPresent,
          observedKeys: spaces.keys,
          liveVerified: false,
          livePageAcceptance: "pending",
        },
      };
    }
    if (existing.profileId !== binding.profileId) {
      return {
        ok: false,
        code: "ACCOUNT_MISMATCH",
        message: "已有空间的 profileId 与配置绑定不一致。已停止，未打开页面，也未尝试切换 Profile。",
        evidence: {
          spaceId: existing.id,
          spaceName: existing.name,
          actualProfileId: existing.profileId,
          expectedProfileId: binding.profileId,
          liveVerified: false,
        },
      };
    }
    return {
      ok: true,
      action: "resume",
      nameOrId: numeric != null ? numeric : existing.name,
      profileId: binding.profileId,
      passProfileId: false,
      openPage: true,
      profileProof: "listed-space-profileId",
    };
  }
  return {
    ok: true,
    action: "create",
    nameOrId: wantedName,
    profileId: binding.profileId,
    passProfileId: true,
    openPage: true,
    profileProof: "create-option-only",
  };
}

export function compareAccountObservation(expected, observation) {
  const displayNameHits = Number(observation?.displayNameExactHits || 0);
  const accountIdOutsideEditor = observation?.accountIdOutsideEditor === true;
  if (!observation || observation.readFailed === true) {
    return {
      ok: false,
      code: "ACCOUNT_UNVERIFIED",
      message: "页面身份读回失败。不能把空间名称当成账号证明。",
      evidence: { livePageAcceptance: "pending", readFailed: true },
    };
  }
  if (displayNameHits === 1 && accountIdOutsideEditor) {
    return {
      ok: true,
      evidence: {
        required: true,
        displayName: expected.displayName,
        accountId: expected.accountId,
        displayNameExactHits: 1,
        accountIdOutsideEditor: true,
        freshRead: true,
        livePageAcceptance: "pending",
      },
    };
  }
  if (displayNameHits > 1) {
    return {
      ok: false,
      code: "ACCOUNT_AMBIGUOUS",
      message: "页面上有多个与绑定显示名相同的文本。已停止。",
      evidence: { displayNameHits, accountIdOutsideEditor, livePageAcceptance: "pending" },
    };
  }
  return {
    ok: false,
    code: "ACCOUNT_UNVERIFIED",
    message: displayNameHits === 1
      ? "看到了显示名，但没有在编辑器之外读到账号 ID。不能当成正确账号。"
      : "页面没有证明配置中的账号。已停止，不会把它当成目标账号。",
    evidence: { displayNameHits, accountIdOutsideEditor, livePageAcceptance: "pending" },
  };
}

export function accountSnapshotExpression(displayName, accountId) {
  return `(() => {
    const expectedName = ${JSON.stringify(displayName)};
    const expectedId = ${JSON.stringify(accountId)};
    const compact = value => String(value || "").replace(/\\s+/g, " ").trim();
    const visible = el => {
      const rect = el.getBoundingClientRect?.();
      const style = getComputedStyle?.(el);
      if (!rect || !style) return true;
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
    };
    const inEditor = el => Boolean(el.closest?.("[contenteditable='true'],[contenteditable=''],textarea,input"));
    const idPattern = new RegExp("(^|\\\\D)" + expectedId.replace(/[.*+?^\${}()|[\\]\\\\]/g, "\\\\$&") + "(\\\\D|$)");
    let displayNameExactHits = 0;
    let accountIdOutsideEditor = false;
    const nodes = [...document.querySelectorAll("body *")];
    for (const el of nodes) {
      if (!visible(el) || inEditor(el)) continue;
      const own = compact(el.childNodes ? [...el.childNodes].filter(node => node.nodeType === 3).map(node => node.textContent).join(" ") : "");
      const text = own || (el.children?.length ? "" : compact(el.innerText || el.textContent || ""));
      if (!text || text.length > 80) continue;
      if (text === expectedName) displayNameExactHits += 1;
      if (text === expectedId || idPattern.test(text)) accountIdOutsideEditor = true;
    }
    return { displayNameExactHits, accountIdOutsideEditor, readFailed: false };
  })()`;
}

export function bindingDiagnosticScript() {
  return `
const profilesPayload = await profiles();
const spacesPayload = await listTaskSpaces();
console.log("VIDEO_PUBLISHER_BINDING_DIAGNOSTIC:" + JSON.stringify({
  profiles: profilesPayload,
  spaces: spacesPayload,
  taskSpaceCalled: false,
  pageOpened: false
}));
`;
}

export function sanitizeDiagnostic(value, depth = 0) {
  if (depth > 6) return null;
  if (Array.isArray(value)) return value.slice(0, 40).map(item => sanitizeDiagnostic(item, depth + 1));
  if (value && typeof value === "object") {
    const result = {};
    for (const [key, child] of Object.entries(value)) {
      if (SECRET_KEY.test(key)) continue;
      result[key] = sanitizeDiagnostic(child, depth + 1);
    }
    return result;
  }
  if (typeof value === "string") return value.length > 180 ? `${value.slice(0, 180)}…` : value;
  if (typeof value === "number" || typeof value === "boolean" || value == null) return value;
  return String(value).slice(0, 180);
}

export function describeProfileInventory(payload) {
  const extracted = extractProfileRecords(payload);
  return {
    shape: extracted.shape,
    observedKeys: extracted.keys,
    profiles: extracted.records.map(record => {
      const label = record.label || "";
      return {
        profileId: record.profileId,
        label,
        rawIdField: record.sourceField || "",
        labelField: record.labelField || "",
        idEqualsLabel: Boolean(label) && record.profileId === label,
        idLooksLikeDisplayLabel: LABEL_LIKE_PROFILE_ID.test(record.profileId),
        bindUsing: "profileId",
        doNotBindUsing: label && label !== record.profileId ? "label" : "",
      };
    }),
    accountVerified: false,
    ready: false,
  };
}

export function describeSpaceInventory(payload) {
  const extracted = extractSpaceRecords(payload);
  return {
    shape: extracted.shape,
    observedKeys: extracted.keys,
    spaces: extracted.records.map(record => ({
      id: record.id,
      name: record.name,
      profileId: record.profileId,
      profileIdFieldPresent: record.profileFieldPresent,
      nameIsNotProfileId: true,
    })),
    created: false,
    opened: false,
    switched: false,
    closed: false,
    resumeVerified: false,
    absenceNotProven: extracted.records.length === 0,
  };
}

export function explainDiscoveryConfig({ exists = false, onboardingRequired = false, errors = [], warnings = [], binding = null } = {}) {
  const notes = [];
  if (!exists) notes.push("no completed config is required for profile discovery, and this command does not write one");
  for (const warning of warnings) notes.push(`${warning}; not required for profile discovery`);
  for (const error of errors) notes.push(`${error}; this blocks later create, resume, and inspect, not this diagnostic`);
  if (!binding) notes.push("no account binding is configured; copy a profileId from this output before bind-account");
  else {
    if (binding.labelLikeProfileId === true) notes.push("configured profileId matches a display-label pattern. Discovery does not send it to Ego. A later create accepts that exact id only when profiles() lists it; the name field is not a substitute.");
    if (/^PASTE_|^placeholder$/i.test(binding.profileId)) notes.push("configured profileId is still a placeholder and was not sent to Ego");
    notes.push("configured display name and account id were not compared with a page");
  }
  return {
    configPresent: exists === true,
    onboardingRequired: onboardingRequired === true,
    bindingConfigured: Boolean(binding),
    bindingUsed: false,
    blocksThisDiagnostic: false,
    notes,
  };
}

const MAINTENANCE_SPACE_NAME = /^vp-maint-[A-Za-z0-9][A-Za-z0-9._-]{2,80}$/;

export function planMaintenanceSpace({ binding, spaceName, profilesPayload, spacesPayload }) {
  if (!binding?.profileId || !binding.displayName || !binding.accountId) {
    return {
      ok: false,
      create: false,
      code: "ACCOUNT_BINDING_INVALID",
      message: "维护诊断需要明确的 profileId、显示名和账号 ID。未创建空间。",
    };
  }
  if (!MAINTENANCE_SPACE_NAME.test(String(spaceName || ""))) {
    return {
      ok: false,
      create: false,
      code: "MAINTENANCE_SPACE_NAME_INVALID",
      message: "维护空间名必须是 vp-maint- 开头的新名称。不会使用已有发布空间名。",
    };
  }
  const profiles = extractProfileRecords(profilesPayload);
  if (!profiles.records.length || profiles.shape === "unrecognized") {
    return {
      ok: false,
      create: false,
      code: "PROFILE_LIST_UNVERIFIED",
      message: "profiles() 形状未知或为空。未创建空间，也未回退默认 Profile。",
      evidence: { shape: profiles.shape, keys: profiles.keys },
    };
  }
  if (!profiles.records.some(record => record.profileId === binding.profileId)) {
    return {
      ok: false,
      create: false,
      code: "PROFILE_NOT_LISTED",
      message: "配置的 profileId 不在 profiles() 的 id 列表中。显示 name 不会代替 id。未创建空间。",
      evidence: { configuredProfileId: binding.profileId, listedCount: profiles.records.length, targetListed: false },
    };
  }
  const spaces = extractSpaceRecords(spacesPayload);
  if (spaces.shape === "unrecognized") {
    return {
      ok: false,
      create: false,
      code: "SPACE_LIST_UNVERIFIED",
      message: "listTaskSpaces() 形状无法确认同名空间是否已存在。为避免接管已有空间，未调用 taskSpace。",
      evidence: { shape: spaces.shape, keys: spaces.keys },
    };
  }
  if (spaces.records.some(record => record.name === spaceName)) {
    return {
      ok: false,
      create: false,
      code: "MAINTENANCE_SPACE_NAME_CONFLICT",
      message: "这个维护空间名已经在库存里。不 claim、不 adopt、不改 ownership，也不改用其他空间。",
      evidence: { spaceName },
    };
  }
  return {
    ok: true,
    create: true,
    navigate: false,
    profileId: binding.profileId,
    spaceName,
    profileProof: "create-option-only",
  };
}

export const MAINTENANCE_PAGES = Object.freeze({
  home: "https://creator.xiaohongshu.com/new/home",
  noteManager: "https://creator.xiaohongshu.com/new/note-manager",
});

export function evaluateHomeIdentity(text, binding) {
  const body = String(text || "");
  const risk = /验证码|安全验证|扫码登录|请登录/.test(body);
  const nameOk = Boolean(binding?.displayName) && body.includes(binding.displayName);
  const accountId = String(binding?.accountId || "");
  const idOk = Boolean(accountId) && new RegExp(`(?:^|\\D)${accountId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:\\D|$)`).test(body);
  const ok = nameOk && idOk && !risk;
  return { ok, nameOk, idOk, risk, noteManagerAllowed: ok };
}

export function summarizeManagerText(text) {
  const body = String(text || "");
  const seen = (pattern) => pattern.test(body);
  return {
    aiDeclaration: seen(/笔记含AI合成内容/) ? "visible-text" : "not-observed",
    collection: seen(/合集/) ? "visible-text" : "not-observed",
    cover: seen(/封面/) ? "visible-text" : "not-observed",
    schedule: seen(/定时/) ? "visible-text" : "not-observed",
    meaning: "visible text only; not clicked; not-observed is not a claim that the platform lacks the control",
  };
}

export function selectMaintenanceCloseTarget({ spaceName, spaceId, profileId, profilesPayload, spacesPayload }) {
  const profiles = extractProfileRecords(profilesPayload);
  if (!profiles.records.length || profiles.shape === "unrecognized" || !profiles.records.some(record => record.profileId === profileId)) {
    return { ok: false, code: "PROFILE_NOT_LISTED", taskSpaceAllowed: false };
  }
  const spaces = extractSpaceRecords(spacesPayload);
  if (spaces.shape === "unrecognized") {
    return { ok: false, code: "SPACE_LIST_UNVERIFIED", taskSpaceAllowed: false };
  }
  const wantedId = String(spaceId);
  const matches = spaces.records.filter(record => record.name === spaceName || String(record.id) === wantedId);
  if (matches.length !== 1) {
    return { ok: false, code: matches.length === 0 ? "SPACE_ABSENT" : "SPACE_AMBIGUOUS", taskSpaceAllowed: false, matchCount: matches.length };
  }
  const match = matches[0];
  if (match.name !== spaceName || String(match.id) !== wantedId) {
    return { ok: false, code: "SPACE_ID_NAME_MISMATCH", taskSpaceAllowed: false };
  }
  if (!match.ownershipKnown || match.ownership !== "agent") {
    return { ok: false, code: "SPACE_OWNERSHIP_UNVERIFIED", taskSpaceAllowed: false };
  }
  if (!match.profileFieldPresent || match.profileId !== profileId) {
    return { ok: false, code: "SPACE_PROFILE_MISMATCH", taskSpaceAllowed: false };
  }
  return { ok: true, code: "MATCHED", taskSpaceAllowed: true, spaceId: match.id, spaceName: match.name, ownership: match.ownership, profileId: match.profileId };
}

export function maintenanceCloseInventory(spacesPayload, { spaceName, spaceId }) {
  const spaces = extractSpaceRecords(spacesPayload);
  if (spaces.shape === "unrecognized") return { checked: true, code: "SPACE_LIST_UNVERIFIED" };
  const wantedId = String(spaceId);
  const matches = spaces.records.filter(record => record.name === spaceName || String(record.id) === wantedId);
  if (matches.length === 0) return { checked: true, code: "SPACE_ABSENT" };
  return { checked: true, code: "STILL_PRESENT", matchCount: matches.length };
}

export function assertMaintenanceScript(script) {
  const forbidden = [
    /useOrCreateTaskSpace/,
    /openOrReuseTab/,
    /completeTaskSpace/,
    /closeTaskSpace/,
    /cliLog\s*\(/,
    /releaseForConfirmedPublish/,
    /uploadFile/,
    /\/publish\/publish/,
    /gotoAndWait/,
    /newTab\s*\(/,
    /switchTab\s*\(/,
    /listTabs\s*\(/,
    /mouse\.move/,
    /xiaohongshu\.com\/explore/,
    /\bclick\s*\(/,
  ];
  const hit = forbidden.find(pattern => pattern.test(script));
  if (hit) throw new Error(`maintenance script contains a forbidden call: ${hit}`);
  const creates = script.match(/await taskSpace\(/g) || [];
  if (creates.length !== 1) throw new Error("maintenance script must call taskSpace exactly once");
  if (!script.includes(MAINTENANCE_PAGES.home) || !script.includes(MAINTENANCE_PAGES.noteManager)) {
    throw new Error("maintenance script must name only the allowlisted account pages");
  }
  if (!script.includes("publishUrlOpened: false")) throw new Error("maintenance script must record that the publish URL stayed closed");
  const homeGoto = script.indexOf("readAllowlisted(page, pages.home");
  const gateAt = script.indexOf("identity.noteManagerAllowed");
  const managerGoto = script.indexOf("readAllowlisted(page, pages.noteManager");
  if (!(homeGoto >= 0 && gateAt > homeGoto && managerGoto > gateAt)) {
    throw new Error("note-manager navigation must follow the home identity gate");
  }
  const finishAt = script.indexOf("await handle.finish");
  const factAt = script.indexOf("VIDEO_PUBLISHER_MAINTENANCE:");
  if (!(factAt >= 0 && finishAt > factAt)) {
    throw new Error("maintenance facts must be logged before finish");
  }
  if (!script.includes("\"pending\"")) {
    throw new Error("close must stay pending until finish returns");
  }
}

export function buildMaintenanceDiagnoseScript(input) {
  const runner = `
const input = ${JSON.stringify(input)};
const profilesPayload = await profiles();
const spacesPayload = await listTaskSpaces();
const plan = planMaintenanceSpace({
  binding: input.binding,
  spaceName: input.spaceName,
  profilesPayload,
  spacesPayload,
});
const pages = ${JSON.stringify(MAINTENANCE_PAGES)};
async function readAllowlisted(page, url, screenshotPath) {
  if (url !== pages.home && url !== pages.noteManager) throw new Error("url not allowlisted");
  await page.goto(url);
  if (typeof page.waitForTimeout === "function") await page.waitForTimeout(6000);
  const text = await page.evaluate(() => String((document.body && document.body.innerText) || "").slice(0, 2000));
  let screenshotError = "";
  if (screenshotPath && typeof page.screenshot === "function") {
    try { await page.screenshot({ path: screenshotPath }); }
    catch (error) { screenshotError = String(error && error.message || error); }
  }
  return { url, text, screenshotError };
}
const base = {
  plan,
  publishUrlOpened: false,
  mediaRead: false,
  retried: false,
  finalGuardReleaseCalled: false,
  ready: false,
  accepted: false,
  publishable: false,
  accountVerified: false,
};
if (!plan.create) {
  console.log("VIDEO_PUBLISHER_MAINTENANCE:" + JSON.stringify({ ...base, taskSpaceCalled: false, created: false, homeOpened: false, noteManagerOpened: false }));
} else {
  let handle = null;
  let callError = "";
  try {
    handle = await taskSpace(plan.spaceName, { profileId: plan.profileId });
  } catch (error) {
    callError = String(error && error.message || error);
  }
  if (!handle) {
    console.log("VIDEO_PUBLISHER_MAINTENANCE:" + JSON.stringify({ ...base, taskSpaceCalled: true, created: false, homeOpened: false, noteManagerOpened: false, callError }));
  } else {
    const spaceName = handle.name == null ? "" : String(handle.name);
    const spaceId = handle.spaceId != null ? handle.spaceId : (handle.id != null ? handle.id : null);
    const ownership = handle.ownership == null ? null : String(handle.ownership);
    const nameMatches = spaceName === plan.spaceName;
    const ownHandle = nameMatches && ownership !== "user" && spaceId != null;
    let home = null;
    let identity = { ok: false, noteManagerAllowed: false };
    let notes = null;
    let pageError = "";
    if (!ownHandle) {
      pageError = "refusing to open pages on a handle that is not the new maintenance space";
    } else {
      try {
        const page = await handle.newPage();
        home = await readAllowlisted(page, pages.home, input.screenshots && input.screenshots.home);
        identity = evaluateHomeIdentity(home.text, input.binding);
        if (identity.noteManagerAllowed) {
          notes = await readAllowlisted(page, pages.noteManager, input.screenshots && input.screenshots.noteManager);
        }
      } catch (error) {
        pageError = String(error && error.message || error);
      }
    }
    const closeResult = !ownHandle
      ? { closed: false, reason: "not-own-handle" }
      : pageError
        ? { closed: false, reason: "page-error" }
        : { closed: null, reason: input.closeAfter ? "pending" : "kept" };
    const snapshot = {
      ...base,
      taskSpaceCalled: true,
      created: ownHandle,
      spaceName,
      spaceId,
      ownership,
      homeOpened: Boolean(home),
      homeIdentityMatched: identity.ok === true,
      noteManagerOpened: Boolean(notes),
      home: identity,
      controls: notes ? summarizeManagerText(notes.text) : null,
      pageError,
      closeResult,
      callError,
      sideEffects: "reported",
    };
    await emitMaintenance(snapshot);
    if (ownHandle && input.closeAfter === true && !pageError) {
      try {
        if (typeof handle.finish !== "function") snapshot.closeResult = { closed: false, reason: "finish-not-on-handle" };
        else {
          await handle.finish({ keep: false });
          snapshot.closeResult = { closed: true, keep: false, reason: "finish-returned" };
        }
      } catch (error) {
        snapshot.closeResult = { closed: false, reason: "finish-threw", error: String(error && error.message || error) };
      }
      await emitMaintenance(snapshot);
    }
  }
}
`;
  const helpers = `
function maintenanceJson(state) {
  return JSON.stringify({ runId: input.runId, ...state });
}
async function emitMaintenance(state) {
  const body = maintenanceJson(state);
  console.log("VIDEO_PUBLISHER_MAINTENANCE:" + body);
  if (!input.checkpointPath) return;
  try {
    const fs = await import("node:fs");
    fs.writeFileSync(input.checkpointPath, body + "\\n", { mode: 0o600 });
  } catch (error) {
    console.log("VIDEO_PUBLISHER_MAINTENANCE_CHECKPOINT_ERROR:" + JSON.stringify(String(error && error.message || error)));
  }
}
`;
  return `${helpers}${runner}`;
}

const MAINTENANCE_MARKER = "VIDEO_PUBLISHER_MAINTENANCE:";

export function unknownMaintenanceObservation() {
  return {
    sideEffects: "unknown",
    created: null,
    homeOpened: null,
    homeIdentityMatched: null,
    noteManagerOpened: null,
    spaceId: null,
    spaceName: null,
    closeResult: { closed: null, reason: "unknown" },
    publishUrlOpened: null,
    retried: null,
    finalGuardReleaseCalled: null,
    controls: null,
  };
}

function parseJsonValue(source, index) {
  let start = index;
  while (start < source.length && /\s/.test(source[start])) start += 1;
  if (source[start] !== "{") return { ok: false, error: "maintenance payload was not JSON" };
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let cursor = start; cursor < source.length; cursor += 1) {
    const ch = source[cursor];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === "\"") inString = false;
      continue;
    }
    if (ch === "\"") {
      inString = true;
      continue;
    }
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        const raw = source.slice(start, cursor + 1);
        try {
          return { ok: true, value: JSON.parse(raw), end: cursor + 1 };
        } catch (error) {
          return { ok: false, error: `maintenance payload was not JSON: ${String(error?.message || error)}` };
        }
      }
    }
  }
  return { ok: false, error: "maintenance payload was not JSON" };
}

export function parseMaintenanceOutput(text) {
  const source = String(text || "");
  const events = [];
  let broken = "";
  let search = 0;
  while (search < source.length) {
    const at = source.indexOf(MAINTENANCE_MARKER, search);
    if (at < 0) break;
    const parsed = parseJsonValue(source, at + MAINTENANCE_MARKER.length);
    if (!parsed.ok) {
      broken = parsed.error;
      break;
    }
    if (parsed.value && typeof parsed.value === "object" && !Array.isArray(parsed.value)) events.push(parsed.value);
    search = parsed.end;
  }
  if (!events.length) {
    return {
      ok: false,
      error: broken || "maintenance marker missing",
      payload: unknownMaintenanceObservation(),
    };
  }
  const payload = events.reduce((merged, event) => ({ ...merged, ...event }), {});
  payload.markerCount = events.length;
  if (broken) payload.trailingMarkerIncomplete = true;
  if (!payload.sideEffects) payload.sideEffects = "reported";
  return { ok: !broken, error: broken, payload };
}

export function buildMaintenanceSpaceStatusScript(input) {
  return `
const targetName = ${JSON.stringify(input.spaceName)};
const targetProfileId = ${JSON.stringify(input.profileId)};
const profilesPayload = await profiles();
const spacesPayload = await listTaskSpaces();
const profileIds = [];
const walk = (node, depth) => {
  if (!node || depth > 6) return;
  if (Array.isArray(node)) {
    node.slice(0, 80).forEach(item => walk(item, depth + 1));
    return;
  }
  if (typeof node !== "object") return;
  if (typeof node.id === "string" && node.id.trim()) profileIds.push(node.id.trim());
  for (const value of Object.values(node)) {
    if (value && typeof value === "object") walk(value, depth + 1);
  }
};
walk(profilesPayload, 0);
const matches = [];
const visitSpace = (node, depth) => {
  if (!node || depth > 6) return;
  if (Array.isArray(node)) {
    node.slice(0, 80).forEach(item => visitSpace(item, depth + 1));
    return;
  }
  if (typeof node !== "object") return;
  if (typeof node.id === "string" && typeof node.name === "string" && typeof node.isDefault === "boolean") return;
  if (node.name != null && String(node.name) === targetName) {
    const spaceId = node.spaceId != null ? node.spaceId : (node.id != null ? node.id : null);
    matches.push({
      spaceId,
      ownership: Object.prototype.hasOwnProperty.call(node, "ownership") && node.ownership != null ? String(node.ownership) : null,
      ownershipKnown: Object.prototype.hasOwnProperty.call(node, "ownership"),
      profileId: Object.prototype.hasOwnProperty.call(node, "profileId") && node.profileId != null ? String(node.profileId) : null,
      profileKnown: Object.prototype.hasOwnProperty.call(node, "profileId"),
    });
  }
  for (const value of Object.values(node)) {
    if (value && typeof value === "object") visitSpace(value, depth + 1);
  }
};
visitSpace(spacesPayload, 0);
const unique = [];
const seen = new Set();
for (const match of matches) {
  const key = String(match.spaceId) + "::" + String(match.ownership);
  if (seen.has(key)) continue;
  seen.add(key);
  unique.push(match);
}
const one = unique.length === 1 ? unique[0] : null;
const listUsable = Array.isArray(spacesPayload) || (spacesPayload && typeof spacesPayload === "object");
console.log("VIDEO_PUBLISHER_MAINTENANCE_STATUS:" + JSON.stringify({
  taskSpaceCalled: false,
  pageOpened: false,
  finishCalled: false,
  closeConfirmed: false,
  inventoryAccessed: ["profiles", "listTaskSpaces"],
  otherSpacesHidden: true,
  otherProfilesHidden: true,
  targetProfileListed: profileIds.includes(targetProfileId),
  listUsable: Boolean(listUsable),
  found: listUsable ? unique.length === 1 : null,
  ambiguous: unique.length > 1,
  matchCount: unique.length,
  spaceId: one ? one.spaceId : null,
  ownership: one && one.ownershipKnown ? one.ownership : null,
  ownershipKnown: Boolean(one && one.ownershipKnown),
  profileIdMatches: one && one.profileKnown ? one.profileId === targetProfileId : null,
  meaning: "Inventory match for one exact name. Absence does not prove finish succeeded. Presence does not claim, resume, or close the space.",
}));
`;
}

export function assertMaintenanceSpaceStatusScript(script) {
  if (/taskSpace\s*\(|finish\s*\(|page\.goto|\.screenshot\s*\(/.test(script)) {
    throw new Error("maintenance space status must not create, resume, navigate, or close");
  }
  if (!script.includes("VIDEO_PUBLISHER_MAINTENANCE_STATUS:")) {
    throw new Error("maintenance space status must return its marker");
  }
}

export function parseMaintenanceSpaceStatus(text) {
  const source = String(text || "");
  const marker = "VIDEO_PUBLISHER_MAINTENANCE_STATUS:";
  const at = source.indexOf(marker);
  if (at < 0) return { ok: false, error: "maintenance status marker missing" };
  const parsed = parseJsonValue(source, at + marker.length);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  return { ok: true, payload: parsed.value };
}

export function buildMaintenanceCloseScript(input) {
  const helpers = `
function maintenanceJson(state) {
  return JSON.stringify({ runId: input.runId, ...state });
}
async function emitMaintenance(state) {
  const body = maintenanceJson(state);
  console.log("VIDEO_PUBLISHER_MAINTENANCE:" + body);
  if (!input.checkpointPath) return;
  try {
    const fs = await import("node:fs");
    fs.writeFileSync(input.checkpointPath, body + "\\n", { mode: 0o600 });
  } catch (error) {
    console.log("VIDEO_PUBLISHER_MAINTENANCE_CHECKPOINT_ERROR:" + JSON.stringify(String(error && error.message || error)));
  }
}
`;
  const runner = `
const input = ${JSON.stringify(input)};
const base = {
  pureReadOnly: false,
  pageOpened: false,
  retried: false,
  publishUrlOpened: false,
  mediaRead: false,
  finalGuardReleaseCalled: false,
  ready: false,
  accepted: false,
  publishable: false,
  accountVerified: false,
  sideEffects: "reported",
};
const profilesPayload = await profiles();
const spacesPayload = await listTaskSpaces();
const decision = selectMaintenanceCloseTarget({
  spaceName: input.spaceName,
  spaceId: input.spaceId,
  profileId: input.profileId,
  profilesPayload,
  spacesPayload,
});
if (!decision.taskSpaceAllowed) {
  await emitMaintenance({
    ...base,
    taskSpaceCalled: false,
    handleMatched: false,
    decisionCode: decision.code,
    closeResult: { closed: false, reason: "inventory-refused" },
    inventoryAfter: { checked: false },
  });
} else {
  let handle = null;
  let callError = "";
  try {
    handle = await taskSpace(input.spaceId);
  } catch (error) {
    callError = String(error && error.message || error);
  }
  if (!handle) {
    const userControl = /USER_CONTROL/.test(callError);
    await emitMaintenance({
      ...base,
      taskSpaceCalled: true,
      handleMatched: false,
      decisionCode: decision.code,
      callError,
      closeResult: { closed: false, reason: userControl ? "user-control" : "taskSpace-threw", error: callError },
      inventoryAfter: { checked: false },
    });
  } else {
    const handleId = handle.spaceId != null ? handle.spaceId : (handle.id != null ? handle.id : null);
    const handleName = handle.name == null ? "" : String(handle.name);
    const handleOwnership = handle.ownership == null ? null : String(handle.ownership);
    const handleMatched = String(handleId) === String(input.spaceId)
      && handleName === input.spaceName
      && handleOwnership === "agent";
    if (!handleMatched) {
      await emitMaintenance({
        ...base,
        taskSpaceCalled: true,
        handleMatched: false,
        decisionCode: "HANDLE_MISMATCH",
        spaceId: handleId,
        spaceName: handleName,
        ownership: handleOwnership,
        closeResult: { closed: false, reason: "handle-mismatch" },
        inventoryAfter: { checked: false },
        substituteCreated: "unknown",
      });
    } else {
      await emitMaintenance({
        ...base,
        taskSpaceCalled: true,
        handleMatched: true,
        decisionCode: decision.code,
        spaceId: handleId,
        spaceName: handleName,
        ownership: handleOwnership,
        closeResult: { closed: null, reason: "pending" },
        inventoryAfter: { checked: false },
      });
      let closeResult = { closed: null, reason: "pending" };
      try {
        if (typeof handle.finish !== "function") closeResult = { closed: false, reason: "finish-not-on-handle" };
        else {
          await handle.finish({ keep: false });
          closeResult = { closed: true, keep: false, reason: "finish-returned" };
        }
      } catch (error) {
        closeResult = { closed: false, reason: "finish-threw", error: String(error && error.message || error) };
      }
      let inventoryAfter = { checked: false };
      if (closeResult.reason === "finish-returned") {
        try {
          inventoryAfter = maintenanceCloseInventory(await listTaskSpaces(), { spaceName: input.spaceName, spaceId: input.spaceId });
        } catch (error) {
          inventoryAfter = { checked: false, error: String(error && error.message || error) };
        }
      }
      await emitMaintenance({
        ...base,
        taskSpaceCalled: true,
        handleMatched: true,
        decisionCode: decision.code,
        spaceId: handleId,
        spaceName: handleName,
        ownership: handleOwnership,
        closeResult,
        inventoryAfter,
      });
    }
  }
}
`;
  return `${helpers}${runner}`;
}

export function assertMaintenanceCloseScript(script) {
  const calls = script.match(/await taskSpace\s*\(/g) || [];
  if (calls.length !== 1) throw new Error("maintenance close must call taskSpace once");
  if (!script.includes("await taskSpace(input.spaceId)")) throw new Error("maintenance close must resume by the expected id");
  if (/await taskSpace\s*\([^)]*profileId|claimTaskSpace|page\.goto|newPage\s*\(|\/publish\/publish|releaseForConfirmedPublish/.test(script)) {
    throw new Error("maintenance close contains a forbidden call");
  }
  const factAt = script.indexOf("VIDEO_PUBLISHER_MAINTENANCE:");
  const finishAt = script.indexOf("await handle.finish");
  if (!(factAt >= 0 && finishAt > factAt)) throw new Error("close facts must be logged before finish");
  if (!script.includes("\"pending\"")) throw new Error("close must stay pending until finish returns");
}

export function sameAccountBinding(left, right) {
  if (!left || !right) return false;
  return left.profileId === right.profileId
    && left.displayName === right.displayName
    && left.accountId === right.accountId;
}
