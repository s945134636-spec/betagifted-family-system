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

function command(type, values, state, seed) {
  const household = core.active(state.household)[0];
  return core.commandEnvelope(type, {
    command_id: core.uuidFromSeed(seed || `${type}:${JSON.stringify(values)}`),
    household_id: household?.id || values.household_id || "",
    actor_id: core.uuidFromSeed("actor:maintainer"),
    ...values,
  }, { clock: () => new Date("2026-08-13T10:00:00Z") });
}

function planApply(state, type, values, seed) {
  const operation = core.planCommand(command(type, values, state, seed), state);
  apply(state, operation);
  return operation;
}

function fixtureState() {
  const state = emptyState();
  planApply(state, "initialize-household", { name: "测试家庭" }, "init");
  planApply(state, "add-member", { name: "维护者", role: "maintainer" }, "member:maintainer");
  planApply(state, "add-member", { name: "孩子", role: "member" }, "member:child");
  planApply(state, "add-recipe", {
    name: "清蒸鲈鱼",
    category: "主菜",
    meal_types: ["午餐", "晚餐"],
    servings: 3,
    prep_minutes: 25,
    ingredients: [
      { id: core.uuidFromSeed("ingredient:fish"), name: "鲈鱼", quantity: 1, unit: "条", specificity: "specific", inventory_policy: "tracked" },
      { id: core.uuidFromSeed("ingredient:salt"), name: "盐", quantity: 5, unit: "克", specificity: "general", inventory_policy: "tracked" },
    ],
    tags: ["清淡"],
    allergen_tags: [],
    steps: ["鲈鱼处理干净。", "蒸熟后调味。"],
  }, "recipe:fish");
  return state;
}

function testIdentityAndTimes() {
  const state = fixtureState();
  const member = core.active(state.member)[0];
  assert.deepStrictEqual(core.active(state.task_category).map((item) => item.route_kind).sort(), ["household", "meal_handling", "purchase"]);
  assert.strictEqual(core.active(state.task_category).filter((item) => item.is_default).length, 1);
  assert.match(member.id, /^[0-9a-f-]{36}$/);
  assert.strictEqual(member.recorded_at, "2026-08-13T10:00:00.000Z");
  assert.strictEqual(core.rulePriority({ effect_level: "hard_constraint" }) > core.rulePriority({ effect_level: "soft_preference" }), true);
  assert.throws(() => core.normalizeVaultPath("../outside"), /安全相对路径/);
  assert.strictEqual(core.normalizeVaultRoot("."), ".");
  assert.strictEqual(core.joinVaultPath(".", "01_基础信息系统/家庭资料.md"), "01_基础信息系统/家庭资料.md");
  assert.strictEqual(core.joinVaultPath("家庭管理系统", "01_基础信息系统/家庭资料.md"), "家庭管理系统/01_基础信息系统/家庭资料.md");
  assert.strictEqual(core.isPathWithin("06_事务提醒系统/事务规则.md", "."), true);
  assert.throws(() => core.normalizeVaultRoot("../outside"), /安全相对路径/);
}

function testDiningPlanAndDerivedState() {
  const state = fixtureState();
  const recipe = core.active(state.recipe)[0];
  const operation = planApply(state, "schedule-dish", {
    recipe_id: recipe.id,
    planned_date: "2099-08-17",
    meal_label: "晚餐",
    default_purchase_time: "18:00",
  }, "schedule:fish");
  assert(operation.effects.some((item) => item.record_type === "ingredient_requirement"));
  assert(operation.effects.some((item) => item.record_type === "purchase_demand"));
  assert(operation.effects.some((item) => item.record_type === "task"));
  const derived = core.deriveCurrentOrder(state, new Date("2099-08-16T10:00:00Z"));
  assert.strictEqual(derived.at_risk.length, 1);
  assert.strictEqual(derived.purchase_count, 2);
}

