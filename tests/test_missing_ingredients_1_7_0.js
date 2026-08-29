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
  return operation;
}

function command(state, type, payload, seed, at = "2026-08-25T10:00:00.000Z") {
  return core.commandEnvelope(type, {
    command_id: core.uuidFromSeed(seed),
    household_id: core.active(state.household)[0]?.id || "",
    actor_id: core.uuidFromSeed("actor:missing-ingredient-test"),
    ...payload,
  }, { clock: () => new Date(at) });
}

function planApply(state, type, payload, seed, at) {
  return apply(state, core.planCommand(command(state, type, payload, seed, at), state));
}

function setup() {
  const state = emptyState();
  planApply(state, "initialize-household", { name: "缺料测试家庭" }, "missing:init");
  planApply(state, "add-member", { name: "维护者", role: "maintainer" }, "missing:member");
  const household = core.active(state.household)[0];
  const riceId = core.uuidFromSeed("missing:item:rice");
  const spiceId = core.uuidFromSeed("missing:item:spice");
  [
    { id: riceId, name: "大米", canonical_unit: "克", unit: "克", purchase_group: "米面杂粮" },
    { id: spiceId, name: "香料", canonical_unit: "克", unit: "克", purchase_group: "粮油调味" },
  ].forEach((item) => state.entity.push(core.recordBase("entity", {
    ...item,
    entity_kind: "ingredient_item",
    tracking_policy: "exact_unit",
    status: "active",
  }, { household_id: household.id, recorded_at: "2026-08-25T08:00:00.000Z" })));
  planApply(state, "add-recipe", {
    name: "缺料仍可制作套餐",
    category: "一餐式",
    meal_types: ["晚餐"],
    servings: 3,
    prep_minutes: 20,
    ingredients: [
      { id: riceId, name: "大米", quantity: 100, unit: "克", inventory_policy: "tracked" },
      { id: spiceId, name: "香料", quantity: 10, unit: "克", inventory_policy: "tracked" },
    ],
    steps: ["按现实可用原料完成制作。"],
  }, "missing:recipe");
  planApply(state, "inventory.receive-manual", {
    item_entity_id: riceId,
    quantity: 100,
    unit: "克",
    intake_reason: "opening_balance",
  }, "missing:rice-stock");
  planApply(state, "inventory.receive-manual", {
    item_entity_id: spiceId,
    quantity: 4,
    unit: "克",
    intake_reason: "opening_balance",
  }, "missing:spice-stock");
  const recipe = core.active(state.recipe)[0];
  planApply(state, "schedule-dish", {
    recipe_id: recipe.id,
    planned_date: "2026-08-26",
    meal_label: "晚餐",
    default_purchase_time: "18:00",
  }, "missing:schedule");
  return { state, riceId, spiceId };
}

function testContinueWithoutMissingAndRestore() {
  const { state, spiceId } = setup();
  let dish = core.active(state.dish_plan)[0];
  let derived = core.deriveCurrentOrder(state, new Date("2026-08-25T10:00:00.000Z"));
  assert.strictEqual(derived.blocked.length, 0);
  assert.strictEqual(derived.at_risk.length, 1);
  assert.strictEqual(derived.at_risk[0].missing_requirements.length, 1);
  assert.strictEqual(derived.at_risk[0].missing_requirements[0].missing_quantity, 6);

  const protectedTypes = ["purchase_demand", "task", "receipt", "inventory_batch", "inventory_movement", "finance_transaction", "finance_link"];
  const protectedHashes = Object.fromEntries(protectedTypes.map((type) => [type, core.hashRecordType(state, type)]));
  const operation = planApply(state, "dish.continue-without-missing", {
    dish_plan_id: dish.id,
    expected_revision: dish.revision,
  }, "missing:continue");
  assert(operation.effects.some((item) => item.record_type === "domain_event" && item.record.event_type === "dish.ingredients_omitted"));
  assert(operation.warnings.some((item) => item.includes("采购提醒")));
  assert.deepStrictEqual(operation.invariants, protectedTypes);
  protectedTypes.forEach((type) => assert.strictEqual(core.hashRecordType(state, type), protectedHashes[type], `${type} 不应因缺料继续被改写`));

  const omitted = core.active(state.ingredient_requirement).find((item) => item.ingredient_id === spiceId);
  assert.strictEqual(omitted.status, "omitted");
  assert.strictEqual(omitted.omission_reason, "continued_without_missing");
  dish = core.active(state.dish_plan)[0];
  assert.deepStrictEqual(dish.omitted_requirement_ids, [omitted.id]);
  derived = core.deriveCurrentOrder(state, new Date("2026-08-25T10:00:00.000Z"));
  assert.strictEqual(derived.adapted.length, 1);
  assert.deepStrictEqual(derived.adapted[0].omitted, ["香料"]);

  const repeated = core.planCommand(command(state, "dish.continue-without-missing", {
    dish_plan_id: dish.id,
    expected_revision: dish.revision,
  }, "missing:continue:repeated"), state);
  assert.strictEqual(repeated.effects.length, 0);

  const staleRevision = dish.revision;
  planApply(state, "dish.restore-omitted-ingredients", {
    dish_plan_id: dish.id,
    expected_revision: dish.revision,
  }, "missing:restore");
  assert.strictEqual(core.active(state.ingredient_requirement).find((item) => item.id === omitted.id).status, "required");
  assert(core.active(state.domain_event).some((item) => item.event_type === "dish.ingredients_restored"));
  assert.throws(() => core.planCommand(command(state, "dish.continue-without-missing", {
    dish_plan_id: dish.id,
    expected_revision: staleRevision,
  }, "missing:stale"), state), /版本冲突/);
}

