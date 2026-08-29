"use strict";

const assert = require("assert");
const core = require("../src/core");

function emptyState() {
  const state = Object.fromEntries(core.RECORD_TYPES.map((type) => [type, []]));
  state.operations = [];
  state.conflicts = [];
  state.imports = [];
  return state;
}

function apply(state, operation) {
  operation.effects.forEach((item) => {
    const list = state[item.record_type];
    const index = list.findIndex((record) => record.id === item.record.id);
    const previous = index >= 0 ? list[index] : null;
    const next = { ...item.record, revision: (previous?.revision || 0) + 1 };
    if (index >= 0) list[index] = next;
    else list.push(next);
  });
  return state;
}

function command(state, type, payload, seed, at = "2026-08-24T10:00:00.000Z") {
  const household = core.active(state.household)[0];
  return core.commandEnvelope(type, {
    command_id: core.uuidFromSeed(seed),
    household_id: household?.id || payload.household_id || "",
    actor_id: core.uuidFromSeed("actor:maintainer"),
    ...payload,
  }, { clock: () => new Date(at) });
}

function planApply(state, type, payload, seed, at) {
  const operation = core.planCommand(command(state, type, payload, seed, at), state);
  apply(state, operation);
  return operation;
}

function initializedState() {
  const state = emptyState();
  planApply(state, "initialize-household", { name: "测试家庭" }, "init");
  planApply(state, "add-member", { name: "成员", role: "maintainer" }, "member");
  return state;
}

function addEntity(state, values) {
  const household = core.active(state.household)[0];
  const entity = core.recordBase("entity", {
    id: values.id,
    entity_kind: "ingredient_item",
    name: values.name,
    category: "食品",
    canonical_unit: values.unit,
    unit: values.unit,
    purchase_group: values.purchase_group || "粮油调味",
    tracking_policy: values.tracking_policy || "exact_unit",
    package_conversions: values.package_conversions || [],
    status: "active",
  }, { household_id: household.id, recorded_at: "2026-08-24T08:00:00.000Z" });
  state.entity.push(entity);
  return entity;
}

function addRecipe(state, values, seed) {
  planApply(state, "add-recipe", {
    name: values.name,
    category: "主菜",
    meal_types: ["午餐", "晚餐"],
    servings: 3,
    prep_minutes: 20,
    ingredients: values.ingredients,
    tags: [],
    allergen_tags: [],
    steps: ["完成烹饪。"],
  }, seed);
  return core.active(state.recipe).find((item) => item.name === values.name);
}

function testMealCompletionAggregatesAndNeverGoesNegative() {
  const state = initializedState();
  const rice = addEntity(state, { id: core.uuidFromSeed("item:rice"), name: "大米", unit: "克", purchase_group: "米面杂粮" });
  const salt = addEntity(state, { id: core.uuidFromSeed("item:salt"), name: "盐", unit: "克" });
  const waterId = core.uuidFromSeed("item:water-untracked");
  const recipe = addRecipe(state, {
    name: "米饭套餐",
    ingredients: [
      { id: rice.id, name: "大米", quantity: 150, unit: "克", inventory_policy: "tracked" },
      { id: salt.id, name: "盐", quantity: 5, unit: "克", inventory_policy: "tracked" },
      { id: waterId, name: "清水", quantity: 300, unit: "毫升", inventory_policy: "untracked_consumable" },
    ],
  }, "recipe:meal-completion");
  const sideRecipe = addRecipe(state, {
    name: "米饼",
    ingredients: [{ id: rice.id, name: "大米", quantity: 0.025, unit: "千克", inventory_policy: "tracked" }],
  }, "recipe:meal-completion:side");
  planApply(state, "inventory.receive-manual", { item_entity_id: rice.id, quantity: 100, unit: "克", intake_reason: "opening_balance" }, "intake:rice:old", "2026-08-24T08:00:00.000Z");
  planApply(state, "inventory.receive-manual", { item_entity_id: rice.id, quantity: 100, unit: "克", intake_reason: "manual_purchase" }, "intake:rice:new", "2026-08-24T09:00:00.000Z");
  planApply(state, "schedule-dish", { recipe_id: recipe.id, planned_date: "2026-08-24", meal_label: "晚餐" }, "schedule:meal-completion");
  const slot = core.active(state.meal_slot)[0];
  planApply(state, "schedule-dish", { recipe_id: sideRecipe.id, meal_slot_id: slot.id, planned_date: "2026-08-24", meal_label: "晚餐" }, "schedule:meal-completion:side");
  const operation = planApply(state, "meal.complete", { meal_slot_id: slot.id, expected_revision: slot.revision }, "complete:meal");
  const batches = core.active(state.inventory_batch).filter((item) => item.item_entity_id === rice.id).sort((left, right) => left.recorded_at.localeCompare(right.recorded_at));
  assert.deepStrictEqual(batches.map((item) => item.available_quantity), [0, 25]);
  assert.strictEqual(core.active(state.meal_slot)[0].status, "completed");
  assert(core.active(state.dish_plan).every((item) => item.status === "completed"));
  assert(core.active(state.ingredient_requirement).every((item) => item.status === "consumed"));
  assert.strictEqual(core.active(state.inventory_movement).filter((item) => item.movement_kind === "meal_consumption_out").length, 2);
  assert(!core.active(state.inventory_movement).some((item) => item.item_entity_id === waterId));
  const shortfall = core.active(state.decision_request).find((item) => item.decision_type === "inventory_shortfall_after_meal");
  assert(shortfall);
  assert.deepStrictEqual([shortfall.subject_id, shortfall.missing_quantity, shortfall.unit], [salt.id, 5, "克"]);
  assert(operation.warnings.some((item) => item.includes("盐")));
  assert(core.active(state.inventory_batch).every((item) => Number(item.available_quantity) >= 0));
  const repeated = core.planCommand(command(state, "meal.complete", { meal_slot_id: slot.id, expected_revision: core.active(state.meal_slot)[0].revision }, "complete:meal:again"), state);
  assert.strictEqual(repeated.effects.length, 0);
}