function testHardAndSoftConstraints() {
  const state = fixtureState();
  const child = core.active(state.member).find((item) => item.name === "孩子");
  planApply(state, "add-health-constraint", {
    member_id: child.id,
    constraint_kind: "allergy",
    target: "坚果",
    effect_level: "hard_constraint",
  }, "constraint:nut");
  planApply(state, "add-recipe", {
    name: "坚果拌菜",
    category: "配菜",
    meal_types: ["午餐", "晚餐"],
    servings: 3,
    prep_minutes: 10,
    ingredients: [{ id: core.uuidFromSeed("ingredient:nut"), name: "坚果", quantity: 1, unit: "份", inventory_policy: "tracked" }],
    allergen_tags: ["坚果"],
    steps: ["将食材拌匀。"],
  }, "recipe:nut");
  const recipe = core.active(state.recipe).find((item) => item.name === "坚果拌菜");
  assert.throws(() => core.planCommand(command("schedule-dish", { recipe_id: recipe.id, planned_date: "2099-08-17", meal_label: "晚餐" }, state, "schedule:nut"), state), /硬安全约束/);

  const softState = fixtureState();
  const softMember = core.active(softState.member).find((item) => item.name === "孩子");
  planApply(softState, "add-health-constraint", { member_id: softMember.id, target: "清淡", effect_level: "soft_preference" }, "constraint:soft");
  const fish = core.active(softState.recipe)[0];
  const result = core.planCommand(command("schedule-dish", { recipe_id: fish.id, planned_date: "2099-08-17", meal_label: "晚餐" }, softState, "schedule:soft"), softState);
  assert.strictEqual(result.warnings.length, 1);
}

function testRescheduleMaintainsDomainBoundaries() {
  const state = fixtureState();
  const recipe = core.active(state.recipe)[0];
  planApply(state, "schedule-dish", { recipe_id: recipe.id, planned_date: "2099-08-17", meal_label: "晚餐", default_purchase_time: "18:00" }, "schedule:reschedule");
  const dish = core.active(state.dish_plan)[0];
  assert.throws(() => core.planCommand(command("confirm-missing-and-reschedule", { dish_plan_id: dish.id, confirmed_missing: false, new_date: "2099-08-18" }, state, "reschedule:not-confirmed"), state), /必须由用户确认现实/);
  const inventoryHash = core.hashRecordType(state, "inventory_batch");
  const financeHash = core.hashRecordType(state, "finance_link");
  const operation = planApply(state, "confirm-missing-and-reschedule", {
    dish_plan_id: dish.id,
    confirmed_missing: true,
    new_date: "2099-08-18",
    new_meal_label: "晚餐",
    default_purchase_time: "18:00",
  }, "reschedule:confirmed");
  assert.deepStrictEqual(operation.invariants, ["inventory_batch", "inventory_movement", "finance_link"]);
  assert.strictEqual(core.hashRecordType(state, "inventory_batch"), inventoryHash);
  assert.strictEqual(core.hashRecordType(state, "finance_link"), financeHash);
  assert.strictEqual(core.active(state.dish_plan)[0].meal_slot_id, core.active(state.meal_slot).at(-1).id);
  assert(core.active(state.decision_request).some((item) => item.decision === "reschedule"));
}

function testReceiptInventoryConsumptionAndFinanceBoundary() {
  const state = fixtureState();
  const recipe = core.active(state.recipe)[0];
  planApply(state, "schedule-dish", { recipe_id: recipe.id, planned_date: "2099-08-17", meal_label: "晚餐" }, "schedule:receipt");
  const fishDemand = core.active(state.purchase_demand).find((item) => item.ingredient_name === "鲈鱼");
  planApply(state, "confirm-receipt", { purchase_demand_id: fishDemand.id, quantity: 1, unit: "条", tracking_policy: "exact" }, "receipt:fish");
  const batch = core.active(state.inventory_batch)[0];
  assert.strictEqual(batch.admitted_by_plan, true);
  planApply(state, "record-consumption", { inventory_batch_id: batch.id, quantity: 1, dish_plan_id: core.active(state.dish_plan)[0].id }, "consume:fish");
  assert.strictEqual(core.active(state.inventory_batch)[0].available_quantity, 0);
  assert.strictEqual(core.active(state.dish_plan)[0].status, "planned");

  const beforeInventory = core.hashRecordType(state, "inventory_batch");
  planApply(state, "record-unplanned-purchase", { transaction_id: "txn-unplanned-001", amount: 36 }, "unplanned:finance");
  assert.strictEqual(core.hashRecordType(state, "inventory_batch"), beforeInventory);
  assert.strictEqual(core.active(state.finance_link).at(-1).planned_purchase, false);
}

