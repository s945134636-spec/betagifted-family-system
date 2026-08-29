"use strict";

const assert = require("assert");
const { commandEnvelope, contentHash, uuidFromSeed } = require("../src/core");
const { CoreStorage, LifeCoreService } = require("../src/storage");
const { parseMealPlanDraft } = require("../src/authority");

class MockVault {
  constructor() {
    this.files = new Map();
    this.folders = new Set();
    this.failOncePattern = null;
  }
  object(path, folder) { return folder ? { path, children: [] } : { path, name: path.split("/").at(-1), basename: path.split("/").at(-1).replace(/\.md$/, "") }; }
  getAbstractFileByPath(path) { return this.files.has(path) ? this.object(path, false) : this.folders.has(path) ? this.object(path, true) : null; }
  async createFolder(path) { this.folders.add(path); return this.object(path, true); }
  maybeFail(path) { if (this.failOncePattern && path.includes(this.failOncePattern)) { this.failOncePattern = null; throw new Error(`injected failure: ${path}`); } }
  async create(path, content) { this.maybeFail(path); this.files.set(path, content); return this.object(path, false); }
  async modify(file, content) { this.maybeFail(file.path); this.files.set(file.path, content); }
  async process(file, updater) { this.maybeFail(file.path); this.files.set(file.path, updater(this.files.get(file.path))); }
  async read(file) { return this.files.get(file.path); }
  async delete(file) { this.files.delete(file.path); }
  async trash(file) { this.files.delete(file.path); }
  getFiles() { return [...this.files.keys()].map((path) => this.object(path, false)); }
  getMarkdownFiles() { return this.getFiles().filter((file) => file.path.endsWith(".md")); }
  on() { return { unload() {} }; }
}

class MockMetadataCache { getFileCache() { return { frontmatter: {} }; } }

function app() {
  return { vault: new MockVault(), metadataCache: new MockMetadataCache() };
}

function cmd(type, values, householdId, seed) {
  return commandEnvelope(type, { command_id: uuidFromSeed(seed), household_id: householdId || "", actor_id: uuidFromSeed("actor"), ...values }, { clock: () => new Date("2026-08-13T10:00:00Z") });
}

