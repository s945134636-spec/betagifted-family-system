"use strict";

const {
  RECORD_TYPES,
  contentHash,
  createId,
  joinVaultPath,
  normalizeVaultRoot,
  stableStringify,
  validateRecord,
} = require("./core");

const AUTHORITY_MODULE_SCHEMA = "family-system/authority-module-v1";
const AUTHORITY_INDEX_SCHEMA = "family-system/authority-index-v1";
const DRAFT_SCHEMA = "family-system/meal-plan-draft-v1";
const DRAFT_RECORD_TYPES = Object.freeze(["meal_plan", "meal_slot", "dish_plan", "ingredient_requirement"]);

const MODULE_SPECS = Object.freeze({
  basic: Object.freeze({
    title: "家庭资料",
    relative_path: "01_基础信息系统/家庭资料.md",
    record_types: Object.freeze(["household", "member", "document", "contact", "medical_profile", "account_reference"]),
  }),
  finance: Object.freeze({
    title: "财务配置",
    relative_path: "02_财务保障系统/财务配置.md",
    record_types: Object.freeze(["finance_account", "budget", "recurring_item"]),
  }),
  asset: Object.freeze({
    title: "资产计划",
    relative_path: "03_资产维护系统/资产计划.md",
    record_types: Object.freeze(["asset", "maintenance_plan"]),
  }),
  purchase: Object.freeze({
    title: "物品目录",
    relative_path: "04_采购库存系统/物品目录.md",
    record_types: Object.freeze(["entity"]),
  }),
  diet: Object.freeze({
    title: "饮食资料",
    relative_path: "05_饮食健康系统/饮食资料.md",
    record_types: Object.freeze(["recipe", "health_constraint"]),
  }),
  task: Object.freeze({
    title: "事务规则",
    relative_path: "06_事务提醒系统/事务规则.md",
    record_types: Object.freeze(["task_category", "rule", "task_template"]),
  }),
});

const MARKDOWN_RECORD_TYPES = Object.freeze(Object.values(MODULE_SPECS).flatMap((spec) => spec.record_types));
const STRUCTURED_RECORD_TYPES = Object.freeze(RECORD_TYPES.filter((type) => !MARKDOWN_RECORD_TYPES.includes(type)));

function authorityModuleKey(recordType) {
  return Object.keys(MODULE_SPECS).find((key) => MODULE_SPECS[key].record_types.includes(recordType)) || null;
}

function authorityModulePath(authorityRoot, moduleKey) {
  const spec = MODULE_SPECS[moduleKey];
  if (!spec) throw new Error(`未知 Markdown 权威模块：${moduleKey}`);
  return joinVaultPath(authorityRoot, spec.relative_path);
}

function draftRootPath(authorityRoot) {
  return joinVaultPath(authorityRoot, "05_饮食健康系统/菜单草稿");
}

function mealPlanDraftPath(authorityRoot, draftId) {
  return `${draftRootPath(authorityRoot)}/${draftId}.md`;
}

function mealPlanDraftHash(draft) {
  return contentHash({
    schema: DRAFT_SCHEMA,
    draft_id: draft.draft_id,
    draft_revision: Number(draft.draft_revision || 0),
    status: draft.status || "draft",
    week_start: draft.week_start || "",
    household_id: draft.household_id || "",
    activated_at: draft.activated_at || null,
    updated_at: draft.updated_at || "",
    records: [...(draft.records || [])].sort((left, right) => `${left.record_type}:${left.id}`.localeCompare(`${right.record_type}:${right.id}`)),
  });
}

function defaultDraftBody(weekStart) {
  return `\n# ${weekStart || "一周"}菜单草稿\n\n> 草稿业务字段保存在 frontmatter；激活后会冻结为 Life Core 运行记录。\n`;
}