function testSkipMealKeepsSingleIntent() {
  const state = fixtureState();
  const recipe = core.active(state.recipe)[0];
  planApply(state, "schedule-dish", { recipe_id: recipe.id, planned_date: "2099-08-17", meal_label: "晚餐" }, "schedule:skip");
  const slot = core.active(state.meal_slot)[0];
  const operation = planApply(state, "skip-meal", { meal_slot_id: slot.id }, "skip:meal");
  assert.strictEqual(operation.command.command_type, "skip-meal");
  assert.strictEqual(core.active(state.meal_slot)[0].status, "skipped");
  assert(core.stateList(state, "dish_plan").every((item) => item.status === "skipped"));
}

function testReplaceDishUsesExistingMealSlot() {
  const state = fixtureState();
  planApply(state, "add-recipe", {
    name: "番茄炒蛋",
    category: "主菜",
    meal_types: ["午餐", "晚餐"],
    servings: 3,
    prep_minutes: 15,
    ingredients: [{ id: core.uuidFromSeed("ingredient:tomato"), name: "番茄", quantity: 2, unit: "个", inventory_policy: "tracked" }],
    steps: ["番茄切块，与鸡蛋炒熟。"],
  }, "recipe:tomato");
  const fish = core.active(state.recipe).find((item) => item.name === "清蒸鲈鱼");
  const tomato = core.active(state.recipe).find((item) => item.name === "番茄炒蛋");
  planApply(state, "schedule-dish", { recipe_id: fish.id, planned_date: "2099-08-17", meal_label: "晚餐" }, "schedule:replace");
  const dish = core.active(state.dish_plan)[0];
  const slot = core.active(state.meal_slot)[0];
  const operation = core.planCommand(command("replace-dish", {
    dish_plan_id: dish.id,
    recipe_id: tomato.id,
    meal_slot_id: slot.id,
    planned_date: slot.planned_date,
    meal_label: slot.meal_label,
  }, state, "replace:dish"), state);
  assert.strictEqual(operation.effects.filter((item) => item.record_type === "meal_slot").length, 0);
  apply(state, operation);
  assert.strictEqual(core.active(state.dish_plan).filter((item) => item.status === "planned").length, 1);
}

function testUnitConversionAndGroupedDemandCompatibility() {
  assert.strictEqual(core.convertUnitQuantity(10, "千克", "克"), 10000);
  assert.strictEqual(core.convertUnitQuantity(2, "升", "毫升"), 2000);
  assert.strictEqual(core.convertUnitQuantity(1, "千克", "毫升"), null);
  const ids = [core.uuidFromSeed("requirement:one"), core.uuidFromSeed("requirement:two")];
  assert.deepStrictEqual(core.demandRequirementIds({ requirement_ids: ids }), ids);
  assert.deepStrictEqual(core.demandRequirementIds({ requirement_id: ids[0] }), [ids[0]]);
}

function addIngredientEntity(state, values) {
  const household = core.active(state.household)[0];
  state.entity.push(core.recordBase("entity", {
    id: values.id,
    name: values.name,
    entity_kind: "ingredient",
    unit: values.unit,
    canonical_unit: values.canonical_unit || values.unit,
    purchase_group: values.purchase_group || "粮油调味",
    package_conversions: values.package_conversions || [],
    status: "active",
  }, { household_id: household.id, recorded_at: "2026-08-13T10:00:00.000Z" }));
}

