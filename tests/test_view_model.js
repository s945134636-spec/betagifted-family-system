"use strict";

const assert = require("assert");
const Module = require("module");

const originalLoad = Module._load;
class StubItemView {}
class StubModal {}
class StubPlugin {}
class StubSettingTab {}
class StubSetting {}
Module._load = function(request, parent, isMain) {
  if (request === "obsidian") return { ItemView: StubItemView, Modal: StubModal, Notice: class {}, Plugin: StubPlugin, PluginSettingTab: StubSettingTab, Setting: StubSetting, setIcon() {} };
  return originalLoad.call(this, request, parent, isMain);
};
let test;
try { test = require("../main.js").__test; } finally { Module._load = originalLoad; }

function records(count, make) { return Array.from({ length: count }, (_, index) => ({ status: "active", ...make(index) })); }
const state = Object.fromEntries(test.RECORD_TYPES.map((type) => [type, []]));
state.operations = [];
state.conflicts = [];
state.imports = [];
state.member = records(3, (i) => ({ id: `member-${i}`, name: `成员${i}` }));
state.inventory_batch = records(62, (i) => ({ id: `batch-${i}`, item_entity_id: `ingredient-${i}`, ingredient_id: `ingredient-${i}`, ingredient_name: `需求${i}`, available_quantity: 1, unit: "份" }));
state.recipe = records(44, (i) => ({ id: `recipe-${i}`, name: `菜谱${i}` }));
state.meal_slot = records(14, (i) => ({ id: `meal-${i}`, planned_date: "2026-08-15", meal_label: "晚餐" }));
state.dish_plan = records(38, (i) => ({ id: `dish-${i}`, recipe_id: `recipe-${i % 44}`, meal_slot_id: `meal-${i % 14}` }));
state.entity = records(165, (i) => ({ id: `ingredient-${i}`, name: `需求${i}`, entity_kind: "ingredient_item", canonical_unit: "份", unit: "份", tracking_policy: "exact_unit", purchase_group: i < 80 ? "生鲜蔬菜" : "粮油调味" }));
state.purchase_demand = records(165, (i) => ({ id: `demand-${i}`, ingredient_id: `ingredient-${i}`, ingredient_name: `需求${i}`, quantity: 1, unit: "份", status: "open" }));
state.task = records(54, (i) => ({ id: `task-${i}`, title: `采购任务${i}`, category: i < 40 ? "purchase" : "meal_handling", due_at: "2026-08-15T18:00:00", status: i < 4 ? "completed" : "open" }));
const derived = {
  ready: [],
  adapted: [],
  adaptable: [{ id: "dish-adaptable", recipe_id: "recipe-0", status: "adaptable", missing: ["需求0"] }],
  at_risk: [],
  blocked: [],
  dish_states: state.dish_plan,
  pending_decisions: [],
  recovery_count: 0,
};
const dashboard = test.buildFamilySystemViewModel(state, derived, { now: new Date("2026-08-14T08:00:00Z") });

assert.strictEqual(dashboard.members.length, 3);
assert.strictEqual(dashboard.batches.length, 62);
assert.strictEqual(dashboard.inventory_summary.length, 62);
assert.strictEqual(dashboard.inventory_summary_all.length, 165);
assert.strictEqual(dashboard.inventory_summary[0].batch_count, 1);
assert.strictEqual(dashboard.recipes.length, 44);
assert.strictEqual(dashboard.future_meals.length, 14);
assert.strictEqual(derived.dish_states.length, 38);
assert.strictEqual(dashboard.demands.length, 165);
assert.strictEqual(dashboard.tasks.length, 54);
assert.strictEqual(dashboard.task_categories.length, 3);
assert.deepStrictEqual(dashboard.task_categories.map((item) => item.name), ["采购", "食材处理", "家庭事务"]);
assert.strictEqual(dashboard.tasks[0].category_name, "采购");
assert.strictEqual(dashboard.demands[0].item_name, "需求0");
assert.strictEqual(dashboard.tasks_by_page.completed.length, 4);
assert.strictEqual(dashboard.signals[0].severity, "warning");
assert.match(dashboard.signals[0].detail, /缺料但可继续制作/);
assert.strictEqual(dashboard.purchase_groups[0].group, "生鲜蔬菜");
assert.strictEqual(dashboard.purchase_groups[0].items.length, 80);
assert.strictEqual(dashboard.purchase_groups.find((group) => group.group === "粮油调味").items.length, 85);
const searchedInventory = test.buildFamilySystemViewModel(state, derived, { now: new Date("2026-08-14T08:00:00Z"), inventory_filter: { query: "需求1", group: "生鲜蔬菜", status: "available" } });
assert(searchedInventory.inventory_summary.length > 0);
assert(searchedInventory.inventory_summary.every((item) => item.item_name.includes("需求1") && item.purchase_group === "生鲜蔬菜" && item.status === "available"));
const depletedInventory = test.buildFamilySystemViewModel(state, derived, { now: new Date("2026-08-14T08:00:00Z"), inventory_filter: { query: "", group: "all", status: "depleted" } });
assert.strictEqual(depletedInventory.inventory_summary.length, 103);
assert.deepStrictEqual(Object.keys(test.MODULES), ["overview", "reminder", "diet", "purchase", "finance", "basic", "asset"]);
assert.strictEqual(Object.values(test.MODULES).reduce((sum, module) => sum + module.pages.length, 0), 34);