function createMealPlanDraft(draftId, records, options) {
  const plan = (records || []).find((record) => record.record_type === "meal_plan");
  const draft = {
    schema: DRAFT_SCHEMA,
    draft_id: draftId,
    draft_revision: Number(options?.draft_revision || 1),
    status: options?.status || plan?.status || "draft",
    week_start: options?.week_start || plan?.week_start || "",
    household_id: options?.household_id || plan?.household_id || "",
    activated_at: options?.activated_at || null,
    updated_at: options?.updated_at || new Date().toISOString(),
    records: (records || []).map((record) => ({ ...record })),
    body: options?.body == null ? defaultDraftBody(options?.week_start || plan?.week_start) : String(options.body),
  };
  draft.content_hash = mealPlanDraftHash(draft);
  return draft;
}

function serializeMealPlanDraft(input) {
  const draft = createMealPlanDraft(input.draft_id, input.records || [], input);
  const records = stableStringify(draft.records, 2).split("\n");
  const lines = [
    "---",
    `schema: ${JSON.stringify(draft.schema)}`,
    `draft_id: ${JSON.stringify(draft.draft_id)}`,
    `draft_revision: ${draft.draft_revision}`,
    `status: ${JSON.stringify(draft.status)}`,
    `week_start: ${JSON.stringify(draft.week_start)}`,
    `household_id: ${JSON.stringify(draft.household_id)}`,
    `activated_at: ${JSON.stringify(draft.activated_at)}`,
    `updated_at: ${JSON.stringify(draft.updated_at)}`,
    `content_hash: ${JSON.stringify(draft.content_hash)}`,
    `records: ${records[0]}`,
    ...records.slice(1),
    "---",
  ];
  const body = String(input.body == null ? defaultDraftBody(input.week_start) : input.body);
  return `${lines.join("\n")}${body.startsWith("\n") ? "" : "\n"}${body.replace(/\s*$/, "")}\n`;
}

function moduleHashPayload(module) {
  return {
    schema: AUTHORITY_MODULE_SCHEMA,
    module_key: module.module_key,
    module_revision: Number(module.module_revision || 0),
    household_id: module.household_id || "",
    updated_at: module.updated_at || "",
    records: [...(module.records || [])].sort((left, right) => `${left.record_type}:${left.id}`.localeCompare(`${right.record_type}:${right.id}`)),
  };
}

function authorityModuleHash(module) {
  return contentHash(moduleHashPayload(module));
}

function defaultModuleBody(moduleKey) {
  const spec = MODULE_SPECS[moduleKey];
  return `\n# ${spec.title}\n\n> 业务字段保存在 frontmatter，由 Family System 校验后提交；正文可自由补充说明。\n`;
}

function createAuthorityModule(moduleKey, records, options) {
  const spec = MODULE_SPECS[moduleKey];
  if (!spec) throw new Error(`未知 Markdown 权威模块：${moduleKey}`);
  const module = {
    schema: AUTHORITY_MODULE_SCHEMA,
    module_key: moduleKey,
    module_revision: Number(options?.module_revision || 1),
    household_id: options?.household_id || records?.[0]?.household_id || "",
    updated_at: options?.updated_at || new Date().toISOString(),
    records: (records || []).map((record) => ({ ...record })),
    body: options?.body == null ? defaultModuleBody(moduleKey) : String(options.body),
  };
  module.content_hash = authorityModuleHash(module);
  return module;
}

function serializeAuthorityModule(input) {
  const module = createAuthorityModule(input.module_key, input.records || [], input);
  module.content_hash = authorityModuleHash(module);
  const records = stableStringify(module.records, 2).split("\n");
  const lines = [
    "---",
    `schema: ${JSON.stringify(module.schema)}`,
    `module_key: ${JSON.stringify(module.module_key)}`,
    `module_revision: ${module.module_revision}`,
    `household_id: ${JSON.stringify(module.household_id)}`,
    `updated_at: ${JSON.stringify(module.updated_at)}`,
    `content_hash: ${JSON.stringify(module.content_hash)}`,
    `records: ${records[0]}`,
    ...records.slice(1),
    "---",
  ];
  const body = String(input.body == null ? defaultModuleBody(input.module_key) : input.body);
  return `${lines.join("\n")}${body.startsWith("\n") ? "" : "\n"}${body.replace(/\s*$/, "")}\n`;
}

