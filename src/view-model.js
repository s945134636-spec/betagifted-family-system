"use strict";

const { active, convertUnitQuantity, dateRangeInclusive, DEFAULT_TASK_CATEGORY_NAMES, defaultTaskCategoryId, mealPlanRange } = require("./core");

const MODULES = Object.freeze({
  overview: Object.freeze({
    label: "家庭总览",
    short: "总",
    icon: "orbit",
    pages: Object.freeze([["overview", "总览"]]),
  }),
  reminder: Object.freeze({
    label: "事务提醒",
    short: "事",
    icon: "list-checks",
    pages: Object.freeze([["overview", "总览"], ["today", "今天"], ["upcoming", "即将到期"], ["all", "全部"], ["completed", "已完成"]]),
  }),
  diet: Object.freeze({
    label: "饮食健康",
    short: "食",
    icon: "salad",
    pages: Object.freeze([["menu", "菜单"], ["plans", "菜单计划"], ["recipes", "菜谱"], ["profiles", "成员档案"], ["rules", "规则"]]),
  }),
  purchase: Object.freeze({
    label: "采购",
    short: "采",
    icon: "shopping-basket",
    pages: Object.freeze([["demands", "待买需求"], ["sessions", "采购批次"], ["receipts", "实收"], ["inventory", "库存"], ["movements", "库存流水"], ["aftersales", "售后"]]),
  }),
  finance: Object.freeze({
    label: "财务",
    short: "财",
    icon: "landmark",
    pages: Object.freeze([["overview", "总览"], ["transactions", "流水"], ["budgets", "预算"], ["accounts", "账户"], ["recurring", "固定项"], ["balances", "余额"], ["review", "待核对"]]),
  }),
  basic: Object.freeze({
    label: "基础信息",
    short: "基",
    icon: "contact-round",
    pages: Object.freeze([["household", "家庭"], ["members", "成员"], ["documents", "证件"], ["contacts", "联系人"], ["medical", "医疗"], ["accounts", "账号入口"]]),
  }),
  asset: Object.freeze({
    label: "资产",
    short: "资",
    icon: "house-plug",
    pages: Object.freeze([["overview", "总览"], ["assets", "资产档案"], ["plans", "维护计划"], ["services", "维保记录"]]),
  }),
});

const DEFAULT_PAGES = Object.freeze(Object.fromEntries(
  Object.entries(MODULES).map(([key, value]) => [key, value.pages[0][0]])
));

function array(state, key) {
  return Array.isArray(state && state[key]) ? state[key] : [];
}

function text(value) {
  return String(value == null ? "" : value);
}

function dateKey(value) {
  const raw = text(value);
  const matched = raw.match(/^\d{4}-\d{2}-\d{2}/);
  return matched ? matched[0] : "";
}

function normalizeModule(value) {
  return Object.prototype.hasOwnProperty.call(MODULES, value) ? value : "overview";
}

function normalizePage(moduleInput, pageInput) {
  const module = normalizeModule(moduleInput);
  const pages = MODULES[module].pages.map((item) => item[0]);
  return pages.includes(pageInput) ? pageInput : pages[0];
}

function taskCategories(state) {
  const persisted = array(state, "task_category").filter((item) => !item.tombstone);
  const categories = persisted.length ? persisted : Object.entries(DEFAULT_TASK_CATEGORY_NAMES).map(([routeKind, name], index) => ({
    schema: "family-system/task_category-v1",
    record_type: "task_category",
    id: defaultTaskCategoryId(routeKind),
    name,
    route_kind: routeKind,
    sort_order: index,
    is_default: true,
    status: "active",
    revision: 0,
    virtual: true,
  }));
  return categories.sort((left, right) => Number(left.sort_order || 0) - Number(right.sort_order || 0) || text(left.name).localeCompare(text(right.name)));
}