async function main() {
  const rootApp = app();
  const rootStorage = new CoreStorage(rootApp, "00_系统核心/life-core", () => new Date("2026-08-13T10:00:00Z"), { authorityRoot: ".", deviceId: "root-layout" });
  const rootService = new LifeCoreService(rootStorage, () => new Date("2026-08-13T10:00:00Z"));
  const rootInit = await rootService.preview(cmd("initialize-household", { name: "根目录家庭" }, "", "root:init"));
  await rootService.commit(rootInit.id);
  assert(rootApp.vault.files.has("01_基础信息系统/家庭资料.md"));
  assert(rootApp.vault.files.has("00_系统核心/life-core/manifest.json"));
  assert(rootApp.vault.files.has("00_系统核心/life-core/projections/当前秩序.md"));
  assert.strictEqual(JSON.parse(rootApp.vault.files.get("00_系统核心/life-core/manifest.json")).authority_map.markdown.basic.path, "01_基础信息系统/家庭资料.md");
  assert.strictEqual(JSON.parse(rootApp.vault.files.get("00_系统核心/life-core/indexes/markdown-authority.json")).authority_root, ".");
  assert.strictEqual([...rootApp.vault.files.keys()].some((path) => path.startsWith("家庭管理系统/")), false);

  const mockApp = app();
  const storage = new CoreStorage(mockApp, "家庭管理系统/00_系统核心/life-core", () => new Date("2026-08-13T10:00:00Z"));
  const service = new LifeCoreService(storage, () => new Date("2026-08-13T10:00:00Z"));
  const init = await service.preview(cmd("initialize-household", { name: "测试家庭" }, "", "init-storage"));
  const committed = await service.commit(init.id);
  assert.strictEqual(committed.status, "committed");
  const repeated = await service.commit(init.id);
  assert.strictEqual(repeated.status, "committed");
  let state = await storage.loadState();
  assert.strictEqual(state.household.filter((item) => !item.tombstone).length, 1);
  assert.deepStrictEqual(state.task_category.map((item) => item.route_kind).sort(), ["household", "meal_handling", "purchase"]);
  assert.strictEqual(state.task_category.filter((item) => item.is_default).length, 1);
  assert(mockApp.vault.files.has("家庭管理系统/00_系统核心/life-core/projections/当前秩序.md"));
  const manifest = JSON.parse(mockApp.vault.files.get("家庭管理系统/00_系统核心/life-core/manifest.json"));
  assert.deepStrictEqual({ schema: manifest.schema, schema_version: manifest.schema_version }, { schema: "family-system/store-v4", schema_version: 4 });
  assert.strictEqual(manifest.authority_map.policy, "domain-partitioned-single-authority");

  const household = state.household[0];
  const categoryOperation = await service.preview(cmd("task-category.create", {
    name: "家务协作",
    route_kind: "household",
    is_default: true,
  }, household.id, "category-storage"));
  await service.commit(categoryOperation.id);
  state = await storage.loadState();
  assert.strictEqual(state.task.length, 0, "records/task 不能把 task_category 读成事务");
  assert.strictEqual(state.task_category.length, 4);
  assert(state.task_category.every((item) => item.record_type === "task_category"));

  const backup = await storage.createPortableBackup();
  assert.strictEqual(backup.status, "valid");
  assert(backup.file_count > 6);
  const verifiedBackup = await storage.verifyPortableBackup(backup.path);
  assert.strictEqual(verifiedBackup.bundle_hash, backup.bundle_hash);
  const restored = await storage.restorePortableBackupCandidate(
    backup.path,
    "家庭系统恢复候选/00_系统核心/life-core",
    "家庭系统恢复候选",
  );
  assert.strictEqual(restored.status, "candidate_ready");
  assert.strictEqual(restored.record_counts.household, 1);
  assert.strictEqual(restored.record_counts.task_category, 4);
  assert.strictEqual(restored.validation.status, "valid");
  await assert.rejects(() => storage.restorePortableBackupCandidate(
    backup.path,
    "家庭系统恢复候选/00_系统核心/life-core",
    "家庭系统恢复候选",
  ), /目标必须为空/);
  const tamperedPath = "家庭管理系统/00_系统核心/life-core/backups/portable/tampered.json";
  const tampered = JSON.parse(mockApp.vault.files.get(backup.path));
  tampered.files[0].content += "\n篡改";
  mockApp.vault.files.set(tamperedPath, JSON.stringify(tampered));
  await assert.rejects(() => storage.verifyPortableBackup(tamperedPath), /哈希不匹配/);

  const draftRecipeOperation = await service.preview(cmd("add-recipe", {
    name: "草稿测试菜谱", category: "一餐式", meal_types: ["晚餐"], servings: 3, prep_minutes: 20,
    ingredients: [{ id: uuidFromSeed("draft:ingredient"), name: "草稿食材", quantity: 1, unit: "份", inventory_policy: "untracked_consumable" }],
    steps: ["完成制作。"],
  }, household.id, "draft:recipe"));
  await service.commit(draftRecipeOperation.id);
  let recipe = (await storage.loadState()).recipe.find((item) => item.name === "草稿测试菜谱");
  const dietPath = storage.modulePath("diet");
  mockApp.vault.files.set(dietPath, mockApp.vault.files.get(dietPath).replace("草稿测试菜谱", "草稿测试菜谱（外部）"));
  const authorityConflict = await storage.checkAuthorityModification(dietPath);
  assert.strictEqual(authorityConflict.conflict_type, "markdown_authority_modified_externally");
  await assert.rejects(() => service.preview(cmd("schedule-dish", { recipe_id: recipe.id, planned_date: "2026-08-22", meal_label: "晚餐" }, household.id, "external:blocked")), /待处理外部修改/);
  const adopt = await service.preview(cmd("authority.adopt-external", { module_key: "diet" }, household.id, "external:adopt"));
  assert.strictEqual(adopt.authority_changes[0].action, "update");
  await service.commit(adopt.id);
  await storage.resolveAuthorityConflicts("diet", "adopted");
  recipe = (await storage.loadState()).recipe.find((item) => item.id === recipe.id);
  assert.strictEqual(recipe.name, "草稿测试菜谱（外部）");
  const createDraft = await service.preview(cmd("meal-plan.create", { week_start: "2026-08-22", title: "Markdown 草稿" }, household.id, "draft:create"));
  await service.commit(createDraft.id);
  let draftPlan = (await storage.loadState()).meal_plan.find((item) => item.status === "draft");
  const schedule = await service.preview(cmd("schedule-dish", { meal_plan_id: draftPlan.id, recipe_id: recipe.id, planned_date: "2026-08-22", meal_label: "晚餐" }, household.id, "draft:schedule"));
  await service.commit(schedule.id);
  assert.strictEqual((await storage.readRecords("purchase_demand")).length, 0, "草稿不得提前创建采购需求");
  assert.strictEqual(mockApp.vault.files.has(storage.recordPath("meal_plan", draftPlan.id)), false, "草稿不得写入 JSON 当前记录");
  recipe = (await storage.loadState()).recipe.find((item) => item.id === recipe.id);
  const recipeUpdate = await service.preview(cmd("recipe.update", {
    id: recipe.id,
    expected_revision: recipe.revision,
    patch: { ingredients: recipe.ingredients.map((item) => ({ ...item, quantity: 2 })) },
  }, household.id, "draft:recipe:update-before-activation"));
  await service.commit(recipeUpdate.id);
  draftPlan = (await storage.loadState()).meal_plan.find((item) => item.id === draftPlan.id);
  const activation = await service.preview(cmd("meal-plan.activate", { id: draftPlan.id, expected_revision: draftPlan.revision }, household.id, "draft:activate"));
  assert(activation.effects.some((item) => item.kind === "move_markdown_draft"));
  assert(activation.effects.some((item) => item.kind === "upsert_json_record" && item.record_type === "meal_slot"));
  assert(activation.effects.some((item) => item.kind === "upsert_json_record" && item.record_type === "ingredient_requirement" && item.record.quantity === 2), "激活必须按当时最新菜谱冻结食材实例");
  await service.commit(activation.id);
  assert.strictEqual((await storage.readRecord("meal_plan", draftPlan.id)).status, "active");
  const activatedDraft = parseMealPlanDraft(mockApp.vault.files.get(storage.draftPath(draftPlan.id)));
  assert.strictEqual(activatedDraft.status, "activated");

  const cancelledLongRange = await service.preview(cmd("meal-plan.generate-draft", {
    range_start: "2026-10-01",
    range_end: "2026-11-15",
    participant_ids: [],
    default_serving_count: 1,
    meal_types: ["晚餐"],
    generation_strategy: "balanced",
    generation_seed: "storage-cancelled-long-menu",
  }, household.id, "auto-menu:cancelled-long"));
  const cancelledPlanId = cancelledLongRange.effects.find((item) => item.kind === "upsert_markdown_draft").draft_id;
  assert.strictEqual(mockApp.vault.files.has(storage.draftPath(cancelledPlanId)), false, "预览阶段不得提前写长区间草稿");
  await service.discardPreview(cancelledLongRange.id);
  assert.strictEqual(mockApp.vault.files.has(storage.draftPath(cancelledPlanId)), false, "取消长区间生成不得留下草稿文件");

  const autoDraftOperation = await service.preview(cmd("meal-plan.generate-draft", {
    range_start: "2026-09-01",
    range_end: "2026-09-03",
    participant_ids: [],
    guest_count: 1,
    default_serving_count: 1,
    meal_types: ["晚餐"],
    generation_strategy: "balanced",
    generation_seed: "storage-auto-menu",
  }, household.id, "auto-menu:storage"));
  assert.strictEqual(autoDraftOperation.effects.filter((item) => item.kind === "upsert_markdown_draft").length, 1, "自动菜单必须原子写入一份 Markdown 草稿");
  assert.strictEqual(autoDraftOperation.effects.some((item) => item.kind === "upsert_json_record" && ["purchase_demand", "task", "inventory_batch", "inventory_movement"].includes(item.record_type)), false, "自动草稿不得写采购、事务或库存 JSON");
  await service.commit(autoDraftOperation.id);
  const autoPlan = (await storage.loadState()).meal_plan.find((item) => item.range_start === "2026-09-01");
  assert(autoPlan && autoPlan.status === "draft");
  const autoDraft = await storage.readMealPlanDraft(autoPlan.id);
  assert.strictEqual(autoDraft.records.filter((item) => item.record_type === "meal_slot").length, 3);
  const autoSlot = autoDraft.records.find((item) => item.record_type === "meal_slot");
  const lockOperation = await service.preview(cmd("meal-slot.set-lock", { id: autoSlot.id, expected_revision: autoSlot.revision, locked: true }, household.id, "auto-menu:lock"));
  assert.strictEqual(lockOperation.effects[0].kind, "upsert_markdown_draft");
  await service.commit(lockOperation.id);
  const lockedDraft = await storage.readMealPlanDraft(autoPlan.id);
  assert.strictEqual(lockedDraft.records.find((item) => item.id === autoSlot.id).locked, true);

  const memberOperation = await service.preview(cmd("add-member", { name: "成员", role: "member" }, household.id, "member-storage"));
  await service.commit(memberOperation.id);
  const member = (await storage.loadState()).member[0];
  await assert.rejects(() => storage.writeRecord({ ...member, name: "冲突改名" }, 0), /Markdown 权威记录必须通过模块 EffectSet/);
  const undo = await service.recover(memberOperation.id, "undo");
  assert.strictEqual(undo.status, "committed");
  const reversedEvents = (await storage.readRecords("domain_event")).filter((item) => item.event_type === "operation.reversed");
  assert.strictEqual(reversedEvents.length, 1);

  const previewOnly = await service.preview(cmd("add-member", { name: "预演成员", role: "member" }, household.id, "preview-only"));
  const discarded = await service.discardPreview(previewOnly.id);
  assert.strictEqual(discarded.status, "previewed");
  assert(discarded.discarded_at);
  assert.strictEqual((await storage.loadState()).member.filter((item) => !item.tombstone).length, 0);

  const projectionPath = "家庭管理系统/00_系统核心/life-core/projections/当前秩序.md";
  mockApp.vault.files.set(projectionPath, `${mockApp.vault.files.get(projectionPath)}\n人工修改`);
  const conflict = await storage.checkProjectionModification(projectionPath);
  assert.strictEqual(conflict.conflict_type, "projection_modified_externally");

  const recipeOperation = await service.preview(cmd("add-recipe", {
    name: "故障菜谱",
    category: "一餐式",
    meal_types: ["晚餐"],
    servings: 3,
    prep_minutes: 20,
    ingredients: [{ id: uuidFromSeed("ingredient:test"), name: "测试食材", quantity: 1, unit: "份", inventory_policy: "tracked" }],
    steps: ["完成测试制作。"],
  }, household.id, "recipe-failure"));
  mockApp.vault.failOncePattern = "/domain_event/";
  await assert.rejects(() => service.commit(recipeOperation.id), /injected failure/);
  const failedOperation = await storage.readOperation(recipeOperation.id);
  assert.strictEqual(failedOperation.status, "compensated");
  const recipes = await storage.readRecords("recipe");
  assert(recipes.every((item) => item.tombstone || item.name !== "故障菜谱"));

  const currentProjection = mockApp.vault.files.get(projectionPath);
  const status = (await storage.readRecords("projection_status"))[0];
  assert.notStrictEqual(contentHash(currentProjection), status.content_hash, "人工修改应继续保持冲突，不静默覆盖");

  const transactionId = uuidFromSeed("shortcut:transaction");
  const accountId = uuidFromSeed("shortcut:finance-account");
  const accountOperation = await service.preview(cmd("record.create", {
    record_type: "finance_account",
    record: { id: accountId, name: "现金账户", account_type: "cash", status: "active" },
  }, household.id, "shortcut:finance-account"));
  await service.commit(accountOperation.id);
  const inbox = cmd("finance.transaction.capture", {
    transaction_id: transactionId,
    date: "2026-08-22",
    direction: "支出",
    amount: 12,
    account_id: accountId,
    category: "餐饮",
    name: "快捷指令测试",
    source: "shortcut",
    status: "confirmed",
  }, household.id, "shortcut:command");
  await storage.writeJson(storage.inboxPath("pending", inbox.id), inbox);
  const inboxResults = await service.processInbox();
  assert.strictEqual(inboxResults[0].status, "processed");
  assert.strictEqual((await storage.readRecords("finance_transaction")).length, 1);
  assert.strictEqual(mockApp.vault.getAbstractFileByPath(storage.inboxPath("pending", inbox.id)), null);
  assert(mockApp.vault.getAbstractFileByPath(storage.inboxPath("processed", inbox.id)));

  const rebuildTypes = ["household", "recipe", "entity", "meal_plan", "meal_slot", "task", "inventory_batch"];
  const beforeRebuild = Object.fromEntries(await Promise.all(rebuildTypes.map(async (type) => [type, contentHash(await storage.readRecords(type))])));
  await mockApp.vault.delete(mockApp.vault.getAbstractFileByPath(storage.authorityIndexPath()));
  await storage.rebuildAuthorityIndex();
  const afterRebuild = Object.fromEntries(await Promise.all(rebuildTypes.map(async (type) => [type, contentHash(await storage.readRecords(type))])));
  assert.deepStrictEqual(afterRebuild, beforeRebuild, "删除源索引后必须能从 Markdown 与运行 JSON 重建相同状态");

  const mixedIntake = await service.preview(cmd("inventory.receive-manual", {
    new_item: { name: "混合效果测试油", canonical_unit: "毫升", purchase_group: "粮油调味", tracking_policy: "estimated" },
    quantity: 500, unit: "毫升", intake_reason: "opening_balance",
  }, household.id, "mixed:intake"));
  assert(mixedIntake.effects.some((item) => item.kind === "upsert_markdown_module" && item.module_key === "purchase"));
  assert(mixedIntake.effects.some((item) => item.kind === "upsert_json_record" && item.record_type === "inventory_batch"));
  await service.commit(mixedIntake.id);
  const mixedBatch = (await storage.loadState()).inventory_batch.find((item) => item.item_name === "混合效果测试油");
  const mixedAdjust = await service.preview(cmd("inventory.adjust", {
    inventory_batch_id: mixedBatch.id, available_quantity: 1, unit: "瓶", package_size: 500, package_size_unit: "毫升",
  }, household.id, "mixed:adjust"));
  assert(mixedAdjust.effects.some((item) => item.kind === "upsert_markdown_module" && item.module_key === "purchase"));
  assert(mixedAdjust.effects.some((item) => item.kind === "upsert_json_record" && item.record_type === "inventory_batch"));
  await service.commit(mixedAdjust.id);
  const adjustedState = await storage.loadState();
  assert.strictEqual(adjustedState.inventory_batch.find((item) => item.id === mixedBatch.id).available_quantity, 500);
  assert.strictEqual(adjustedState.entity.find((item) => item.id === mixedBatch.item_entity_id).package_conversions[0].unit, "瓶");

  mockApp.vault.files.set(dietPath, "---\nschema: [损坏\n---\n# 无法解析\n");
  const brokenConflict = await storage.checkAuthorityModification(dietPath);
  assert(brokenConflict.details.error, "损坏 frontmatter 必须记录解析错误");
  const restore = await service.preview(cmd("authority.restore-module", { module_key: "diet" }, household.id, "external:restore"));
  assert.strictEqual(restore.effects[0].kind, "restore_markdown_module");
  await service.commit(restore.id);
  await storage.resolveAuthorityConflicts("diet", "restored");
  assert.strictEqual((await storage.readAuthorityModule("diet")).records.some((item) => item.id === recipe.id), true);

  const leasedOperation = await service.preview(cmd("task.create", { title: "租约测试", category: "household" }, household.id, "lease:operation"));
  await storage.writeJson(storage.leasePath(), { schema: "family-system/writer-lease-v1", token: "other", device_id: "iphone", operation_id: "other-operation", status: "active", expires_at: "2026-08-13T10:10:00.000Z" });
  await assert.rejects(() => service.commit(leasedOperation.id), /另一设备正在写入/);
  await storage.writeJson(storage.leasePath(), { schema: "family-system/writer-lease-v1", token: "expired", device_id: "iphone", operation_id: "other-operation", status: "active", expires_at: "2026-08-13T09:59:00.000Z" });
  assert.strictEqual((await service.commit(leasedOperation.id)).status, "committed", "过期租约且没有未恢复操作时允许接管");

  console.log(JSON.stringify({ status: "ok", suite: "storage", files: mockApp.vault.files.size, exact_record_directories: true }));
}

main().catch((error) => { console.error(error); process.exit(1); });