function testWeeklySettlementCompletesAndSkipsExplicitly() {
  const state = initializedState();
  const rice = addEntity(state, { id: core.uuidFromSeed("item:settle-rice"), name: "杂粮", unit: "克", purchase_group: "米面杂粮" });
  const recipe = addRecipe(state, { name: "杂粮饭", ingredients: [{ id: rice.id, name: "杂粮", quantity: 100, unit: "克", inventory_policy: "tracked" }] }, "recipe:settle");
  planApply(state, "inventory.receive-manual", { item_entity_id: rice.id, quantity: 300, unit: "克", intake_reason: "opening_balance" }, "intake:settle");
  planApply(state, "meal-plan.create", { week_start: "2026-08-22", title: "结算测试" }, "plan:settle");
  let plan = core.active(state.meal_plan)[0];
  planApply(state, "schedule-dish", { meal_plan_id: plan.id, recipe_id: recipe.id, planned_date: "2026-08-22", meal_label: "晚餐" }, "schedule:settle:first");
  const firstSlot = core.active(state.meal_slot)[0];
  planApply(state, "schedule-dish", { meal_plan_id: plan.id, meal_slot_id: undefined, recipe_id: recipe.id, planned_date: "2026-08-23", meal_label: "午餐" }, "schedule:settle:second");
  const secondSlot = core.active(state.meal_slot).find((item) => item.id !== firstSlot.id);
  plan = core.active(state.meal_plan)[0];
  planApply(state, "meal-plan.activate", { id: plan.id, expected_revision: plan.revision }, "activate:settle");
  plan = core.active(state.meal_plan)[0];
  const partial = planApply(state, "meal-plan.settle", {
    id: plan.id,
    expected_revision: plan.revision,
    outcomes: [
      { meal_slot_id: firstSlot.id, expected_revision: firstSlot.revision, outcome: "completed" },
      { meal_slot_id: secondSlot.id, expected_revision: secondSlot.revision, outcome: "leave" },
    ],
  }, "settle:week:partial");
  assert.strictEqual(core.active(state.meal_plan)[0].status, "active");
  assert.deepStrictEqual(core.active(state.meal_slot).map((item) => item.status).sort(), ["completed", "planned"]);
  assert(partial.effects.some((item) => item.record_type === "domain_event" && item.record.event_type === "meal_plan.settled"));
  plan = core.active(state.meal_plan)[0];
  const operation = planApply(state, "meal-plan.settle", {
    id: plan.id,
    expected_revision: plan.revision,
    outcomes: [{ meal_slot_id: secondSlot.id, expected_revision: core.active(state.meal_slot).find((item) => item.id === secondSlot.id).revision, outcome: "skipped" }],
  }, "settle:week:final");
  assert.strictEqual(core.active(state.meal_plan)[0].status, "completed");
  assert.deepStrictEqual(core.active(state.meal_slot).map((item) => item.status).sort(), ["completed", "skipped"]);
  assert.strictEqual(core.active(state.inventory_batch)[0].available_quantity, 200);
  assert(operation.effects.some((item) => item.record_type === "domain_event" && item.record.event_type === "meal_plan.settled"));
  const repeated = core.planCommand(command(state, "meal-plan.settle", { id: plan.id, expected_revision: core.active(state.meal_plan)[0].revision, outcomes: [] }, "settle:week:again"), state);
  assert.strictEqual(repeated.effects.length, 0);
}

function testManualInventoryAdmissionAndConsumptionBoundary() {
  const state = initializedState();
  const operation = planApply(state, "inventory.receive-manual", {
    new_item: { name: "厨房纸", canonical_unit: "卷", purchase_group: "日用清洁", tracking_policy: "exact_unit" },
    quantity: 3,
    unit: "卷",
    intake_reason: "gift",
    note: "亲友赠送",
  }, "intake:new-item");
  assert(operation.effects.some((item) => item.record_type === "entity"));
  assert.strictEqual(core.active(state.inventory_batch)[0].available_quantity, 3);
  assert.strictEqual(core.active(state.inventory_movement)[0].movement_kind, "manual_intake");
  ["purchase_demand", "receipt", "task", "finance_transaction"].forEach((type) => assert.strictEqual(core.active(state[type]).length, 0));
  assert.throws(() => core.planCommand(command(state, "inventory.receive-manual", {
    new_item: { name: "厨房纸", canonical_unit: "卷", purchase_group: "日用清洁", tracking_policy: "exact_unit" },
    quantity: 1,
    unit: "卷",
    intake_reason: "manual_purchase",
  }, "intake:duplicate"), state), /物品已存在/);
  const item = core.active(state.entity)[0];
  assert.throws(() => core.planCommand(command(state, "inventory.receive-manual", {
    item_entity_id: item.id,
    quantity: 1,
    unit: "箱",
    intake_reason: "manual_purchase",
  }, "intake:unknown-package"), state), /没有换算关系/);
}

testMealCompletionAggregatesAndNeverGoesNegative();
testWeeklySettlementCompletesAndSkipsExplicitly();
testManualInventoryAdmissionAndConsumptionBoundary();

console.log(JSON.stringify({ status: "ok", suite: "usability-1.5.0", assertions: 37 }));