function taskRows(state, categories) {
  const categoryIndex = new Map((categories || []).map((item) => [item.id, item]));
  const authority = active(array(state, "task"));
  return (authority.length ? authority : active(array(state, "task_projection"))).map((item) => {
    const routeKind = item.category || (item.source_type === "purchase_demand" ? "purchase" : item.source_type === "meal_handling" ? "meal_handling" : "household");
    const category = categoryIndex.get(item.category_id) || (categories || []).find((entry) => entry.route_kind === routeKind && entry.is_default) || null;
    return {
      ...item,
      category: routeKind,
      category_id: item.category_id || category?.id || null,
      category_name: category?.name || DEFAULT_TASK_CATEGORY_NAMES[routeKind] || "未分类",
    };
  }).sort((left, right) => {
    const leftDone = ["completed", "cancelled", "receipt_confirmed"].includes(left.status) ? 1 : 0;
    const rightDone = ["completed", "cancelled", "receipt_confirmed"].includes(right.status) ? 1 : 0;
    return leftDone - rightDone || text(left.due_at).localeCompare(text(right.due_at)) || text(left.title).localeCompare(text(right.title));
  });
}

function tasksForPage(tasks, page, today) {
  if (page === "completed") return tasks.filter((item) => ["completed", "cancelled", "receipt_confirmed"].includes(item.status));
  if (page === "today") return tasks.filter((item) => dateKey(item.due_at) === today && !["completed", "cancelled", "receipt_confirmed"].includes(item.status));
  if (page === "upcoming") return tasks.filter((item) => dateKey(item.due_at) > today && !["completed", "cancelled", "receipt_confirmed"].includes(item.status));
  if (page === "all") return tasks;
  return tasks.filter((item) => !["completed", "cancelled", "receipt_confirmed"].includes(item.status));
}

function financeNeedsReview(link) {
  return ["needs_review", "pending", "conflict"].includes(text(link.status)) || !text(link.transaction_id);
}

function addDays(date, offset) {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + offset);
  return value.toISOString().slice(0, 10);
}

function weekdayLabel(date) {
  return ["周日", "周一", "周二", "周三", "周四", "周五", "周六"][new Date(`${date}T00:00:00.000Z`).getUTCDay()];
}

function buildWeeklyMenu(mealPlans, mealSlots, dishStates, today, selectedPlanId) {
  const plans = (mealPlans || []).slice().sort((left, right) => mealPlanRange(right).start.localeCompare(mealPlanRange(left).start));
  const activePlans = plans.filter((plan) => plan.status === "active");
  const selected = selectedPlanId ? plans.find((item) => item.id === selectedPlanId) : null;
  const plan = selected || activePlans.find((item) => {
    const range = mealPlanRange(item);
    return range.start <= today && range.end >= today;
  }) || activePlans.find((item) => mealPlanRange(item).start >= today) || activePlans[0] || plans[0] || null;
  const range = plan ? mealPlanRange(plan) : { start: "", end: "" };
  if (!plan || !dateKey(range.start) || !dateKey(range.end)) {
    return { plan: null, plans, range, days: [], week_groups: [], default_date: "all", meal_count: 0, dish_count: 0, gap_count: 0 };
  }

  const planSlots = (mealSlots || []).filter((slot) => slot.source_plan_id === plan.id);
  const planSlotIds = new Set(planSlots.map((slot) => slot.id));
  const planDishes = (dishStates || []).filter((dish) => planSlotIds.has(dish.meal_slot?.id || dish.meal_slot_id));
  const instructions = new Map((plan.handling_instructions || []).map((item) => [item.id, item]));
  const handlingActions = Array.isArray(plan.handling_actions) ? plan.handling_actions : [];
  const mealOrder = { 早餐: 0, 午餐: 1, 晚餐: 2, 加餐: 3 };
  const days = dateRangeInclusive(range.start, range.end).map((date) => {
    const meals = planSlots.filter((slot) => slot.planned_date === date).sort((left, right) =>
      (mealOrder[left.meal_label] ?? 9) - (mealOrder[right.meal_label] ?? 9) || text(left.meal_label).localeCompare(text(right.meal_label))
    ).map((slot) => ({
      ...slot,
      dishes: planDishes.filter((dish) => (dish.meal_slot?.id || dish.meal_slot_id) === slot.id),
    }));
    const actions = handlingActions.filter((action) => dateKey(action.scheduled_at) === date).map((action) => ({
      ...action,
      instructions: (action.instruction_ids || []).map((id) => instructions.get(id)).filter(Boolean),
    }));
    return {
      date,
      weekday: weekdayLabel(date),
      date_label: date.slice(5),
      is_today: date === today,
      meals,
      handling_actions: actions,
      meal_count: meals.length,
      dish_count: meals.reduce((sum, meal) => sum + meal.dishes.length, 0),
    };
  });
  const dates = new Set(days.map((day) => day.date));
  const defaultDate = dates.has(today) ? today : days.find((day) => day.date >= today && day.meal_count)?.date || days.find((day) => day.meal_count)?.date || "all";
  const weekGroups = [];
  for (let index = 0; index < days.length; index += 7) weekGroups.push(days.slice(index, index + 7));
  return {
    plan,
    plans,
    range,
    days,
    week_groups: weekGroups,
    default_date: defaultDate,
    meal_count: days.reduce((sum, day) => sum + day.meal_count, 0),
    dish_count: days.reduce((sum, day) => sum + day.dish_count, 0),
    gap_count: planSlots.filter((slot) => slot.generation_status === "gap").length,
  };
}