function testFormalDomainCommandsAndIdempotence() {
  const state = fixtureState();
  const assetOperation = planApply(state, "record.create", {
    record_type: "asset",
    record: { name: "冰箱", category: "家电" },
  }, "asset:create");
  const asset = core.active(state.asset)[0];
  assert.strictEqual(assetOperation.status, "prepared");
  planApply(state, "record.update", {
    record_type: "asset",
    id: asset.id,
    expected_revision: asset.revision,
    patch: { location: "厨房" },
  }, "asset:update");
  assert.strictEqual(core.active(state.asset)[0].location, "厨房");
  let currentAsset = core.active(state.asset)[0];
  planApply(state, "record.confirm", { record_type: "asset", id: currentAsset.id, expected_revision: currentAsset.revision }, "asset:confirm");
  currentAsset = core.active(state.asset)[0];
  assert.strictEqual(currentAsset.status, "confirmed");
  planApply(state, "record.archive", { record_type: "asset", id: currentAsset.id, expected_revision: currentAsset.revision }, "asset:archive");
  const archivedAsset = state.asset.find((item) => item.id === currentAsset.id);
  assert.strictEqual(archivedAsset.tombstone, true);
  planApply(state, "record.restore", { record_type: "asset", id: archivedAsset.id, expected_revision: archivedAsset.revision }, "asset:restore");
  currentAsset = core.active(state.asset)[0];
  assert.strictEqual(currentAsset.status, "confirmed");
  planApply(state, "record.void", { record_type: "asset", id: currentAsset.id, expected_revision: currentAsset.revision }, "asset:void");
  assert.strictEqual(core.active(state.asset)[0].status, "void");

  const accountId = core.uuidFromSeed("finance-account:cash");
  planApply(state, "record.create", {
    record_type: "finance_account",
    record: { id: accountId, name: "现金账户", account_type: "cash" },
  }, "finance-account:create");

  const transactionId = core.uuidFromSeed("finance:shared-uuid");
  const transactionValues = {
    transaction_id: transactionId,
    date: "2026-08-22",
    direction: "支出",
    amount: 36,
    account_id: accountId,
    category: "餐饮",
    name: "采购",
    source_key: `finance-transaction:${transactionId}`,
    status: "confirmed",
  };
  planApply(state, "finance.transaction.capture", transactionValues, "finance:first");
  const duplicate = core.planCommand(command("finance.transaction.capture", transactionValues, state, "finance:duplicate"), state);
  assert.strictEqual(duplicate.effects.length, 0);
  assert.strictEqual(core.active(state.finance_transaction).length, 1);
  assert.throws(() => core.planCommand(command("finance.transaction.capture", { ...transactionValues, transaction_id: core.uuidFromSeed("finance:bad-account"), source_key: "finance-transaction:bad-account", account_id: core.uuidFromSeed("finance-account:missing") }, state, "finance:bad-account"), state), /财务账户不存在/);

  planApply(state, "task.create", { title: "家庭事务", source_key: "task:manual-test" }, "task:create");
  assert.strictEqual(core.active(state.task).length, 1);
  const draft = planApply(state, "meal-plan.create", { week_start: "2026-08-22", title: "测试周菜单" }, "meal-plan:create");
  const plan = core.active(state.meal_plan)[0];
  assert(draft.effects.some((item) => item.record_type === "meal_plan"));
  const instructionId = core.uuidFromSeed("test:meal-handling-instruction");
  const actionId = core.uuidFromSeed("test:meal-handling-action");
  planApply(state, "meal-plan.update", { id: plan.id, expected_revision: plan.revision, patch: {
    handling_instructions: [{ id: instructionId, phase: "采购后处理", instruction: "肉类按餐次冷冻分装" }],
    handling_actions: [{ id: actionId, phase: "每晚解冻", title: "移入冷藏解冻", scheduled_at: "2026-08-23T20:00:00", instruction_ids: [instructionId] }],
  } }, "meal-plan:update");
  const updatedPlan = core.active(state.meal_plan)[0];
  assert.strictEqual(updatedPlan.handling_instructions[0].instruction, "肉类按餐次冷冻分装");
  assert.strictEqual(updatedPlan.handling_actions[0].scheduled_at, "2026-08-23T20:00:00");
  const recipe = core.active(state.recipe)[0];
  planApply(state, "schedule-dish", { meal_plan_id: updatedPlan.id, recipe_id: recipe.id, planned_date: "2026-08-22", meal_label: "晚餐" }, "meal-plan:schedule");
  planApply(state, "meal-plan.rebuild-purchases", { id: updatedPlan.id, expected_revision: updatedPlan.revision }, "meal-plan:rebuild");
  assert.strictEqual(core.active(state.purchase_demand).filter((item) => item.source_plan_id === updatedPlan.id).length, 2);
  assert.strictEqual(core.active(state.task).filter((item) => item.source_plan_id === updatedPlan.id).length, 2);
  planApply(state, "meal-plan.rebuild-purchases", { id: updatedPlan.id, expected_revision: updatedPlan.revision }, "meal-plan:rebuild-again");
  assert.strictEqual(core.active(state.purchase_demand).filter((item) => item.source_plan_id === updatedPlan.id).length, 2);
  planApply(state, "meal-plan.activate", { id: updatedPlan.id, expected_revision: updatedPlan.revision }, "meal-plan:activate");
  assert.strictEqual(core.active(state.meal_plan)[0].status, "active");
  let handlingTask = core.active(state.task).find((item) => item.source_type === "meal_handling");
  assert(handlingTask);
  assert.strictEqual(handlingTask.source_key, `task:${handlingTask.id}`);
  assert.strictEqual(handlingTask.notes, "肉类按餐次冷冻分装");
  assert.strictEqual(handlingTask.due_at, "2026-08-23T20:00:00");
  let activePlan = core.active(state.meal_plan)[0];
  planApply(state, "meal-plan.update", { id: activePlan.id, expected_revision: activePlan.revision, patch: {
    handling_actions: [{ ...activePlan.handling_actions[0], scheduled_at: "2026-08-23T19:30:00" }],
  } }, "meal-plan:update-active-action");
  handlingTask = core.active(state.task).find((item) => item.source_type === "meal_handling");
  assert.strictEqual(handlingTask.due_at, "2026-08-23T19:30:00");
  activePlan = core.active(state.meal_plan)[0];
  planApply(state, "meal-plan.update", { id: activePlan.id, expected_revision: activePlan.revision, patch: { handling_actions: [] } }, "meal-plan:remove-action");
  assert.strictEqual(core.active(state.task).filter((item) => item.source_type === "meal_handling").length, 0);
  assert(state.task.some((item) => item.source_type === "meal_handling" && item.status === "cancelled" && item.tombstone));
}

