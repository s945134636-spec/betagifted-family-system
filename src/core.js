"use strict";

const SCHEMA_VERSION = 1;
const RECORD_TYPES = Object.freeze([
  "household", "member", "entity", "health_constraint", "recipe", "meal_slot", "dish_plan",
  "ingredient_requirement", "purchase_demand", "receipt", "inventory_batch",
  "inventory_movement", "finance_link", "task_projection", "relationship", "fact",
  "intent", "evidence", "domain_event", "rule", "decision_request",
  "projection_status", "import_mapping",
  "document", "contact", "medical_profile", "account_reference",
  "finance_account", "finance_transaction", "budget", "recurring_item", "balance_snapshot",
  "asset", "maintenance_plan", "service_record", "meal_plan", "purchase_session",
  "aftersale_case", "task", "task_category", "task_template"
]);

const GENERIC_RECORD_TYPES = Object.freeze([
  "document", "contact", "medical_profile", "account_reference", "finance_account",
  "budget", "recurring_item", "balance_snapshot", "asset", "maintenance_plan",
  "service_record", "purchase_session", "aftersale_case", "task_template", "rule"
]);

const FORMAL_DOMAIN_TYPES = Object.freeze([
  "document", "contact", "medical_profile", "account_reference",
  "finance_account", "finance_transaction", "budget", "recurring_item", "balance_snapshot",
  "asset", "maintenance_plan", "service_record", "meal_plan", "purchase_session",
  "aftersale_case", "task", "task_category", "task_template", "rule"
]);

const UNIT_FACTORS = Object.freeze({
  克: { dimension: "mass", factor: 1 },
  千克: { dimension: "mass", factor: 1000 },
  毫升: { dimension: "volume", factor: 1 },
  升: { dimension: "volume", factor: 1000 },
});

const PURCHASE_GROUP_ORDER = Object.freeze([
  "生鲜蔬菜", "水果", "肉禽蛋", "水产海鲜", "乳品豆制品",
  "冷冻速食", "米面杂粮", "干货罐装", "粮油调味", "未分类",
]);

const RECIPE_CATEGORIES = Object.freeze(["一餐式", "主菜", "主食", "汤羹", "配菜"]);
const RECIPE_MEAL_TYPES = Object.freeze(["早餐", "午餐", "晚餐", "加餐"]);

const MENU_GENERATION_STRATEGIES = Object.freeze(["balanced", "inventory_first", "time_first"]);
const MENU_MEAL_TYPES = Object.freeze(["早餐", "午餐", "晚餐", "加餐"]);
const MENU_STRATEGY_WEIGHTS = Object.freeze({
  balanced: Object.freeze({ repeat: 45, variety: 25, inventory: 20, time: 10 }),
  inventory_first: Object.freeze({ repeat: 20, variety: 10, inventory: 60, time: 10 }),
  time_first: Object.freeze({ repeat: 25, variety: 10, inventory: 10, time: 55 }),
});

const TASK_CATEGORIES = Object.freeze(["purchase", "meal_handling", "household"]);
const PURCHASE_MODES = Object.freeze(["reminder_only", "inventory_managed"]);
const MANUAL_INTAKE_REASONS = Object.freeze(["manual_purchase", "gift", "opening_balance", "other"]);
const DEFAULT_TASK_CATEGORY_NAMES = Object.freeze({
  purchase: "采购",
  meal_handling: "食材处理",
  household: "家庭事务",
});

function defaultTaskCategoryId(routeKind) {
  if (!TASK_CATEGORIES.includes(routeKind)) throw new Error(`事务路由无效：${routeKind}`);
  return uuidFromSeed(`task-category:default:${routeKind}`);
}

const RULE_PRIORITY = Object.freeze({
  reality: 600,
  hard_constraint: 500,
  instance_decision: 400,
  family_policy: 300,
  domain_default: 300,
  soft_preference: 200,
  suggestion: 100,
});

function nowIso(clock) {
  return (clock ? clock() : new Date()).toISOString();
}