function buildInventorySummary(entities, batches) {
  const items = (entities || []).filter((item) => ["ingredient_item", "inventory_item"].includes(item.entity_kind));
  return items.map((item) => {
    const canonicalUnit = item.canonical_unit || item.unit || "份";
    const itemBatches = (batches || []).filter((batch) => (batch.item_entity_id || batch.ingredient_id) === item.id);
    const availableQuantity = itemBatches.reduce((sum, batch) => {
      const converted = convertUnitQuantity(Number(batch.available_quantity || 0), batch.unit || canonicalUnit, canonicalUnit);
      return sum + Math.max(0, converted == null ? 0 : converted);
    }, 0);
    const orderedBatches = itemBatches.slice().sort((left, right) => String(left.received_at || left.recorded_at || left.created_at || "").localeCompare(String(right.received_at || right.recorded_at || right.created_at || "")) || text(left.id).localeCompare(text(right.id)));
    return {
      id: item.id,
      item_entity_id: item.id,
      item_name: item.name || "未命名物品",
      purchase_group: item.purchase_group || "未分类",
      tracking_policy: item.tracking_policy || orderedBatches.find((batch) => batch.tracking_policy)?.tracking_policy || "estimated",
      canonical_unit: canonicalUnit,
      available_quantity: availableQuantity,
      unit: canonicalUnit,
      status: availableQuantity > 0 ? "available" : "depleted",
      batch_count: itemBatches.length,
      available_batch_count: itemBatches.filter((batch) => Number(batch.available_quantity || 0) > 0).length,
      primary_batch_id: orderedBatches.find((batch) => Number(batch.available_quantity || 0) > 0)?.id || orderedBatches[0]?.id || null,
      batches: orderedBatches,
    };
  }).sort((left, right) => {
    const leftAvailable = left.status === "available" ? 0 : 1;
    const rightAvailable = right.status === "available" ? 0 : 1;
    return leftAvailable - rightAvailable || text(left.purchase_group).localeCompare(text(right.purchase_group)) || text(left.item_name).localeCompare(text(right.item_name), "zh-CN");
  });
}

function filterInventorySummary(rows, filters = {}) {
  const query = text(filters.query).trim().toLocaleLowerCase("zh-CN");
  const group = text(filters.group || "all");
  const status = text(filters.status || "available");
  return (rows || []).filter((item) => {
    if (query && !text(item.item_name).toLocaleLowerCase("zh-CN").includes(query)) return false;
    if (group !== "all" && item.purchase_group !== group) return false;
    if (status !== "all" && item.status !== status) return false;
    return true;
  });
}