function testAppleProjectionEvidenceBoundaries() {
  const state = fixtureState();
  planApply(state, "task.create", { title: "普通事务", category: "household", source_key: "task:ordinary" }, "task:ordinary");
  const ordinary = core.active(state.task)[0];
  planApply(state, "apple.projection-event", { event_id: core.uuidFromSeed("apple:event:ordinary"), event_type: "completed", task_id: ordinary.id, source_key: ordinary.source_key }, "apple:event:ordinary");
  assert.strictEqual(core.active(state.task)[0].status, "completed");

  const recipe = core.active(state.recipe)[0];
  planApply(state, "schedule-dish", { recipe_id: recipe.id, planned_date: "2099-08-17", meal_label: "晚餐" }, "schedule:apple-purchase");
  const purchase = core.active(state.task).find((item) => item.source_type === "purchase_demand");
  const demand = core.active(state.purchase_demand).find((item) => purchase.source_id === item.id || (purchase.source_ids || []).includes(item.id));
  const eventId = core.uuidFromSeed("apple:event:purchase");
  planApply(state, "apple.projection-event", { event_id: core.uuidFromSeed("apple:event:purchase"), event_type: "completed", task_id: purchase.id, source_key: purchase.source_key }, "apple:event:purchase");
  assert.strictEqual(core.active(state.task).find((item) => item.id === purchase.id).status, "receipt_confirmed");
  assert.strictEqual(core.active(state.purchase_demand).find((item) => item.id === demand.id).status, "fulfilled");
  assert.strictEqual(core.active(state.decision_request).filter((item) => item.decision_type === "purchase_receipt_confirmation").length, 0);
  assert.strictEqual(core.active(state.receipt).length, 1);
  assert.strictEqual(core.active(state.inventory_batch).length, 1);

  const receiptsAfterFirstCompletion = core.hashRecordType(state, "receipt");
  const inventoryAfterFirstCompletion = core.hashRecordType(state, "inventory_batch");
  const repeated = planApply(state, "apple.projection-event", { event_id: eventId, event_type: "completed", task_id: purchase.id, source_key: purchase.source_key }, "apple:event:purchase:repeated-command");
  assert.strictEqual(repeated.effects.length, 0);
  assert.strictEqual(core.hashRecordType(state, "receipt"), receiptsAfterFirstCompletion);
  assert.strictEqual(core.hashRecordType(state, "inventory_batch"), inventoryAfterFirstCompletion);
  const recordedCompletion = state.domain_event.find((item) => item.payload?.event_id === eventId);
  recordedCompletion.tombstone = true;
  recordedCompletion.status = "compensated";
  const repeatedAfterCompensation = planApply(state, "apple.projection-event", { event_id: eventId, event_type: "completed", task_id: purchase.id, source_key: purchase.source_key }, "apple:event:purchase:repeated-after-compensation");
  assert.strictEqual(repeatedAfterCompensation.effects.length, 0);
  assert.strictEqual(core.hashRecordType(state, "receipt"), receiptsAfterFirstCompletion);
  assert.strictEqual(core.hashRecordType(state, "inventory_batch"), inventoryAfterFirstCompletion);

  planApply(state, "apple.projection-event", { event_id: core.uuidFromSeed("apple:event:deleted"), event_type: "deleted", task_id: purchase.id, source_key: purchase.source_key }, "apple:event:deleted");
  assert.strictEqual(core.active(state.task).find((item) => item.id === purchase.id).status, "projection_paused");
  assert.strictEqual(core.active(state.decision_request).filter((item) => item.decision_type === "apple_projection_deleted").length, 1);

  const beforeHandlingInventory = core.hashRecordType(state, "inventory_batch");
  planApply(state, "task.create", { title: "移入冷藏解冻", category: "meal_handling", source_type: "meal_handling", source_key: "task:meal-handling-test" }, "task:meal-handling");
  const handling = core.active(state.task).find((item) => item.source_type === "meal_handling");
  planApply(state, "apple.projection-event", { event_id: core.uuidFromSeed("apple:event:meal-handling"), event_type: "completed", task_id: handling.id, source_key: handling.source_key }, "apple:event:meal-handling");
  assert.strictEqual(core.active(state.task).find((item) => item.id === handling.id).status, "completed");
  assert.strictEqual(core.hashRecordType(state, "inventory_batch"), beforeHandlingInventory);
  assert.strictEqual(core.active(state.receipt).length, 1);
}

