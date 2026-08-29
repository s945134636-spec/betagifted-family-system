"use strict";

const assert = require("assert");
const core = require("../src/core");

const state = Object.fromEntries(core.RECORD_TYPES.map((type) => [type, []]));
state.operations = [];
state.conflicts = [];
state.imports = [];
const householdId = core.uuidFromSeed("auto-menu:household");
const at = "2028-02-01T00:00:00.000Z";

function add(type, seed, values) {
  const record = core.recordBase(type, { id: core.uuidFromSeed(`auto-menu:${seed}`), ...(values || {}) }, { household_id: householdId, recorded_at: at });
  state[type].push(record);
  return record;
}

function ingredient(item, quantity = 100) {
  return { id: item.id, item_entity_id: item.id, name: item.name, quantity, unit: item.canonical_unit, specificity: "general", inventory_policy: "tracked" };
}

function recipe(seed, name, category, prepMinutes, item, options = {}) {
  return add("recipe", `recipe:${seed}`, {
    name,
    category,
    meal_types: options.meal_types || ["午餐", "晚餐"],
    servings: 2,
    prep_minutes: prepMinutes,
    ingredients: [ingredient(item, options.quantity || 100)],
    tags: options.tags || [category],
    allergen_tags: options.allergen_tags || [],
    steps: ["完成制作"],
    status: "active",
  });
}

function command(type, payload, seed) {
  return core.commandEnvelope(type, {
    ...payload,
    command_id: core.uuidFromSeed(`auto-menu:command:${seed}`),
    household_id: householdId,
    actor_id: member.id,
  }, { clock: () => new Date(at) });
}

const member = add("member", "member", { name: "成员甲", role: "member", status: "active" });
const rice = add("entity", "item:rice", { name: "米", entity_kind: "ingredient_item", canonical_unit: "克", purchase_group: "米面杂粮", status: "active" });
const chicken = add("entity", "item:chicken", { name: "鸡肉", entity_kind: "ingredient_item", canonical_unit: "克", purchase_group: "肉禽蛋", status: "active" });
const tofu = add("entity", "item:tofu", { name: "豆腐", entity_kind: "ingredient_item", canonical_unit: "克", purchase_group: "乳品豆制品", status: "active" });
const greens = add("entity", "item:greens", { name: "青菜", entity_kind: "ingredient_item", canonical_unit: "克", purchase_group: "生鲜蔬菜", status: "active" });
const peanuts = add("entity", "item:peanut", { name: "花生", entity_kind: "ingredient_item", canonical_unit: "克", purchase_group: "干货罐装", status: "active" });

const stockedSlowMain = recipe("stocked-main", "库存慢炖鸡", "主菜", 90, chicken);
const fastMain = recipe("fast-main", "快手豆腐", "主菜", 10, tofu);
recipe("side", "清炒青菜", "配菜", 15, greens);
recipe("staple", "米饭", "主食", 30, rice);
recipe("one", "鸡肉焖饭", "一餐式", 35, chicken);
recipe("soup", "青菜汤", "汤羹", 20, greens);
const forbidden = recipe("forbidden", "花生鸡丁", "主菜", 20, peanuts, { allergen_tags: ["花生"] });
recipe("breakfast", "早餐粥", "一餐式", 20, rice, { meal_types: ["早餐"] });
add("health_constraint", "constraint", { member_id: member.id, constraint_kind: "allergy", target: "花生", label: "花生过敏", effect_level: "hard_constraint", status: "active" });
add("inventory_batch", "stock:chicken", { ingredient_id: chicken.id, item_entity_id: chicken.id, ingredient_name: chicken.name, quantity: 5000, available_quantity: 5000, unit: "克", status: "available" });

const common = {
  range_start: "2028-02-28",
  range_end: "2028-03-01",
  participant_ids: [member.id],
  guest_count: 2,
  default_serving_count: 3,
  meal_types: ["午餐", "晚餐"],
  avoid_repeat_days: 0,
  generation_seed: "stable-seed",
  daily_meal_overrides: { "2028-02-29": ["早餐"] },
  serving_overrides: { "2028-03-01|晚餐": 5 },
};

const balanced = core.planCommand(command("meal-plan.generate-draft", { ...common, generation_strategy: "balanced" }, "balanced"), state);
const records = balanced.effects.map((item) => item.record);
const plan = records.find((item) => item.record_type === "meal_plan");
const slots = records.filter((item) => item.record_type === "meal_slot");
const dishes = records.filter((item) => item.record_type === "dish_plan");
const requirements = records.filter((item) => item.record_type === "ingredient_requirement");
assert.deepStrictEqual(core.mealPlanRange(plan), { start: "2028-02-28", end: "2028-03-01" });
assert.strictEqual(slots.length, 5);
assert.strictEqual(slots.find((item) => item.planned_date === "2028-02-29").meal_label, "早餐");
assert.strictEqual(slots.find((item) => item.planned_date === "2028-03-01" && item.meal_label === "晚餐").serving_count, 5);
assert(!dishes.some((item) => item.recipe_id === forbidden.id));
assert.strictEqual(balanced.effects.some((item) => ["purchase_demand", "task", "receipt", "inventory_movement"].includes(item.record_type)), false);
const threeServingRequirement = requirements.find((item) => {
  const dish = dishes.find((candidate) => candidate.id === item.dish_plan_id);
  return dish?.target_servings === 3 && item.ingredient_id === rice.id;
});
assert(threeServingRequirement);
assert.strictEqual(threeServingRequirement.quantity, 150);