function parseScalar(value) {
  const raw = String(value || "").trim();
  try { return JSON.parse(raw); } catch (_) {}
  if (/^-?\d+(?:\.\d+)?$/.test(raw)) return Number(raw);
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (raw === "null") return null;
  return raw;
}

function extractFrontmatter(text) {
  const source = String(text || "");
  if (!source.startsWith("---\n")) throw new Error("Markdown 权威文件缺少 frontmatter");
  const end = source.indexOf("\n---", 4);
  if (end < 0) throw new Error("Markdown 权威文件 frontmatter 未闭合");
  return { frontmatter: source.slice(4, end), body: source.slice(end + 4) };
}

function parseAuthorityModule(text, options) {
  const extracted = extractFrontmatter(text);
  const recordsMarker = extracted.frontmatter.indexOf("\nrecords:");
  if (recordsMarker < 0) throw new Error("Markdown 权威文件缺少 records");
  const metaText = extracted.frontmatter.slice(0, recordsMarker);
  const recordsText = extracted.frontmatter.slice(recordsMarker + "\nrecords:".length).trim();
  const meta = {};
  metaText.split("\n").forEach((line) => {
    const separator = line.indexOf(":");
    if (separator <= 0) return;
    meta[line.slice(0, separator).trim()] = parseScalar(line.slice(separator + 1));
  });
  let records;
  try { records = JSON.parse(recordsText); } catch (error) { throw new Error(`Markdown 权威 records 损坏：${error.message}`); }
  const module = { ...meta, records, body: extracted.body || "" };
  const errors = validateAuthorityModule(module, { check_hash: options?.check_hash !== false });
  if (errors.length) {
    const error = new Error(errors.join("；"));
    error.validation_errors = errors;
    throw error;
  }
  module.actual_hash = authorityModuleHash(module);
  return module;
}

function validateMealPlanDraft(draft, options) {
  const errors = [];
  if (draft?.schema !== DRAFT_SCHEMA) errors.push("菜单草稿 schema 无效");
  if (!draft?.draft_id) errors.push("菜单草稿缺少 draft_id");
  if (!Number.isInteger(Number(draft?.draft_revision)) || Number(draft?.draft_revision) < 1) errors.push("菜单草稿 revision 必须大于 0");
  if (!Array.isArray(draft?.records)) errors.push("菜单草稿 records 必须是数组");
  if (!["draft", "activated", "archived"].includes(draft?.status)) errors.push("菜单草稿状态无效");
  const ids = new Set();
  let planCount = 0;
  for (const record of Array.isArray(draft?.records) ? draft.records : []) {
    if (!DRAFT_RECORD_TYPES.includes(record.record_type)) errors.push(`菜单草稿不允许 ${record.record_type}`);
    if (ids.has(record.id)) errors.push(`菜单草稿内重复记录 ID：${record.id}`);
    ids.add(record.id);
    if (record.record_type === "meal_plan") {
      planCount += 1;
      if (record.id !== draft.draft_id) errors.push("meal_plan ID 必须等于 draft_id");
    } else if (record.source_plan_id !== draft.draft_id) errors.push(`${record.record_type}/${record.id} 未关联当前草稿`);
    errors.push(...validateRecord(record).map((message) => `${record.record_type || "unknown"}/${record.id || "unknown"}：${message}`));
  }
  if (planCount !== 1) errors.push("菜单草稿必须且只能包含一条 meal_plan");
  if (options?.check_hash !== false && draft?.content_hash !== mealPlanDraftHash(draft)) errors.push("菜单草稿内容哈希不匹配");
  return errors;
}