function normalizeVaultPath(value) {
  const raw = String(value || "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  const parts = raw.split("/").filter(Boolean);
  if (!raw || parts.some((part) => part === "." || part === "..")) {
    throw new Error("数据路径必须是仓库内的安全相对路径");
  }
  return parts.join("/");
}

function normalizeVaultRoot(value) {
  const raw = String(value || "").trim().replace(/\\/g, "/");
  if (raw === ".") return ".";
  return normalizeVaultPath(raw);
}

function joinVaultPath(root, ...parts) {
  const cleanRoot = normalizeVaultRoot(root);
  const cleanParts = parts.filter((part) => part != null && String(part).trim() !== "").map(normalizeVaultPath);
  if (!cleanParts.length) return cleanRoot;
  return cleanRoot === "." ? cleanParts.join("/") : [cleanRoot, ...cleanParts].join("/");
}

function isPathWithin(path, root) {
  const cleanPath = normalizeVaultPath(path);
  const cleanRoot = normalizeVaultRoot(root);
  if (cleanRoot === ".") return true;
  return cleanPath === cleanRoot || cleanPath.startsWith(`${cleanRoot}/`);
}

function fnv1a(value, seed) {
  let hash = seed == null ? 0x811c9dc5 : seed >>> 0;
  const text = String(value);
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function contentHash(value) {
  return fnv1a(typeof value === "string" ? value : stableStringify(value)).toString(16).padStart(8, "0");
}

function uuidFromSeed(seed) {
  const chunks = [0, 1, 2, 3].map((index) => fnv1a(`${seed}:${index}`, 0x811c9dc5 ^ index).toString(16).padStart(8, "0"));
  const hex = chunks.join("").slice(0, 32).split("");
  hex[12] = "5";
  hex[16] = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  const value = hex.join("");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

function createId(kind, seed) {
  const source = seed || `${kind}:${Date.now()}:${Math.random()}`;
  return uuidFromSeed(source);
}

function stableStringify(value, spacing) {
  const ancestors = new WeakSet();
  const normalize = (input) => {
    if (input === null || typeof input !== "object") return input;
    if (ancestors.has(input)) throw new Error("不能序列化循环结构");
    ancestors.add(input);
    try {
      if (Array.isArray(input)) return input.map(normalize);
      const output = {};
      Object.keys(input).sort().forEach((key) => {
        if (input[key] !== undefined) output[key] = normalize(input[key]);
      });
      return output;
    } finally {
      ancestors.delete(input);
    }
  };
  return JSON.stringify(normalize(value), null, spacing == null ? 2 : spacing);
}

function validDateKey(value) {
  const text = String(value || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const date = new Date(`${text}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === text;
}

function addDateDays(value, offset) {
  if (!validDateKey(value)) throw new Error(`日期无效：${value || "空"}`);
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + Number(offset || 0));
  return date.toISOString().slice(0, 10);
}

function dateRangeInclusive(start, end) {
  if (!validDateKey(start) || !validDateKey(end)) throw new Error("菜单日期区间无效");
  if (end < start) throw new Error("菜单结束日期不能早于开始日期");
  const days = [];
  for (let date = start; date <= end; date = addDateDays(date, 1)) days.push(date);
  return days;
}

function mealPlanRange(plan) {
  const start = plan?.range_start || plan?.week_start || "";
  const end = plan?.range_end || (validDateKey(start) ? addDateDays(start, 6) : "");
  return { start, end };
}

function rangesOverlap(left, right) {
  const a = mealPlanRange(left);
  const b = mealPlanRange(right);
  return Boolean(validDateKey(a.start) && validDateKey(a.end) && validDateKey(b.start) && validDateKey(b.end) && a.start <= b.end && b.start <= a.end);
}

function roundMenuQuantity(value) {
  const number = Number(value || 0);
  if (!Number.isFinite(number)) throw new Error("食材数量无效");
  return Math.round((number + Number.EPSILON) * 100) / 100;
}

function servingScale(targetServings, recipeServings) {
  const target = Number(targetServings);
  const base = Number(recipeServings);
  if (!Number.isFinite(target) || target <= 0) throw new Error("餐次人数必须大于 0");
  if (!Number.isFinite(base) || base <= 0) throw new Error("菜谱标准份数必须大于 0");
  return target / base;
}

function scaledIngredientQuantity(quantity, targetServings, recipeServings) {
  const original = Number(quantity || 0);
  const scale = servingScale(targetServings, recipeServings);
  // Existing schedules stored recipe quantities verbatim. Preserve the exact
  // amount when no serving conversion is needed; rounding 0.025 kg to 0.03 kg
  // would otherwise change a historical requirement by 20 percent.
  return Math.abs(scale - 1) < 1e-9 ? original : roundMenuQuantity(original * scale);
}

function recordBase(recordType, input, context) {
  if (!RECORD_TYPES.includes(recordType)) throw new Error(`未知记录类型：${recordType}`);
  const at = context && context.recorded_at ? context.recorded_at : nowIso(context && context.clock);
  const cleanInput = Object.fromEntries(Object.entries(input || {}).filter(([, value]) => value !== undefined));
  return {
    schema: `family-system/${recordType}-v${recordType === "purchase_demand" ? 3 : SCHEMA_VERSION}`,
    record_type: recordType,
    id: cleanInput.id || createId(recordType, cleanInput.seed),
    household_id: cleanInput.household_id || (context && context.household_id) || "",
    revision: Number.isInteger(cleanInput.revision) ? cleanInput.revision : 0,
    created_at: cleanInput.created_at || at,
    updated_at: at,
    recorded_at: cleanInput.recorded_at || at,
    tombstone: Boolean(cleanInput.tombstone),
    ...cleanInput,
  };
}

function validateRecord(record) {
  const errors = [];
  if (!record || typeof record !== "object") return ["记录必须是对象"];
  if (!RECORD_TYPES.includes(record.record_type)) errors.push("record_type 不受支持");
  if (!record.id || !/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(record.id)) errors.push("id 必须是稳定 UUID");
  if (!Number.isInteger(record.revision) || record.revision < 0) errors.push("revision 必须是非负整数");
  if (!record.schema || !record.created_at || !record.updated_at || !record.recorded_at) errors.push("缺少 schema 或时间字段");
  if (record.record_type === "finance_transaction") {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(record.date || "")) errors.push("财务日期无效");
    if (!['收入', '支出', '转账'].includes(record.direction)) errors.push("财务方向无效");
    if (!Number.isFinite(Number(record.amount)) || Number(record.amount) <= 0) errors.push("财务金额无效");
    if (!['pending', 'confirmed', 'void'].includes(record.status)) errors.push("财务状态无效");
    if (record.direction === '转账' && (!record.from_account_id || !record.to_account_id || record.from_account_id === record.to_account_id)) errors.push("转账账户无效");
    if (record.direction !== '转账' && !record.account_id) errors.push("缺少财务账户");
  }
  if (record.record_type === "task") {
    if (!String(record.title || "").trim()) errors.push("事务标题不能为空");
    if (record.category && !TASK_CATEGORIES.includes(record.category)) errors.push("事务类别无效");
  }
  if (record.record_type === "task_category") {
    if (!String(record.name || "").trim()) errors.push("分类名称不能为空");
    if (!TASK_CATEGORIES.includes(record.route_kind)) errors.push("分类 Apple 路由无效");
    if (!["active", "archived"].includes(record.status)) errors.push("分类状态无效");
    if (!Number.isFinite(Number(record.sort_order))) errors.push("分类排序无效");
  }
  if (record.record_type === "purchase_demand") {
    const itemId = record.item_entity_id || record.ingredient_id;
    const itemName = record.item_name || record.ingredient_name;
    if (!itemId) errors.push("采购需求缺少物品引用");
    if (!String(itemName || "").trim()) errors.push("采购需求缺少物品名称");
    if (!Number.isFinite(Number(record.quantity)) || Number(record.quantity) <= 0) errors.push("采购数量必须大于 0");
    if (!String(record.unit || "").trim()) errors.push("采购单位不能为空");
  }
  if (record.record_type === "ingredient_requirement") {
    if (!["required", "consumed", "omitted", "cancelled"].includes(record.status)) errors.push("食材需求状态无效");
  }
  if (record.record_type === "recipe") {
    if (!String(record.name || "").trim()) errors.push("菜谱名称不能为空");
    if (!RECIPE_CATEGORIES.includes(record.category)) errors.push("菜谱分类无效");
    if (!Array.isArray(record.meal_types) || !record.meal_types.length || record.meal_types.some((item) => !RECIPE_MEAL_TYPES.includes(item))) errors.push("菜谱适用餐次无效");
    if (!Number.isFinite(Number(record.servings)) || Number(record.servings) <= 0) errors.push("菜谱份数必须大于 0");
    if (!Number.isFinite(Number(record.prep_minutes)) || Number(record.prep_minutes) <= 0) errors.push("制作时长必须大于 0");
    if (!Array.isArray(record.ingredients) || !record.ingredients.length) errors.push("菜谱至少需要一种食材");
    if (!Array.isArray(record.steps) || !record.steps.length || record.steps.some((item) => !String(item || "").trim())) errors.push("菜谱至少需要一条有效制作步骤");
    const ingredientIds = new Set();
    (Array.isArray(record.ingredients) ? record.ingredients : []).forEach((ingredient) => {
      if (!ingredient || typeof ingredient !== "object" || !ingredient.id || !String(ingredient.name || "").trim()) errors.push("菜谱食材缺少稳定 ID 或名称");
      if (ingredient?.id && !/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(ingredient.id)) errors.push(`食材“${ingredient.name || "未命名"}”的 ID 必须是稳定 UUID`);
      if (!Number.isFinite(Number(ingredient?.quantity)) || Number(ingredient.quantity) <= 0 || !String(ingredient?.unit || "").trim()) errors.push(`食材“${ingredient?.name || "未命名"}”的数量或单位无效`);
      if (ingredient?.id && ingredientIds.has(ingredient.id)) errors.push(`菜谱食材重复：${ingredient.name || ingredient.id}`);
      if (ingredient?.id) ingredientIds.add(ingredient.id);
    });
  }
  if (record.record_type === "meal_plan") {
    const range = mealPlanRange(record);
    if (!validDateKey(range.start) || !validDateKey(range.end) || range.end < range.start) errors.push("菜单日期区间无效");
    if (record.guest_count != null && (!Number.isInteger(Number(record.guest_count)) || Number(record.guest_count) < 0)) errors.push("菜单访客人数无效");
    if (record.default_serving_count != null && (!Number.isFinite(Number(record.default_serving_count)) || Number(record.default_serving_count) <= 0)) errors.push("菜单默认人数无效");
    if (record.generation_strategy != null && !MENU_GENERATION_STRATEGIES.includes(record.generation_strategy)) errors.push("菜单生成策略无效");
    if (record.handling_instructions != null && !Array.isArray(record.handling_instructions)) errors.push("食材处理说明必须是数组");
    if (record.handling_actions != null && !Array.isArray(record.handling_actions)) errors.push("食材处理动作必须是数组");
    (Array.isArray(record.handling_instructions) ? record.handling_instructions : []).forEach((item) => {
      if (!item || typeof item !== "object" || !item.id || !String(item.phase || "").trim() || !String(item.instruction || "").trim()) errors.push("食材处理说明缺少 ID、阶段或内容");
    });
    (Array.isArray(record.handling_actions) ? record.handling_actions : []).forEach((item) => {
      if (!item || typeof item !== "object" || !item.id || !String(item.title || "").trim() || !String(item.scheduled_at || "").trim()) errors.push("食材处理动作缺少 ID、标题或执行时间");
    });
  }
  if (record.record_type === "meal_slot") {
    if (!validDateKey(record.planned_date)) errors.push("餐次日期无效");
    if (!MENU_MEAL_TYPES.includes(record.meal_label)) errors.push("餐次名称无效");
    if (record.serving_count != null && (!Number.isFinite(Number(record.serving_count)) || Number(record.serving_count) <= 0)) errors.push("餐次人数必须大于 0");
    if (!Number.isInteger(Number(record.guest_count || 0)) || Number(record.guest_count || 0) < 0) errors.push("餐次访客人数无效");
    if (record.participant_ids != null && !Array.isArray(record.participant_ids)) errors.push("餐次成员必须是数组");
  }
  if (record.record_type === "dish_plan" && record.target_servings != null) {
    if (!Number.isFinite(Number(record.target_servings)) || Number(record.target_servings) <= 0) errors.push("菜品目标份数必须大于 0");
  }
  return errors;
}

function normalizeHandlingInstructions(items, planId) {
  const phaseCounts = new Map();
  return (Array.isArray(items) ? items : []).map((source) => {
    const input = source && typeof source === "object" ? source : { instruction: String(source || "") };
    const phase = String(input.phase || "通用处理").trim() || "通用处理";
    const index = phaseCounts.get(phase) || 0;
    phaseCounts.set(phase, index + 1);
    return {
      ...input,
      id: input.id || uuidFromSeed(`meal-handling-instruction:${planId}:${phase}:${index}`),
      phase,
      instruction: String(input.instruction || "").trim(),
      instruction_kind: input.instruction_kind || "handling_reference",
    };
  }).filter((item) => item.instruction);
}

function normalizeHandlingActions(items, planId) {
  return (Array.isArray(items) ? items : []).map((source, index) => {
    const input = source && typeof source === "object" ? source : { title: String(source || "") };
    return {
      ...input,
      id: input.id || uuidFromSeed(`meal-handling-action:${planId}:${index}`),
      title: String(input.title || "").trim(),
      scheduled_at: String(input.scheduled_at || "").trim(),
      phase: String(input.phase || "食材处理").trim() || "食材处理",
      action_kind: input.action_kind || "meal_handling",
      instruction_ids: Array.isArray(input.instruction_ids) ? input.instruction_ids.filter(Boolean) : [],
      related_meal_ids: Array.isArray(input.related_meal_ids) ? input.related_meal_ids.filter(Boolean) : [],
      task_required: input.task_required !== false,
      projection_policy: input.projection_policy || "apple-reminders",
      status: input.status || "planned",
    };
  }).filter((item) => item.title || item.scheduled_at);
}

function handlingActionNotes(action, instructions) {
  const byId = new Map((instructions || []).map((item) => [item.id, item]));
  const linked = (action.instruction_ids || []).map((id) => byId.get(id)?.instruction).filter(Boolean);
  return linked.length ? linked.join("\n") : String(action.notes || "");
}

function parseIngredientLines(value) {
  const rows = String(value || "").split(/\n|;/).map((row) => row.trim()).filter(Boolean);
  return rows.map((row, index) => {
    const [name, quantity, unit, specificity, inventoryPolicy] = row.split("|").map((part) => String(part || "").trim());
    if (!name) throw new Error(`第 ${index + 1} 行食材缺少名称`);
    const amount = Number(quantity || 1);
    if (!Number.isFinite(amount) || amount <= 0) throw new Error(`${name} 的数量无效`);
    return {
      id: uuidFromSeed(`ingredient:${name.toLowerCase()}`),
      name,
      quantity: amount,
      unit: unit || "份",
      specificity: specificity === "专属" || specificity === "specific" ? "specific" : "general",
      inventory_policy: inventoryPolicy || "tracked",
    };
  });
}

function normalizeRecipeStringList(value) {
  const source = Array.isArray(value) ? value : String(value || "").split(/[，,]/);
  return [...new Set(source.map((item) => String(item || "").trim()).filter(Boolean))];
}

function normalizeRecipeSteps(value) {
  const source = Array.isArray(value) ? value : String(value || "").split(/\n/);
  return source.map((item) => String(item || "").trim()).filter(Boolean);
}

function normalizeRecipeIngredients(value) {
  if (!Array.isArray(value)) throw new Error("菜谱食材必须使用结构化记录");
  return value.map((source) => {
    const ingredient = source && typeof source === "object" ? source : {};
    return {
      ...ingredient,
      id: String(ingredient.id || "").trim(),
      name: String(ingredient.name || "").trim(),
      quantity: Number(ingredient.quantity),
      unit: String(ingredient.unit || "").trim(),
      specificity: ingredient.specificity === "specific" || ingredient.specificity === "专属" ? "specific" : "general",
      inventory_policy: ingredient.inventory_policy || "tracked",
    };
  });
}

function recipeFields(payload) {
  return {
    name: String(payload.name || "").trim(),
    category: String(payload.category || ""),
    meal_types: normalizeRecipeStringList(payload.meal_types),
    servings: Number(payload.servings),
    prep_minutes: Number(payload.prep_minutes),
    ingredients: normalizeRecipeIngredients(payload.ingredients),
    tags: normalizeRecipeStringList(payload.tags),
    allergen_tags: normalizeRecipeStringList(payload.allergen_tags),
    steps: normalizeRecipeSteps(payload.steps),
  };
}

function rulePriority(rule) {
  return RULE_PRIORITY[rule && rule.effect_level] || 0;
}

function sortRules(rules) {
  return [...(rules || [])].sort((a, b) => rulePriority(b) - rulePriority(a));
}

function active(records) {
  return (records || []).filter((record) => !record.tombstone && record.status !== "cancelled");
}

function indexRecords(records) {
  const index = new Map();
  (records || []).forEach((record) => index.set(record.id, record));
  return index;
}

function stateList(state, type) {
  return Array.isArray(state && state[type]) ? state[type] : [];
}

function persistedTaskCategories(state) {
  return stateList(state, "task_category").filter((item) => !item.tombstone);
}

function taskCategoryById(state, id, options = {}) {
  if (!id) return null;
  const category = persistedTaskCategories(state).find((item) => item.id === id) || null;
  if (category && options.activeOnly !== false && category.status !== "active") throw new Error(`事务分类已停用：${category.name}`);
  return category;
}

function taskCategoryForRoute(state, routeKind) {
  const categories = persistedTaskCategories(state).filter((item) => item.status === "active" && item.route_kind === routeKind);
  return categories.find((item) => item.is_default) || categories.sort((a, b) => Number(a.sort_order || 0) - Number(b.sort_order || 0))[0] || null;
}

function categoryIdForRoute(state, routeKind) {
  return taskCategoryForRoute(state, routeKind)?.id || null;
}

function requireTaskCategory(state, categoryId, expectedRoute) {
  const category = taskCategoryById(state, categoryId);
  if (!category) throw new Error("请选择有效的事务分类");
  if (expectedRoute && category.route_kind !== expectedRoute) throw new Error(`分类“${category.name}”不属于所选事务路由`);
  return category;
}

function normalizedActiveName(value) {
  return String(value || "").trim().toLocaleLowerCase("zh-CN");
}

function assertUniqueTaskCategoryName(state, name, exceptId) {
  const normalized = normalizedActiveName(name);
  if (!normalized) throw new Error("分类名称不能为空");
  const duplicate = persistedTaskCategories(state).find((item) => item.status === "active" && item.id !== exceptId && normalizedActiveName(item.name) === normalized);
  if (duplicate) throw new Error(`活动分类名称已存在：${duplicate.name}`);
}

function demandItemId(demand) {
  return demand?.item_entity_id || demand?.ingredient_id || null;
}

function demandItemName(demand) {
  return demand?.item_name || demand?.ingredient_name || "未命名物品";
}

function evaluateRecipeConstraints(recipe, participantIds, state) {
  const constraints = active(stateList(state, "health_constraint"));
  const members = indexRecords(active(stateList(state, "member")));
  const ingredients = new Set((recipe.ingredients || []).map((item) => String(item.name).toLowerCase()));
  const allergens = new Set((recipe.allergen_tags || []).map((item) => String(item).toLowerCase()));
  const blocking = [];
  const warnings = [];
  participantIds.forEach((memberId) => {
    constraints.filter((item) => item.member_id === memberId).forEach((constraint) => {
      const target = String(constraint.target || "").toLowerCase();
      const matched = ingredients.has(target) || allergens.has(target) || (recipe.tags || []).map(String).map((item) => item.toLowerCase()).includes(target);
      if (!matched) return;
      const message = `${members.get(memberId)?.name || "成员"}：${constraint.label || constraint.target}`;
      if (constraint.effect_level === "hard_constraint") blocking.push(message);
      else warnings.push(message);
    });
  });
  return { blocking, warnings };
}

function convertUnitQuantity(amount, fromUnit, toUnit) {
  const source = UNIT_FACTORS[String(fromUnit || "")];
  const target = UNIT_FACTORS[String(toUnit || "")];
  if (!source || !target) return String(fromUnit || "") === String(toUnit || "") ? Number(amount || 0) : null;
  if (source.dimension !== target.dimension) return null;
  return (Number(amount || 0) * source.factor) / target.factor;
}

function ingredientEntity(state, ingredientId) {
  return active(stateList(state, "entity")).find((item) => item.id === ingredientId) || null;
}

function canonicalUnitFor(state, ingredientId, fallbackUnit) {
  const entity = ingredientEntity(state, ingredientId);
  return String(entity?.canonical_unit || entity?.unit || fallbackUnit || "份");
}

function normalizeIngredientQuantity(state, ingredientId, amount, unit, fallbackUnit) {
  const quantity = Number(amount);
  if (!Number.isFinite(quantity) || quantity < 0) throw new Error("数量必须是非负数");
  const actualUnit = String(unit || fallbackUnit || "份");
  const canonicalUnit = canonicalUnitFor(state, ingredientId, fallbackUnit || actualUnit);
  const direct = convertUnitQuantity(quantity, actualUnit, canonicalUnit);
  if (direct !== null) return { quantity: direct, unit: canonicalUnit };
  const entity = ingredientEntity(state, ingredientId);
  const conversion = (entity?.package_conversions || []).find((item) => String(item.unit) === actualUnit);
  if (!conversion) throw new Error(`${entity?.name || "物品"} 的单位“${actualUnit}”没有换算关系`);
  const perPackage = Number(conversion.canonical_quantity);
  if (!Number.isFinite(perPackage) || perPackage <= 0) throw new Error(`${entity?.name || "物品"} 的包装换算无效`);
  const converted = convertUnitQuantity(quantity * perPackage, conversion.canonical_unit, canonicalUnit);
  if (converted === null) throw new Error(`${entity?.name || "物品"} 的包装单位与标准单位不兼容`);
  return { quantity: converted, unit: canonicalUnit };
}

function purchaseGroupFor(state, ingredientId) {
  return ingredientEntity(state, ingredientId)?.purchase_group || "未分类";
}

function inventoryAvailable(state, ingredientId, targetUnit) {
  return active(stateList(state, "inventory_batch"))
    .filter((batch) => batch.ingredient_id === ingredientId && batch.status !== "depleted")
    .reduce((sum, batch) => {
      const converted = convertUnitQuantity(batch.available_quantity, batch.unit, targetUnit || batch.unit);
      return sum + Math.max(0, converted === null ? 0 : converted);
    }, 0);
}

function demandRequirementIds(demand) {
  if (Array.isArray(demand?.requirement_ids)) return demand.requirement_ids.filter(Boolean);
  return demand?.requirement_id ? [demand.requirement_id] : [];
}

function taskProjectsDemand(task, demandId) {
  return task?.source_id === demandId || (Array.isArray(task?.source_ids) && task.source_ids.includes(demandId));
}

function deriveDishState(dish, state, now) {
  const requirements = stateList(state, "ingredient_requirement").filter((item) => item.dish_plan_id === dish.id && !item.tombstone && item.status !== "cancelled");
  const omittedRequirements = requirements.filter((item) => item.status === "omitted").map((item) => ({
    id: item.id,
    ingredient_id: item.ingredient_id,
    ingredient_name: item.ingredient_name,
    quantity: Number(item.quantity || 0),
    unit: item.unit,
  }));
  if (dish.status === "completed" || dish.status === "skipped") return {
    status: dish.status,
    missing: [],
    missing_requirements: [],
    omitted: omittedRequirements.map((item) => item.ingredient_name),
    omitted_requirements: omittedRequirements,
  };
  const demands = active(stateList(state, "purchase_demand"));
  let risk = false;
  let adaptable = false;
  const missingRequirements = [];
  requirements.filter((item) => item.status === "required").forEach((requirement) => {
    const availableQuantity = inventoryAvailable(state, requirement.ingredient_id, requirement.unit);
    if (availableQuantity >= Number(requirement.quantity || 0)) return;
    const demand = demands.find((item) => demandRequirementIds(item).includes(requirement.id) && item.status !== "fulfilled");
    if (!demand) {
      adaptable = true;
    } else {
      const deadline = demand.due_at ? new Date(demand.due_at) : null;
      if (demand.confirmed_missing || (deadline && deadline.getTime() < now.getTime())) adaptable = true;
      else risk = true;
    }
    missingRequirements.push({
      id: requirement.id,
      ingredient_id: requirement.ingredient_id,
      ingredient_name: requirement.ingredient_name,
      quantity: Number(requirement.quantity || 0),
      available_quantity: availableQuantity,
      missing_quantity: Math.max(0, Number(requirement.quantity || 0) - availableQuantity),
      unit: requirement.unit,
      demand_id: demand?.id || null,
      demand_status: demand?.status || null,
    });
  });
  const status = adaptable ? "adaptable" : risk ? "at_risk" : omittedRequirements.length ? "adapted" : "ready";
  return {
    status,
    missing: missingRequirements.map((item) => item.ingredient_name),
    missing_requirements: missingRequirements,
    omitted: omittedRequirements.map((item) => item.ingredient_name),
    omitted_requirements: omittedRequirements,
  };
}

function deriveCurrentOrder(state, at) {
  const now = at instanceof Date ? at : new Date(at || Date.now());
  const slots = indexRecords(active(stateList(state, "meal_slot")));
  const dishes = active(stateList(state, "dish_plan"));
  const dishStates = dishes.map((dish) => ({ ...dish, ...deriveDishState(dish, state, now), meal_slot: slots.get(dish.meal_slot_id) || null }));
  const authoritativeTasks = active(stateList(state, "task"));
  const tasks = authoritativeTasks.length ? authoritativeTasks : active(stateList(state, "task_projection"));
  const operations = stateList(state, "operations");
  const conflicts = stateList(state, "conflicts");
  const activeDemands = active(stateList(state, "purchase_demand")).filter((item) => item.status !== "fulfilled");
  return {
    dish_states: dishStates,
    ready: dishStates.filter((item) => item.status === "ready"),
    adapted: dishStates.filter((item) => item.status === "adapted"),
    adaptable: dishStates.filter((item) => item.status === "adaptable"),
    at_risk: dishStates.filter((item) => item.status === "at_risk"),
    blocked: [],
    purchase_count: activeDemands.length,
    purchase_quantity: activeDemands.reduce((sum, item) => sum + Number(item.quantity || 0), 0),
    pending_tasks: tasks.filter((item) => !["completed", "cancelled", "receipt_confirmed"].includes(item.status)),
    pending_decisions: active(stateList(state, "decision_request")).filter((item) => item.status === "pending"),
    recovery_count: operations.filter((item) => ["committed_with_pending_projection", "failed", "needs_review"].includes(item.status)).length + conflicts.filter((item) => item.status === "open").length,
  };
}

function commandEnvelope(type, payload, context) {
  const recordedAt = nowIso(context && context.clock);
  const id = payload.command_id || createId("command");
  return {
    schema: "family-system/command-v1",
    id,
    command_type: type,
    household_id: payload.household_id || (context && context.household_id) || "",
    actor_id: payload.actor_id || (context && context.actor_id) || "local-user",
    authority: payload.authority || "explicit_user_decision",
    planned_at: payload.planned_at || null,
    occurred_at: payload.occurred_at || recordedAt,
    recorded_at: recordedAt,
    causation_id: payload.causation_id || id,
    correlation_id: payload.correlation_id || id,
    payload: { ...payload },
  };
}

function effect(record, before, note) {
  return {
    effect_id: createId("effect", `${record.record_type}:${record.id}:${record.updated_at}:${note || "upsert"}`),
    kind: "upsert_record",
    record_type: record.record_type,
    record,
    before: before || null,
    expected_revision: before ? before.revision : 0,
    note: note || "",
  };
}

function relationship(context, fromId, toId, type, sourceEventId, input) {
  return recordBase("relationship", {
    id: uuidFromSeed(`${context.household_id}:${type}:${fromId}:${toId}`),
    from_id: fromId,
    to_id: toId,
    relationship_type: type,
    source_event_id: sourceEventId,
    valid_from: input?.valid_from || context.recorded_at,
    valid_to: input?.valid_to || null,
    status: input?.status || "active",
  }, context);
}

function domainEvent(command, eventType, aggregateId, payload) {
  return recordBase("domain_event", {
    id: createId("event", `${command.id}:${eventType}:${aggregateId}`),
    event_type: eventType,
    aggregate_id: aggregateId,
    actor_id: command.actor_id,
    authority: command.authority,
    occurred_at: command.occurred_at,
    causation_id: command.causation_id,
    correlation_id: command.correlation_id,
    payload,
  }, { household_id: command.household_id, recorded_at: command.recorded_at });
}

function effectSet(command, effects, meta) {
  return {
    schema: "family-system/effect-set-v2",
    id: command.id,
    operation_id: command.id,
    command,
    status: "prepared",
    effects,
    applied_effect_ids: [],
    invariants: meta?.invariants || [],
    warnings: meta?.warnings || [],
    summary: meta?.summary || command.command_type,
    created_at: command.recorded_at,
    updated_at: command.recorded_at,
  };
}

function findRecord(state, type, id) {
  const record = stateList(state, type).find((item) => item.id === id && !item.tombstone);
  if (!record) throw new Error(`找不到 ${type}：${id}`);
  return record;
}

function withUpdate(record, values, context) {
  return { ...record, ...values, revision: record.revision, updated_at: context.recorded_at };
}

function purchaseDeadline(date, time) {
  return `${date}T${time || "18:00"}:00`;
}

function planInitialize(command, state) {
  if (active(stateList(state, "household")).length) throw new Error("Life Core 已经存在家庭记录");
  const household = recordBase("household", {
    id: command.payload.household_id || createId("household"),
    name: command.payload.name || "我的家庭",
    status: "active",
  }, { household_id: command.payload.household_id || "", recorded_at: command.recorded_at });
  household.household_id = household.id;
  const defaultCategories = [
    { name: "家庭采购", route_kind: "purchase", sort_order: 0, is_default: true },
    { name: "食材处理", route_kind: "meal_handling", sort_order: 1, is_default: false },
    { name: "家庭事务", route_kind: "household", sort_order: 2, is_default: false },
  ].map((category) => recordBase("task_category", {
    id: createId("task-category", `${household.id}:${category.route_kind}`),
    ...category,
    status: "active",
  }, { household_id: household.id, recorded_at: command.recorded_at }));
  const event = domainEvent({ ...command, household_id: household.id }, "household.initialized", household.id, { name: household.name });
  return effectSet(
    { ...command, household_id: household.id },
    [effect(household), ...defaultCategories.map((category) => effect(category)), effect(event)],
    { summary: `建立空白家庭：${household.name}；建立 3 个基础事务分类` },
  );
}

function planSimpleRecord(command, state, type, fields, summary) {
  if (!command.household_id) throw new Error("请先建立家庭 Life Core");
  const record = recordBase(type, fields, { household_id: command.household_id, recorded_at: command.recorded_at });
  const event = domainEvent(command, `${type}.created`, record.id, { record_type: type });
  return effectSet(command, [effect(record), effect(event)], { summary });
}

function safeRecordPayload(payload) {
  const blocked = new Set(["record_type", "schema", "revision", "created_at", "updated_at", "recorded_at", "tombstone", "household_id"]);
  return Object.fromEntries(Object.entries(payload || {}).filter(([key]) => !blocked.has(key)));
}

function planCreateRecord(command, state) {
  const type = String(command.payload.record_type || "");
  if (!GENERIC_RECORD_TYPES.includes(type)) throw new Error(`不允许通用创建：${type}`);
  const fields = safeRecordPayload(command.payload.record || command.payload);
  if (fields.id && stateList(state, type).some((item) => item.id === fields.id && !item.tombstone)) throw new Error(`${type} 已存在：${fields.id}`);
  return planSimpleRecord(command, state, type, { ...fields, status: fields.status || "active" }, `新增 ${type}`);
}

function planUpdateRecord(command, state) {
  const type = String(command.payload.record_type || "");
  if (!GENERIC_RECORD_TYPES.includes(type)) throw new Error(`不允许通用更新：${type}`);
  const current = findRecord(state, type, command.payload.id);
  if (Number(command.payload.expected_revision) !== Number(current.revision)) throw new Error(`版本冲突：${type}/${current.id}`);
  const next = withUpdate(current, safeRecordPayload(command.payload.patch || {}), command);
  const errors = validateRecord(next);
  if (errors.length) throw new Error(errors.join("；"));
  const event = domainEvent(command, `${type}.updated`, current.id, { changed_fields: Object.keys(command.payload.patch || {}).sort() });
  return effectSet(command, [effect(next, current), effect(event)], { summary: `更新 ${type}` });
}

function planArchiveRecord(command, state) {
  const type = String(command.payload.record_type || "");
  if (!FORMAL_DOMAIN_TYPES.includes(type)) throw new Error(`不允许归档：${type}`);
  const current = findRecord(state, type, command.payload.id);
  if (Number(command.payload.expected_revision) !== Number(current.revision)) throw new Error(`版本冲突：${type}/${current.id}`);
  const next = withUpdate(current, { status: "archived", tombstone: true, archived_at: command.occurred_at, archived_from_status: current.status || null }, command);
  const event = domainEvent(command, `${type}.archived`, current.id, {});
  return effectSet(command, [effect(next, current), effect(event)], { summary: `归档 ${type}` });
}

function planLifecycleRecord(command, state, action, status) {
  const type = String(command.payload.record_type || "");
  if (!FORMAL_DOMAIN_TYPES.includes(type)) throw new Error(`不允许${action}：${type}`);
  const current = action === "恢复"
    ? stateList(state, type).find((item) => item.id === command.payload.id)
    : findRecord(state, type, command.payload.id);
  if (!current) throw new Error(`找不到 ${type}：${command.payload.id}`);
  if (Number(command.payload.expected_revision) !== Number(current.revision)) throw new Error(`版本冲突：${type}/${current.id}`);
  const restoreDefault = type === "finance_transaction" ? "pending" : type === "meal_plan" ? "draft" : type === "task" ? "open" : "active";
  const patch = action === "恢复"
    ? { status: command.payload.restore_status || current.archived_from_status || restoreDefault, tombstone: false, restored_at: command.occurred_at }
    : { status, ...(action === "作废" ? { voided_at: command.occurred_at } : { confirmed_at: command.occurred_at }) };
  const next = withUpdate(current, patch, command);
  const errors = validateRecord(next);
  if (errors.length) throw new Error(errors.join("；"));
  const eventName = action === "确认" ? "confirmed" : action === "作废" ? "voided" : "restored";
  const event = domainEvent(command, `${type}.${eventName}`, current.id, { previous_status: current.status, status: next.status });
  return effectSet(command, [effect(next, current), effect(event)], { summary: `${action} ${type}` });
}

function requireFinanceAccounts(state, transaction) {
  const accounts = active(stateList(state, "finance_account"));
  const ids = new Set(accounts.map((item) => item.id));
  const required = transaction.direction === "转账"
    ? [transaction.from_account_id, transaction.to_account_id]
    : [transaction.account_id];
  const missing = required.filter((id) => !ids.has(id));
  if (missing.length) throw new Error(`财务账户不存在或已归档：${missing.join("、")}`);
}

function normalizeTransactionPayload(payload) {
  const direction = payload.direction || "支出";
  return {
    id: payload.transaction_id || payload.id || undefined,
    date: payload.date,
    time: payload.time || "",
    direction,
    amount: Number(payload.amount),
    currency: String(payload.currency || "CNY").toUpperCase(),
    account_id: direction === "转账" ? null : (payload.account_id || payload.account || ""),
    from_account_id: direction === "转账" ? (payload.from_account_id || payload.from_account || "") : null,
    to_account_id: direction === "转账" ? (payload.to_account_id || payload.to_account || "") : null,
    category: payload.category || "未分类",
    name: payload.name || payload.category || "未命名流水",
    merchant: payload.merchant || "",
    member_id: payload.member_id || payload.member || "",
    source: payload.source || "dashboard",
    source_key: payload.source_key || `finance-transaction:${payload.transaction_id || payload.id || commandSafeSeed(payload)}`,
    note: payload.note || "",
    confidence: payload.confidence == null ? null : Number(payload.confidence),
    tags: Array.isArray(payload.tags) ? payload.tags : String(payload.tags || "").split(/[,，]/).map((item) => item.trim()).filter(Boolean),
    recurring_id: payload.recurring_id || null,
    purchase_session_id: payload.purchase_session_id || null,
    status: payload.status || "pending",
  };
}

function commandSafeSeed(payload) {
  return contentHash({ date: payload.date, time: payload.time, amount: payload.amount, name: payload.name, member: payload.member_id || payload.member });
}

function planCaptureFinanceTransaction(command, state) {
  const values = normalizeTransactionPayload(command.payload);
  if (!values.id) values.id = uuidFromSeed(`finance-transaction:${values.source_key}`);
  const existing = stateList(state, "finance_transaction").find((item) => item.id === values.id || (values.source_key && item.source_key === values.source_key));
  if (existing) {
    const same = contentHash({ ...existing, revision: 0, created_at: "", updated_at: "", recorded_at: "" }) === contentHash({ ...existing, ...values, id: existing.id, revision: 0, created_at: "", updated_at: "", recorded_at: "" });
    if (same) return effectSet(command, [], { summary: `财务流水已存在：${existing.id}` });
    throw new Error(`财务流水幂等冲突：${existing.id}`);
  }
  const record = recordBase("finance_transaction", values, { household_id: command.household_id, recorded_at: command.recorded_at });
  const errors = validateRecord(record);
  if (errors.length) throw new Error(errors.join("；"));
  requireFinanceAccounts(state, record);
  const event = domainEvent(command, "finance.transaction.captured", record.id, { source: record.source, status: record.status });
  return effectSet(command, [effect(record), effect(event)], { summary: `记录财务流水：${record.name}`, invariants: ["inventory_batch", "inventory_movement"] });
}

function planUpdateFinanceTransaction(command, state) {
  const current = findRecord(state, "finance_transaction", command.payload.id);
  if (Number(command.payload.expected_revision) !== Number(current.revision)) throw new Error(`版本冲突：finance_transaction/${current.id}`);
  const next = withUpdate(current, safeRecordPayload(command.payload.patch || {}), command);
  const errors = validateRecord(next);
  if (errors.length) throw new Error(errors.join("；"));
  requireFinanceAccounts(state, next);
  const event = domainEvent(command, "finance.transaction.updated", current.id, { status: next.status });
  return effectSet(command, [effect(next, current), effect(event)], { summary: `更新财务流水：${current.name}`, invariants: ["inventory_batch", "inventory_movement"] });
}

function planCreateTaskCategory(command, state) {
  const name = String(command.payload.name || "").trim();
  const routeKind = String(command.payload.route_kind || "");
  assertUniqueTaskCategoryName(state, name);
  if (!TASK_CATEGORIES.includes(routeKind)) throw new Error("分类必须映射到家庭采购、食材处理或家庭事务");
  const existingForRoute = persistedTaskCategories(state).filter((item) => item.status === "active" && item.route_kind === routeKind);
  const category = recordBase("task_category", {
    id: command.payload.id || undefined,
    name,
    route_kind: routeKind,
    sort_order: Number(command.payload.sort_order ?? existingForRoute.length),
    is_default: command.payload.is_default === true || !existingForRoute.some((item) => item.is_default),
    status: "active",
  }, { household_id: command.household_id, recorded_at: command.recorded_at });
  if (stateList(state, "task_category").some((item) => item.id === category.id)) throw new Error(`事务分类 ID 已存在：${category.id}`);
  const effects = [];
  if (category.is_default) {
    existingForRoute.filter((item) => item.is_default).forEach((item) => effects.push(effect(withUpdate(item, { is_default: false }, command), item)));
  }
  effects.push(effect(category));
  const event = domainEvent(command, "task_category.created", category.id, { name, route_kind: routeKind, is_default: category.is_default });
  effects.push(effect(event));
  return effectSet(command, effects, { summary: `新增事务分类：${name}` });
}

function planUpdateTaskCategory(command, state) {
  const current = findRecord(state, "task_category", command.payload.id);
  if (Number(command.payload.expected_revision) !== Number(current.revision)) throw new Error(`版本冲突：task_category/${current.id}`);
  const patch = safeRecordPayload(command.payload.patch || {});
  if (patch.status || patch.tombstone != null || patch.is_default != null) throw new Error("分类状态和默认分类必须使用专用命令修改");
  const routeKind = patch.route_kind || current.route_kind;
  if (!TASK_CATEGORIES.includes(routeKind)) throw new Error("分类 Apple 路由无效");
  if (routeKind !== current.route_kind) {
    if (current.is_default) throw new Error("默认分类不能直接更改 Apple 路由，请先设置新的默认分类");
    if (stateList(state, "task").some((item) => !item.tombstone && item.category_id === current.id)) throw new Error("已经被事务使用的分类不能更改 Apple 路由");
  }
  const name = patch.name == null ? current.name : String(patch.name).trim();
  assertUniqueTaskCategoryName(state, name, current.id);
  const next = withUpdate(current, {
    ...patch,
    name,
    route_kind: routeKind,
    sort_order: patch.sort_order == null ? current.sort_order : Number(patch.sort_order),
  }, command);
  const errors = validateRecord(next);
  if (errors.length) throw new Error(errors.join("；"));
  const event = domainEvent(command, "task_category.updated", current.id, { changed_fields: Object.keys(patch).sort() });
  return effectSet(command, [effect(next, current), effect(event)], { summary: `更新事务分类：${current.name}` });
}

function planSetDefaultTaskCategory(command, state) {
  const current = findRecord(state, "task_category", command.payload.id);
  if (current.status !== "active") throw new Error("停用分类不能设为默认");
  if (Number(command.payload.expected_revision) !== Number(current.revision)) throw new Error(`版本冲突：task_category/${current.id}`);
  const effects = persistedTaskCategories(state)
    .filter((item) => item.status === "active" && item.route_kind === current.route_kind && item.is_default && item.id !== current.id)
    .map((item) => effect(withUpdate(item, { is_default: false }, command), item));
  if (!current.is_default) effects.push(effect(withUpdate(current, { is_default: true }, command), current));
  effects.push(effect(domainEvent(command, "task_category.default_changed", current.id, { route_kind: current.route_kind })));
  return effectSet(command, effects, { summary: `设为默认分类：${current.name}` });
}

function planArchiveTaskCategory(command, state) {
  const current = findRecord(state, "task_category", command.payload.id);
  if (Number(command.payload.expected_revision) !== Number(current.revision)) throw new Error(`版本冲突：task_category/${current.id}`);
  if (current.is_default) throw new Error("默认分类不能停用，请先为该 Apple 路由设置新的默认分类");
  const next = withUpdate(current, { status: "archived", archived_at: command.occurred_at }, command);
  const event = domainEvent(command, "task_category.archived", current.id, {});
  return effectSet(command, [effect(next, current), effect(event)], { summary: `停用事务分类：${current.name}` });
}

function planRestoreTaskCategory(command, state) {
  const current = stateList(state, "task_category").find((item) => item.id === command.payload.id && !item.tombstone);
  if (!current) throw new Error(`找不到 task_category：${command.payload.id}`);
  if (Number(command.payload.expected_revision) !== Number(current.revision)) throw new Error(`版本冲突：task_category/${current.id}`);
  assertUniqueTaskCategoryName(state, current.name, current.id);
  const next = withUpdate(current, { status: "active", restored_at: command.occurred_at }, command);
  const event = domainEvent(command, "task_category.restored", current.id, {});
  return effectSet(command, [effect(next, current), effect(event)], { summary: `恢复事务分类：${current.name}` });
}

function planReorderTaskCategories(command, state) {
  const items = Array.isArray(command.payload.items) ? command.payload.items : [];
  if (!items.length) throw new Error("分类排序不能为空");
  const ids = new Set();
  const effects = items.map((input) => {
    if (ids.has(input.id)) throw new Error(`分类排序重复：${input.id}`);
    ids.add(input.id);
    const current = findRecord(state, "task_category", input.id);
    if (Number(input.expected_revision) !== Number(current.revision)) throw new Error(`版本冲突：task_category/${current.id}`);
    const sortOrder = Number(input.sort_order);
    if (!Number.isFinite(sortOrder)) throw new Error(`分类排序无效：${current.name}`);
    return effect(withUpdate(current, { sort_order: sortOrder }, command), current);
  });
  effects.push(effect(domainEvent(command, "task_category.reordered", command.household_id, { category_ids: [...ids] })));
  return effectSet(command, effects, { summary: "调整事务分类顺序" });
}

function planCreateTask(command, state) {
  if (!String(command.payload.title || "").trim()) throw new Error("事务标题不能为空");
  const requestedRoute = command.payload.category || null;
  const category = command.payload.category_id ? requireTaskCategory(state, command.payload.category_id, requestedRoute) : taskCategoryForRoute(state, requestedRoute || "household");
  const routeKind = category?.route_kind || requestedRoute || "household";
  const record = recordBase("task", {
    id: command.payload.task_id || command.payload.id || undefined,
    title: String(command.payload.title).trim(),
    notes: command.payload.notes || "",
    due_at: command.payload.due_at || null,
    priority: Number(command.payload.priority || 0),
    assignee_ids: command.payload.assignee_ids || [],
    source_type: command.payload.source_type || "manual",
    category: routeKind,
    category_id: category?.id || command.payload.category_id || null,
    purchase_mode: command.payload.purchase_mode || null,
    purchase_group: command.payload.purchase_group || null,
    source_ids: command.payload.source_ids || [],
    source_key: command.payload.source_key || null,
    status: command.payload.status || "open",
  }, { household_id: command.household_id, recorded_at: command.recorded_at });
  const existing = stateList(state, "task").find((item) => item.id === record.id || (record.source_key && item.source_key === record.source_key));
  if (existing) throw new Error(`事务来源键或 ID 已存在：${existing.id}`);
  const event = domainEvent(command, "task.created", record.id, { source_key: record.source_key });
  return effectSet(command, [effect(record), effect(event)], { summary: `新增事务：${record.title}` });
}

function planUpdateTask(command, state) {
  const current = findRecord(state, "task", command.payload.id);
  if (Number(command.payload.expected_revision) !== Number(current.revision)) throw new Error(`版本冲突：task/${current.id}`);
  const patch = safeRecordPayload(command.payload.patch || {});
  if (patch.category_id) {
    const category = requireTaskCategory(state, patch.category_id, patch.category || null);
    patch.category = category.route_kind;
  }
  const next = withUpdate(current, patch, command);
  const errors = validateRecord(next);
  if (errors.length) throw new Error(errors.join("；"));
  const event = domainEvent(command, "task.updated", current.id, { changed_fields: Object.keys(patch).sort(), source: command.payload.source || "family-system" });
  return effectSet(command, [effect(next, current), effect(event)], { summary: `更新事务：${current.title}` });
}

function planDeleteTask(command, state) {
  const current = findRecord(state, "task", command.payload.id);
  if (Number(command.payload.expected_revision) !== Number(current.revision)) throw new Error(`版本冲突：task/${current.id}`);
  const deletedAt = command.occurred_at || command.recorded_at;
  const next = withUpdate(current, {
    tombstone: true,
    status: "cancelled",
    deleted_at: deletedAt,
    deleted_by: command.actor_id,
    previous_status: current.status,
  }, command);
  const event = domainEvent(command, "task.deleted", current.id, {
    previous_status: current.status,
    source_key: current.source_key || null,
    source_type: current.source_type || null,
  });
  return effectSet(command, [effect(next, current), effect(event)], {
    summary: `删除事务：${current.title}`,
    invariants: ["purchase_demand", "receipt", "inventory_batch", "inventory_movement", "finance_transaction"],
  });
}

function planCreateManualPurchase(command, state) {
  const mode = String(command.payload.purchase_mode || "");
  if (!PURCHASE_MODES.includes(mode)) throw new Error("请选择仅购物提醒或纳入库存");
  const category = requireTaskCategory(state, command.payload.category_id, "purchase");
  if (mode === "reminder_only") {
    return planCreateTask({
      ...command,
      payload: {
        ...command.payload,
        category: "purchase",
        category_id: category.id,
        purchase_mode: mode,
        source_type: "manual_purchase",
        title: String(command.payload.title || command.payload.item_name || "").trim(),
      },
    }, state);
  }

  const quantity = Number(command.payload.quantity);
  const unit = String(command.payload.unit || "").trim();
  if (!Number.isFinite(quantity) || quantity <= 0) throw new Error("采购数量必须大于 0");
  if (!unit) throw new Error("采购单位不能为空");
  const effects = [];
  let item = null;
  if (command.payload.item_entity_id) {
    item = findRecord(state, "entity", command.payload.item_entity_id);
    if (!["ingredient_item", "inventory_item"].includes(item.entity_kind)) throw new Error("所选实体不是可采购库存物品");
  } else {
    const input = command.payload.new_item || {};
    const name = String(input.name || command.payload.item_name || "").trim();
    const canonicalUnit = String(input.canonical_unit || unit).trim();
    const purchaseGroup = String(input.purchase_group || command.payload.purchase_group || "未分类").trim() || "未分类";
    const trackingPolicy = String(input.tracking_policy || "estimated");
    if (!name) throw new Error("新物品名称不能为空");
    if (!canonicalUnit) throw new Error("新物品标准单位不能为空");
    if (!["exact_unit", "estimated", "manual_depletion"].includes(trackingPolicy)) throw new Error("库存策略无效");
    const duplicate = active(stateList(state, "entity")).find((entry) => ["ingredient_item", "inventory_item"].includes(entry.entity_kind) && normalizedActiveName(entry.name) === normalizedActiveName(name));
    if (duplicate) throw new Error(`物品已存在，请改为选择现有物品：${duplicate.name}`);
    item = recordBase("entity", {
      id: input.id || uuidFromSeed(`inventory-item:${command.id}:${name}`),
      entity_kind: "inventory_item",
      name,
      category: input.category || "家庭物品",
      canonical_unit: canonicalUnit,
      unit: canonicalUnit,
      purchase_group: purchaseGroup,
      tracking_policy: trackingPolicy,
      package_conversions: Array.isArray(input.package_conversions) ? input.package_conversions : [],
      min_quantity: Number(input.min_quantity || 0),
      target_quantity: Number(input.target_quantity || 0),
      status: "active",
    }, { household_id: command.household_id, recorded_at: command.recorded_at });
    effects.push(effect(item));
  }

  const itemName = String(item.name || command.payload.item_name || "").trim();
  const demandId = command.payload.purchase_demand_id || uuidFromSeed(`manual-purchase-demand:${command.id}`);
  const demand = recordBase("purchase_demand", {
    id: demandId,
    item_entity_id: item.id,
    item_name: itemName,
    ingredient_id: item.id,
    ingredient_name: itemName,
    quantity,
    unit,
    note: command.payload.notes || "",
    planned_admission: true,
    due_at: command.payload.due_at || null,
    priority: Number(command.payload.priority || 0) > 0 ? "high" : "normal",
    requirement_ids: [],
    source_type: "manual",
    source_key: command.payload.source_key || `manual-purchase:${demandId}`,
    status: "open",
  }, { household_id: command.household_id, recorded_at: command.recorded_at });
  const task = recordBase("task", {
    id: command.payload.task_id || uuidFromSeed(`manual-purchase-task:${demand.id}`),
    title: String(command.payload.title || `采购：${itemName}`).trim(),
    notes: command.payload.notes || "",
    due_at: demand.due_at,
    priority: Number(command.payload.priority || 0),
    assignee_ids: command.payload.assignee_ids || [],
    source_type: "purchase_demand",
    source_id: demand.id,
    source_ids: [demand.id],
    source_key: `purchase:${demand.id}`,
    category: "purchase",
    category_id: category.id,
    purchase_mode: mode,
    purchase_group: item.purchase_group || "未分类",
    status: "open",
  }, { household_id: command.household_id, recorded_at: command.recorded_at });
  const event = domainEvent(command, "purchase.manual_planned", demand.id, { item_entity_id: item.id, task_id: task.id, created_item: effects.length > 0 });
  effects.push(effect(demand), effect(task));
  effects.push(effect(relationship({ household_id: command.household_id, recorded_at: command.recorded_at }, demand.id, item.id, "purchase_targets_item", event.id)));
  effects.push(effect(relationship({ household_id: command.household_id, recorded_at: command.recorded_at }, task.id, demand.id, "task_projects_demand", event.id)));
  effects.push(effect(event));
  return effectSet(command, effects, {
    summary: `新增纳入库存采购：${itemName}`,
    invariants: ["finance_transaction", "receipt", "inventory_batch", "inventory_movement"],
  });
}

function planAppleProjectionEvent(command, state) {
  const payload = command.payload || {};
  const task = stateList(state, "task").find((item) => item.id === payload.task_id || (payload.source_key && item.source_key === payload.source_key));
  if (!task) throw new Error(`Apple 投影事件找不到事务：${payload.task_id || payload.source_key || "unknown"}`);
  const eventType = String(payload.event_type || "");
  const externalEventId = payload.event_id || command.id;
  const previouslyRecorded = stateList(state, "domain_event").find((item) => item.payload?.event_id === externalEventId);
  if (previouslyRecorded) return effectSet(command, [], { summary: `Apple 事件已处理：${task.title}` });
  if (task.tombstone) {
    const effects = [];
    if (eventType === "completed") {
      const decision = recordBase("decision_request", {
        id: uuidFromSeed(`apple-completed-after-task-deleted:${externalEventId}:${task.id}`),
        title: `已删除事务收到 Apple 完成证据：${task.title}`,
        reason: "Life Core 事务已先删除，不能再静默推断采购、实收、库存或普通事务完成。",
        decision_type: "apple_completion_after_task_deleted",
        subject_id: task.id,
        known_facts: ["Life Core 事务已删除", "Apple 投影报告已完成"],
        unknowns: ["现实中是否已执行", "是否需要补记对应事实"],
        status: "open",
      }, { household_id: command.household_id, recorded_at: command.recorded_at });
      if (!stateList(state, "decision_request").some((item) => item.id === decision.id && !item.tombstone)) effects.push(effect(decision));
    } else if (eventType !== "deleted") {
      throw new Error(`不支持的 Apple 投影事件：${eventType}`);
    }
    effects.push(effect(domainEvent(command, `apple.projection.${eventType}`, task.id, {
      event_id: externalEventId,
      source_key: payload.source_key || task.source_key,
      resulting_status: "task_deleted",
      task_deleted: true,
    })));
    return effectSet(command, effects, {
      summary: eventType === "deleted" ? `确认已删除事务的 Apple 投影已移除：${task.title}` : `记录已删除事务的 Apple 完成证据：${task.title}`,
      invariants: ["purchase_demand", "receipt", "inventory_batch", "inventory_movement", "finance_transaction"],
    });
  }
  const effects = [];
  let nextStatus = task.status;
  let decision = null;
  let receiptId = null;
  if (eventType === "completed" && task.source_type === "purchase_demand") {
    const demandId = task.source_id || (task.source_ids || [])[0];
    const demand = findRecord(state, "purchase_demand", demandId);
    nextStatus = "receipt_confirmed";
    if (demand.status !== "fulfilled") {
      const received = receiptEffects(command, state, demand, {
        actual_name: demandItemName(demand),
        quantity: demand.quantity,
        unit: demand.unit,
        tracking_policy: "estimated",
      }, { identity: `apple:${externalEventId}:${demand.id}`, confirmation_mode: "apple_auto" });
      receiptId = received.receipt?.id || null;
      effects.push(...received.effects);
      const taskEffect = effects.find((item) => item.record_type === "task" && item.record.id === task.id);
      if (taskEffect) taskEffect.record = {
        ...taskEffect.record,
        apple_event_id: externalEventId,
        apple_event_at: payload.occurred_at || command.occurred_at,
      };
    } else {
      receiptId = demand.receipt_id || null;
    }
  } else if (eventType === "completed") {
    nextStatus = "completed";
  } else if (eventType === "deleted") {
    nextStatus = "projection_paused";
    decision = recordBase("decision_request", {
      id: uuidFromSeed(`apple-projection-deleted:${payload.event_id || command.id}:${task.id}`),
      title: `Apple 投影被删除：${task.title}`,
      reason: "Apple 删除只暂停投影，不能直接删除 Life Core 权威事务。",
      decision_type: "apple_projection_deleted",
      subject_id: task.id,
      known_facts: ["Apple 投影已删除"],
      unknowns: ["是否重新投影", "是否取消权威事务"],
      status: "open",
    }, { household_id: command.household_id, recorded_at: command.recorded_at });
  } else {
    throw new Error(`不支持的 Apple 投影事件：${eventType}`);
  }
  const hasTaskEffect = effects.some((item) => item.record_type === "task" && item.record.id === task.id);
  if (!hasTaskEffect && (task.status !== nextStatus || task.apple_event_id !== externalEventId)) effects.push(effect(withUpdate(task, { status: nextStatus, apple_event_id: externalEventId, apple_event_at: payload.occurred_at || command.occurred_at }, command), task));
  if (decision && !stateList(state, "decision_request").some((item) => item.id === decision.id && !item.tombstone)) effects.push(effect(decision));
  effects.push(effect(domainEvent(command, `apple.projection.${eventType}`, task.id, {
    event_id: externalEventId,
    source_key: payload.source_key || task.source_key,
    resulting_status: nextStatus,
    receipt_id: receiptId,
    idempotent: eventType === "completed" && task.source_type === "purchase_demand" && !receiptId,
  })));
  const invariants = eventType === "completed" && task.source_type === "purchase_demand"
    ? ["finance_transaction"]
    : ["receipt", "inventory_batch", "inventory_movement", "finance_transaction"];
  return effectSet(command, dedupeEffects(effects), { summary: eventType === "deleted" ? `暂停 Apple 投影：${task.title}` : `接收 Apple 完成状态：${task.title}`, invariants });
}

function reconcileMealHandlingTasks(plan, state, command, actions) {
  const desiredActions = (actions || plan.handling_actions || []).filter((item) => item.task_required !== false && item.status !== "cancelled" && item.scheduled_at);
  const currentTasks = stateList(state, "task").filter((item) => item.source_type === "meal_handling" && item.source_plan_id === plan.id);
  const retainedTaskIds = new Set();
  const effects = [];
  for (const action of desiredActions) {
    const taskId = uuidFromSeed(`meal-handling-task:${plan.id}:${action.id}`);
    const previous = currentTasks.find((item) => item.id === taskId || item.handling_action_id === action.id);
    retainedTaskIds.add(previous?.id || taskId);
    if (previous && previous.status === "completed") continue;
    const values = {
      title: action.title,
      notes: handlingActionNotes(action, plan.handling_instructions || []),
      due_at: action.scheduled_at,
      priority: Number(action.priority || 0),
      assignee_ids: action.assignee_ids || [],
      source_type: "meal_handling",
      category: "meal_handling",
      category_id: categoryIdForRoute(state, "meal_handling"),
      source_ids: [plan.id, ...(action.related_meal_ids || [])],
      source_plan_id: plan.id,
      handling_action_id: action.id,
      source_key: `task:${taskId}`,
      status: previous && !["cancelled", "archived"].includes(previous.status) ? previous.status : "open",
      tombstone: false,
    };
    const task = previous
      ? withUpdate(previous, values, command)
      : recordBase("task", { id: taskId, ...values }, { household_id: command.household_id, recorded_at: command.recorded_at });
    effects.push(effect(task, previous, "同步菜单食材处理任务"));
  }
  currentTasks.filter((item) => !retainedTaskIds.has(item.id) && !item.tombstone && item.status !== "completed").forEach((item) => {
    effects.push(effect(withUpdate(item, {
      status: "cancelled",
      tombstone: true,
      cancelled_at: command.occurred_at,
      cancellation_reason: "meal_handling_action_removed_or_plan_superseded",
    }, command), item, "取消失效的菜单食材处理任务"));
  });
  return effects;
}

function refreshDraftMealFacts(plan, state, command) {
  const effects = [];
  const dishes = active(stateList(state, "dish_plan")).filter((item) => item.source_plan_id === plan.id);
  const slots = indexRecords(active(stateList(state, "meal_slot")));
  const members = new Set(active(stateList(state, "member")).map((item) => item.id));
  for (const participantId of plan.participant_ids || []) if (!members.has(participantId)) throw new Error(`菜单成员已失效：${participantId}`);
  const entities = new Set(active(stateList(state, "entity")).map((item) => item.id));
  for (const dish of dishes) {
    const recipe = findRecord(state, "recipe", dish.recipe_id);
    const slot = slots.get(dish.meal_slot_id);
    const targetServings = Number(dish.target_servings || slot?.serving_count || recipe.servings);
    const participants = dish.participant_ids?.length ? dish.participant_ids : plan.participant_ids || [];
    const constraintResult = evaluateRecipeConstraints(recipe, participants, state);
    if (constraintResult.blocking.length) throw new Error(`硬安全约束阻止激活：${constraintResult.blocking.join("；")}`);
    for (const ingredient of recipe.ingredients || []) {
      if (ingredient.inventory_policy !== "untracked_consumable" && ingredient.item_entity_id && !entities.has(ingredient.item_entity_id)) {
        throw new Error(`菜谱 ${recipe.name} 引用了已失效物品：${ingredient.item_entity_id}`);
      }
    }
    if (contentHash(dish.constraint_warnings || []) !== contentHash(constraintResult.warnings || [])) {
      effects.push(effect(withUpdate(dish, { constraint_warnings: constraintResult.warnings }, command), dish, "激活时刷新安全约束"));
    }
    const current = stateList(state, "ingredient_requirement").filter((item) => item.dish_plan_id === dish.id && !item.tombstone);
    const desiredIds = new Set();
    for (const ingredient of recipe.ingredients || []) {
      const id = createId("requirement", `${dish.id}:${ingredient.id}`);
      desiredIds.add(id);
      const previous = current.find((item) => item.id === id);
      const values = {
        dish_plan_id: dish.id,
        meal_slot_id: dish.meal_slot_id,
        ingredient_id: ingredient.id,
        item_entity_id: ingredient.item_entity_id || ingredient.id,
        ingredient_name: ingredient.name,
        quantity: scaledIngredientQuantity(ingredient.quantity, targetServings, recipe.servings),
        unit: ingredient.unit || "份",
        specificity: ingredient.specificity || "general",
        inventory_policy: ingredient.inventory_policy || "tracked",
        status: "required",
        source_plan_id: plan.id,
        tombstone: false,
      };
      const requirement = previous
        ? withUpdate(previous, values, command)
        : recordBase("ingredient_requirement", { id, ...values }, { household_id: command.household_id, recorded_at: command.recorded_at });
      if (!previous || contentHash(values) !== contentHash(Object.fromEntries(Object.keys(values).map((key) => [key, previous[key]])))) {
        effects.push(effect(requirement, previous, "激活时按当前菜谱冻结食材实例"));
      }
    }
    current.filter((item) => !desiredIds.has(item.id)).forEach((item) => {
      effects.push(effect(withUpdate(item, { status: "cancelled", tombstone: true, archived_at: command.occurred_at }, command), item, "激活时归档已移除食材实例"));
    });
  }
  return effects;
}

function stateWithEffects(state, effects) {
  const next = { ...state };
  for (const item of effects || []) {
    if (!item.record_type || !item.record || item.record_type === "domain_event") continue;
    if (!next[item.record_type]) next[item.record_type] = [];
    else if (next[item.record_type] === state[item.record_type]) next[item.record_type] = [...next[item.record_type]];
    const index = next[item.record_type].findIndex((record) => record.id === item.record.id);
    if (index >= 0) next[item.record_type][index] = item.record;
    else next[item.record_type].push(item.record);
  }
  return next;
}

function menuGenerationPattern(mealLabel) {
  if (mealLabel === "早餐" || mealLabel === "加餐") return [["*"]];
  return [["主菜", "配菜", "主食"], ["一餐式", "配菜"], ["一餐式", "汤羹"]];
}

function menuGenerationWeights(strategy) {
  return MENU_STRATEGY_WEIGHTS[MENU_GENERATION_STRATEGIES.includes(strategy) ? strategy : "balanced"];
}

function daysBetween(left, right) {
  return Math.abs(new Date(`${left}T00:00:00.000Z`).getTime() - new Date(`${right}T00:00:00.000Z`).getTime()) / 86400000;
}

function recipeInventoryCoverage(recipe, state, targetServings) {
  const ingredients = Array.isArray(recipe.ingredients) ? recipe.ingredients : [];
  if (!ingredients.length) return 0;
  const scale = servingScale(targetServings, recipe.servings);
  let tracked = 0;
  let coverage = 0;
  ingredients.forEach((ingredient) => {
    if (String(ingredient.inventory_policy || "tracked").startsWith("untracked")) return;
    const itemId = ingredient.item_entity_id || ingredient.id;
    const required = roundMenuQuantity(Number(ingredient.quantity || 0) * scale);
    if (!itemId || required <= 0) return;
    tracked += 1;
    coverage += Math.min(1, inventoryAvailable(state, itemId, ingredient.unit || "份") / required);
  });
  return tracked ? coverage / tracked : 0;
}

function normalizeMenuGenerationInput(payload, state) {
  const source = payload?.plan || payload || {};
  const rangeStart = source.range_start || source.week_start;
  const rangeEnd = source.range_end || (validDateKey(rangeStart) ? addDateDays(rangeStart, 6) : "");
  const dates = dateRangeInclusive(rangeStart, rangeEnd);
  const activeMemberIds = new Set(active(stateList(state, "member")).map((item) => item.id));
  const participantIds = Array.isArray(source.participant_ids) && source.participant_ids.length
    ? [...new Set(source.participant_ids.map(String))]
    : [...activeMemberIds];
  participantIds.forEach((id) => {
    if (!activeMemberIds.has(id)) throw new Error(`菜单成员已失效：${id}`);
  });
  const guestCount = Number(source.guest_count || 0);
  if (!Number.isInteger(guestCount) || guestCount < 0) throw new Error("访客人数必须是非负整数");
  const defaultServingCount = Number(source.default_serving_count || participantIds.length + guestCount);
  if (!Number.isFinite(defaultServingCount) || defaultServingCount <= 0) throw new Error("菜单人数必须大于 0");
  const mealTypes = [...new Set((Array.isArray(source.meal_types) ? source.meal_types : ["午餐", "晚餐"]).map(String))];
  if (!mealTypes.length || mealTypes.some((item) => !MENU_MEAL_TYPES.includes(item))) throw new Error("请选择有效餐次");
  const strategy = MENU_GENERATION_STRATEGIES.includes(source.generation_strategy) ? source.generation_strategy : "balanced";
  const maxPrep = source.max_prep_minutes == null || source.max_prep_minutes === "" ? null : Number(source.max_prep_minutes);
  if (maxPrep != null && (!Number.isFinite(maxPrep) || maxPrep <= 0)) throw new Error("最大制作时间必须大于 0");
  const avoidRepeatDays = Math.max(0, Number(source.avoid_repeat_days == null ? 7 : source.avoid_repeat_days));
  if (!Number.isFinite(avoidRepeatDays)) throw new Error("避免重复天数无效");
  const dailyOverrides = source.daily_meal_overrides && typeof source.daily_meal_overrides === "object" ? source.daily_meal_overrides : {};
  const servingOverrides = source.serving_overrides && typeof source.serving_overrides === "object" ? source.serving_overrides : {};
  Object.keys(dailyOverrides).forEach((date) => {
    if (!dates.includes(date)) throw new Error(`逐日餐次覆盖超出菜单区间：${date}`);
    if (!Array.isArray(dailyOverrides[date]) || dailyOverrides[date].some((item) => !MENU_MEAL_TYPES.includes(item))) throw new Error(`逐日餐次覆盖无效：${date}`);
  });
  Object.entries(servingOverrides).forEach(([key, value]) => {
    const [date, mealLabel] = key.split("|");
    if (!dates.includes(date) || !MENU_MEAL_TYPES.includes(mealLabel) || !Number.isFinite(Number(value)) || Number(value) <= 0) throw new Error(`单餐人数覆盖无效：${key}`);
  });
  return {
    ...source,
    range_start: rangeStart,
    range_end: rangeEnd,
    week_start: source.week_start || rangeStart,
    dates,
    participant_ids: participantIds,
    guest_count: guestCount,
    default_serving_count: defaultServingCount,
    meal_types: mealTypes,
    generation_strategy: strategy,
    max_prep_minutes: maxPrep,
    avoid_repeat_days: avoidRepeatDays,
    excluded_recipe_ids: [...new Set((source.excluded_recipe_ids || []).map(String))],
    excluded_tags: [...new Set((source.excluded_tags || []).map((item) => String(item).trim()).filter(Boolean))],
    daily_meal_overrides: dailyOverrides,
    serving_overrides: servingOverrides,
    generation_seed: String(source.generation_seed || source.id || payload?.command_id || `${rangeStart}:${rangeEnd}`),
  };
}

function recipeGenerationScore(recipe, context) {
  const { config, date, mealLabel, targetServings, state, recipeUsage, tagUsage } = context;
  const weights = menuGenerationWeights(config.generation_strategy);
  const lastDate = recipeUsage.get(recipe.id)?.last_date || null;
  const repeatDistance = lastDate ? daysBetween(lastDate, date) : config.avoid_repeat_days;
  const repeatScore = config.avoid_repeat_days <= 0 ? 1 : Math.min(1, repeatDistance / config.avoid_repeat_days);
  const tags = [...new Set([recipe.category, ...(recipe.tags || [])].filter(Boolean))];
  const usedTags = tags.reduce((sum, tag) => sum + Number(tagUsage.get(tag) || 0), 0);
  const varietyScore = 1 / (1 + usedTags / Math.max(1, tags.length));
  const inventoryScore = recipeInventoryCoverage(recipe, state, targetServings);
  const prepCeiling = config.max_prep_minutes || Math.max(120, Number(recipe.prep_minutes || 0));
  const timeScore = Math.max(0, 1 - (Number(recipe.prep_minutes || prepCeiling) / prepCeiling));
  const stableTie = fnv1a(`${config.generation_seed}:${date}:${mealLabel}:${recipe.id}`) / 0xffffffff;
  return (weights.repeat * repeatScore) + (weights.variety * varietyScore) + (weights.inventory * inventoryScore) + (weights.time * timeScore) + (stableTie * 0.0001);
}

function eligibleGenerationRecipes(state, config, mealLabel) {
  const excludedIds = new Set(config.excluded_recipe_ids);
  const excludedTags = new Set(config.excluded_tags.map((item) => item.toLocaleLowerCase("zh-CN")));
  return active(stateList(state, "recipe")).filter((recipe) => {
    if (excludedIds.has(recipe.id)) return false;
    if (!(recipe.meal_types || []).includes(mealLabel)) return false;
    if (config.max_prep_minutes != null && Number(recipe.prep_minutes || Infinity) > config.max_prep_minutes) return false;
    const tags = [recipe.category, ...(recipe.tags || []), ...(recipe.allergen_tags || [])].map((item) => String(item).toLocaleLowerCase("zh-CN"));
    if (tags.some((tag) => excludedTags.has(tag))) return false;
    return evaluateRecipeConstraints(recipe, config.participant_ids, state).blocking.length === 0;
  });
}

function chooseGeneratedMeal(recipes, context) {
  const patterns = menuGenerationPattern(context.mealLabel);
  const candidates = [];
  patterns.forEach((pattern, patternIndex) => {
    const selected = [];
    let score = 0;
    for (const category of pattern) {
      const pool = recipes.filter((recipe) => !selected.some((item) => item.id === recipe.id) && (category === "*" || recipe.category === category));
      if (!pool.length) return;
      pool.sort((left, right) => recipeGenerationScore(right, context) - recipeGenerationScore(left, context) || String(left.id).localeCompare(String(right.id)));
      const recipe = pool[0];
      selected.push(recipe);
      score += recipeGenerationScore(recipe, context);
    }
    candidates.push({ recipes: selected, score, pattern_index: patternIndex, pattern });
  });
  candidates.sort((left, right) => right.score - left.score || left.pattern_index - right.pattern_index);
  return candidates[0] || null;
}

function buildGeneratedRequirement(dish, slot, recipe, ingredient, command) {
  const itemId = ingredient.item_entity_id || ingredient.id;
  return recordBase("ingredient_requirement", {
    id: createId("requirement", `${dish.id}:${ingredient.id}`),
    dish_plan_id: dish.id,
    meal_slot_id: slot.id,
    ingredient_id: ingredient.id,
    item_entity_id: itemId || null,
    ingredient_name: ingredient.name,
    quantity: scaledIngredientQuantity(ingredient.quantity, dish.target_servings, recipe.servings),
    unit: ingredient.unit || "份",
    specificity: ingredient.specificity || "general",
    inventory_policy: ingredient.inventory_policy || "tracked",
    status: "required",
    source_plan_id: dish.source_plan_id,
  }, { household_id: command.household_id, recorded_at: command.recorded_at });
}

function generateMealPlanDraftRecords(command, state, requestedPlanId) {
  const config = normalizeMenuGenerationInput(command.payload, state);
  const planId = requestedPlanId || config.id || createId("meal-plan", command.id);
  const recipeUsage = new Map();
  const tagUsage = new Map();
  const warnings = [];
  const records = [];
  const generationOptions = {
    meal_types: config.meal_types,
    generation_strategy: config.generation_strategy,
    max_prep_minutes: config.max_prep_minutes,
    avoid_repeat_days: config.avoid_repeat_days,
    excluded_recipe_ids: config.excluded_recipe_ids,
    excluded_tags: config.excluded_tags,
    daily_meal_overrides: config.daily_meal_overrides,
    serving_overrides: config.serving_overrides,
    generation_seed: config.generation_seed,
    weights: menuGenerationWeights(config.generation_strategy),
  };
  const plan = recordBase("meal_plan", {
    id: planId,
    title: config.title || `${config.range_start} 至 ${config.range_end} 自动菜单`,
    week_start: config.week_start,
    range_start: config.range_start,
    range_end: config.range_end,
    status: "draft",
    participant_ids: config.participant_ids,
    guest_count: config.guest_count,
    default_serving_count: config.default_serving_count,
    generation_strategy: config.generation_strategy,
    generation_options: generationOptions,
    generation_revision: Number(config.generation_revision || 1),
    generation_warnings: warnings,
    handling_instructions: normalizeHandlingInstructions(config.handling_instructions || [], planId),
    handling_actions: normalizeHandlingActions(config.handling_actions || [], planId),
  }, { household_id: command.household_id, recorded_at: command.recorded_at });
  records.push(plan);
  config.dates.forEach((date) => {
    const mealTypes = Object.prototype.hasOwnProperty.call(config.daily_meal_overrides, date) ? config.daily_meal_overrides[date] : config.meal_types;
    mealTypes.forEach((mealLabel) => {
      const servingCount = Number(config.serving_overrides[`${date}|${mealLabel}`] || config.default_serving_count);
      const slot = recordBase("meal_slot", {
        id: createId("meal-slot", `${planId}:${date}:${mealLabel}`),
        planned_date: date,
        meal_label: mealLabel,
        participant_ids: config.participant_ids,
        guest_count: config.guest_count,
        serving_count: servingCount,
        locked: false,
        generation_status: "complete",
        generation_message: "",
        status: "planned",
        source_plan_id: planId,
      }, { household_id: command.household_id, recorded_at: command.recorded_at });
      const recipes = eligibleGenerationRecipes(state, config, mealLabel);
      const chosen = chooseGeneratedMeal(recipes, { config, date, mealLabel, targetServings: servingCount, state, recipeUsage, tagUsage });
      if (!chosen) {
        slot.generation_status = "gap";
        slot.generation_message = `没有同时满足 ${mealLabel}、成员安全约束和餐次模板的现有菜谱`;
        warnings.push(`${date} ${mealLabel}：${slot.generation_message}`);
        records.push(slot);
        return;
      }
      slot.generation_pattern = chosen.pattern;
      records.push(slot);
      chosen.recipes.forEach((recipe, index) => {
        const constraintResult = evaluateRecipeConstraints(recipe, config.participant_ids, state);
        const dish = recordBase("dish_plan", {
          id: createId("dish", `${slot.id}:${index}:${recipe.id}`),
          recipe_id: recipe.id,
          meal_slot_id: slot.id,
          participant_ids: config.participant_ids,
          target_servings: servingCount,
          planned_at: `${slot.planned_date}T00:00:00`,
          status: "planned",
          constraint_warnings: constraintResult.warnings,
          source_plan_id: planId,
          generation_source: "automatic_menu_v1",
          generation_score: roundMenuQuantity(recipeGenerationScore(recipe, { config, date, mealLabel, targetServings: servingCount, state, recipeUsage, tagUsage })),
        }, { household_id: command.household_id, recorded_at: command.recorded_at });
        records.push(dish);
        (recipe.ingredients || []).forEach((ingredient) => records.push(buildGeneratedRequirement(dish, slot, recipe, ingredient, command)));
        recipeUsage.set(recipe.id, { last_date: date, count: Number(recipeUsage.get(recipe.id)?.count || 0) + 1 });
        [...new Set([recipe.category, ...(recipe.tags || [])].filter(Boolean))].forEach((tag) => tagUsage.set(tag, Number(tagUsage.get(tag) || 0) + 1));
      });
    });
  });
  plan.generation_warnings = [...warnings];
  const errors = records.flatMap((record) => validateRecord(record).map((message) => `${record.record_type}/${record.id}：${message}`));
  if (errors.length) throw new Error(errors.join("；"));
  return { config, plan, records, warnings };
}

function planGenerateMealPlan(command, state) {
  const generated = generateMealPlanDraftRecords(command, state);
  return effectSet(command, generated.records.map((record) => effect(record)), {
    summary: `生成菜单草稿：${generated.config.range_start} 至 ${generated.config.range_end}`,
    warnings: generated.warnings,
    invariants: ["purchase_demand", "task", "receipt", "inventory_batch", "inventory_movement", "finance_transaction"],
  });
}

function planRegenerateMealPlan(command, state) {
  const currentPlan = findRecord(state, "meal_plan", command.payload.id);
  if (currentPlan.status !== "draft") throw new Error("只有菜单草稿可以重新生成");
  if (Number(command.payload.expected_revision) !== Number(currentPlan.revision)) throw new Error(`版本冲突：meal_plan/${currentPlan.id}`);
  const options = currentPlan.generation_options || {};
  const generated = generateMealPlanDraftRecords({
    ...command,
    payload: {
      ...currentPlan,
      ...options,
      ...command.payload,
      id: currentPlan.id,
      plan: undefined,
      generation_revision: Number(currentPlan.generation_revision || 1) + 1,
    },
  }, state, currentPlan.id);
  const targetIds = new Set((command.payload.meal_slot_ids || active(stateList(state, "meal_slot")).filter((slot) => slot.source_plan_id === currentPlan.id && !slot.locked).map((slot) => slot.id)).map(String));
  const currentSlots = active(stateList(state, "meal_slot")).filter((slot) => slot.source_plan_id === currentPlan.id);
  const lockedIds = new Set(currentSlots.filter((slot) => slot.locked).map((slot) => slot.id));
  const actualTargets = new Set([...targetIds].filter((id) => !lockedIds.has(id)));
  if (!actualTargets.size) throw new Error("没有可重新生成的未锁定餐次");
  const nextById = new Map(generated.records.map((record) => [record.id, record]));
  const effects = [];
  const nextPlan = withUpdate(currentPlan, {
    generation_revision: Number(currentPlan.generation_revision || 1) + 1,
    generation_warnings: generated.warnings,
  }, command);
  effects.push(effect(nextPlan, currentPlan));
  currentSlots.filter((slot) => actualTargets.has(slot.id)).forEach((slot) => {
    const next = nextById.get(slot.id);
    if (!next) throw new Error(`重新生成结果缺少餐次：${slot.id}`);
    effects.push(effect(withUpdate(slot, {
      generation_status: next.generation_status,
      generation_message: next.generation_message,
      generation_pattern: next.generation_pattern || null,
    }, command), slot));
  });
  const currentDishes = active(stateList(state, "dish_plan")).filter((dish) => dish.source_plan_id === currentPlan.id && actualTargets.has(dish.meal_slot_id));
  const currentDishIds = new Set(currentDishes.map((dish) => dish.id));
  const nextDishes = generated.records.filter((record) => record.record_type === "dish_plan" && actualTargets.has(record.meal_slot_id));
  const nextDishIds = new Set(nextDishes.map((dish) => dish.id));
  currentDishes.filter((dish) => !nextDishIds.has(dish.id)).forEach((dish) => effects.push(effect(withUpdate(dish, { status: "archived", tombstone: true }, command), dish)));
  nextDishes.forEach((dish) => {
    const before = currentDishes.find((item) => item.id === dish.id) || null;
    effects.push(effect(before ? withUpdate(before, { ...dish, revision: before.revision, created_at: before.created_at, tombstone: false }, command) : dish, before));
  });
  const currentRequirements = active(stateList(state, "ingredient_requirement")).filter((item) => currentDishIds.has(item.dish_plan_id));
  const nextRequirements = generated.records.filter((record) => record.record_type === "ingredient_requirement" && nextDishIds.has(record.dish_plan_id));
  const nextRequirementIds = new Set(nextRequirements.map((item) => item.id));
  currentRequirements.filter((item) => !nextRequirementIds.has(item.id)).forEach((item) => effects.push(effect(withUpdate(item, { status: "cancelled", tombstone: true }, command), item)));
  nextRequirements.forEach((item) => {
    const before = currentRequirements.find((record) => record.id === item.id) || null;
    effects.push(effect(before ? withUpdate(before, { ...item, revision: before.revision, created_at: before.created_at, tombstone: false }, command) : item, before));
  });
  return effectSet(command, effects, {
    summary: `重新生成 ${actualTargets.size} 个餐次`,
    warnings: generated.warnings,
    invariants: ["purchase_demand", "task", "receipt", "inventory_batch", "inventory_movement", "finance_transaction"],
  });
}

function planSetMealSlotLock(command, state) {
  const slot = findRecord(state, "meal_slot", command.payload.id);
  const plan = findRecord(state, "meal_plan", slot.source_plan_id);
  if (plan.status !== "draft") throw new Error("只有菜单草稿可以锁定餐次");
  if (Number(command.payload.expected_revision) !== Number(slot.revision)) throw new Error(`版本冲突：meal_slot/${slot.id}`);
  const next = withUpdate(slot, { locked: command.payload.locked !== false }, command);
  return effectSet(command, [effect(next, slot)], { summary: `${next.locked ? "锁定" : "解锁"} ${slot.planned_date} ${slot.meal_label}` });
}

function planCreateMealPlan(command, state) {
  const source = command.payload.plan || command.payload;
  const rangeStart = source.range_start || source.week_start;
  const rangeEnd = source.range_end || (validDateKey(rangeStart) ? addDateDays(rangeStart, 6) : "");
  dateRangeInclusive(rangeStart, rangeEnd);
  const planId = source.id || createId("meal-plan", command.id);
  const record = recordBase("meal_plan", {
    id: planId,
    title: source.title || `${rangeStart} 至 ${rangeEnd} 菜单`,
    week_start: source.week_start || rangeStart,
    range_start: rangeStart,
    range_end: rangeEnd,
    status: source.status || "draft",
    participant_ids: source.participant_ids || [],
    guest_count: Number(source.guest_count || 0),
    default_serving_count: source.default_serving_count == null ? undefined : Number(source.default_serving_count),
    handling_instructions: normalizeHandlingInstructions(source.handling_instructions || [], planId),
    handling_actions: normalizeHandlingActions(source.handling_actions || [], planId),
    source_hash: source.source_hash || null,
  }, { household_id: command.household_id, recorded_at: command.recorded_at });
  const errors = validateRecord(record);
  if (errors.length) throw new Error(errors.join("；"));
  const event = domainEvent(command, "meal_plan.created", record.id, { range_start: record.range_start, range_end: record.range_end, status: record.status });
  return effectSet(command, [effect(record), effect(event)], { summary: `建立菜单：${record.range_start} 至 ${record.range_end}` });
}

function planActivateMealPlan(command, state) {
  const plan = findRecord(state, "meal_plan", command.payload.id);
  if (plan.status !== "draft") throw new Error("只有草稿菜单可以激活");
  if (Number(command.payload.expected_revision) !== Number(plan.revision)) throw new Error(`版本冲突：meal_plan/${plan.id}`);
  const overlapping = active(stateList(state, "meal_plan")).filter((item) => item.id !== plan.id && item.status === "active" && rangesOverlap(item, plan));
  if (overlapping.length) {
    const ranges = overlapping.map((item) => {
      const range = mealPlanRange(item);
      return `${item.title || item.id}（${range.start} 至 ${range.end}）`;
    });
    throw new Error(`菜单日期与活动菜单重叠，请先调整草稿区间：${ranges.join("、")}`);
  }
  const effects = [];
  const activated = withUpdate(plan, { status: "active", activated_at: command.occurred_at }, command);
  effects.push(effect(activated, plan));
  effects.push(...refreshDraftMealFacts(plan, state, command));
  const activationState = stateWithEffects(state, effects);
  const purchasePlan = planRebuildMealPurchases({
    ...command,
    payload: { id: plan.id, expected_revision: plan.revision, default_purchase_time: command.payload.default_purchase_time },
  }, activationState);
  effects.push(...purchasePlan.effects.filter((item) => item.record_type !== "domain_event"));
  effects.push(...reconcileMealHandlingTasks(activated, activationState, command));
  const range = mealPlanRange(plan);
  effects.push(effect(domainEvent(command, "meal_plan.activated", plan.id, { range_start: range.start, range_end: range.end })));
  return effectSet(command, effects, { summary: `激活菜单：${range.start} 至 ${range.end}` });
}

function planUpdateMealPlan(command, state) {
  const plan = findRecord(state, "meal_plan", command.payload.id);
  if (Number(command.payload.expected_revision) !== Number(plan.revision)) throw new Error(`版本冲突：meal_plan/${plan.id}`);
  const allowed = new Set(["title", "participant_ids", "handling_instructions", "handling_actions"]);
  const patch = Object.fromEntries(Object.entries(command.payload.patch || {}).filter(([key]) => allowed.has(key)));
  if (Object.prototype.hasOwnProperty.call(patch, "handling_instructions")) patch.handling_instructions = normalizeHandlingInstructions(patch.handling_instructions, plan.id);
  if (Object.prototype.hasOwnProperty.call(patch, "handling_actions")) patch.handling_actions = normalizeHandlingActions(patch.handling_actions, plan.id);
  const next = withUpdate(plan, patch, command);
  const errors = validateRecord(next);
  if (errors.length) throw new Error(errors.join("；"));
  const event = domainEvent(command, "meal_plan.updated", plan.id, { changed_fields: Object.keys(patch).sort() });
  const effects = [effect(next, plan)];
  if (next.status === "active") effects.push(...reconcileMealHandlingTasks(next, state, command));
  effects.push(effect(event));
  return effectSet(command, effects, { summary: `更新一周菜单：${plan.week_start}` });
}

function planRebuildMealPurchases(command, state) {
  const plan = findRecord(state, "meal_plan", command.payload.id);
  if (Number(command.payload.expected_revision) !== Number(plan.revision)) throw new Error(`版本冲突：meal_plan/${plan.id}`);
  const slots = indexRecords(active(stateList(state, "meal_slot")));
  const planDishIds = new Set(active(stateList(state, "dish_plan")).filter((item) => item.source_plan_id === plan.id).map((item) => item.id));
  const requirements = active(stateList(state, "ingredient_requirement")).filter((item) => item.source_plan_id === plan.id || planDishIds.has(item.dish_plan_id));
  const groups = new Map();
  requirements.forEach((item) => {
    const key = `${item.ingredient_id}:${item.unit}`;
    if (!groups.has(key)) groups.set(key, { ingredient_id: item.ingredient_id, ingredient_name: item.ingredient_name, unit: item.unit, quantity: 0, requirement_ids: [], due_dates: [] });
    const group = groups.get(key);
    group.quantity += Number(item.quantity || 0);
    group.requirement_ids.push(item.id);
    const date = slots.get(item.meal_slot_id)?.planned_date;
    if (date) group.due_dates.push(date);
  });
  const currentDemands = stateList(state, "purchase_demand").filter((item) => item.source_plan_id === plan.id);
  const currentTasks = stateList(state, "task").filter((item) => item.source_type === "purchase_demand" && (item.source_plan_id === plan.id || currentDemands.some((demand) => taskProjectsDemand(item, demand.id))));
  const effects = [];
  const retainedDemandIds = new Set();
  const retainedTaskIds = new Set();
  for (const [aggregationKey, group] of groups.entries()) {
    const quantity = Math.max(0, group.quantity - inventoryAvailable(state, group.ingredient_id, group.unit));
    if (quantity <= 0) continue;
    const demandId = uuidFromSeed(`meal-plan-purchase:${plan.id}:${aggregationKey}`);
    const previousDemand = currentDemands.find((item) => item.id === demandId);
    const values = {
      source_plan_id: plan.id,
      aggregation_key: aggregationKey,
      requirement_ids: group.requirement_ids.sort(),
      ingredient_id: group.ingredient_id,
      ingredient_name: group.ingredient_name,
      item_entity_id: group.ingredient_id,
      item_name: group.ingredient_name,
      quantity,
      unit: group.unit,
      planned_admission: true,
      due_at: purchaseDeadline(group.due_dates.sort()[0] || plan.week_start, command.payload.default_purchase_time),
      status: "open",
      tombstone: false,
    };
    const demand = previousDemand
      ? withUpdate(previousDemand, values, command)
      : recordBase("purchase_demand", { id: demandId, ...values }, { household_id: command.household_id, recorded_at: command.recorded_at });
    effects.push(effect(demand, previousDemand));
    retainedDemandIds.add(demand.id);
    const taskId = uuidFromSeed(`meal-plan-purchase-task:${demand.id}`);
    const previousTask = currentTasks.find((item) => item.id === taskId);
    const taskValues = {
      source_type: "purchase_demand",
      category: "purchase",
      category_id: categoryIdForRoute(state, "purchase"),
      purchase_group: purchaseGroupFor(state, group.ingredient_id),
      source_id: demand.id,
      source_ids: [demand.id],
      source_plan_id: plan.id,
      title: `采购：${group.ingredient_name}`,
      due_at: demand.due_at,
      status: "open",
      source_key: `purchase:${demand.id}`,
      tombstone: false,
    };
    const task = previousTask
      ? withUpdate(previousTask, taskValues, command)
      : recordBase("task", { id: taskId, ...taskValues }, { household_id: command.household_id, recorded_at: command.recorded_at });
    effects.push(effect(task, previousTask));
    retainedTaskIds.add(task.id);
  }
  currentDemands.filter((item) => !retainedDemandIds.has(item.id) && !item.tombstone).forEach((item) => effects.push(effect(withUpdate(item, { status: "cancelled", tombstone: true, cancelled_at: command.occurred_at }, command), item)));
  currentTasks.filter((item) => !retainedTaskIds.has(item.id) && !item.tombstone).forEach((item) => effects.push(effect(withUpdate(item, { status: "cancelled", tombstone: true, cancelled_at: command.occurred_at }, command), item)));
  const event = domainEvent(command, "meal_plan.purchases_rebuilt", plan.id, { requirement_count: requirements.length, purchase_count: retainedDemandIds.size });
  effects.push(effect(event));
  return effectSet(command, effects, { summary: `重算一周菜单采购：${retainedDemandIds.size} 项`, invariants: ["finance_transaction", "receipt"] });
}

function planAddMember(command, state) {
  if (!command.payload.name?.trim()) throw new Error("成员名称不能为空");
  return planSimpleRecord(command, state, "member", {
    name: command.payload.name.trim(),
    role: command.payload.role || "member",
    permissions: command.payload.permissions || ["view", "submit"],
    status: "active",
  }, `新增家庭成员：${command.payload.name.trim()}`);
}

function planAddConstraint(command, state) {
  findRecord(state, "member", command.payload.member_id);
  if (!command.payload.target?.trim()) throw new Error("约束对象不能为空");
  return planSimpleRecord(command, state, "health_constraint", {
    member_id: command.payload.member_id,
    constraint_kind: command.payload.constraint_kind || "allergy",
    target: command.payload.target.trim(),
    label: command.payload.label || command.payload.target.trim(),
    effect_level: command.payload.effect_level === "soft_preference" ? "soft_preference" : "hard_constraint",
    confirmed_by: command.actor_id,
    confirmed_at: command.occurred_at,
    status: "active",
  }, "新增已确认饮食约束");
}

function planAddRecipe(command, state) {
  if (!command.household_id) throw new Error("请先建立家庭 Life Core");
  const fields = recipeFields({
    ...command.payload,
    ingredients: Array.isArray(command.payload.ingredients) ? command.payload.ingredients : parseIngredientLines(command.payload.ingredients_text),
  });
  const record = recordBase("recipe", { ...fields, status: "active" }, { household_id: command.household_id, recorded_at: command.recorded_at });
  const errors = validateRecord(record);
  if (errors.length) throw new Error(errors.join("；"));
  const event = domainEvent(command, "recipe.created", record.id, { category: record.category, meal_types: record.meal_types });
  return effectSet(command, [effect(record), effect(event)], { summary: `新增菜谱：${record.name}` });
}

function planUpdateRecipe(command, state) {
  const current = findRecord(state, "recipe", command.payload.id);
  if (Number(command.payload.expected_revision) !== Number(current.revision)) throw new Error(`版本冲突：recipe/${current.id}`);
  const allowed = new Set(["name", "category", "meal_types", "servings", "prep_minutes", "ingredients", "tags", "allergen_tags", "steps"]);
  const rawPatch = Object.fromEntries(Object.entries(command.payload.patch || {}).filter(([key]) => allowed.has(key)));
  if (!Object.keys(rawPatch).length) throw new Error("菜谱没有可保存的修改");
  const patch = recipeFields({ ...current, ...rawPatch });
  const next = withUpdate(current, patch, command);
  const errors = validateRecord(next);
  if (errors.length) throw new Error(errors.join("；"));
  const changedFields = Object.keys(rawPatch).sort();
  const event = domainEvent(command, "recipe.updated", current.id, { changed_fields: changedFields, affects_existing_meals: false });
  return effectSet(command, [effect(next, current), effect(event)], {
    summary: `更新菜谱：${next.name}（只影响以后安排的餐次）`,
    invariants: ["dish_plan", "ingredient_requirement", "purchase_demand", "task", "receipt", "inventory_batch", "inventory_movement"],
  });
}

function scheduleEffects(command, state) {
  const recipe = findRecord(state, "recipe", command.payload.recipe_id);
  const mealPlan = command.payload.meal_plan_id ? findRecord(state, "meal_plan", command.payload.meal_plan_id) : null;
  const draftPlan = mealPlan?.status === "draft";
  if (mealPlan) {
    const range = mealPlanRange(mealPlan);
    if (command.payload.planned_date < range.start || command.payload.planned_date > range.end) throw new Error("餐次日期必须位于菜单日期区间内");
  }
  const participants = command.payload.participant_ids?.length
    ? command.payload.participant_ids
    : mealPlan?.participant_ids?.length
      ? mealPlan.participant_ids
      : active(stateList(state, "member")).map((member) => member.id);
  const constraintResult = evaluateRecipeConstraints(recipe, participants, state);
  if (constraintResult.blocking.length) throw new Error(`硬安全约束阻止安排：${constraintResult.blocking.join("；")}`);
  const existingSlot = command.payload.meal_slot_id
    ? active(stateList(state, "meal_slot")).find((item) => item.id === command.payload.meal_slot_id)
    : null;
  const targetServings = Number(command.payload.target_servings || command.payload.serving_count || existingSlot?.serving_count || mealPlan?.default_serving_count || recipe.servings);
  if (!Number.isFinite(targetServings) || targetServings <= 0) throw new Error("餐次人数必须大于 0");
  const slot = existingSlot || recordBase("meal_slot", {
    id: createId("meal-slot", `${command.id}:${command.payload.planned_date}:${command.payload.meal_label}`),
    planned_date: command.payload.planned_date,
    meal_label: command.payload.meal_label || "晚餐",
    participant_ids: participants,
    guest_count: Number(command.payload.guest_count || mealPlan?.guest_count || 0),
    serving_count: targetServings,
    locked: false,
    status: "planned",
    source_plan_id: command.payload.meal_plan_id || null,
  }, { household_id: command.household_id, recorded_at: command.recorded_at });
  const dish = recordBase("dish_plan", {
    id: command.payload.dish_plan_id || createId("dish", `${command.id}:${recipe.id}`),
    recipe_id: recipe.id,
    meal_slot_id: slot.id,
    participant_ids: participants,
    target_servings: targetServings,
    planned_at: `${slot.planned_date}T00:00:00`,
    status: "planned",
    constraint_warnings: constraintResult.warnings,
    source_plan_id: command.payload.meal_plan_id || null,
  }, { household_id: command.household_id, recorded_at: command.recorded_at });
  const effects = [effect(dish)];
  if (!existingSlot) effects.unshift(effect(slot));
  const event = domainEvent(command, "dish.scheduled", dish.id, { recipe_id: recipe.id, meal_slot_id: slot.id });
  effects.push(effect(relationship({ household_id: command.household_id, recorded_at: command.recorded_at }, slot.id, dish.id, "meal_contains_dish", event.id)), effect(event));
  (recipe.ingredients || []).forEach((ingredient) => {
    const itemId = ingredient.item_entity_id || ingredient.id;
    const requirement = recordBase("ingredient_requirement", {
      id: createId("requirement", `${dish.id}:${ingredient.id}`),
      dish_plan_id: dish.id,
      meal_slot_id: slot.id,
      ingredient_id: ingredient.id,
      item_entity_id: itemId || null,
      ingredient_name: ingredient.name,
      quantity: scaledIngredientQuantity(ingredient.quantity, targetServings, recipe.servings),
      unit: ingredient.unit || "份",
      specificity: ingredient.specificity || "general",
      inventory_policy: ingredient.inventory_policy || "tracked",
      status: "required",
      source_plan_id: command.payload.meal_plan_id || null,
    }, { household_id: command.household_id, recorded_at: command.recorded_at });
    effects.push(effect(requirement));
    effects.push(effect(relationship({ household_id: command.household_id, recorded_at: command.recorded_at }, dish.id, requirement.id, "dish_requires_ingredient", event.id)));
    const missingQuantity = Math.max(0, requirement.quantity - inventoryAvailable(state, itemId, requirement.unit));
    if (missingQuantity > 0 && !draftPlan) {
      const demand = recordBase("purchase_demand", {
        id: createId("demand", requirement.id),
        requirement_id: requirement.id,
        dish_plan_id: dish.id,
        meal_slot_id: slot.id,
        ingredient_id: ingredient.id,
        ingredient_name: ingredient.name,
        item_entity_id: itemId,
        item_name: ingredient.name,
        quantity: missingQuantity,
        unit: requirement.unit,
        planned_admission: ingredient.inventory_policy !== "untracked",
        due_at: purchaseDeadline(slot.planned_date, command.payload.default_purchase_time),
        status: "open",
        source_plan_id: command.payload.meal_plan_id || null,
      }, { household_id: command.household_id, recorded_at: command.recorded_at });
      const task = recordBase("task", {
        id: createId("task", demand.id),
        source_type: "purchase_demand",
        category: "purchase",
        category_id: categoryIdForRoute(state, "purchase"),
        purchase_group: purchaseGroupFor(state, itemId),
        source_id: demand.id,
        title: `采购：${ingredient.name}`,
        due_at: demand.due_at,
        assignee_id: command.payload.assignee_id || command.actor_id,
        status: "open",
        source_key: `purchase:${demand.id}`,
        source_plan_id: command.payload.meal_plan_id || null,
      }, { household_id: command.household_id, recorded_at: command.recorded_at });
      effects.push(effect(demand), effect(task));
      effects.push(effect(relationship({ household_id: command.household_id, recorded_at: command.recorded_at }, demand.id, requirement.id, "purchase_satisfies_requirement", event.id)));
      effects.push(effect(relationship({ household_id: command.household_id, recorded_at: command.recorded_at }, task.id, demand.id, "task_projects_demand", event.id)));
    }
  });
  return { effects, warnings: constraintResult.warnings, dish, slot };
}

function planScheduleDish(command, state) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(command.payload.planned_date || "")) throw new Error("餐次日期必须是 YYYY-MM-DD");
  const planned = scheduleEffects(command, state);
  return effectSet(command, planned.effects, { warnings: planned.warnings, summary: `安排菜品到 ${planned.slot.planned_date} ${planned.slot.meal_label}` });
}

function planReschedule(command, state) {
  if (command.payload.confirmed_missing !== true) throw new Error("提醒或证据不足不能直接写成未购买，必须由用户确认现实");
  const dish = findRecord(state, "dish_plan", command.payload.dish_plan_id);
  const oldSlot = findRecord(state, "meal_slot", dish.meal_slot_id);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(command.payload.new_date || "")) throw new Error("必须指定新的餐次日期");
  const newSlot = recordBase("meal_slot", {
    id: createId("meal-slot", `${command.id}:${command.payload.new_date}:${command.payload.new_meal_label || oldSlot.meal_label}`),
    planned_date: command.payload.new_date,
    meal_label: command.payload.new_meal_label || oldSlot.meal_label,
    participant_ids: oldSlot.participant_ids || [],
    status: "planned",
    source_plan_id: oldSlot.source_plan_id || dish.source_plan_id || null,
  }, { household_id: command.household_id, recorded_at: command.recorded_at });
  const movedDish = withUpdate(dish, { meal_slot_id: newSlot.id, planned_at: `${newSlot.planned_date}T00:00:00`, status: "planned" }, command);
  const missingFact = recordBase("fact", {
    subject_id: dish.id,
    predicate: "purchase_missing",
    value: true,
    authority: "explicit_user_confirmation",
    confirmed_by: command.actor_id,
    occurred_at: command.occurred_at,
    status: "current",
  }, { household_id: command.household_id, recorded_at: command.recorded_at });
  const decision = recordBase("decision_request", {
    trigger_fact_id: missingFact.id,
    subject_ids: [dish.id],
    decided_by: command.actor_id,
    decision: "reschedule",
    decision_payload: { from_slot_id: oldSlot.id, to_slot_id: newSlot.id },
    status: "resolved",
  }, { household_id: command.household_id, recorded_at: command.recorded_at });
  const event = domainEvent(command, "dish.rescheduled", dish.id, { from_slot_id: oldSlot.id, to_slot_id: newSlot.id, decision_id: decision.id });
  const effects = [effect(newSlot), effect(movedDish, dish), effect(missingFact), effect(decision), effect(event)];
  effects.push(effect(relationship({ household_id: command.household_id, recorded_at: command.recorded_at }, newSlot.id, dish.id, "meal_contains_dish", event.id)));
  active(stateList(state, "ingredient_requirement")).filter((item) => item.dish_plan_id === dish.id).forEach((requirement) => {
    effects.push(effect(withUpdate(requirement, { meal_slot_id: newSlot.id }, command), requirement));
  });
  const movedRequirementIds = new Set(active(stateList(state, "ingredient_requirement")).filter((item) => item.dish_plan_id === dish.id).map((item) => item.id));
  active(stateList(state, "purchase_demand")).filter((item) => demandRequirementIds(item).some((id) => movedRequirementIds.has(id)) && item.status !== "fulfilled").forEach((demand) => {
    const nextDemand = withUpdate(demand, {
      meal_slot_id: newSlot.id,
      due_at: purchaseDeadline(newSlot.planned_date, command.payload.default_purchase_time),
      confirmed_missing: false,
    }, command);
    effects.push(effect(nextDemand, demand));
    active(stateList(state, "task")).filter((task) => taskProjectsDemand(task, demand.id)).forEach((task) => {
      effects.push(effect(withUpdate(task, { due_at: nextDemand.due_at, status: "open" }, command), task));
    });
  });
  return effectSet(command, effects, {
    summary: `将菜品改期到 ${newSlot.planned_date} ${newSlot.meal_label}`,
    invariants: ["inventory_batch", "inventory_movement", "finance_link"],
  });
}

function planSkipDish(command, state) {
  const dish = findRecord(state, "dish_plan", command.payload.dish_plan_id);
  const event = domainEvent(command, "dish.skipped", dish.id, { reason: command.payload.reason || "user_decision" });
  const effects = [effect(withUpdate(dish, { status: "skipped", skipped_at: command.occurred_at }, command), dish), effect(event)];
  active(stateList(state, "ingredient_requirement")).filter((item) => item.dish_plan_id === dish.id).forEach((record) => effects.push(effect(withUpdate(record, { status: "cancelled" }, command), record)));
  const skippedRequirements = active(stateList(state, "ingredient_requirement")).filter((item) => item.dish_plan_id === dish.id);
  const skippedRequirementIds = new Set(skippedRequirements.map((item) => item.id));
  const skippedQuantityByIngredient = new Map();
  skippedRequirements.forEach((item) => skippedQuantityByIngredient.set(item.ingredient_id, (skippedQuantityByIngredient.get(item.ingredient_id) || 0) + Number(item.quantity || 0)));
  active(stateList(state, "purchase_demand")).filter((item) => demandRequirementIds(item).some((id) => skippedRequirementIds.has(id)) && item.status !== "fulfilled").forEach((record) => {
    const remainingIds = demandRequirementIds(record).filter((id) => !skippedRequirementIds.has(id));
    const remainingQuantity = Math.max(0, Number(record.quantity || 0) - Number(skippedQuantityByIngredient.get(record.ingredient_id) || 0));
    const cancelled = !remainingIds.length || remainingQuantity <= 0;
    effects.push(effect(withUpdate(record, { requirement_ids: remainingIds, quantity: remainingQuantity, status: cancelled ? "cancelled" : record.status }, command), record));
    if (cancelled) active(stateList(state, "task")).filter((task) => taskProjectsDemand(task, record.id)).forEach((task) => effects.push(effect(withUpdate(task, { status: "cancelled" }, command), task)));
  });
  return effectSet(command, effects, { summary: "跳过菜品并取消未满足的专属执行前提", invariants: ["inventory_batch", "finance_link"] });
}

function assertDishCanAdapt(dish) {
  if (dish.status === "completed") throw new Error("已完成的菜品不能再调整原料");
  if (dish.status === "skipped") throw new Error("已跳过的菜品不能再调整原料");
}

function planContinueWithoutMissing(command, state) {
  const dish = findRecord(state, "dish_plan", command.payload.dish_plan_id);
  assertDishCanAdapt(dish);
  if (Number(command.payload.expected_revision) !== Number(dish.revision)) throw new Error(`版本冲突：dish_plan/${dish.id}`);
  const derived = deriveDishState(dish, state, new Date(command.occurred_at || command.recorded_at));
  const missingIds = new Set((derived.missing_requirements || []).map((item) => item.id));
  const requirements = stateList(state, "ingredient_requirement").filter((item) => item.dish_plan_id === dish.id && !item.tombstone && item.status === "required" && missingIds.has(item.id));
  if (!requirements.length) return effectSet(command, [], { summary: "当前没有需要省略的缺料" });
  const previousOmittedIds = stateList(state, "ingredient_requirement")
    .filter((item) => item.dish_plan_id === dish.id && !item.tombstone && item.status === "omitted")
    .map((item) => item.id);
  const omittedIds = [...new Set([...previousOmittedIds, ...requirements.map((item) => item.id)])];
  const nextDish = withUpdate(dish, {
    adaptation_status: "continued_without_missing",
    omitted_requirement_ids: omittedIds,
    adapted_at: command.occurred_at,
    adapted_by: command.actor_id,
  }, command);
  const effects = [effect(nextDish, dish)];
  requirements.forEach((requirement) => effects.push(effect(withUpdate(requirement, {
    status: "omitted",
    omitted_at: command.occurred_at,
    omitted_by: command.actor_id,
    omission_reason: "continued_without_missing",
  }, command), requirement)));
  const event = domainEvent(command, "dish.ingredients_omitted", dish.id, {
    requirement_ids: requirements.map((item) => item.id),
    ingredients: requirements.map((item) => ({
      ingredient_id: item.ingredient_id,
      ingredient_name: item.ingredient_name,
      quantity: Number(item.quantity || 0),
      unit: item.unit,
    })),
    purchase_demands_preserved: true,
    tasks_preserved: true,
  });
  effects.push(effect(event));
  return effectSet(command, effects, {
    summary: `缺料也继续制作：本餐不使用 ${requirements.map((item) => item.ingredient_name).join("、")}`,
    warnings: ["未完成采购需求和 Apple 采购提醒将继续保留"],
    invariants: ["purchase_demand", "task", "receipt", "inventory_batch", "inventory_movement", "finance_transaction", "finance_link"],
  });
}

function planRestoreOmittedIngredients(command, state) {
  const dish = findRecord(state, "dish_plan", command.payload.dish_plan_id);
  assertDishCanAdapt(dish);
  if (Number(command.payload.expected_revision) !== Number(dish.revision)) throw new Error(`版本冲突：dish_plan/${dish.id}`);
  const requirements = stateList(state, "ingredient_requirement").filter((item) => item.dish_plan_id === dish.id && !item.tombstone && item.status === "omitted");
  if (!requirements.length) return effectSet(command, [], { summary: "当前没有已省略的原料" });
  const nextDish = withUpdate(dish, {
    adaptation_status: null,
    omitted_requirement_ids: [],
    ingredients_restored_at: command.occurred_at,
    ingredients_restored_by: command.actor_id,
  }, command);
  const effects = [effect(nextDish, dish)];
  requirements.forEach((requirement) => effects.push(effect(withUpdate(requirement, {
    status: "required",
    restored_at: command.occurred_at,
    restored_by: command.actor_id,
  }, command), requirement)));
  const event = domainEvent(command, "dish.ingredients_restored", dish.id, {
    requirement_ids: requirements.map((item) => item.id),
    ingredients: requirements.map((item) => ({
      ingredient_id: item.ingredient_id,
      ingredient_name: item.ingredient_name,
      quantity: Number(item.quantity || 0),
      unit: item.unit,
    })),
  });
  effects.push(effect(event));
  return effectSet(command, effects, {
    summary: `恢复本餐原料：${requirements.map((item) => item.ingredient_name).join("、")}`,
    invariants: ["purchase_demand", "task", "receipt", "inventory_batch", "inventory_movement", "finance_transaction", "finance_link"],
  });
}

function planSkipMeal(command, state) {
  const slot = findRecord(state, "meal_slot", command.payload.meal_slot_id);
  const dishes = active(stateList(state, "dish_plan")).filter((dish) => dish.meal_slot_id === slot.id);
  if (!dishes.length) throw new Error("餐次中没有可跳过菜品");
  const effects = [];
  dishes.forEach((dish) => {
    const planned = planSkipDish({ ...command, payload: { ...command.payload, dish_plan_id: dish.id } }, state);
    effects.push(...planned.effects);
  });
  effects.push(effect(withUpdate(slot, { status: "skipped", skipped_at: command.occurred_at }, command), slot));
  return effectSet(command, dedupeEffects(effects), { summary: `跳过整个餐次：${slot.planned_date} ${slot.meal_label}`, invariants: ["inventory_batch", "finance_link"] });
}

function dedupeEffects(effects) {
  const map = new Map();
  effects.forEach((item) => {
    const key = `${item.record_type}:${item.record.id}`;
    const previous = map.get(key);
    map.set(key, previous ? { ...item, before: previous.before, expected_revision: previous.expected_revision } : item);
  });
  return [...map.values()];
}

function stateAfterEffects(state, effects) {
  const next = { ...state };
  dedupeEffects(effects).forEach((item) => {
    const records = Array.isArray(next[item.record_type]) ? [...next[item.record_type]] : [];
    const index = records.findIndex((record) => record.id === item.record.id);
    if (index >= 0) records[index] = item.record;
    else records.push(item.record);
    next[item.record_type] = records;
  });
  return next;
}

function planReplaceDish(command, state) {
  const original = findRecord(state, "dish_plan", command.payload.dish_plan_id);
  const skipped = planSkipDish(command, state);
  const scheduled = scheduleEffects({ ...command, payload: { ...command.payload, meal_plan_id: command.payload.meal_plan_id || original.source_plan_id || null, dish_plan_id: undefined } }, state);
  return effectSet(command, dedupeEffects([...skipped.effects, ...scheduled.effects]), { warnings: scheduled.warnings, summary: "替换菜品并传播确定后果", invariants: ["inventory_batch", "finance_link"] });
}

function requirementItemId(requirement) {
  return requirement?.item_entity_id || requirement?.ingredient_id || null;
}

function mealConsumptionGroups(state, dishes) {
  const dishIds = new Set((dishes || []).map((dish) => dish.id));
  const groups = new Map();
  active(stateList(state, "ingredient_requirement")).filter((item) => dishIds.has(item.dish_plan_id) && item.status === "required").forEach((requirement) => {
    const itemId = requirementItemId(requirement);
    const entity = itemId ? ingredientEntity(state, itemId) : null;
    if (!entity || !["ingredient_item", "inventory_item"].includes(entity.entity_kind) || String(requirement.inventory_policy || "").startsWith("untracked")) return;
    const canonical = normalizeIngredientQuantity(state, itemId, Number(requirement.quantity || 0), requirement.unit, entity.canonical_unit || entity.unit || requirement.unit);
    if (!groups.has(itemId)) groups.set(itemId, {
      item_id: itemId,
      item_name: requirement.ingredient_name || requirement.item_name || entity.name || "未命名物品",
      quantity: 0,
      unit: canonical.unit,
      requirement_ids: [],
      dish_plan_ids: [],
    });
    const group = groups.get(itemId);
    if (group.unit !== canonical.unit) throw new Error(`${group.item_name} 的餐次需求单位不兼容`);
    group.quantity += canonical.quantity;
    group.requirement_ids.push(requirement.id);
    if (!group.dish_plan_ids.includes(requirement.dish_plan_id)) group.dish_plan_ids.push(requirement.dish_plan_id);
  });
  return [...groups.values()];
}

function planCompleteMeal(command, state) {
  const slot = findRecord(state, "meal_slot", command.payload.meal_slot_id);
  if (slot.status === "completed") return effectSet(command, [], { summary: `餐次已经完成：${slot.planned_date} ${slot.meal_label}` });
  if (slot.status === "skipped") throw new Error("已跳过的餐次不能再确认完成");
  if (Number(command.payload.expected_revision) !== Number(slot.revision)) throw new Error(`版本冲突：meal_slot/${slot.id}`);
  const mealDishes = active(stateList(state, "dish_plan")).filter((dish) => dish.meal_slot_id === slot.id && dish.status !== "skipped");
  if (!mealDishes.length) throw new Error("餐次中没有可完成菜品");
  const dishes = mealDishes.filter((dish) => dish.status !== "completed");
  const omittedRequirements = stateList(state, "ingredient_requirement").filter((item) => dishes.some((dish) => dish.id === item.dish_plan_id) && !item.tombstone && item.status === "omitted");
  const groups = mealConsumptionGroups(state, dishes);
  const effects = [];
  const warnings = [];
  const summaries = [];
  groups.forEach((group) => {
    let remaining = group.quantity;
    let deducted = 0;
    const batches = active(stateList(state, "inventory_batch"))
      .filter((batch) => (batch.item_entity_id || batch.ingredient_id) === group.item_id && batch.status !== "depleted" && Number(batch.available_quantity || 0) > 0)
      .sort((left, right) => String(left.received_at || left.recorded_at || left.created_at || "").localeCompare(String(right.received_at || right.recorded_at || right.created_at || "")) || left.id.localeCompare(right.id));
    batches.forEach((batch) => {
      if (remaining <= 0) return;
      const available = normalizeIngredientQuantity(state, group.item_id, Number(batch.available_quantity || 0), batch.unit, group.unit).quantity;
      const take = Math.min(available, remaining);
      if (take <= 0) return;
      const takeInBatchUnit = convertUnitQuantity(take, group.unit, batch.unit);
      if (takeInBatchUnit === null) throw new Error(`${group.item_name} 的库存批次单位无法扣减`);
      const nextQuantity = Math.max(0, Number(batch.available_quantity || 0) - takeInBatchUnit);
      const nextBatch = withUpdate(batch, { available_quantity: nextQuantity, status: nextQuantity === 0 ? "depleted" : "available" }, command);
      const movement = recordBase("inventory_movement", {
        id: uuidFromSeed(`meal-consumption:${command.id}:${slot.id}:${batch.id}`),
        inventory_batch_id: batch.id,
        item_entity_id: group.item_id,
        item_name: group.item_name,
        ingredient_id: group.item_id,
        ingredient_name: group.item_name,
        movement_kind: "meal_consumption_out",
        quantity: -takeInBatchUnit,
        unit: batch.unit,
        normalized_quantity: -take,
        normalized_unit: group.unit,
        occurred_at: command.occurred_at,
        source_type: "meal_completion",
        source_id: slot.id,
        meal_slot_id: slot.id,
        dish_plan_ids: group.dish_plan_ids,
        ingredient_requirement_ids: group.requirement_ids,
        status: "confirmed",
      }, { household_id: command.household_id, recorded_at: command.recorded_at });
      effects.push(effect(nextBatch, batch), effect(movement));
      deducted += take;
      remaining = Math.max(0, remaining - take);
    });
    summaries.push({ item_entity_id: group.item_id, item_name: group.item_name, required_quantity: group.quantity, deducted_quantity: deducted, missing_quantity: remaining, unit: group.unit });
    if (remaining > 0) {
      const decision = recordBase("decision_request", {
        id: uuidFromSeed(`meal-inventory-shortfall:${command.id}:${slot.id}:${group.item_id}`),
        decision_type: "inventory_shortfall_after_meal",
        subject_id: group.item_id,
        source_ids: [slot.id, ...group.requirement_ids],
        title: `核对库存差异：${group.item_name}`,
        reason: `餐次已完成，登记库存不足 ${remaining} ${group.unit}`,
        required_quantity: group.quantity,
        deducted_quantity: deducted,
        missing_quantity: remaining,
        unit: group.unit,
        status: "pending",
      }, { household_id: command.household_id, recorded_at: command.recorded_at });
      effects.push(effect(decision));
      warnings.push(`${group.item_name} 登记库存不足 ${remaining} ${group.unit}，已生成待核对事项`);
    }
  });
  const requirements = active(stateList(state, "ingredient_requirement")).filter((item) => dishes.some((dish) => dish.id === item.dish_plan_id) && item.status === "required");
  requirements.forEach((requirement) => effects.push(effect(withUpdate(requirement, { status: "consumed", consumed_at: command.occurred_at }, command), requirement)));
  dishes.forEach((dish) => effects.push(effect(withUpdate(dish, { status: "completed", completed_at: command.occurred_at }, command), dish)));
  effects.push(effect(withUpdate(slot, { status: "completed", completed_at: command.occurred_at }, command), slot));
  const event = domainEvent(command, "meal.completed", slot.id, {
    meal_plan_id: slot.source_plan_id || null,
    consumption: summaries,
    omitted_ingredients: omittedRequirements.map((item) => ({
      requirement_id: item.id,
      ingredient_id: item.ingredient_id,
      ingredient_name: item.ingredient_name,
      quantity: Number(item.quantity || 0),
      unit: item.unit,
    })),
  });
  effects.push(effect(event));
  effects.filter((item) => item.record_type === "inventory_movement").forEach((item) => {
    effects.push(effect(relationship({ household_id: command.household_id, recorded_at: command.recorded_at }, item.record.id, slot.id, "consumption_serves_meal", event.id)));
    effects.push(effect(relationship({ household_id: command.household_id, recorded_at: command.recorded_at }, item.record.id, item.record.inventory_batch_id, "movement_updates_batch", event.id)));
  });
  return effectSet(command, dedupeEffects(effects), {
    summary: `完成本餐并扣减库存：${slot.planned_date} ${slot.meal_label} · ${summaries.length} 项`,
    warnings,
    invariants: ["finance_transaction", "receipt", "purchase_demand", "task"],
  });
}

function planSettleMealPlan(command, state) {
  const plan = findRecord(state, "meal_plan", command.payload.id);
  if (plan.status === "completed") return effectSet(command, [], { summary: `一周菜单已经结算：${plan.week_start}` });
  if (Number(command.payload.expected_revision) !== Number(plan.revision)) throw new Error(`版本冲突：meal_plan/${plan.id}`);
  const outcomes = Array.isArray(command.payload.outcomes) ? command.payload.outcomes : [];
  if (!outcomes.length) throw new Error("请至少选择一个需要结算的餐次");
  let workingState = state;
  let combined = [];
  const warnings = [];
  outcomes.forEach((outcome, index) => {
    const slot = findRecord(workingState, "meal_slot", outcome.meal_slot_id);
    if (slot.source_plan_id !== plan.id) throw new Error("餐次不属于当前一周菜单");
    if (outcome.outcome === "completed") {
      const planned = planCompleteMeal({ ...command, id: `${command.id}:meal:${index}`, payload: { meal_slot_id: slot.id, expected_revision: outcome.expected_revision } }, workingState);
      combined = dedupeEffects([...combined, ...planned.effects]);
      warnings.push(...planned.warnings);
      workingState = stateAfterEffects(workingState, planned.effects);
    } else if (outcome.outcome === "skipped") {
      if (Number(outcome.expected_revision) !== Number(slot.revision)) throw new Error(`版本冲突：meal_slot/${slot.id}`);
      const planned = planSkipMeal({ ...command, id: `${command.id}:skip:${index}`, payload: { meal_slot_id: slot.id } }, workingState);
      combined = dedupeEffects([...combined, ...planned.effects]);
      workingState = stateAfterEffects(workingState, planned.effects);
    } else if (outcome.outcome !== "leave") {
      throw new Error("餐次结算结果无效");
    }
  });
  const finalSlots = active(stateList(workingState, "meal_slot")).filter((slot) => slot.source_plan_id === plan.id);
  const fullySettled = finalSlots.length > 0 && finalSlots.every((slot) => ["completed", "skipped"].includes(slot.status));
  if (fullySettled) combined.push(effect(withUpdate(plan, { status: "completed", completed_at: command.occurred_at }, command), plan));
  combined.push(effect(domainEvent(command, "meal_plan.settled", plan.id, {
    outcome_count: outcomes.filter((item) => item.outcome !== "leave").length,
    fully_settled: fullySettled,
  })));
  return effectSet(command, dedupeEffects(combined), {
    summary: `${fullySettled ? "完成" : "更新"}一周菜单结算：${plan.week_start}`,
    warnings,
    invariants: ["finance_transaction", "receipt"],
  });
}

function receiptEffects(command, state, demand, input, options = {}) {
  if (demand.status === "fulfilled") return { effects: [], receipt: null, idempotent: true };
  const quantity = Number(input.quantity);
  const itemId = demandItemId(demand);
  const itemName = demandItemName(demand);
  if (!Number.isFinite(quantity) || quantity <= 0) throw new Error(`${itemName} 的实收数量必须大于 0`);
  const unit = String(input.unit || demand.unit);
  const normalized = normalizeIngredientQuantity(state, itemId, quantity, unit, demand.unit);
  const identity = options.identity || `${command.id}:${demand.id}`;
  const receipt = recordBase("receipt", {
    id: uuidFromSeed(`purchase-receipt:${identity}`),
    purchase_demand_id: demand.id,
    item_entity_id: itemId,
    item_name: input.actual_name || itemName,
    ingredient_id: itemId,
    ingredient_name: input.actual_name || itemName,
    quantity,
    unit,
    normalized_quantity: normalized.quantity,
    normalized_unit: normalized.unit,
    substitute: Boolean(input.actual_name && input.actual_name !== itemName),
    confirmed_by: command.actor_id,
    confirmation_mode: options.confirmation_mode || "manual",
    occurred_at: command.occurred_at,
    status: "confirmed",
  }, { household_id: command.household_id, recorded_at: command.recorded_at });
  const event = domainEvent(command, "purchase.received", demand.id, {
    receipt_id: receipt.id,
    admitted_to_inventory: Boolean(demand.planned_admission),
    confirmation_mode: receipt.confirmation_mode,
  });
  const effects = [effect(receipt), effect(withUpdate(demand, { status: "fulfilled", receipt_id: receipt.id }, command), demand)];
  effects.push(effect(relationship({ household_id: command.household_id, recorded_at: command.recorded_at }, receipt.id, demand.id, "receipt_confirms_demand", event.id)));
  const projectedTasks = active(stateList(state, "task")).filter((task) => taskProjectsDemand(task, demand.id));
  projectedTasks.forEach((task) => effects.push(effect(withUpdate(task, {
    status: "receipt_confirmed",
    category: "purchase",
    purchase_group: task.purchase_group || purchaseGroupFor(state, itemId),
  }, command), task)));
  const taskIds = new Set(projectedTasks.map((task) => task.id));
  active(stateList(state, "decision_request")).filter((decision) =>
    decision.decision_type === "purchase_receipt_confirmation"
    && decision.status === "open"
    && (taskIds.has(decision.subject_id) || (decision.source_ids || []).includes(demand.id))
  ).forEach((decision) => effects.push(effect(withUpdate(decision, {
    status: "resolved",
    resolution: "receipt_confirmed",
    receipt_id: receipt.id,
    resolved_at: command.occurred_at,
  }, command), decision)));
  if (demand.planned_admission) {
    const batch = recordBase("inventory_batch", {
      id: uuidFromSeed(`inventory-batch:${receipt.id}`),
      item_entity_id: itemId,
      item_name: receipt.item_name,
      ingredient_id: itemId,
      ingredient_name: receipt.item_name,
      receipt_id: receipt.id,
      planned_demand_id: demand.id,
      admitted_by_plan: true,
      quantity: normalized.quantity,
      available_quantity: normalized.quantity,
      unit: normalized.unit,
      display_quantity: quantity,
      display_unit: unit,
      tracking_policy: input.tracking_policy || "estimated",
      status: "available",
    }, { household_id: command.household_id, recorded_at: command.recorded_at });
    const movement = recordBase("inventory_movement", {
      id: uuidFromSeed(`inventory-receipt-movement:${receipt.id}`),
      inventory_batch_id: batch.id,
      movement_kind: "receipt_in",
      quantity: normalized.quantity,
      unit: normalized.unit,
      display_quantity: quantity,
      display_unit: unit,
      occurred_at: command.occurred_at,
      source_id: receipt.id,
      status: "confirmed",
    }, { household_id: command.household_id, recorded_at: command.recorded_at });
    effects.push(effect(batch), effect(movement));
    effects.push(effect(relationship({ household_id: command.household_id, recorded_at: command.recorded_at }, batch.id, receipt.id, "inventory_admitted_from_receipt", event.id)));
    effects.push(effect(relationship({ household_id: command.household_id, recorded_at: command.recorded_at }, movement.id, batch.id, "movement_updates_batch", event.id)));
  }
  effects.push(effect(event));
  return { effects, receipt, idempotent: false };
}

function planConfirmReceipt(command, state) {
  const demand = findRecord(state, "purchase_demand", command.payload.purchase_demand_id);
  if (demand.status === "fulfilled") throw new Error("该采购需求已经确认实收");
  const planned = receiptEffects(command, state, demand, command.payload);
  return effectSet(command, planned.effects, { summary: `确认实收：${planned.receipt.item_name || planned.receipt.ingredient_name}` });
}

function planConfirmReceiptsBatch(command, state) {
  const items = Array.isArray(command.payload.items) ? command.payload.items : [];
  if (!items.length) throw new Error("至少选择一项待实收采购");
  const ids = items.map((item) => item.purchase_demand_id);
  if (new Set(ids).size !== ids.length) throw new Error("批量实收包含重复采购项");
  const prepared = items.map((item) => {
    const demand = findRecord(state, "purchase_demand", item.purchase_demand_id);
    if (demand.status === "fulfilled") throw new Error(`${demandItemName(demand)} 已经确认实收`);
    normalizeIngredientQuantity(state, demandItemId(demand), Number(item.quantity), item.unit || demand.unit, demand.unit);
    return { demand, item };
  });
  const effects = [];
  prepared.forEach(({ demand, item }) => effects.push(...receiptEffects(command, state, demand, item, { identity: `${command.id}:${demand.id}`, confirmation_mode: "batch" }).effects));
  return effectSet(command, dedupeEffects(effects), { summary: `批量确认实收：${prepared.length} 项` });
}

function planRecordConsumption(command, state) {
  const batch = findRecord(state, "inventory_batch", command.payload.inventory_batch_id);
  const quantity = Number(command.payload.quantity);
  if (!Number.isFinite(quantity) || quantity <= 0 || quantity > Number(batch.available_quantity || 0)) throw new Error("消耗数量超出当前可用量");
  const nextQuantity = Number(batch.available_quantity) - quantity;
  const movement = recordBase("inventory_movement", {
    inventory_batch_id: batch.id,
    movement_kind: "consumption_out",
    quantity: -quantity,
    unit: batch.unit,
    occurred_at: command.occurred_at,
    source_id: command.payload.dish_plan_id || "manual",
    status: "confirmed",
  }, { household_id: command.household_id, recorded_at: command.recorded_at });
  const event = domainEvent(command, "inventory.consumed", batch.id, { quantity, dish_plan_id: command.payload.dish_plan_id || null });
  const effects = [effect(withUpdate(batch, { available_quantity: nextQuantity, status: nextQuantity === 0 ? "depleted" : "available" }, command), batch), effect(movement)];
  effects.push(effect(relationship({ household_id: command.household_id, recorded_at: command.recorded_at }, movement.id, batch.id, "movement_updates_batch", event.id)));
  if (command.payload.dish_plan_id) effects.push(effect(relationship({ household_id: command.household_id, recorded_at: command.recorded_at }, movement.id, command.payload.dish_plan_id, "consumption_serves_dish", event.id)));
  effects.push(effect(event));
  return effectSet(command, effects, { summary: `记录实际消耗：${batch.ingredient_name}` });
}

function planReceiveManualInventory(command, state) {
  const quantity = Number(command.payload.quantity);
  const unit = String(command.payload.unit || "").trim();
  const reason = String(command.payload.intake_reason || "manual_purchase");
  if (!Number.isFinite(quantity) || quantity <= 0) throw new Error("入库数量必须大于 0");
  if (!unit) throw new Error("入库单位不能为空");
  if (!MANUAL_INTAKE_REASONS.includes(reason)) throw new Error("手动入库来源无效");
  const effects = [];
  let item = null;
  if (command.payload.item_entity_id) {
    item = findRecord(state, "entity", command.payload.item_entity_id);
    if (!["ingredient_item", "inventory_item"].includes(item.entity_kind)) throw new Error("所选实体不是库存物品");
  } else {
    const input = command.payload.new_item || {};
    const name = String(input.name || "").trim();
    const canonicalUnit = String(input.canonical_unit || unit).trim();
    const trackingPolicy = String(input.tracking_policy || "estimated");
    if (!name) throw new Error("新物品名称不能为空");
    if (!canonicalUnit) throw new Error("新物品标准单位不能为空");
    if (!["exact_unit", "estimated", "manual_depletion"].includes(trackingPolicy)) throw new Error("库存策略无效");
    const duplicate = active(stateList(state, "entity")).find((entry) => ["ingredient_item", "inventory_item"].includes(entry.entity_kind) && normalizedActiveName(entry.name) === normalizedActiveName(name));
    if (duplicate) throw new Error(`物品已存在，请改为选择现有物品：${duplicate.name}`);
    item = recordBase("entity", {
      id: input.id || uuidFromSeed(`manual-inventory-item:${command.id}:${name}`),
      entity_kind: "inventory_item",
      name,
      category: input.category || "家庭物品",
      canonical_unit: canonicalUnit,
      unit: canonicalUnit,
      purchase_group: String(input.purchase_group || "未分类").trim() || "未分类",
      tracking_policy: trackingPolicy,
      package_conversions: Array.isArray(input.package_conversions) ? input.package_conversions : [],
      min_quantity: Number(input.min_quantity || 0),
      target_quantity: Number(input.target_quantity || 0),
      status: "active",
    }, { household_id: command.household_id, recorded_at: command.recorded_at });
    effects.push(effect(item));
  }
  const conversionState = item && !stateList(state, "entity").some((entry) => entry.id === item.id)
    ? { ...state, entity: [...stateList(state, "entity"), item] }
    : state;
  const normalized = normalizeIngredientQuantity(conversionState, item.id, quantity, unit, item.canonical_unit || item.unit || unit);
  const batch = recordBase("inventory_batch", {
    id: uuidFromSeed(`manual-inventory-batch:${command.id}:${item.id}`),
    item_entity_id: item.id,
    item_name: item.name,
    ingredient_id: item.id,
    ingredient_name: item.name,
    quantity: normalized.quantity,
    available_quantity: normalized.quantity,
    unit: normalized.unit,
    display_quantity: quantity,
    display_unit: unit,
    tracking_policy: item.tracking_policy || "estimated",
    admitted_by_plan: false,
    admission_mode: "manual",
    intake_reason: reason,
    intake_note: String(command.payload.note || "").trim(),
    status: "available",
  }, { household_id: command.household_id, recorded_at: command.recorded_at });
  const movement = recordBase("inventory_movement", {
    id: uuidFromSeed(`manual-inventory-movement:${command.id}:${item.id}`),
    inventory_batch_id: batch.id,
    item_entity_id: item.id,
    item_name: item.name,
    ingredient_id: item.id,
    ingredient_name: item.name,
    movement_kind: "manual_intake",
    quantity: normalized.quantity,
    unit: normalized.unit,
    display_quantity: quantity,
    display_unit: unit,
    occurred_at: command.occurred_at,
    source_type: "manual_intake",
    source_id: command.actor_id,
    intake_reason: reason,
    note: String(command.payload.note || "").trim(),
    status: "confirmed",
  }, { household_id: command.household_id, recorded_at: command.recorded_at });
  const event = domainEvent(command, "inventory.manually_received", batch.id, { item_entity_id: item.id, movement_id: movement.id, intake_reason: reason });
  effects.push(effect(batch), effect(movement));
  effects.push(effect(relationship({ household_id: command.household_id, recorded_at: command.recorded_at }, movement.id, batch.id, "movement_updates_batch", event.id)));
  effects.push(effect(event));
  return effectSet(command, effects, {
    summary: `手动入库：${item.name} · ${quantity} ${unit}`,
    invariants: ["purchase_demand", "receipt", "task", "finance_transaction"],
  });
}

function planCalibrateInventory(command, state) {
  const batch = findRecord(state, "inventory_batch", command.payload.inventory_batch_id);
  const actualQuantity = Number(command.payload.available_quantity);
  if (!Number.isFinite(actualQuantity) || actualQuantity < 0) throw new Error("校准数量必须是非负数");
  const actualUnit = String(command.payload.unit || batch.display_unit || batch.unit);
  let conversionEffect = null;
  let conversionState = state;
  const packageSize = Number(command.payload.package_size);
  const packageSizeUnit = String(command.payload.package_size_unit || "").trim();
  if (packageSize > 0 && packageSizeUnit) {
    const entity = findRecord(state, "entity", batch.ingredient_id);
    const conversions = (entity.package_conversions || []).filter((item) => String(item.unit) !== actualUnit);
    conversions.push({ unit: actualUnit, canonical_quantity: packageSize, canonical_unit: packageSizeUnit });
    const nextEntity = withUpdate(entity, { canonical_unit: entity.canonical_unit || entity.unit || batch.unit, package_conversions: conversions }, command);
    conversionEffect = effect(nextEntity, entity);
    conversionState = { ...state, entity: stateList(state, "entity").map((item) => item.id === entity.id ? nextEntity : item) };
  }
  const normalized = normalizeIngredientQuantity(conversionState, batch.ingredient_id, actualQuantity, actualUnit, batch.unit);
  let originalTotal = Number(batch.quantity || 0);
  try {
    originalTotal = normalizeIngredientQuantity(conversionState, batch.ingredient_id, Number(batch.quantity || 0), batch.unit, normalized.unit).quantity;
  } catch (_) {
    originalTotal = normalized.quantity;
  }
  const delta = normalized.quantity - Number(batch.available_quantity || 0);
  const movement = recordBase("inventory_movement", {
    inventory_batch_id: batch.id,
    movement_kind: "manual_calibration",
    quantity: delta,
    unit: normalized.unit,
    display_quantity: actualQuantity,
    display_unit: actualUnit,
    occurred_at: command.occurred_at,
    source_id: command.actor_id,
    status: "confirmed",
  }, { household_id: command.household_id, recorded_at: command.recorded_at });
  const nextBatch = withUpdate(batch, {
    quantity: Math.max(originalTotal, normalized.quantity),
    available_quantity: normalized.quantity,
    unit: normalized.unit,
    display_quantity: actualQuantity,
    display_unit: actualUnit,
    status: normalized.quantity === 0 ? "depleted" : "available",
  }, command);
  const effects = [effect(nextBatch, batch), effect(movement), effect(domainEvent(command, "inventory.adjusted", batch.id, {
    quantity: normalized.quantity,
    unit: normalized.unit,
    delta,
  }))];
  if (conversionEffect) effects.unshift(conversionEffect);
  return effectSet(command, effects, { summary: `编辑库存：${batch.ingredient_name}` });
}

function planFinanceLink(command, state, unplanned) {
  if (!command.payload.transaction_id?.trim()) throw new Error("必须填写已确认财务交易 ID");
  if (!unplanned && command.payload.receipt_id) findRecord(state, "receipt", command.payload.receipt_id);
  const link = recordBase("finance_link", {
    transaction_id: command.payload.transaction_id.trim(),
    receipt_id: command.payload.receipt_id || null,
    amount: Number(command.payload.amount || 0),
    currency: command.payload.currency || "CNY",
    planned_purchase: !unplanned,
    authority: "confirmed_finance_reference",
    status: "linked",
  }, { household_id: command.household_id, recorded_at: command.recorded_at });
  const event = domainEvent(command, unplanned ? "finance.unplanned_purchase_linked" : "finance.purchase_linked", link.id, { transaction_id: link.transaction_id, inventory_admission: false });
  const effects = [effect(link), effect(event)];
  if (link.receipt_id) effects.push(effect(relationship({ household_id: command.household_id, recorded_at: command.recorded_at }, link.id, link.receipt_id, "finance_links_receipt", event.id)));
  return effectSet(command, effects, {
    summary: unplanned ? "记录计划外购买的财务关联（不进入库存）" : "关联已确认财务交易",
    invariants: unplanned ? ["inventory_batch", "inventory_movement"] : [],
  });
}

function planCommand(command, state) {
  const planners = {
    "initialize-household": planInitialize,
    "add-member": planAddMember,
    "add-health-constraint": planAddConstraint,
    "add-recipe": planAddRecipe,
    "recipe.update": planUpdateRecipe,
    "schedule-dish": planScheduleDish,
    "confirm-missing-and-reschedule": planReschedule,
    "dish.continue-without-missing": planContinueWithoutMissing,
    "dish.restore-omitted-ingredients": planRestoreOmittedIngredients,
    "skip-dish": planSkipDish,
    "skip-meal": planSkipMeal,
    "replace-dish": planReplaceDish,
    "confirm-receipt": planConfirmReceipt,
    "confirm-receipts-batch": planConfirmReceiptsBatch,
    "record-consumption": planRecordConsumption,
    "meal.complete": planCompleteMeal,
    "meal-plan.settle": planSettleMealPlan,
    "inventory.receive-manual": planReceiveManualInventory,
    "calibrate-inventory": planCalibrateInventory,
    "inventory.adjust": planCalibrateInventory,
    "link-finance": (item, source) => planFinanceLink(item, source, false),
    "record-unplanned-purchase": (item, source) => planFinanceLink(item, source, true),
    "record.create": planCreateRecord,
    "record.update": planUpdateRecord,
    "record.archive": planArchiveRecord,
    "record.confirm": (item, source) => planLifecycleRecord(item, source, "确认", "confirmed"),
    "record.void": (item, source) => planLifecycleRecord(item, source, "作废", "void"),
    "record.restore": (item, source) => planLifecycleRecord(item, source, "恢复", "active"),
    "finance.transaction.capture": planCaptureFinanceTransaction,
    "finance.transaction.update": planUpdateFinanceTransaction,
    "task-category.create": planCreateTaskCategory,
    "task-category.update": planUpdateTaskCategory,
    "task-category.set-default": planSetDefaultTaskCategory,
    "task-category.archive": planArchiveTaskCategory,
    "task-category.restore": planRestoreTaskCategory,
    "task-category.reorder": planReorderTaskCategories,
    "task.create": planCreateTask,
    "task.update": planUpdateTask,
    "task.delete": planDeleteTask,
    "purchase.create-manual": planCreateManualPurchase,
    "apple.projection-event": planAppleProjectionEvent,
    "meal-plan.generate-draft": planGenerateMealPlan,
    "meal-plan.regenerate": planRegenerateMealPlan,
    "meal-slot.set-lock": planSetMealSlotLock,
    "meal-plan.create": planCreateMealPlan,
    "meal-plan.activate": planActivateMealPlan,
    "meal-plan.update": planUpdateMealPlan,
    "meal-plan.rebuild-purchases": planRebuildMealPurchases,
  };
  const planner = planners[command.command_type];
  if (!planner) throw new Error(`不支持的命令：${command.command_type}`);
  return planner(command, state || {});
}

function hashRecordType(state, type) {
  return contentHash(active(stateList(state, type)).map((record) => ({ ...record, updated_at: undefined })).sort((a, b) => a.id.localeCompare(b.id)));
}

function projectionMarkdown(state, derived, generatedAt) {
  const lines = [
    "---",
    "type: family-system-projection/v1",
    `generated_at: ${generatedAt}`,
    "editable: false",
    "---",
    "",
    "# 家庭系统 · 当前秩序",
    "",
    "> 本文件由混合权威系统生成。定义资料来自已提交 Markdown，运行事实来自 Life Core；人工修改本投影只会进入冲突核对。",
    "",
    `- 食材已备齐：${derived.ready.length}`,
    `- 缺料可继续：${derived.adaptable.length}`,
    `- 已按缺料调整：${derived.adapted.length}`,
    `- 等待采购：${derived.at_risk.length}`,
    `- 待采购需求：${derived.purchase_count}`,
    `- 待决定：${derived.pending_decisions.length}`,
    `- 待恢复：${derived.recovery_count}`,
    "",
    "## 当前菜品",
    "",
  ];
  if (!derived.dish_states.length) lines.push("暂无已安排菜品。", "");
  derived.dish_states.forEach((dish) => {
    lines.push(`- **${dish.meal_slot?.planned_date || "未定日期"} ${dish.meal_slot?.meal_label || "餐次"}** · ${dish.status}${dish.missing?.length ? ` · 缺少：${dish.missing.join("、")}` : ""}${dish.omitted?.length ? ` · 本餐未使用：${dish.omitted.join("、")}` : ""}`);
  });
  lines.push("", "## 恢复说明", "", "当前结果可由已提交 Markdown 定义、结构化运行事实、关系和规则重建。", "");
  return lines.join("\n");
}

module.exports = {
  SCHEMA_VERSION,
  RECORD_TYPES,
  GENERIC_RECORD_TYPES,
  FORMAL_DOMAIN_TYPES,
  PURCHASE_GROUP_ORDER,
  PURCHASE_MODES,
  MANUAL_INTAKE_REASONS,
  RECIPE_CATEGORIES,
  RECIPE_MEAL_TYPES,
  MENU_GENERATION_STRATEGIES,
  MENU_MEAL_TYPES,
  MENU_STRATEGY_WEIGHTS,
  RULE_PRIORITY,
  TASK_CATEGORIES,
  DEFAULT_TASK_CATEGORY_NAMES,
  active,
  commandEnvelope,
  contentHash,
  addDateDays,
  dateRangeInclusive,
  convertUnitQuantity,
  categoryIdForRoute,
  canonicalUnitFor,
  createId,
  deriveCurrentOrder,
  demandRequirementIds,
  demandItemId,
  demandItemName,
  defaultTaskCategoryId,
  evaluateRecipeConstraints,
  generateMealPlanDraftRecords,
  hashRecordType,
  indexRecords,
  isPathWithin,
  joinVaultPath,
  handlingActionNotes,
  normalizeHandlingActions,
  normalizeHandlingInstructions,
  normalizeIngredientQuantity,
  normalizeRecipeIngredients,
  normalizeRecipeSteps,
  normalizeRecipeStringList,
  normalizeVaultPath,
  normalizeVaultRoot,
  nowIso,
  parseIngredientLines,
  persistedTaskCategories,
  planCommand,
  mealPlanRange,
  projectionMarkdown,
  recordBase,
  rulePriority,
  sortRules,
  stableStringify,
  roundMenuQuantity,
  servingScale,
  stateList,
  taskCategoryForRoute,
  uuidFromSeed,
  validateRecord,
};