const deterministic = core.planCommand(command("meal-plan.generate-draft", { ...common, generation_strategy: "balanced" }, "deterministic"), state);
assert.deepStrictEqual(
  deterministic.effects.filter((item) => item.record_type === "dish_plan").map((item) => item.record.recipe_id),
  dishes.map((item) => item.recipe_id)
);

const inventoryFirst = core.planCommand(command("meal-plan.generate-draft", {
  ...common,
  range_start: "2028-03-02",
  range_end: "2028-03-02",
  daily_meal_overrides: {},
  serving_overrides: {},
  meal_types: ["晚餐"],
  generation_strategy: "inventory_first",
}, "inventory"), state);
assert(inventoryFirst.effects.some((item) => item.record_type === "dish_plan" && item.record.recipe_id === stockedSlowMain.id));

const timeFirst = core.planCommand(command("meal-plan.generate-draft", {
  ...common,
  range_start: "2028-03-03",
  range_end: "2028-03-03",
  daily_meal_overrides: {},
  serving_overrides: {},
  meal_types: ["晚餐"],
  generation_strategy: "time_first",
}, "time"), state);
assert(timeFirst.effects.some((item) => item.record_type === "dish_plan" && item.record.recipe_id === fastMain.id));

const gap = core.planCommand(command("meal-plan.generate-draft", {
  ...common,
  range_start: "2028-03-04",
  range_end: "2028-03-04",
  daily_meal_overrides: {},
  serving_overrides: {},
  meal_types: ["加餐"],
}, "gap"), state);
const gapSlot = gap.effects.find((item) => item.record_type === "meal_slot").record;
assert.strictEqual(gapSlot.generation_status, "gap");
assert.match(gapSlot.generation_message, /没有同时满足/);

const draftState = { ...state };
core.RECORD_TYPES.forEach((type) => { draftState[type] = [...state[type], ...records.filter((item) => item.record_type === type)]; });
const lockedSlot = draftState.meal_slot[0];
const lock = core.planCommand(command("meal-slot.set-lock", { id: lockedSlot.id, expected_revision: lockedSlot.revision, locked: true }, "lock"), draftState);
draftState.meal_slot = draftState.meal_slot.map((item) => item.id === lockedSlot.id ? lock.effects[0].record : item);
const regenerate = core.planCommand(command("meal-plan.regenerate", { id: plan.id, expected_revision: plan.revision }, "regenerate"), draftState);
assert.strictEqual(regenerate.effects.some((item) => item.record_type === "meal_slot" && item.record.id === lockedSlot.id), false);
assert.strictEqual(regenerate.effects.some((item) => item.record_type === "dish_plan" && item.record.meal_slot_id === lockedSlot.id), false);

const activationState = { ...state };
core.RECORD_TYPES.forEach((type) => { activationState[type] = [...state[type], ...records.filter((item) => item.record_type === type)]; });
activationState.recipe = activationState.recipe.map((item) => item.id === stockedSlowMain.id
  ? { ...item, ingredients: item.ingredients.map((source) => ({ ...source, quantity: 200 })) }
  : item);
activationState.meal_plan.push(core.recordBase("meal_plan", {
  id: core.uuidFromSeed("auto-menu:non-overlap"), title: "不重叠菜单", range_start: "2028-03-10", range_end: "2028-03-12", week_start: "2028-03-10", status: "active",
}, { household_id: householdId, recorded_at: at }));
const activation = core.planCommand(command("meal-plan.activate", { id: plan.id, expected_revision: plan.revision }, "activate"), activationState);
assert.strictEqual(activation.effects.some((item) => item.record_type === "meal_plan" && item.record.id !== plan.id && item.record.status === "superseded"), false);
const refreshedScaled = activation.effects.find((item) => item.record_type === "ingredient_requirement" && item.record.ingredient_id === chicken.id && item.record.quantity === 300);
assert(refreshedScaled, "激活时必须按当前菜谱和三人目标份数重新冻结 200×3/2=300 克");

const overlappingActive = core.recordBase("meal_plan", {
  id: core.uuidFromSeed("auto-menu:overlap"), title: "重叠菜单", range_start: "2028-03-01", range_end: "2028-03-05", week_start: "2028-03-01", status: "active",
}, { household_id: householdId, recorded_at: at });
draftState.meal_plan.push(overlappingActive);
assert.throws(() => core.planCommand(command("meal-plan.activate", { id: plan.id, expected_revision: plan.revision }, "activate-overlap"), draftState), /日期与活动菜单重叠/);

assert.deepStrictEqual(core.mealPlanRange({ week_start: "2028-03-09" }), { start: "2028-03-09", end: "2028-03-15" });
assert.deepStrictEqual(core.dateRangeInclusive("2028-02-28", "2028-03-01"), ["2028-02-28", "2028-02-29", "2028-03-01"]);

console.log(JSON.stringify({ status: "ok", suite: "auto-menu-2.1.0", slots: slots.length, dishes: dishes.length, requirements: requirements.length }));
