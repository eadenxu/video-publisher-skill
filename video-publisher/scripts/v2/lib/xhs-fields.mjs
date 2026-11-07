const AI_LABEL = "笔记含AI合成内容";

function cleanText(value) {
  return String(value || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
}

function shanghaiParts(date) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date).map(part => [part.type, part.value]));
  return {
    year: parts.year,
    month: parts.month,
    day: parts.day,
    hour: parts.hour,
    minute: parts.minute,
    second: parts.second,
  };
}

export function parseScheduleInput(raw) {
  const timeZone = String(raw?.timeZone || "").trim();
  const publishAt = String(raw?.publishAt || "").trim();
  const errors = [];
  if (timeZone !== "Asia/Shanghai") errors.push("xhsSchedule.timeZone must be Asia/Shanghai");
  if (!publishAt) errors.push("xhsSchedule.publishAt is required");
  if (errors.length) return { ok: false, errors };
  const civil = publishAt.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/);
  const zoned = publishAt.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?)(Z|[+-]\d{2}:\d{2})$/);
  if (!civil && !zoned) {
    return { ok: false, errors: ["xhsSchedule.publishAt must be an explicit Shanghai civil time or an offset instant"] };
  }
  const interpretable = civil
    ? `${civil[1]}-${civil[2]}-${civil[3]}T${civil[4]}:${civil[5]}:${civil[6] || "00"}+08:00`
    : publishAt;
  const date = new Date(interpretable);
  if (Number.isNaN(date.getTime())) return { ok: false, errors: ["xhsSchedule.publishAt is not a valid datetime"] };
  const parts = shanghaiParts(date);
  const local = `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
  return {
    ok: true,
    errors: [],
    value: {
      publishAt: interpretable,
      instant: date.toISOString(),
      local,
      timeZone: "Asia/Shanghai",
      authorizesFinalPublish: false,
    },
  };
}

export function scheduleAuthorizesFinalPublish() {
  return false;
}

export function normalizeXhsRequirements(pkg = {}) {
  const aiRequested = pkg.xhsAiSynthesis === true;
  const collectionName = String(pkg.xhsCollection || "").trim();
  const proseText = cleanText(pkg.xhsProse);
  const queries = Array.isArray(pkg.xhsPlatformDedup?.queries)
    ? [...new Set(pkg.xhsPlatformDedup.queries.map(item => String(item || "").trim()).filter(Boolean))]
    : [];
  const dedupRequired = pkg.xhsPlatformDedup?.required === true || queries.length > 0;
  const scheduleRequested = pkg.xhsSchedule != null && pkg.xhsSchedule !== false;
  const schedule = scheduleRequested ? parseScheduleInput(pkg.xhsSchedule) : null;
  const originalityBasis = String(pkg.originalityBasis || "").trim();
  return {
    aiSynthesis: { required: aiRequested, label: aiRequested ? AI_LABEL : "" },
    collection: { required: Boolean(collectionName), name: collectionName },
    prose: { required: Boolean(proseText), text: proseText },
    dedup: { required: dedupRequired, queries },
    schedule: scheduleRequested
      ? {
        required: true,
        ...(schedule.ok ? schedule.value : {}),
        error: schedule.ok ? "" : schedule.errors.join("; "),
        authorizesFinalPublish: false,
      }
      : { required: false, authorizesFinalPublish: false },
    originalityBasis,
    strictExtras: aiRequested || Boolean(collectionName) || Boolean(proseText) || dedupRequired || scheduleRequested,
  };
}

export function validateXhsRequirements(requirements) {
  const errors = [];
  if (!requirements) return errors;
  if (requirements.schedule?.required && requirements.schedule.error) errors.push(requirements.schedule.error);
  if (requirements.collection?.required && [...requirements.collection.name].length > 40) {
    errors.push("xhsCollection must be at most 40 characters");
  }
  if (requirements.prose?.required && [...requirements.prose.text].length > 1000) {
    errors.push("xhsProse must be at most 1000 characters");
  }
  if (requirements.dedup?.required && !requirements.dedup.queries.length) {
    errors.push("xhsPlatformDedup.queries must name at least one read-only query");
  }
  if ((requirements.dedup?.queries.length || 0) > 8) errors.push("xhsPlatformDedup.queries supports at most 8 queries");
  if (requirements.dedup?.queries.some(query => /[\r\n]/.test(query) || [...query].length > 40)) {
    errors.push("xhsPlatformDedup queries must be single-line and at most 40 characters");
  }
  if (requirements.strictExtras && !requirements.originalityBasis) {
    errors.push("originalityBasis is required when Xiaohongshu AI declaration, collection, prose, schedule, or platform dedup is requested");
  }
  if (requirements.originalityBasis && [...requirements.originalityBasis].length > 300) {
    errors.push("originalityBasis must be at most 300 characters");
  }
  return errors;
}

export function evaluateLabeledSwitch(spec, observation) {
  if (!spec?.required) return { ok: true, evidence: { required: false } };
  const base = {
    label: spec.label,
    clickAccepted: false,
    freshRead: observation?.freshRead === true,
    livePageAcceptance: "pending",
    found: observation?.found === true,
    unique: observation?.unique === true,
    enabled: observation?.enabled === true,
  };
  if (observation?.unique !== true || observation?.found !== true || observation?.freshRead !== true) {
    return {
      ok: false,
      code: "AI_DECLARATION_UNVERIFIED",
      message: `「${spec.label}」没有唯一控件的新鲜读回。未把点击当成声明成功，也不能据此判断平台没有该声明。`,
      evidence: base,
    };
  }
  if (observation.enabled !== true) {
    return {
      ok: false,
      code: "AI_DECLARATION_UNVERIFIED",
      message: `「${spec.label}」的新鲜读回不是开启状态。`,
      evidence: base,
    };
  }
  return { ok: true, evidence: { ...base, required: true } };
}

export function evaluateCollection(spec, observation) {
  if (!spec?.required) return { ok: true, evidence: { required: false } };
  const hits = Number(observation?.selectedExactHits || 0);
  const evidence = {
    name: spec.name,
    selectedExactHits: hits,
    clickAccepted: false,
    freshRead: observation?.freshRead === true,
    livePageAcceptance: "pending",
  };
  if (hits === 1 && observation?.freshRead === true) return { ok: true, evidence: { ...evidence, required: true } };
  return {
    ok: false,
    code: "COLLECTION_UNVERIFIED",
    message: `合集「${spec.name}」没有唯一的新鲜选中读回。未把点击当成字段成功。`,
    evidence,
  };
}

export function evaluateScheduleControl(spec, observation) {
  if (!spec?.required) return { ok: true, evidence: { required: false, authorizesFinalPublish: false } };
  const matchedCount = Number(observation?.matchedCount || 0);
  const evidence = {
    local: spec.local || "",
    timeZone: spec.timeZone || "Asia/Shanghai",
    matchedCount,
    observedValues: Array.isArray(observation?.values) ? observation.values.slice(0, 12) : [],
    authorizesFinalPublish: false,
    freshRead: observation?.freshRead === true,
    livePageAcceptance: "pending",
    clickAccepted: false,
  };
  if (spec.error) {
    return { ok: false, code: "SCHEDULE_CONTROL_UNVERIFIED", message: spec.error, evidence };
  }
  if (matchedCount === 1 && observation?.freshRead === true && observation?.finalControlClicked !== true) {
    return { ok: true, evidence: { ...evidence, required: true } };
  }
  return {
    ok: false,
    code: "SCHEDULE_CONTROL_UNVERIFIED",
    message: "页面还没有读到与目标日期和 Asia/Shanghai 一致的定时值。这不表示平台不支持定时，配置里的时间也不是最终发布授权。",
    evidence,
  };
}

export function evaluateProse(spec, observation) {
  if (!spec?.required) return { ok: true, evidence: { required: false } };
  const evidence = {
    freshRead: observation?.freshRead === true,
    bodyIncludesProse: observation?.bodyIncludesProse === true,
    topicsIntact: observation?.topicsIntact === true,
    clickAccepted: false,
    livePageAcceptance: "pending",
  };
  if (evidence.freshRead && evidence.bodyIncludesProse && evidence.topicsIntact) {
    return { ok: true, evidence: { ...evidence, required: true } };
  }
  return {
    ok: false,
    code: "PROSE_NOT_RETAINED",
    message: "请求的正文没有和话题实体一起被新鲜读回。不会清空编辑器来冒充写入。",
    evidence,
  };
}

export function evaluatePlatformDedup(spec, observation) {
  if (!spec?.required) return { ok: true, evidence: { required: false, jobDedupUsed: false } };
  const evidence = {
    queries: spec.queries,
    jobDedupUsed: false,
    liveVerified: observation?.liveVerified === true,
    source: observation?.source || "",
    livePageAcceptance: "pending",
  };
  if (observation?.jobDedupUsed === true || observation?.source === "job") {
    return {
      ok: false,
      code: "PLATFORM_HISTORY_UNVERIFIED",
      message: "任务去重不能代替笔记管理里的已发或已定时去重。",
      evidence: { ...evidence, jobDedupUsed: true },
    };
  }
  if (observation?.liveVerified !== true || observation?.source !== "note-management" || !Array.isArray(observation?.matches)) {
    return {
      ok: false,
      code: "PLATFORM_HISTORY_UNVERIFIED",
      message: "还没有笔记管理的新鲜只读结果。未查询不能当成没有重复。",
      evidence,
    };
  }
  if (observation.matches.length) {
    return {
      ok: false,
      code: "PLATFORM_DUPLICATE",
      message: "笔记管理里已有与查询匹配的已发或已定时笔记。",
      evidence: { ...evidence, matches: observation.matches.slice(0, 20), observedAt: observation.observedAt || "" },
    };
  }
  return {
    ok: true,
    evidence: { ...evidence, required: true, matches: [], observedAt: observation.observedAt || "", freshRead: true },
  };
}

export function labeledSwitchExpression(label) {
  return `(() => {
    const labelText = ${JSON.stringify(label)};
    const compact = value => String(value || "").replace(/\\s+/g, " ").trim();
    const visible = el => {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return rect.width > 4 && rect.height > 4 && style.display !== "none" && style.visibility !== "hidden";
    };
    const labels = [...document.querySelectorAll("div,section,label,span,p")]
      .filter(el => visible(el) && compact(el.innerText || el.textContent || "") === labelText)
      .sort((a, b) => {
        const ar = a.getBoundingClientRect();
        const br = b.getBoundingClientRect();
        return ar.width * ar.height - br.width * br.height;
      });
    if (labels.length !== 1) return { found: labels.length > 0, unique: false, enabled: false, count: labels.length, freshRead: true };
    const selectors = ".custom-switch-switch, .d-switch, [role='switch'], input[type='checkbox']";
    const ancestors = [];
    for (let el = labels[0]; el && ancestors.length < 8; el = el.parentElement) ancestors.push(el);
    const row = ancestors.find(el => el.matches?.(selectors) || el.querySelector?.(selectors));
    const target = row?.matches?.(selectors) ? row : row?.querySelector?.(selectors);
    if (!target) return { found: true, unique: false, enabled: false, freshRead: true, reason: "switch-not-found" };
    const input = target.matches?.("input[type='checkbox']") ? target : target.querySelector?.("input[type='checkbox']");
    const tokens = String(target.className || "").split(/\\s+/).filter(Boolean);
    const enabled = Boolean(
      input?.checked === true
      || target.getAttribute?.("aria-checked") === "true"
      || tokens.includes("checked")
      || tokens.includes("active")
    );
    if (!enabled) target.id = "vp2-xhs-labeled-switch";
    return { found: true, unique: true, enabled, selector: enabled ? "" : "#vp2-xhs-labeled-switch", freshRead: true };
  })()`;
}

export function collectionExpression(name) {
  return `(() => {
    const expected = ${JSON.stringify(name)};
    const compact = value => String(value || "").replace(/\\s+/g, " ").trim();
    const visible = el => {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return rect.width > 4 && rect.height > 4 && style.display !== "none" && style.visibility !== "hidden";
    };
    const inEditor = el => Boolean(el.closest?.("[contenteditable='true'],[contenteditable=''],textarea"));
    const titleLike = el => String(el.getAttribute?.("placeholder") || el.placeholder || "").includes("填写标题");
    let selectedExactHits = 0;
    for (const el of document.querySelectorAll("input,[aria-selected='true'],[aria-checked='true'],[role='option']")) {
      if (!visible(el) || inEditor(el) || titleLike(el)) continue;
      const text = compact(el.value || el.getAttribute?.("aria-label") || el.innerText || el.textContent || "");
      const parentText = compact(el.parentElement?.innerText || "");
      const nearCollection = parentText.length > 0 && parentText.length < 80 && parentText.includes("合集");
      const selected = el.getAttribute?.("aria-selected") === "true" || el.getAttribute?.("aria-checked") === "true" || el.value === expected;
      if (text === expected && nearCollection && selected) selectedExactHits += 1;
    }
    return { selectedExactHits, freshRead: true, clicked: false };
  })()`;
}

export function scheduleControlExpression(localText, isoText) {
  return `(() => {
    const expected = new Set(${JSON.stringify([localText, isoText].filter(Boolean))});
    const compact = value => String(value || "").replace(/\\s+/g, " ").trim();
    const visible = el => {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return rect.width > 4 && rect.height > 4 && style.display !== "none" && style.visibility !== "hidden";
    };
    const values = [];
    for (const el of document.querySelectorAll("input,textarea,time,[role='textbox']")) {
      if (!visible(el)) continue;
      const text = compact(el.value || el.getAttribute?.("datetime") || el.innerText || "");
      if (text) values.push(text);
    }
    return { values: values.slice(0, 20), matchedCount: values.filter(value => expected.has(value)).length, finalControlClicked: false, freshRead: true };
  })()`;
}

export function proseExpression(prose, topics) {
  return `(() => {
    const prose = ${JSON.stringify(prose)};
    const topics = ${JSON.stringify(topics)};
    const editors = [...document.querySelectorAll("[contenteditable='true'],[contenteditable='']")];
    const editor = editors.find(el => el.querySelector("a")) || editors[0];
    const text = String(editor?.innerText || "");
    const names = [...(editor?.querySelectorAll("a") || [])].map(el => {
      try { return String(JSON.parse(el.getAttribute("data-topic") || "{}").name || "").trim(); }
      catch { return ""; }
    }).filter(Boolean);
    const topicsIntact = topics.every(tag => names.filter(name => name === tag).length === 1);
    return { bodyIncludesProse: prose ? text.includes(prose) : false, topicsIntact, freshRead: true, clicked: false };
  })()`;
}

export function gateFromJudgement(judgement) {
  if (judgement.ok) return { ok: true, evidence: judgement.evidence || {} };
  return {
    ok: false,
    evidence: { ...(judgement.evidence || {}), code: judgement.code, message: judgement.message },
  };
}