function buildSignals(state, derived, recipeNames) {
  const signals = [];
  (derived.adaptable || []).forEach((dish) => signals.push({
    id: `adaptable:${dish.id}`,
    module: "diet",
    page: "menu",
    severity: "warning",
    title: recipeNames[dish.recipe_id] || "未命名菜品",
    detail: `缺料但可继续制作${dish.missing?.length ? ` · 缺少 ${dish.missing.join("、")}` : ""}`,
  }));
  (derived.at_risk || []).forEach((dish) => signals.push({
    id: `risk:${dish.id}`,
    module: "diet",
    page: "menu",
    severity: "warning",
    title: recipeNames[dish.recipe_id] || "未命名菜品",
    detail: `等待采购，也可选择缺料继续${dish.missing?.length ? ` · 缺少 ${dish.missing.join("、")}` : ""}`,
  }));
  (derived.pending_decisions || []).forEach((decision) => signals.push({
    id: `decision:${decision.id}`,
    module: "overview",
    page: "overview",
    core: "decisions",
    severity: "warning",
    title: decision.title || "等待家庭决定",
    detail: decision.reason || "需要人创造新的家庭意图",
  }));
  const pendingOperations = array(state, "operations").filter((item) => ["committed_with_pending_projection", "failed", "needs_review"].includes(item.status));
  pendingOperations.forEach((operation) => signals.push({
    id: `operation:${operation.operation_id || operation.id}`,
    module: "overview",
    page: "overview",
    core: "recovery",
    severity: "urgent",
    title: operation.summary || "操作需要恢复",
    detail: operation.error || operation.status,
  }));
  array(state, "conflicts").filter((item) => item.status === "open").forEach((conflict) => signals.push({
    id: `conflict:${conflict.id}`,
    module: "overview",
    page: "overview",
    core: "recovery",
    severity: "urgent",
    title: conflict.conflict_type || "冲突需要核对",
    detail: conflict.details?.projection_path || conflict.operation_id || conflict.id,
  }));
  return signals;
}