function parseMealPlanDraft(text, options) {
  const extracted = extractFrontmatter(text);
  const recordsMarker = extracted.frontmatter.indexOf("\nrecords:");
  if (recordsMarker < 0) throw new Error("菜单草稿缺少 records");
  const metaText = extracted.frontmatter.slice(0, recordsMarker);
  const recordsText = extracted.frontmatter.slice(recordsMarker + "\nrecords:".length).trim();
  const meta = {};
  metaText.split("\n").forEach((line) => {
    const separator = line.indexOf(":");
    if (separator <= 0) return;
    meta[line.slice(0, separator).trim()] = parseScalar(line.slice(separator + 1));
  });
  let records;
  try { records = JSON.parse(recordsText); } catch (error) { throw new Error(`菜单草稿 records 损坏：${error.message}`); }
  const draft = { ...meta, records, body: extracted.body || "" };
  const errors = validateMealPlanDraft(draft, { check_hash: options?.check_hash !== false });
  if (errors.length) throw new Error(errors.join("；"));
  draft.actual_hash = mealPlanDraftHash(draft);
  return draft;
}

function validateAuthorityModule(module, options) {
  const errors = [];
  const spec = MODULE_SPECS[module?.module_key];
  if (module?.schema !== AUTHORITY_MODULE_SCHEMA) errors.push("Markdown 权威模块 schema 无效");
  if (!spec) errors.push("Markdown 权威 module_key 无效");
  if (!Number.isInteger(Number(module?.module_revision)) || Number(module?.module_revision) < 1) errors.push("模块 revision 必须大于 0");
  if (!Array.isArray(module?.records)) errors.push("records 必须是数组");
  const ids = new Set();
  for (const record of Array.isArray(module?.records) ? module.records : []) {
    if (ids.has(record.id)) errors.push(`模块内重复记录 ID：${record.id}`);
    ids.add(record.id);
    if (spec && !spec.record_types.includes(record.record_type)) errors.push(`${record.record_type} 不属于 ${module.module_key} 模块`);
    errors.push(...validateRecord(record).map((message) => `${record.record_type || "unknown"}/${record.id || "unknown"}：${message}`));
  }
  if (options?.check_hash !== false && module?.content_hash !== authorityModuleHash(module)) errors.push("Markdown 权威内容哈希不匹配，需预演采纳或恢复");
  return errors;
}

function buildAuthorityIndex(modules, authorityRoot, acceptedAt) {
  const entries = {};
  Object.entries(modules || {}).forEach(([moduleKey, module]) => {
    entries[moduleKey] = {
      path: authorityModulePath(authorityRoot, moduleKey),
      module_revision: Number(module.module_revision),
      content_hash: module.content_hash || authorityModuleHash(module),
      record_ids: (module.records || []).map((record) => record.id).sort(),
      accepted_at: acceptedAt || module.updated_at,
      accepted_snapshot_path: null,
    };
  });
  return { schema: AUTHORITY_INDEX_SCHEMA, authority_root: normalizeVaultRoot(authorityRoot), rebuilt_at: acceptedAt || new Date().toISOString(), entries };
}

function diffAuthorityModules(accepted, candidate) {
  if (accepted.module_key !== candidate.module_key) throw new Error("不能比较不同权威模块");
  const before = new Map((accepted.records || []).map((record) => [record.id, record]));
  const after = new Map((candidate.records || []).map((record) => [record.id, record]));
  const changes = [];
  for (const [id, record] of after) {
    const previous = before.get(id);
    if (!previous) changes.push({ action: "create", id, record_type: record.record_type, before: null, after: record });
    else if (contentHash(previous) !== contentHash(record)) changes.push({ action: "update", id, record_type: record.record_type, before: previous, after: record });
  }
  for (const [id, record] of before) {
    if (!after.has(id)) changes.push({ action: "archive", id, record_type: record.record_type, before: record, after: { ...record, status: "archived", tombstone: true } });
  }
  return changes.sort((left, right) => `${left.record_type}:${left.id}`.localeCompare(`${right.record_type}:${right.id}`));
}

