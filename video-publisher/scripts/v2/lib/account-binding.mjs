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

export function sameAccountBinding(left, right) {
  if (!left || !right) return false;
  return left.profileId === right.profileId
    && left.displayName === right.displayName
    && left.accountId === right.accountId;
}
