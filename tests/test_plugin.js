"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const Module = require("module");

const root = path.resolve(__dirname, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
const main = fs.readFileSync(path.join(root, "main.js"), "utf8");
const styles = fs.readFileSync(path.join(root, "styles.css"), "utf8");

assert.deepStrictEqual({ id: manifest.id, version: manifest.version, desktop: manifest.isDesktopOnly }, {
  id: "betagifted-family-system", version: "2.3.0", desktop: false,
});
assert.strictEqual(manifest.minAppVersion, "1.8.10");
assert.strictEqual(manifest.name, "BetaGifted Family System");
assert.match(manifest.description, /\.$/);
assert(!/innerHTML|outerHTML|insertAdjacentHTML/.test(main));
assert(!/\bfetch\s*\(|XMLHttpRequest|WebSocket|https?:\/\//.test(main.replaceAll("http://127.0.0.1:41729", "")));
assert(!/require\(["'](?:fs|path|electron|child_process|http|https)["']\)/.test(main));
assert(!/telemetry|analytics|auto[- ]?update/i.test(main));
assert(!/detachLeavesOfType/.test(main));
assert(!/companionCredential:\s*String/.test(main));
assert.match(main, /module\.exports\.__test/);
assert.match(main, /vault\.on/);
assert.match(main, /\(current\.domain_event \|\| \[\]\)\.some\(\(item\) => item\.payload\?\.event_id === event\.id\)/);
assert.match(styles, /@container \(max-width: 760px\)/);
assert.match(styles, /@container \(max-width: 520px\)/);
assert.match(styles, /prefers-reduced-motion/);
assert.match(styles, /border-radius: 18px/);
assert.match(main, /当前菜谱最新版/);
assert.match(main, /菜谱不可用：可能已归档、删除或刚被其他修改更新/);
assert.match(main, /"task\.delete"/);
assert.match(main, /"dish\.continue-without-missing"/);
assert.match(main, /"dish\.restore-omitted-ingredients"/);
assert.match(main, /"meal-plan\.generate-draft"/);
assert.match(main, /"meal-plan\.regenerate"/);
assert.match(main, /"meal-slot\.set-lock"/);
assert.match(main, /一键自动生成菜单/);
assert.match(main, /超过 31 天/);
assert.match(main, /dish\.ingredients_omitted/);
assert.match(main, /dish\.ingredients_restored/);
assert.match(main, /records, type\)}\/`/);
assert.match(styles, /family-system-mini-button\.is-danger/);
assert.match(styles, /family-system-badge\.is-adaptable/);

const originalLoad = Module._load;
const notices = [];
class StubItemView {}
class StubModal {}
class StubNotice { constructor(message) { notices.push(message); } }
class StubPlugin {}
class StubSettingTab {}
class StubSetting {}
Module._load = function(request, parent, isMain) {
  if (request === "obsidian") return {
    ItemView: StubItemView, Modal: StubModal, Notice: StubNotice, Plugin: StubPlugin,
    PluginSettingTab: StubSettingTab, Setting: StubSetting, setIcon() {},
  };
  return originalLoad.call(this, request, parent, isMain);
};
let plugin;
try {
  delete require.cache[require.resolve("../main.js")];
  plugin = require("../main.js");
} finally {
  Module._load = originalLoad;
}
assert.strictEqual(typeof plugin, "function");
assert.strictEqual(typeof plugin.__test.previewImport, "undefined");
assert.strictEqual(typeof plugin.__test.planCommand, "function");
assert.strictEqual(typeof plugin.__test.renderDashboard, "function");
assert.strictEqual(typeof plugin.__test.buildFamilySystemViewModel, "function");
assert.strictEqual(plugin.__test.MODULES.asset.label, "资产");
assert.strictEqual(plugin.__test.DEFAULT_SETTINGS.dataRoot, "家庭管理系统/00_系统核心/life-core");
assert.strictEqual(plugin.__test.DEFAULT_SETTINGS.authorityRoot, "家庭管理系统");
assert.strictEqual(plugin.__test.normalizeSettings({ authorityRoot: ".", dataRoot: "00_系统核心/life-core" }).authorityRoot, ".");
assert.strictEqual(plugin.__test.normalizeSettings({ authorityRoot: "", dataRoot: "" }).authorityRoot, "家庭管理系统");
assert.strictEqual(plugin.__test.DEFAULT_SETTINGS.companionBaseUrl, "http://127.0.0.1:41729");
assert.strictEqual(plugin.__test.DEFAULT_SETTINGS.appleIntegrationEnabled, false);
assert.strictEqual(plugin.__test.DEFAULT_SETTINGS.onboardingCompleted, false);
assert.strictEqual(Object.prototype.hasOwnProperty.call(plugin.__test.normalizeSettings({ companionCredential: "secret" }), "companionCredential"), false);
assert.deepStrictEqual(plugin.__test.APPLE_LISTS, { purchase: "家庭采购", meal_handling: "食材处理", household: "家庭事务" });
assert.deepStrictEqual(plugin.__test.PURCHASE_MODES, ["reminder_only", "inventory_managed"]);
assert(plugin.__test.RECORD_TYPES.includes("task_category"));
assert.deepStrictEqual(plugin.__test.DEFAULT_SETTINGS.purchaseGroupOrder.split("\n").slice(0, 3), ["生鲜蔬菜", "水果", "肉禽蛋"]);
const projectionState = {
  purchase_demand: [{ id: "demand-oil", ingredient_id: "ingredient-oil", ingredient_name: "食用油", quantity: 202.5, unit: "毫升", status: "planned" }],
  entity: [{ id: "ingredient-oil", purchase_group: "粮油调味", status: "active" }],
};
assert.deepStrictEqual(plugin.__test.appleProjectionTask({
  id: "task-oil", source_type: "purchase_demand", source_id: "demand-oil", source_key: "purchase:demand-oil", status: "open",
}, projectionState), {
  source_key: "purchase:demand-oil", task_id: "task-oil", title: "粮油调味｜食用油｜202.5 毫升", notes: "", due_at: null,
  priority: 0, completed: false, kind: "purchase", category: "purchase", list_title: "家庭采购", projection_enabled: true,
});
assert.strictEqual(plugin.__test.appleProjectionTask({
  id: "task-deleted", source_key: "task:deleted", title: "已删除事务", status: "cancelled", tombstone: true,
}, { purchase_demand: [], entity: [] }).projection_enabled, false);
const instruction = { id: plugin.__test.uuidFromSeed("handling:instruction"), phase: "每晚解冻安排", instruction: "周日晚将虾仁移入冷藏室" };
assert.strictEqual(plugin.__test.handlingInstructionsText([instruction]), "每晚解冻安排｜周日晚将虾仁移入冷藏室");
assert.deepStrictEqual(plugin.__test.parseHandlingInstructionsText("每晚解冻安排｜周日晚将虾仁和鸡胸肉移入冷藏室", [instruction])[0], {
  ...instruction,
  instruction: "周日晚将虾仁和鸡胸肉移入冷藏室",
});
const action = { id: plugin.__test.uuidFromSeed("handling:action"), scheduled_at: "2026-08-23T20:00:00", title: "移入冷藏解冻", related_meal_ids: ["meal-a"] };
assert.strictEqual(plugin.__test.handlingActionsText([action]), "2026-08-23 20:00｜移入冷藏解冻");
assert.deepStrictEqual(plugin.__test.parseHandlingActionsText("2026-08-23 19:30｜移入冷藏解冻", [action])[0], {
  ...action,
  scheduled_at: "2026-08-23T19:30:00",
  task_required: true,
  projection_policy: "apple-reminders",
  status: "planned",
});

const inventoryItem = { id: plugin.__test.uuidFromSeed("ingredient:fish"), source_item_id: "item-fish", name: "鲈鱼", canonical_unit: "条" };
const mappedIngredient = { id: inventoryItem.id, item_entity_id: inventoryItem.id, inventory_item_id: "item-fish", name: "鲈鱼", quantity: 1, unit: "条", specificity: "specific", inventory_policy: "tracked" };
assert.strictEqual(plugin.__test.recipeIngredientMode(mappedIngredient, [inventoryItem]), "tracked");
assert.strictEqual(plugin.__test.recipeIngredientMode({ id: plugin.__test.uuidFromSeed("ingredient:water"), name: "清水", inventory_policy: "untracked_consumable" }, [inventoryItem]), "untracked");
assert.deepStrictEqual(plugin.__test.recipeIngredientDraftToRecord({ original: mappedIngredient, mode: "tracked", item_id: inventoryItem.id, quantity: 2, unit: "条", specificity: "general" }, [inventoryItem]), {
  ...mappedIngredient,
  key: "鲈鱼",
  quantity: 2,
  specificity: "general",
  source_item_id: "item-fish",
});
const unmapped = plugin.__test.recipeIngredientDraftToRecord({ mode: "untracked", name: "清水", quantity: 500, unit: "毫升", specificity: "general" }, [inventoryItem]);
assert.strictEqual(unmapped.inventory_policy, "untracked_consumable");
assert.strictEqual(unmapped.item_entity_id, undefined);
assert.match(unmapped.id, /^[0-9a-f-]{36}$/);
assert.strictEqual(plugin.__test.recipeMeta({ category: "主菜", meal_types: ["晚餐"], servings: 3, prep_minutes: 25 }), "主菜 · 晚餐 · 3 份 · 25 分钟");

(async () => {
  await plugin.prototype.viewRecipe.call({
    loadModel: async () => ({ state: { recipe: [] } }),
  }, "recipe-invalidated-after-click", {
    readOnly: true,
    context: { planned_date: "2026-08-24", meal_label: "午餐" },
  });
  assert.deepStrictEqual(notices, ["菜谱不可用：可能已归档、删除或刚被其他修改更新"]);
  console.log(JSON.stringify({ status: "ok", suite: "plugin", version: manifest.version, bytes: Buffer.byteLength(main), recipe_editor: true, stale_recipe_notice: true }));
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