function testBatchReceiptAndPackageConversion() {
  const state = fixtureState();
  const fishId = core.uuidFromSeed("ingredient:fish");
  const saltId = core.uuidFromSeed("ingredient:salt");
  addIngredientEntity(state, { id: fishId, name: "鲈鱼", unit: "条", purchase_group: "水产海鲜" });
  addIngredientEntity(state, { id: saltId, name: "盐", unit: "克", purchase_group: "粮油调味" });
  const recipe = core.active(state.recipe)[0];
  planApply(state, "schedule-dish", { recipe_id: recipe.id, planned_date: "2099-08-17", meal_label: "晚餐" }, "schedule:batch-receipt");
  const demands = core.active(state.purchase_demand);
  planApply(state, "confirm-receipts-batch", {
    items: demands.map((item) => ({ purchase_demand_id: item.id, quantity: item.quantity, unit: item.unit })),
  }, "receipt:batch");
  assert.strictEqual(core.active(state.receipt).length, 2);
  assert.strictEqual(core.active(state.inventory_batch).length, 2);
  assert(core.active(state.task).filter((item) => item.source_type === "purchase_demand").every((item) => item.status === "receipt_confirmed"));

  const oilState = fixtureState();
  const oilId = core.uuidFromSeed("ingredient:oil");
  addIngredientEntity(oilState, {
    id: oilId,
    name: "食用油",
    unit: "毫升",
    canonical_unit: "毫升",
    package_conversions: [{ unit: "壶", canonical_quantity: 5, canonical_unit: "升" }],
  });
  const household = core.active(oilState.household)[0];
  const demand = core.recordBase("purchase_demand", {
    id: core.uuidFromSeed("demand:oil"),
    ingredient_id: oilId,
    ingredient_name: "食用油",
    quantity: 5000,
    unit: "毫升",
    planned_admission: true,
    source_key: "diet-health:test:oil",
    status: "planned",
  }, { household_id: household.id, recorded_at: "2026-08-13T10:00:00.000Z" });
  oilState.purchase_demand.push(demand);
  planApply(oilState, "confirm-receipt", { purchase_demand_id: demand.id, quantity: 1, unit: "壶" }, "receipt:oil-package");
  const oilReceipt = core.active(oilState.receipt)[0];
  const oilBatch = core.active(oilState.inventory_batch)[0];
  assert.deepStrictEqual([oilReceipt.quantity, oilReceipt.unit, oilReceipt.normalized_quantity, oilReceipt.normalized_unit], [1, "壶", 5000, "毫升"]);
  assert.deepStrictEqual([oilBatch.quantity, oilBatch.unit, oilBatch.display_quantity, oilBatch.display_unit], [5000, "毫升", 1, "壶"]);

  const unknownState = fixtureState();
  addIngredientEntity(unknownState, { id: oilId, name: "食用油", unit: "毫升", canonical_unit: "毫升" });
  const unknownHousehold = core.active(unknownState.household)[0];
  unknownState.purchase_demand.push(core.recordBase("purchase_demand", { ...demand, id: core.uuidFromSeed("demand:unknown-oil"), status: "planned" }, { household_id: unknownHousehold.id, recorded_at: "2026-08-13T10:00:00.000Z" }));
  assert.throws(() => core.planCommand(command("confirm-receipts-batch", {
    items: [{ purchase_demand_id: core.uuidFromSeed("demand:unknown-oil"), quantity: 1, unit: "瓶" }],
  }, unknownState, "receipt:unknown-package"), unknownState), /没有换算关系/);
}