function testCompletionSkipsOmittedRequirementsAndKeepsPurchases() {
  const { state, riceId, spiceId } = setup();
  let dish = core.active(state.dish_plan)[0];
  const slot = core.active(state.meal_slot)[0];
  const purchaseHash = core.hashRecordType(state, "purchase_demand");
  const taskHash = core.hashRecordType(state, "task");
  planApply(state, "dish.continue-without-missing", {
    dish_plan_id: dish.id,
    expected_revision: dish.revision,
  }, "missing:complete:continue");
  const spiceBatchBefore = core.active(state.inventory_batch).find((item) => item.item_entity_id === spiceId).available_quantity;
  const operation = planApply(state, "meal.complete", {
    meal_slot_id: slot.id,
    expected_revision: slot.revision,
  }, "missing:complete");

  assert.strictEqual(core.active(state.meal_slot)[0].status, "completed");
  assert.strictEqual(core.active(state.dish_plan)[0].status, "completed");
  assert.strictEqual(core.active(state.ingredient_requirement).find((item) => item.ingredient_id === riceId).status, "consumed");
  assert.strictEqual(core.active(state.ingredient_requirement).find((item) => item.ingredient_id === spiceId).status, "omitted");
  assert.strictEqual(core.active(state.inventory_batch).find((item) => item.item_entity_id === spiceId).available_quantity, spiceBatchBefore);
  assert(!core.active(state.inventory_movement).some((item) => item.item_entity_id === spiceId && item.movement_kind === "meal_consumption_out"));
  assert(!core.active(state.decision_request).some((item) => item.subject_id === spiceId && item.decision_type === "inventory_shortfall_after_meal"));
  assert.strictEqual(core.hashRecordType(state, "purchase_demand"), purchaseHash);
  assert.strictEqual(core.hashRecordType(state, "task"), taskHash);
  const completedEvent = operation.effects.find((item) => item.record_type === "domain_event" && item.record.event_type === "meal.completed")?.record;
  assert.deepStrictEqual(completedEvent.payload.omitted_ingredients.map((item) => item.ingredient_name), ["香料"]);
  dish = core.active(state.dish_plan)[0];
  assert.throws(() => core.planCommand(command(state, "dish.restore-omitted-ingredients", {
    dish_plan_id: dish.id,
    expected_revision: dish.revision,
  }, "missing:restore:completed"), state), /已完成/);
}

function testWeeklySettlementUsesOmissions() {
  const { state, spiceId } = setup();
  let dish = core.active(state.dish_plan)[0];
  const slot = core.active(state.meal_slot)[0];
  planApply(state, "meal-plan.create", { week_start: "2026-08-22", title: "缺料结算测试" }, "missing:plan");
  let plan = core.active(state.meal_plan)[0];
  dish.source_plan_id = plan.id;
  slot.source_plan_id = plan.id;
  planApply(state, "meal-plan.activate", { id: plan.id, expected_revision: plan.revision }, "missing:plan:activate");
  dish = core.active(state.dish_plan)[0];
  planApply(state, "dish.continue-without-missing", { dish_plan_id: dish.id, expected_revision: dish.revision }, "missing:settle:continue");
  plan = core.active(state.meal_plan)[0];
  planApply(state, "meal-plan.settle", {
    id: plan.id,
    expected_revision: plan.revision,
    outcomes: [{ meal_slot_id: slot.id, expected_revision: slot.revision, outcome: "completed" }],
  }, "missing:settle");
  assert.strictEqual(core.active(state.meal_plan)[0].status, "completed");
  assert.strictEqual(core.active(state.ingredient_requirement).find((item) => item.ingredient_id === spiceId).status, "omitted");
  assert(!core.active(state.decision_request).some((item) => item.subject_id === spiceId));
}

testContinueWithoutMissingAndRestore();
testCompletionSkipsOmittedRequirementsAndKeepsPurchases();
testWeeklySettlementUsesOmissions();

console.log(JSON.stringify({ status: "ok", suite: "missing-ingredients-1.7.0", assertions: 35 }));