function moduleEffectFromRecordEffects(module, recordEffects, context) {
  const currentById = new Map((module.records || []).map((record) => [record.id, record]));
  const changedIds = [];
  for (const item of recordEffects) {
    const current = currentById.get(item.record.id) || null;
    const expected = Number(item.expected_revision || 0);
    if (Number(current?.revision || 0) !== expected) throw new Error(`版本冲突：${item.record_type}/${item.record.id}`);
    const next = {
      ...item.record,
      revision: expected + 1,
      created_at: current?.created_at || item.record.created_at,
      updated_at: context.recorded_at,
    };
    const errors = validateRecord(next);
    if (errors.length) throw new Error(`记录无效：${errors.join("；")}`);
    currentById.set(next.id, next);
    changedIds.push(next.id);
  }
  const nextModule = createAuthorityModule(module.module_key, [...currentById.values()], {
    ...module,
    module_revision: Number(module.module_revision) + 1,
    updated_at: context.recorded_at,
    body: module.body,
  });
  return {
    effect_id: createId("effect", `authority:${module.module_key}:${nextModule.module_revision}:${changedIds.sort().join(",")}`),
    kind: "upsert_markdown_module",
    module_key: module.module_key,
    record_type: "authority_module",
    record: nextModule,
    before: module,
    expected_revision: Number(module.module_revision),
    expected_hash: module.content_hash,
    changed_record_ids: changedIds,
    note: "markdown_authority",
  };
}

function draftEffectFromRecordEffects(draft, draftId, recordEffects, context) {
  const currentById = new Map((draft?.records || []).map((record) => [record.id, record]));
  for (const item of recordEffects) {
    const current = currentById.get(item.record.id) || null;
    const expected = Number(item.expected_revision || 0);
    if (Number(current?.revision || 0) !== expected) throw new Error(`版本冲突：${item.record_type}/${item.record.id}`);
    currentById.set(item.record.id, {
      ...item.record,
      revision: expected + 1,
      created_at: current?.created_at || item.record.created_at,
      updated_at: context.recorded_at,
    });
  }
  const records = [...currentById.values()];
  const plan = records.find((record) => record.record_type === "meal_plan");
  const next = createMealPlanDraft(draftId, records, {
    ...(draft || {}),
    draft_revision: Number(draft?.draft_revision || 0) + 1,
    week_start: plan?.week_start,
    household_id: plan?.household_id,
    updated_at: context.recorded_at,
  });
  return {
    effect_id: createId("effect", `draft:${draftId}:${next.draft_revision}`),
    kind: "upsert_markdown_draft",
    draft_id: draftId,
    record_type: "meal_plan_draft",
    record: next,
    before: draft || null,
    expected_revision: Number(draft?.draft_revision || 0),
    expected_hash: draft?.content_hash || null,
    note: "markdown_meal_plan_draft",
  };
}

function authorityMapManifest(authorityRoot) {
  const markdown = {};
  Object.entries(MODULE_SPECS).forEach(([key, spec]) => {
    markdown[key] = { path: authorityModulePath(authorityRoot, key), record_types: [...spec.record_types] };
  });
  return {
    policy: "domain-partitioned-single-authority",
    markdown,
    structured: { root: "records", record_types: [...STRUCTURED_RECORD_TYPES] },
    lifecycle: { meal_plan_draft: "markdown", meal_plan_active: "structured_snapshot" },
  };
}

module.exports = {
  AUTHORITY_INDEX_SCHEMA,
  AUTHORITY_MODULE_SCHEMA,
  DRAFT_SCHEMA,
  DRAFT_RECORD_TYPES,
  MARKDOWN_RECORD_TYPES,
  MODULE_SPECS,
  STRUCTURED_RECORD_TYPES,
  authorityMapManifest,
  authorityModuleHash,
  authorityModuleKey,
  authorityModulePath,
  buildAuthorityIndex,
  createAuthorityModule,
  createMealPlanDraft,
  diffAuthorityModules,
  draftRootPath,
  draftEffectFromRecordEffects,
  mealPlanDraftHash,
  mealPlanDraftPath,
  moduleEffectFromRecordEffects,
  parseAuthorityModule,
  parseMealPlanDraft,
  serializeAuthorityModule,
  serializeMealPlanDraft,
  validateAuthorityModule,
  validateMealPlanDraft,
};