function buildFamilySystemViewModel(state, derived, options = {}) {
  const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
  const today = now.toISOString().slice(0, 10);
  const recipes = active(array(state, "recipe"));
  const recipeNames = Object.fromEntries(recipes.map((item) => [item.id, item.name]));
  const categories = taskCategories(state);
  const activeCategories = categories.filter((item) => item.status === "active");
  const tasks = taskRows(state, categories);
  const entities = active(array(state, "entity"));
  const entityIndex = new Map(entities.map((item) => [item.id, item]));
  const members = active(array(state, "member"));
  const withPurchaseGroup = (item) => {
    const itemId = item.item_entity_id || item.ingredient_id;
    const entity = entityIndex.get(itemId);
    return {
      ...item,
      item_entity_id: itemId,
      item_name: item.item_name || item.ingredient_name || entity?.name || "未命名物品",
      purchase_group: item.purchase_group || entity?.purchase_group || "未分类",
    };
  };
  const demands = active(array(state, "purchase_demand")).filter((item) => item.status !== "fulfilled").map(withPurchaseGroup);
  const receipts = active(array(state, "receipt")).map(withPurchaseGroup);
  const batches = active(array(state, "inventory_batch")).map(withPurchaseGroup);
  const movements = active(array(state, "inventory_movement"));
  const financeLinks = active(array(state, "finance_link"));
  const financeTransactions = active(array(state, "finance_transaction"));
  const financeAccounts = active(array(state, "finance_account"));
  const budgets = active(array(state, "budget"));
  const recurringItems = active(array(state, "recurring_item"));
  const balances = active(array(state, "balance_snapshot"));
  const mealPlans = active(array(state, "meal_plan"));
  const purchaseSessions = active(array(state, "purchase_session"));
  const aftersales = active(array(state, "aftersale_case"));
  const documents = active(array(state, "document"));
  const contacts = active(array(state, "contact"));
  const medicalProfiles = active(array(state, "medical_profile"));
  const accountReferences = active(array(state, "account_reference"));
  const assets = active(array(state, "asset"));
  const maintenancePlans = active(array(state, "maintenance_plan"));
  const services = active(array(state, "service_record"));
  const mealSlots = active(array(state, "meal_slot"));
  const futureMeals = mealSlots.filter((item) => text(item.planned_date) >= today && !["completed", "skipped"].includes(item.status));
  const weeklyMenu = buildWeeklyMenu(mealPlans, mealSlots, derived.dish_states || [], today, options.menu_plan_id);
  const recordTypesWithData = Object.keys(state || {}).filter((key) => Array.isArray(state[key]) && active(state[key]).length).length;
  const signals = buildSignals(state, derived, recipeNames);
  const configuredOrder = Array.isArray(options.purchase_group_order) ? options.purchase_group_order : [];
  const discoveredGroups = [...new Set(demands.map((item) => item.purchase_group))];
  const purchaseGroupOrder = [...configuredOrder, ...discoveredGroups.filter((group) => !configuredOrder.includes(group))];
  const purchaseGroups = purchaseGroupOrder.map((group) => ({ group, items: demands.filter((item) => item.purchase_group === group) })).filter((item) => item.items.length);
  const inventorySummaryAll = buildInventorySummary(entities, batches);
  const inventoryGroups = [...new Set(inventorySummaryAll.map((item) => item.purchase_group))].sort((left, right) => {
    const leftIndex = purchaseGroupOrder.indexOf(left);
    const rightIndex = purchaseGroupOrder.indexOf(right);
    return (leftIndex < 0 ? 999 : leftIndex) - (rightIndex < 0 ? 999 : rightIndex) || text(left).localeCompare(text(right), "zh-CN");
  });
  const inventorySummary = filterInventorySummary(inventorySummaryAll, options.inventory_filter);
  const moduleCounts = {
    overview: signals.length,
    reminder: tasksForPage(tasks, "overview", today).length,
    diet: (derived.dish_states || []).length,
    purchase: demands.length,
    finance: financeTransactions.length,
    basic: members.length + documents.length + contacts.length + medicalProfiles.length + accountReferences.length,
    asset: assets.length,
  };
  return {
    today,
    recipes,
    recipe_names: recipeNames,
    members,
    tasks,
    task_categories: activeCategories,
    all_task_categories: categories,
    inventory_items: entities.filter((item) => ["ingredient_item", "inventory_item"].includes(item.entity_kind)),
    tasks_by_page: Object.fromEntries(MODULES.reminder.pages.map(([page]) => [page, tasksForPage(tasks, page, today)])),
    demands,
    purchase_groups: purchaseGroups,
    purchase_group_order: purchaseGroupOrder,
    receipts,
    batches,
    inventory_summary: inventorySummary,
    inventory_summary_all: inventorySummaryAll,
    inventory_groups: inventoryGroups,
    movements,
    finance_links: financeLinks,
    finance_review: financeLinks.filter(financeNeedsReview),
    finance_transactions: financeTransactions,
    finance_accounts: financeAccounts,
    budgets,
    recurring_items: recurringItems,
    balance_snapshots: balances,
    meal_plans: mealPlans,
    purchase_sessions: purchaseSessions,
    aftersales,
    documents,
    contacts,
    medical_profiles: medicalProfiles,
    account_references: accountReferences,
    assets,
    maintenance_plans: maintenancePlans,
    service_records: services,
    future_meals: futureMeals,
    weekly_menu: weeklyMenu,
    signals,
    module_counts: moduleCounts,
    metrics: [
      ["待处理信号", signals.length, "跨模块聚合"],
      ["今日事务", tasksForPage(tasks, "today", today).length, "Life Core 权威事务"],
      ["近期计划", futureMeals.length, "当前及未来餐次"],
      ["数据核验", recordTypesWithData, "存在有效记录的类型"],
    ],
  };
}

module.exports = {
  DEFAULT_PAGES,
  MODULES,
  buildWeeklyMenu,
  buildInventorySummary,
  filterInventorySummary,
  buildFamilySystemViewModel,
  dateKey,
  normalizeModule,
  normalizePage,
  tasksForPage,
  taskCategories,
};
