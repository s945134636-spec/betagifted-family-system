"use strict";

const assert = require("assert");
const core = require("../src/core");

const householdId = core.uuidFromSeed("household:task-categories");
const at = "2026-08-23T12:00:00.000Z";
const state = Object.fromEntries(core.RECORD_TYPES.map((type) => [type, []]));
state.household.push(core.recordBase("household", { id: householdId, name: "测试家庭", status: "active" }, { household_id: householdId, recorded_at: at }));

function command(type, payload, seed) {
  return core.commandEnvelope(type, {
    command_id: core.uuidFromSeed(seed),
    household_id: householdId,
    actor_id: core.uuidFromSeed("actor:task-categories"),
    ...payload,
  }, { clock: () => new Date(at) });
}

function apply(operation) {
  operation.effects.forEach((item) => {
    const records = state[item.record_type];
    const index = records.findIndex((record) => record.id === item.record.id);
    const committed = { ...item.record, revision: item.expected_revision + 1 };
    if (index >= 0) records[index] = committed;
    else records.push(committed);
  });
  return operation;
}

function planApply(type, payload, seed) {
  return apply(core.planCommand(command(type, payload, seed), state));
}

const purchaseCategory = planApply("task-category.create", { name: "采买", route_kind: "purchase", sort_order: 0 }, "category:purchase").effects.find((item) => item.record_type === "task_category").record;
const mealCategory = planApply("task-category.create", { name: "备餐", route_kind: "meal_handling", sort_order: 1 }, "category:meal").effects.find((item) => item.record_type === "task_category").record;
const householdCategory = planApply("task-category.create", { name: "家务", route_kind: "household", sort_order: 2 }, "category:household").effects.find((item) => item.record_type === "task_category").record;
assert(core.persistedTaskCategories(state).every((item) => item.is_default));
assert.throws(() => core.planCommand(command("task-category.create", { name: "家务", route_kind: "household" }, "category:duplicate"), state), /名称已存在/);

const billsOperation = planApply("task-category.create", { name: "缴费", route_kind: "household", sort_order: 3 }, "category:bills");
let billsCategory = state.task_category.find((item) => item.id === billsOperation.effects.find((item) => item.record_type === "task_category").record.id);
assert.strictEqual(billsCategory.is_default, false);
planApply("task-category.set-default", { id: billsCategory.id, expected_revision: billsCategory.revision }, "category:bills:default");
billsCategory = state.task_category.find((item) => item.id === billsCategory.id);
assert.strictEqual(billsCategory.is_default, true);
assert.strictEqual(state.task_category.find((item) => item.id === householdCategory.id).is_default, false);

planApply("task.create", { title: "交物业费", category_id: billsCategory.id, category: "household", source_key: "task:bill" }, "task:bill");
assert.throws(() => core.planCommand(command("task-category.update", { id: billsCategory.id, expected_revision: billsCategory.revision, patch: { route_kind: "purchase" } }, "category:bills:reroute"), state), /默认分类不能|已经被事务使用/);
const oldHousehold = state.task_category.find((item) => item.id === householdCategory.id);
planApply("task-category.archive", { id: oldHousehold.id, expected_revision: oldHousehold.revision }, "category:household:archive");
assert.strictEqual(state.task_category.find((item) => item.id === oldHousehold.id).status, "archived");
planApply("task-category.restore", { id: oldHousehold.id, expected_revision: state.task_category.find((item) => item.id === oldHousehold.id).revision }, "category:household:restore");