function testRecipeUpdatePreservesScheduledFacts() {
  const state = fixtureState();
  const recipe = core.active(state.recipe)[0];
  planApply(state, "schedule-dish", { recipe_id: recipe.id, planned_date: "2099-08-17", meal_label: "晚餐" }, "schedule:recipe-before-edit");
  const protectedTypes = ["dish_plan", "ingredient_requirement", "purchase_demand", "task", "receipt", "inventory_batch", "inventory_movement"];
  const beforeHashes = Object.fromEntries(protectedTypes.map((type) => [type, core.hashRecordType(state, type)]));
  const originalIdentity = { id: recipe.id, schema: recipe.schema, created_at: recipe.created_at };
  const operation = planApply(state, "recipe.update", {
    id: recipe.id,
    expected_revision: recipe.revision,
    patch: {
      name: "清蒸鲈鱼（少盐）",
      category: "主菜",
      meal_types: ["晚餐", "午餐", "晚餐"],
      servings: 3,
      prep_minutes: 28,
      ingredients: recipe.ingredients.map((item, index) => ({ ...item, quantity: index === 0 ? 2 : item.quantity })),
      tags: ["清淡", "家常", "清淡"],
      allergen_tags: [],
      steps: [" 鲈鱼处理干净。 ", "", "蒸熟后少量调味。"],
    },
  }, "recipe:update");
  assert.deepStrictEqual(operation.invariants, protectedTypes);
  assert(operation.effects.some((item) => item.record_type === "domain_event" && item.record.event_type === "recipe.updated" && item.record.payload.affects_existing_meals === false));
  protectedTypes.forEach((type) => assert.strictEqual(core.hashRecordType(state, type), beforeHashes[type], `${type} 不应被菜谱编辑追溯改写`));
  const updated = core.active(state.recipe).find((item) => item.id === recipe.id);
  assert.deepStrictEqual({ id: updated.id, schema: updated.schema, created_at: updated.created_at }, originalIdentity);
  assert.deepStrictEqual(updated.meal_types, ["晚餐", "午餐"]);
  assert.deepStrictEqual(updated.tags, ["清淡", "家常"]);
  assert.deepStrictEqual(updated.steps, ["鲈鱼处理干净。", "蒸熟后少量调味。"]);
  assert.strictEqual(core.active(state.ingredient_requirement).find((item) => item.ingredient_name === "鲈鱼").quantity, 1);
  planApply(state, "schedule-dish", { recipe_id: updated.id, planned_date: "2099-08-18", meal_label: "晚餐" }, "schedule:recipe-after-edit");
  const laterSlot = core.active(state.meal_slot).find((item) => item.planned_date === "2099-08-18");
  assert.strictEqual(core.active(state.ingredient_requirement).find((item) => item.meal_slot_id === laterSlot.id && item.ingredient_name === "鲈鱼").quantity, 2);
  assert.throws(() => core.planCommand(command("recipe.update", { id: updated.id, expected_revision: recipe.revision, patch: { ...updated } }, state, "recipe:conflict"), state), /版本冲突/);
  assert.throws(() => core.planCommand(command("recipe.update", { id: updated.id, expected_revision: updated.revision, patch: { steps: [] } }, state, "recipe:no-steps"), state), /制作步骤/);
}

