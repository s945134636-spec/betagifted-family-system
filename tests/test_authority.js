"use strict";

const assert = require("assert");
const {
  createAuthorityModule,
  createMealPlanDraft,
  diffAuthorityModules,
  authorityModulePath,
  draftRootPath,
  buildAuthorityIndex,
  parseAuthorityModule,
  parseMealPlanDraft,
  serializeAuthorityModule,
  serializeMealPlanDraft,
} = require("../src/authority");
const { recordBase, uuidFromSeed } = require("../src/core");

const at = "2026-08-26T00:00:00.000Z";
const household = uuidFromSeed("authority-household");
function record(type, seed, values) {
  return recordBase(type, { id: uuidFromSeed(seed), ...values }, { household_id: household, recorded_at: at });
}

const member = record("member", "member", { name: "成员", role: "member", status: "active" });
const authorityModule = createAuthorityModule("basic", [member], { household_id: household, updated_at: at, body: "\n# 自由说明\n\n这段正文必须保留。\n" });
const serialized = serializeAuthorityModule(authorityModule);
const parsed = parseAuthorityModule(serialized);
assert.strictEqual(parsed.body.includes("这段正文必须保留"), true);
assert.strictEqual(parsed.records[0].id, member.id);

const edited = { ...parsed, records: [{ ...member, name: "新名字" }] };
const changes = diffAuthorityModules(parsed, edited);
assert.deepStrictEqual(changes.map((item) => item.action), ["update"]);
assert.throws(() => parseAuthorityModule(serialized.replace(member.id, uuidFromSeed("tampered"))), /内容哈希不匹配/);
assert.throws(() => parseAuthorityModule(serialized.replace('"record_type": "member"', '"record_type": "recipe"'), { check_hash: false }), /不属于 basic/);

const plan = record("meal_plan", "draft-plan", { title: "本周菜单", week_start: "2026-08-22", status: "draft", participant_ids: [] });
const slot = record("meal_slot", "draft-slot", { planned_date: "2026-08-22", meal_label: "晚餐", participant_ids: [], status: "planned", source_plan_id: plan.id });
const draft = createMealPlanDraft(plan.id, [plan, slot], { household_id: household, week_start: plan.week_start, updated_at: at, body: "\n# 草稿备注\n" });
const parsedDraft = parseMealPlanDraft(serializeMealPlanDraft(draft));
assert.strictEqual(parsedDraft.records.length, 2);
assert.strictEqual(parsedDraft.body.includes("草稿备注"), true);
assert.throws(() => parseMealPlanDraft(serializeMealPlanDraft({ ...draft, records: [slot] })), /必须且只能包含一条 meal_plan/);
assert.strictEqual(authorityModulePath(".", "basic"), "01_基础信息系统/家庭资料.md");
assert.strictEqual(draftRootPath("."), "05_饮食健康系统/菜单草稿");
assert.strictEqual(buildAuthorityIndex({ basic: authorityModule }, ".", at).authority_root, ".");

console.log(JSON.stringify({ status: "ok", suite: "authority", module_records: parsed.records.length, draft_records: parsedDraft.records.length }));