const reminder = core.planCommand(command("purchase.create-manual", {
  category_id: purchaseCategory.id,
  purchase_mode: "reminder_only",
  title: "买生日蜡烛",
  due_at: "2026-08-24T18:00:00",
}, "purchase:reminder"), state);
assert.deepStrictEqual([...new Set(reminder.effects.map((item) => item.record_type))].sort(), ["domain_event", "task"]);
apply(reminder);
const reminderTask = state.task.find((item) => item.title === "买生日蜡烛");
assert.strictEqual(reminderTask.source_type, "manual_purchase");
const reminderCompletion = core.planCommand(command("apple.projection-event", {
  task_id: reminderTask.id,
  event_type: "completed",
  event_id: "apple-reminder-only-completed",
}, "apple:reminder-only"), state);
assert(!reminderCompletion.effects.some((item) => ["purchase_demand", "receipt", "inventory_batch", "inventory_movement", "finance_transaction"].includes(item.record_type)));

const tissue = core.recordBase("entity", {
  id: core.uuidFromSeed("inventory-item:tissue"),
  entity_kind: "inventory_item",
  name: "卷纸",
  canonical_unit: "卷",
  unit: "卷",
  purchase_group: "日用清洁",
  tracking_policy: "exact_unit",
  status: "active",
}, { household_id: householdId, recorded_at: at });
state.entity.push({ ...tissue, revision: 1 });
const managed = planApply("purchase.create-manual", {
  category_id: purchaseCategory.id,
  purchase_mode: "inventory_managed",
  item_entity_id: tissue.id,
  quantity: 12,
  unit: "卷",
  due_at: "2026-08-24T18:00:00",
}, "purchase:managed-existing");
assert(managed.effects.some((item) => item.record_type === "purchase_demand" && item.record.schema === "family-system/purchase_demand-v3"));
assert(managed.effects.some((item) => item.record_type === "task" && item.record.category_id === purchaseCategory.id));
const managedTask = state.task.find((item) => item.source_type === "purchase_demand" && item.purchase_group === "日用清洁");
const completionCommand = command("apple.projection-event", {
  task_id: managedTask.id,
  event_type: "completed",
  event_id: "apple-managed-completed",
}, "apple:managed");
const completion = planApply("apple.projection-event", completionCommand.payload, "apple:managed");
assert(completion.effects.some((item) => item.record_type === "receipt" && item.record.item_name === "卷纸"));
assert(completion.effects.some((item) => item.record_type === "inventory_batch" && item.record.item_entity_id === tissue.id));
assert(completion.effects.some((item) => item.record_type === "inventory_movement"));
assert(!completion.effects.some((item) => item.record_type === "finance_transaction"));
const duplicateCompletion = core.planCommand(command("apple.projection-event", completionCommand.payload, "apple:managed:duplicate"), state);
assert.strictEqual(duplicateCompletion.effects.length, 0);

const managedNew = core.planCommand(command("purchase.create-manual", {
  category_id: purchaseCategory.id,
  purchase_mode: "inventory_managed",
  new_item: { name: "洗衣凝珠", canonical_unit: "颗", purchase_group: "日用清洁", tracking_policy: "estimated" },
  quantity: 30,
  unit: "颗",
}, "purchase:managed-new"), state);
const newEntity = managedNew.effects.find((item) => item.record_type === "entity").record;
assert.strictEqual(newEntity.entity_kind, "inventory_item");
assert.strictEqual(newEntity.name, "洗衣凝珠");
assert(managedNew.effects.some((item) => item.record_type === "purchase_demand" && item.record.item_entity_id === newEntity.id));

const legacyDemand = core.recordBase("purchase_demand", {
  ingredient_id: tissue.id,
  ingredient_name: "卷纸",
  quantity: 1,
  unit: "卷",
  status: "open",
}, { household_id: householdId, recorded_at: at });
assert.deepStrictEqual(core.validateRecord(legacyDemand), []);
assert.strictEqual(core.demandItemName(legacyDemand), "卷纸");

planApply("task-category.reorder", {
  items: state.task_category.map((item, index) => ({ id: item.id, expected_revision: item.revision, sort_order: state.task_category.length - index })),
}, "category:reorder");

console.log(JSON.stringify({ status: "ok", suite: "task-categories", categories: state.task_category.length, tasks: state.task.length }));