function testTaskDeletionPreservesLinkedFactsAndHandlesAppleRace() {
  const state = fixtureState();
  planApply(state, "task.create", {
    title: "缴纳物业费",
    category: "household",
    source_key: "task:property-fee",
  }, "task:property-fee");
  const task = core.active(state.task).find((item) => item.source_key === "task:property-fee");
  assert.throws(() => core.planCommand(command("task.delete", {
    id: task.id,
    expected_revision: task.revision + 1,
  }, state, "task:delete:conflict"), state), /版本冲突/);
  const protectedTypes = ["purchase_demand", "receipt", "inventory_batch", "inventory_movement", "finance_transaction"];
  const before = Object.fromEntries(protectedTypes.map((type) => [type, core.hashRecordType(state, type)]));
  const operation = planApply(state, "task.delete", {
    id: task.id,
    expected_revision: task.revision,
  }, "task:delete");
  assert.deepStrictEqual(operation.invariants, protectedTypes);
  const deleted = core.stateList(state, "task").find((item) => item.id === task.id);
  assert.strictEqual(deleted.tombstone, true);
  assert.strictEqual(deleted.status, "cancelled");
  assert.strictEqual(deleted.previous_status, "open");
  assert.strictEqual(core.active(state.task).some((item) => item.id === task.id), false);
  assert(core.active(state.domain_event).some((item) => item.event_type === "task.deleted" && item.aggregate_id === task.id));
  protectedTypes.forEach((type) => assert.strictEqual(core.hashRecordType(state, type), before[type], `${type} 不应被事务删除反向改写`));

  planApply(state, "apple.projection-event", {
    event_id: core.uuidFromSeed("apple:event:completed-after-delete"),
    event_type: "completed",
    task_id: task.id,
    source_key: task.source_key,
  }, "apple:event:completed-after-delete");
  assert.strictEqual(core.active(state.decision_request).filter((item) => item.decision_type === "apple_completion_after_task_deleted").length, 1);
  protectedTypes.forEach((type) => assert.strictEqual(core.hashRecordType(state, type), before[type], `${type} 不应由已删除事务的迟到 Apple 事件静默改写`));
}

testIdentityAndTimes();
testDiningPlanAndDerivedState();
testHardAndSoftConstraints();
testRescheduleMaintainsDomainBoundaries();
testReceiptInventoryConsumptionAndFinanceBoundary();
testSkipMealKeepsSingleIntent();
testReplaceDishUsesExistingMealSlot();
testUnitConversionAndGroupedDemandCompatibility();
testFormalDomainCommandsAndIdempotence();
testAppleProjectionEvidenceBoundaries();
testBatchReceiptAndPackageConversion();
testRecipeUpdatePreservesScheduledFacts();
testTaskDeletionPreservesLinkedFactsAndHandlesAppleRace();

console.log(JSON.stringify({ status: "ok", suite: "core", assertions: 96 }));