const menuState = Object.fromEntries(test.RECORD_TYPES.map((type) => [type, []]));
menuState.operations = [];
menuState.conflicts = [];
menuState.imports = [];
menuState.meal_plan = [{
  id: "plan-week", week_start: "2026-08-22", title: "2026-08-22 本周菜单", status: "active",
  handling_instructions: Array.from({ length: 6 }, (_, index) => ({ id: `instruction-${index}`, instruction: `处理说明 ${index + 1}` })),
  handling_actions: Array.from({ length: 6 }, (_, index) => ({
    id: `action-${index}`,
    title: `处理任务 ${index + 1}`,
    scheduled_at: `2026-08-${String(22 + index).padStart(2, "0")}T20:00:00`,
    instruction_ids: [`instruction-${index}`],
    status: "planned",
  })),
}];
menuState.meal_slot = Array.from({ length: 13 }, (_, index) => {
  const dayOffset = index === 0 ? 0 : Math.floor((index + 1) / 2);
  return {
    id: `week-meal-${index}`,
    source_plan_id: "plan-week",
    planned_date: `2026-08-${String(22 + dayOffset).padStart(2, "0")}`,
    meal_label: index === 0 || index % 2 === 0 ? "晚餐" : "午餐",
    note: `餐次处理 ${index + 1}`,
    status: "planned",
  };
});
const weeklyDishStates = Array.from({ length: 34 }, (_, index) => {
  const slot = menuState.meal_slot[index % menuState.meal_slot.length];
  return { id: `week-dish-${index}`, recipe_id: `week-recipe-${index}`, meal_slot_id: slot.id, meal_slot: slot, status: "ready", missing: [] };
});
const weeklyDashboard = test.buildFamilySystemViewModel(menuState, { ready: weeklyDishStates, adapted: [], adaptable: [], at_risk: [], blocked: [], dish_states: weeklyDishStates, pending_decisions: [] }, { now: new Date("2026-08-23T08:00:00Z") });
assert.strictEqual(weeklyDashboard.weekly_menu.days.length, 7);
assert.strictEqual(weeklyDashboard.weekly_menu.days[0].date, "2026-08-22");
assert.strictEqual(weeklyDashboard.weekly_menu.days[0].weekday, "周六");
assert.strictEqual(weeklyDashboard.weekly_menu.days[6].date, "2026-08-28");
assert.strictEqual(weeklyDashboard.weekly_menu.days[6].weekday, "周五");
assert.strictEqual(weeklyDashboard.weekly_menu.default_date, "2026-08-23");
assert.strictEqual(weeklyDashboard.weekly_menu.meal_count, 13);
assert.strictEqual(weeklyDashboard.weekly_menu.dish_count, 34);
assert.strictEqual(weeklyDashboard.weekly_menu.days.reduce((sum, day) => sum + day.handling_actions.length, 0), 6);
assert.strictEqual(weeklyDashboard.weekly_menu.days[0].handling_actions[0].instructions[0].instruction, "处理说明 1");

const rangeState = Object.fromEntries(test.RECORD_TYPES.map((type) => [type, []]));
rangeState.operations = [];
rangeState.conflicts = [];
rangeState.imports = [];
rangeState.meal_plan = [{
  id: "plan-range", range_start: "2028-02-25", range_end: "2028-03-05", title: "跨周菜单草稿", status: "draft",
}];
rangeState.meal_slot = [
  { id: "range-meal-1", source_plan_id: "plan-range", planned_date: "2028-02-29", meal_label: "晚餐", status: "draft" },
  { id: "range-meal-2", source_plan_id: "plan-range", planned_date: "2028-03-01", meal_label: "加餐", generation_status: "gap", status: "draft" },
];
const rangeDashboard = test.buildFamilySystemViewModel(rangeState, {
  ready: [], adapted: [], adaptable: [], at_risk: [], blocked: [], dish_states: [], pending_decisions: [],
}, { now: new Date("2028-02-26T08:00:00Z"), menu_plan_id: "plan-range" });
assert.strictEqual(rangeDashboard.weekly_menu.days.length, 10);
assert.strictEqual(rangeDashboard.weekly_menu.days[4].date, "2028-02-29");
assert.strictEqual(rangeDashboard.weekly_menu.week_groups.length, 2);
assert.strictEqual(rangeDashboard.weekly_menu.week_groups[0].length, 7);
assert.strictEqual(rangeDashboard.weekly_menu.week_groups[1].length, 3);
assert.strictEqual(rangeDashboard.weekly_menu.gap_count, 1);

const migrated = test.normalizeSettings({ theme: "dark", accent: "iris", material: "rain", motion: "reduced", dataRoot: "家庭管理系统/00_系统核心/life-core" });
assert.deepStrictEqual({ theme: migrated.visual.theme, accent: migrated.visual.accent, material: migrated.visual.activeMaterial, motion: migrated.visual.motion }, { theme: "dark", accent: "iris", material: "rain", motion: "reduced" });
assert.strictEqual(Object.prototype.hasOwnProperty.call(migrated, "theme"), false);

console.log(JSON.stringify({ status: "ok", suite: "view-model", scale: { members: 3, items: 62, recipes: 44, meals: 14, dishes: 38, demands: 165, tasks: 54 }, weekly_menu: { days: 7, meals: 13, dishes: 34, handling_actions: 6 }, range_menu: { days: 10, week_groups: 2, leap_day: true, gaps: 1 }, pages: 34 }));
