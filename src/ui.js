"use strict";

const { ItemView, Modal, Notice, Setting, setIcon } = require("obsidian");
const { MODULES } = require("./view-model");
const { mealPlanRange, RECIPE_CATEGORIES, RECIPE_MEAL_TYPES, uuidFromSeed } = require("./core");

const VIEW_TYPE = "betagifted-family-system-view";
const MATERIALS = Object.freeze([
  ["cyan", "Cyan"],
  ["original", "Original"],
  ["rain", "Rain"],
  ["chrome", "Chrome"],
]);
const ACCENTS = Object.freeze([
  ["ocean", "Ocean"],
  ["emerald", "Emerald"],
  ["iris", "Iris"],
  ["amber", "Amber"],
  ["sakura", "Sakura"],
]);

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = String(text);
  return node;
}

function append(parent, ...children) {
  children.filter(Boolean).forEach((child) => parent.appendChild(child));
  return parent;
}

function button(label, className, onClick, icon, attributes) {
  const node = element("button", className || "family-system-button", label);
  node.type = "button";
  Object.entries(attributes || {}).forEach(([name, value]) => node.setAttribute(name, String(value)));
  if (icon && typeof setIcon === "function") {
    node.textContent = "";
    const iconNode = element("span", "family-system-button-icon");
    setIcon(iconNode, icon);
    append(node, iconNode, element("span", "family-system-button-label", label));
  }
  node.addEventListener("click", onClick);
  return node;
}

function statusLabel(status) {
  const labels = {
    ready: "食材已备齐", adapted: "已按缺料调整", adaptable: "缺料可继续", at_risk: "等待采购", blocked: "已阻塞", planned: "已计划",
    active: "有效", draft: "草稿", completed: "已完成", skipped: "已跳过",
    available: "有库存", depleted: "已耗尽",
    cancelled: "已取消", open: "待处理", pending: "待处理", fulfilled: "已实收",
    receipt_confirmed: "已确认实收", committed: "已完成",
    committed_with_pending_projection: "投影待恢复", compensated: "已补偿",
    failed: "需要人工核对", needs_review: "人工接管", prepared: "待确认",
    applying: "执行中", current: "当前", ready_to_import: "可导入",
  };
  return labels[status] || status || "未知";
}

function badge(status, label) {
  return element("span", `family-system-badge is-${status || "neutral"}`, label || statusLabel(status));
}

function section(title, description, count) {
  const wrapper = element("section", "family-system-panel");
  const head = element("div", "family-system-panel-head");
  const copy = element("div", "family-system-panel-copy");
  append(copy, element("h2", "", title));
  if (description) copy.appendChild(element("p", "", description));
  append(head, copy, count == null ? null : badge("neutral", `${count} 项`));
  wrapper.appendChild(head);
  return wrapper;
}

function emptyState(title, description, actionNode) {
  const node = element("div", "family-system-empty");
  append(node, element("strong", "", title), element("p", "", description), actionNode);
  return node;
}

function metric(label, value, note, index) {
  const node = element("div", `family-system-metric is-material-${index % 4}`);
  append(node,
    element("span", "family-system-metric-label", label),
    element("strong", "family-system-metric-value", value),
    element("span", "family-system-metric-note", note || "")
  );
  return node;
}

function recordRow(title, meta, status, actions, options = {}) {
  const row = element("div", `family-system-record ${options.className || ""}`.trim());
  const copy = element("div", "family-system-record-copy");
  append(copy, element("strong", "", title), element("span", "", meta || ""));
  const side = element("div", "family-system-record-side");
  if (status) side.appendChild(badge(status));
  (actions || []).filter(Boolean).forEach((action) => side.appendChild(action));
  append(row, copy, side);
  return row;
}

function quantityDisplay(item, available = false) {
  const quantity = available ? item.available_quantity : item.quantity;
  const canonical = `${quantity || 0} ${item.unit || ""}`.trim();
  if (item.display_unit && item.display_quantity != null && (item.display_unit !== item.unit || Number(item.display_quantity) !== Number(quantity))) {
    return `${item.display_quantity} ${item.display_unit}（折合 ${canonical}）`;
  }
  if (!available && item.normalized_unit && item.normalized_quantity != null && (item.normalized_unit !== item.unit || Number(item.normalized_quantity) !== Number(item.quantity))) {
    return `${item.quantity || 0} ${item.unit || ""}（折合 ${item.normalized_quantity} ${item.normalized_unit}）`;
  }
  return canonical;
}

function active(records) {
  return (records || []).filter((record) => !record.tombstone && record.status !== "cancelled");
}

function recipeIngredientMode(ingredient, inventoryItems) {
  const itemId = ingredient?.item_entity_id || ingredient?.inventory_item_id || null;
  if (itemId && (inventoryItems || []).some((item) => item.id === itemId || item.source_item_id === itemId)) return "tracked";
  if (String(ingredient?.inventory_policy || "").startsWith("untracked")) return "untracked";
  return "legacy";
}

function recipeIngredientDraftToRecord(draft, inventoryItems) {
  const original = draft.original && typeof draft.original === "object" ? draft.original : {};
  const quantity = Number(draft.quantity);
  const unit = String(draft.unit || "").trim();
  if (!Number.isFinite(quantity) || quantity <= 0) throw new Error("食材数量必须大于 0");
  if (!unit) throw new Error("食材单位不能为空");
  const specificity = draft.specificity === "specific" ? "specific" : "general";
  if (draft.mode === "tracked") {
    const item = (inventoryItems || []).find((candidate) => candidate.id === draft.item_id);
    if (!item) throw new Error("受库存管理的食材必须选择已登记物品");
    return {
      ...original,
      id: item.id,
      key: item.name,
      name: item.name,
      quantity,
      unit,
      specificity,
      inventory_policy: "tracked",
      item_entity_id: item.id,
      inventory_item_id: item.source_item_id || item.id,
      source_item_id: item.source_item_id || original.source_item_id || null,
    };
  }
  const name = String(draft.name || "").trim();
  if (!name) throw new Error("非库存食材名称不能为空");
  if (draft.mode === "legacy") {
    return { ...original, id: original.id, name, key: original.key || name, quantity, unit, specificity };
  }
  const { item_entity_id, inventory_item_id, source_item_id, item_id, ...unmapped } = original;
  return {
    ...unmapped,
    id: original.id || uuidFromSeed(`ingredient:${name.toLocaleLowerCase("zh-CN")}`),
    key: name,
    name,
    quantity,
    unit,
    specificity,
    inventory_policy: "untracked_consumable",
  };
}

function recipeMeta(recipe) {
  return `${recipe.category || "未分类"} · ${(recipe.meal_types || []).join("／") || "未设置餐次"} · ${recipe.servings || 0} 份 · ${recipe.prep_minutes || 0} 分钟`;
}

function detailGroup(title) {
  const group = element("section", "family-system-recipe-detail-group");
  group.appendChild(element("h3", "", title));
  return group;
}

function renderRecipeDetails(parent, recipe) {
  const summary = element("div", "family-system-recipe-summary");
  [
    ["分类", recipe.category || "未设置"],
    ["适用餐次", (recipe.meal_types || []).join("、") || "未设置"],
    ["份数", `${recipe.servings || 0} 份`],
    ["制作时长", `${recipe.prep_minutes || 0} 分钟`],
  ].forEach(([label, value]) => {
    const item = element("div", "family-system-recipe-summary-item");
    append(item, element("span", "", label), element("strong", "", value));
    summary.appendChild(item);
  });
  parent.appendChild(summary);

  const ingredients = detailGroup("食材");
  const ingredientList = element("div", "family-system-recipe-ingredient-list");
  (recipe.ingredients || []).forEach((ingredient) => {
    const row = element("div", "family-system-recipe-ingredient");
    append(row,
      element("strong", "", ingredient.name || "未命名食材"),
      element("span", "", `${ingredient.quantity || 0} ${ingredient.unit || ""}`.trim()),
      element("small", "", String(ingredient.inventory_policy || "").startsWith("untracked") ? "非库存消耗品" : ingredient.item_entity_id ? "已关联库存" : "保留现有食材记录")
    );
    ingredientList.appendChild(row);
  });
  ingredients.appendChild(ingredientList);
  parent.appendChild(ingredients);

  const steps = detailGroup("制作步骤");
  const stepList = element("ol", "family-system-recipe-steps");
  (recipe.steps || []).forEach((step) => stepList.appendChild(element("li", "", step)));
  if (!stepList.children.length) stepList.appendChild(element("li", "family-system-muted", "暂未记录制作步骤"));
  steps.appendChild(stepList);
  parent.appendChild(steps);

  const tags = detailGroup("标签与过敏原");
  const tagLine = element("div", "family-system-recipe-tags");
  (recipe.tags || []).forEach((tag) => tagLine.appendChild(element("span", "", tag)));
  (recipe.allergen_tags || []).forEach((tag) => tagLine.appendChild(element("span", "is-allergen", `过敏原：${tag}`)));
  if (!tagLine.children.length) tagLine.appendChild(element("span", "", "暂无标签"));
  tags.appendChild(tagLine);
  parent.appendChild(tags);
  return parent;
}

function moduleLabel(module) {
  return MODULES[module]?.label || "家庭系统";
}

function renderRail(parent, model, handlers) {
  const rail = element("nav", "family-system-rail family-system-panel");
  rail.setAttribute("aria-label", "家庭模块");
  const brand = element("div", "family-system-brand");
  append(brand, element("div", "family-system-brand-mark", "BG"));
  const copy = element("div", "family-system-brand-copy");
  append(copy, element("strong", "", "家庭系统"), element("span", "", "LIFE CORE"));
  brand.appendChild(copy);
  rail.appendChild(brand);
  const nav = element("div", "family-system-nav");
  Object.entries(MODULES).forEach(([key, meta]) => {
    const item = button(meta.label, `family-system-nav-item ${model.module === key ? "is-active" : ""}`, () => handlers.navigateModule(key), meta.icon, {
      "aria-current": model.module === key ? "page" : "false",
      "aria-label": meta.label,
    });
    item.appendChild(element("span", "family-system-nav-count", model.dashboard.module_counts[key]));
    nav.appendChild(item);
  });
  rail.appendChild(nav);
  const foot = element("div", "family-system-rail-foot");
  append(foot, element("span", "family-system-local-dot"), element("span", "", "本地数据 · 无网络"));
  rail.appendChild(foot);
  parent.appendChild(rail);
}

function renderTopbar(parent, model, handlers) {
  const topbar = element("header", "family-system-topbar");
  const title = element("div", "family-system-top-title");
  append(title, element("strong", "", moduleLabel(model.module)), element("span", "", `${model.household?.name || "尚未建立家庭"} · Markdown 定义 / JSON 运行`));
  const actions = element("div", "family-system-top-actions");
  append(actions,
    badge(model.authority_status || model.store_status),
    model.authority_module_path ? button("打开资料", "family-system-icon-button", handlers.openAuthorityModule, "file-text", { "aria-label": "打开当前模块权威 Markdown" }) : null,
    button("刷新", "family-system-icon-button", handlers.refresh, "refresh-cw", { "aria-label": "刷新" }),
    button("切换主题", "family-system-icon-button", handlers.toggleTheme, model.theme === "dark" ? "sun" : "moon", { "aria-label": "切换主题" }),
    button("材质与外观", "family-system-icon-button", handlers.toggleMaterials, "sliders-horizontal", { "aria-label": "材质与外观" }),
    button("设置", "family-system-icon-button", handlers.settings, "settings-2", { "aria-label": "设置" })
  );
  append(topbar, title, actions);
  parent.appendChild(topbar);
}

function renderLocalNav(parent, model, handlers) {
  const meta = MODULES[model.module];
  const nav = element("nav", "family-system-local-nav");
  nav.setAttribute("aria-label", `${meta.label}页面`);
  meta.pages.forEach(([page, label]) => {
    nav.appendChild(button(label, model.page === page ? "is-active" : "", () => handlers.navigatePage(page), null, {
      "aria-current": model.page === page ? "page" : "false",
    }));
  });
  parent.appendChild(nav);
}

function dishActions(dish, handlers, primaryReschedule = true) {
  return [
    button("改期", `family-system-mini-button ${primaryReschedule ? "is-primary" : ""}`.trim(), () => handlers.reschedule(dish.id)),
    button("跳过菜品", "family-system-mini-button", () => handlers.skipDish(dish.id)),
    button("跳过整餐", "family-system-mini-button", () => handlers.skipMeal(dish.meal_slot?.id)),
    button("替换", "family-system-mini-button", () => handlers.replaceDish(dish.id)),
  ];
}

function dishAdaptationActions(dish, handlers) {
  if (["completed", "skipped"].includes(dish.status)) return [];
  const actions = [];
  if (dish.missing_requirements?.length) {
    actions.push(button("缺料也做", "family-system-mini-button is-primary", () => handlers.continueWithoutMissing(dish.id, dish.revision)));
  }
  if (dish.omitted_requirements?.length) {
    actions.push(button("恢复原料", "family-system-mini-button", () => handlers.restoreOmittedIngredients(dish.id, dish.revision)));
  }
  return actions;
}

function menuDishActions(dish, meal, model, handlers) {
  const recipeAvailable = Boolean(model.recipe_names[dish.recipe_id]);
  const recipeAction = recipeAvailable
    ? button("查看做法", "family-system-mini-button is-primary", () => handlers.viewRecipe(dish.recipe_id, {
      readOnly: true,
      context: {
        planned_date: meal.planned_date || dish.meal_slot?.planned_date || "",
        meal_label: meal.meal_label || dish.meal_slot?.meal_label || "餐次",
        dish_plan_id: dish.id,
      },
    }))
    : button("菜谱不可用", "family-system-mini-button", () => {}, null, {
      disabled: true,
      "aria-disabled": true,
      title: "菜谱可能已归档或删除",
    });
  if (model.dashboard.weekly_menu?.plan?.status === "draft") {
    return [recipeAction, button("手动替换", "family-system-mini-button", () => handlers.replaceDish(dish.id))];
  }
  return [recipeAction, ...dishAdaptationActions(dish, handlers), ...dishActions(dish, handlers, false)];
}

function dishMeta(dish) {
  const slot = dish.meal_slot || {};
  const missing = dish.missing?.length ? ` · 缺少 ${dish.missing.join("、")}` : "";
  const omitted = dish.omitted?.length ? ` · 本餐不使用 ${dish.omitted.join("、")}` : "";
  return `${slot.planned_date || "未定"} ${slot.meal_label || "餐次"}${missing}${omitted}`;
}

function dishDayMeta(dish) {
  if (dish.missing?.length) return `缺少 ${dish.missing.join("、")} · 仍可继续制作`;
  if (dish.omitted?.length) return `本餐不使用 ${dish.omitted.join("、")} · 可继续制作`;
  return "食材与库存状态已核对";
}

function renderMenuDaySwitcher(parent, weeklyMenu, selectedDate, handlers) {
  const switcher = element("nav", "family-system-menu-switcher");
  switcher.setAttribute("aria-label", "按日期查看菜单");
  switcher.appendChild(button("全部日期", `family-system-menu-day-button ${selectedDate === "all" ? "is-active" : ""}`, () => handlers.selectMenuDate("all"), null, {
    "aria-pressed": selectedDate === "all",
  }));
  weeklyMenu.days.forEach((day) => {
    const label = `${day.weekday} ${day.date_label}`;
    switcher.appendChild(button(label, `family-system-menu-day-button ${selectedDate === day.date ? "is-active" : ""} ${day.is_today ? "is-today" : ""}`.trim(), () => handlers.selectMenuDate(day.date), null, {
      "aria-pressed": selectedDate === day.date,
      "aria-label": `${label}${day.is_today ? "，今天" : ""}，${day.meal_count} 餐`,
    }));
  });
  parent.appendChild(switcher);
}

function renderMenuHandling(parent, day) {
  if (!day.handling_actions.length) return;
  const wrapper = element("aside", "family-system-day-handling");
  const head = element("div", "family-system-day-handling-head");
  append(head, element("strong", "", "当天食材处理"), badge("planned", `${day.handling_actions.length} 项`));
  wrapper.appendChild(head);
  day.handling_actions.forEach((action) => {
    const item = element("div", "family-system-day-handling-item");
    const due = String(action.scheduled_at || "").replace("T", " ").slice(11, 16);
    append(item, element("strong", "", action.title || "食材处理"), element("span", "", due ? `${due} 执行` : "时间待定"));
    if (action.instructions?.length) {
      const list = element("ul", "family-system-day-handling-list");
      action.instructions.forEach((instruction) => list.appendChild(element("li", "", instruction.instruction || "")));
      item.appendChild(list);
    }
    wrapper.appendChild(item);
  });
  parent.appendChild(wrapper);
}

function renderMealGroup(parent, meal, model, handlers) {
  const group = element("article", "family-system-meal-group");
  const head = element("div", "family-system-meal-group-head");
  const copy = element("div", "family-system-meal-group-copy");
  append(copy, element("h3", "", meal.meal_label || "餐次"));
  if (meal.note) copy.appendChild(element("p", "", meal.note));
  const headActions = element("div", "family-system-meal-group-actions");
  const draft = model.dashboard.weekly_menu?.plan?.status === "draft";
  headActions.appendChild(badge(meal.generation_status === "gap" ? "adaptable" : meal.status || "planned", meal.generation_status === "gap" ? "待补齐" : `${meal.dishes.length} 道`));
  if (draft) {
    headActions.appendChild(button(meal.locked ? "解锁" : "锁定", "family-system-mini-button", () => handlers.setMealSlotLock(meal.id, meal.revision, !meal.locked)));
    if (!meal.locked) headActions.appendChild(button("换一组", "family-system-mini-button is-primary", () => handlers.regenerateMealPlan(meal.source_plan_id, model.dashboard.weekly_menu.plan.revision, [meal.id])));
  } else if (!["completed", "skipped"].includes(meal.status) && meal.dishes.length) {
    headActions.appendChild(button("完成本餐", "family-system-mini-button is-primary", () => handlers.completeMeal(meal.id, meal.revision)));
  }
  append(head, copy, headActions);
  group.appendChild(head);
  if (!meal.dishes.length) group.appendChild(emptyState("本餐尚未安排菜品", meal.generation_message || "可使用上方按钮为这个餐次添加菜品。"));
  meal.dishes.forEach((dish) => group.appendChild(recordRow(
    model.recipe_names[dish.recipe_id] || dish.id,
    dishDayMeta(dish),
    dish.status,
    menuDishActions(dish, meal, model, handlers),
    { className: "family-system-menu-dish" }
  )));
  parent.appendChild(group);
}

function renderMenuDay(parent, day, model, handlers, compact = false) {
  const dayCard = element("section", `family-system-menu-day ${day.is_today ? "is-today" : ""}`.trim());
  const head = element("div", "family-system-menu-day-head");
  const copy = element("div", "family-system-menu-day-copy");
  append(copy, element("h2", "", `${day.weekday} · ${day.date_label}`), element("span", "", `${day.meal_count} 餐 · ${day.dish_count} 道菜`));
  append(head, copy, day.is_today ? badge("ready", "今天") : null);
  dayCard.appendChild(head);
  renderMenuHandling(dayCard, day);
  const meals = element("div", "family-system-meal-groups");
  if (!day.meals.length) meals.appendChild(emptyState("当天没有餐饮安排", "当前菜单没有为这一天建立餐次。"));
  day.meals.forEach((meal) => renderMealGroup(meals, meal, model, handlers));
  dayCard.appendChild(meals);
  if (compact) dayCard.classList.add("is-week-view");
  parent.appendChild(dayCard);
}

function renderOrderPanel(content, model, handlers, compact) {
  const rows = [...(model.derived.adaptable || []), ...(model.derived.at_risk || []), ...(model.derived.adapted || []), ...(model.derived.ready || [])];
  if (!model.household) {
    content.appendChild(emptyState("尚未建立 Life Core", `将在 ${model.data_root} 建立空白结构化系统。`, button("建立空白家庭", "family-system-button is-primary", handlers.initialize)));
    return;
  }
  if (!rows.length) {
    content.appendChild(emptyState("当前没有餐饮安排", "先新增成员与菜谱，再安排一个确定餐次。", button("前往饮食健康", "family-system-button is-primary", () => handlers.navigateModule("diet"))));
    return;
  }
  rows.slice(0, compact ? 8 : rows.length).forEach((dish) => content.appendChild(recordRow(
    model.recipe_names[dish.recipe_id] || "未命名菜品",
    dishMeta(dish),
    dish.status,
    [...dishAdaptationActions(dish, handlers), ...(["adaptable", "at_risk"].includes(dish.status) ? dishActions(dish, handlers) : [])]
  )));
}

function renderDecisionPanel(content, model, handlers, compact) {
  const actionable = [...(model.derived.adaptable || []), ...(model.derived.at_risk || [])];
  const pending = active(model.state.decision_request).filter((item) => item.status === "pending");
  if (!actionable.length && !pending.length) {
    content.appendChild(emptyState("没有待决定事项", "事实、未知和当前意图没有形成新的决策分支。"));
    return;
  }
  actionable.slice(0, compact ? 6 : actionable.length).forEach((dish) => content.appendChild(recordRow(
    model.recipe_names[dish.recipe_id] || "未命名菜品",
    `待核对：${dish.missing?.join("、") || "执行前提"}；可选择缺料也做、替换、改期或跳过。`,
    dish.status,
    [...dishAdaptationActions(dish, handlers), ...dishActions(dish, handlers)]
  )));
  pending.slice(0, compact ? 4 : pending.length).forEach((decision) => content.appendChild(recordRow(
    decision.title || "待决定事项",
    decision.reason || "需要人工判断",
    decision.status
  )));
}

function renderRecoveryPanel(content, model, handlers, compact) {
  const operations = model.state.operations.filter((item) => !["committed", "compensated", "previewed"].includes(item.status));
  const conflicts = model.state.conflicts.filter((item) => item.status === "open");
  if (!operations.length && !conflicts.length) {
    content.appendChild(emptyState("当前没有恢复事项", "所有已执行操作均已完成或安全补偿。"));
    return;
  }
  operations.slice(0, compact ? 6 : operations.length).forEach((operation) => {
    const actions = [];
    if (operation.status === "prepared") actions.push(button("放弃预演", "family-system-mini-button", () => handlers.recover(operation.operation_id, "discard_preview")));
    if (operation.status === "committed_with_pending_projection") actions.push(button("重试投影", "family-system-mini-button is-primary", () => handlers.recover(operation.operation_id, "retry_projection")));
    if (["committed", "committed_with_pending_projection"].includes(operation.status)) actions.push(button("撤销", "family-system-mini-button", () => handlers.recover(operation.operation_id, "undo")));
    if (["failed", "compensated"].includes(operation.status)) actions.push(button("转人工", "family-system-mini-button", () => handlers.recover(operation.operation_id, "mark_manual")));
    content.appendChild(recordRow(operation.summary || operation.command?.command_type, operation.error || operation.operation_id, operation.status, actions));
  });
  conflicts.slice(0, compact ? 4 : conflicts.length).forEach((conflict) => content.appendChild(recordRow(
    conflict.conflict_type,
    conflict.details?.projection_path || conflict.operation_id || conflict.id,
    "needs_review"
  )));
}

function renderCoreCenter(parent, model, handlers) {
  const panel = section("家庭核心中心", "现实事实先确认，系统再传播确定或预授权的后果。", model.derived.pending_decisions.length + model.derived.recovery_count);
  panel.classList.add("family-system-core-center");
  const nav = element("div", "family-system-core-tabs");
  nav.setAttribute("role", "tablist");
  const tabs = [
    ["order", "当前秩序", `${(model.derived.ready || []).length} 已备齐 · ${(model.derived.adaptable || []).length} 缺料可继续`],
    ["decisions", "决策中心", `${model.derived.pending_decisions.length} 项`],
    ["recovery", "异常与恢复", `${model.derived.recovery_count} 项`],
  ];
  tabs.forEach(([id, label, note]) => {
    const tab = button(label, model.core_section === id ? "is-active" : "", () => handlers.coreSection(id), null, {
      role: "tab", "aria-selected": model.core_section === id ? "true" : "false",
    });
    tab.appendChild(element("small", "", note));
    nav.appendChild(tab);
  });
  panel.appendChild(nav);
  const content = element("div", "family-system-core-content");
  content.setAttribute("role", "tabpanel");
  if (model.core_section === "decisions") renderDecisionPanel(content, model, handlers, true);
  else if (model.core_section === "recovery") renderRecoveryPanel(content, model, handlers, true);
  else renderOrderPanel(content, model, handlers, true);
  panel.appendChild(content);
  parent.appendChild(panel);
}

function normalizedStageOffset(index, activeIndex, count) {
  let offset = index - activeIndex;
  if (offset > count / 2) offset -= count;
  if (offset < -count / 2) offset += count;
  return offset;
}

function renderStage(parent, model, handlers) {
  const entries = Object.entries(MODULES).filter(([key]) => key !== "overview");
  const panel = section("系统导航", "滚轮、拖动或点击进入业务模块；减少动态时自动切换为静态横向列表。", entries.length);
  panel.classList.add("family-system-stage");
  const controls = element("div", "family-system-stage-controls");
  append(controls,
    button("上一个", "family-system-icon-button", () => handlers.rotateStage(-1), "chevron-left", { "aria-label": "上一个系统" }),
    button("下一个", "family-system-icon-button", () => handlers.rotateStage(1), "chevron-right", { "aria-label": "下一个系统" })
  );
  panel.querySelector(".family-system-panel-head").appendChild(controls);
  const viewport = element("div", "family-system-stage-viewport");
  viewport.tabIndex = 0;
  viewport.setAttribute("aria-label", "家庭业务模块动态导航");
  viewport.addEventListener("wheel", (event) => {
    if (model.reduced_motion) return;
    event.preventDefault();
    handlers.rotateStage(event.deltaY >= 0 ? 1 : -1);
  }, { passive: false });
  let startX = null;
  let dragged = false;
  viewport.addEventListener("pointerdown", (event) => {
    startX = event.clientX;
    dragged = false;
    viewport.setPointerCapture?.(event.pointerId);
  });
  viewport.addEventListener("pointermove", (event) => {
    if (startX != null && Math.abs(event.clientX - startX) > 12) dragged = true;
  });
  viewport.addEventListener("pointerup", (event) => {
    if (startX != null && Math.abs(event.clientX - startX) > 42) handlers.rotateStage(event.clientX > startX ? -1 : 1);
    startX = null;
    setTimeout(() => { dragged = false; }, 0);
  });
  const scene = element("div", "family-system-stage-scene");
  entries.forEach(([key, meta], index) => {
    const offset = normalizedStageOffset(index, model.stage_index % entries.length, entries.length);
    const card = button(meta.label, `family-system-stage-card ${offset === 0 ? "is-active" : ""}`, () => {
      if (!dragged) handlers.navigateModule(key);
    }, meta.icon, { "data-module": key, "aria-pressed": offset === 0 ? "true" : "false" });
    card.style.setProperty("--stage-x", String(offset));
    card.style.setProperty("--stage-distance", String(Math.abs(offset)));
    card.style.setProperty("--stage-shift", `${offset * 145}px`);
    card.style.setProperty("--stage-depth", `${(2 - Math.abs(offset)) * 22}px`);
    card.style.setProperty("--stage-turn", `${offset * -10}deg`);
    card.style.setProperty("--stage-scale", String(Math.max(0.76, 1 - Math.abs(offset) * 0.07)));
    card.style.zIndex = String(20 - Math.abs(offset));
    card.style.opacity = String(Math.max(0.28, 1 - Math.abs(offset) * 0.22));
    card.appendChild(element("strong", "family-system-stage-number", String(index + 1).padStart(2, "0")));
    card.appendChild(element("span", "family-system-stage-count", `${model.dashboard.module_counts[key]} 项`));
    scene.appendChild(card);
  });
  viewport.appendChild(scene);
  panel.appendChild(viewport);
  parent.appendChild(panel);
}

function renderSignals(parent, model, handlers) {
  const panel = section("信号队列", "当前信号 → 下一步动作", model.dashboard.signals.length);
  panel.classList.add("family-system-signal-panel");
  if (!model.dashboard.signals.length) panel.appendChild(emptyState("当前没有待处理信号", "Life Core 没有发现阻塞、待决定或待恢复事项。"));
  model.dashboard.signals.slice(0, 12).forEach((signal) => {
    const action = button("打开", "family-system-mini-button", () => handlers.openSignal(signal));
    panel.appendChild(recordRow(signal.title, `${moduleLabel(signal.module)} · ${signal.detail}`, signal.severity === "urgent" ? "blocked" : "at_risk", [action]));
  });
  parent.appendChild(panel);
}

function renderHistory(parent, model) {
  const events = active(model.state.domain_event).slice().sort((a, b) => String(b.recorded_at).localeCompare(String(a.recorded_at)));
  const panel = section("历史与解释", "不可变事件保留事实、决定与修正的因果。", events.length);
  if (!events.length) panel.appendChild(emptyState("尚无领域事件", "完成一次经确认操作后，这里会出现来源、作用对象和变化身份。"));
  events.slice(0, 10).forEach((event) => panel.appendChild(recordRow(event.event_type, `${event.recorded_at} · ${event.aggregate_id}`, "committed")));
  parent.appendChild(panel);
}

function renderOverview(parent, model, handlers) {
  if (!model.household) {
    parent.appendChild(emptyState("尚未建立 Life Core", `将在 ${model.data_root} 建立空白结构化系统，不读取旧插件设置。`, button("建立空白家庭", "family-system-button is-primary", handlers.initialize)));
    return;
  }
  const metrics = element("div", "family-system-metrics");
  model.dashboard.metrics.forEach((entry, index) => metrics.appendChild(metric(entry[0], entry[1], entry[2], index)));
  parent.appendChild(metrics);
  renderCoreCenter(parent, model, handlers);
  const work = element("div", "family-system-work-grid");
  renderSignals(work, model, handlers);
  renderStage(work, model, handlers);
  parent.appendChild(work);
  renderHistory(parent, model);
}

function actionBar(...nodes) {
  const bar = element("div", "family-system-action-bar");
  nodes.filter(Boolean).forEach((node) => bar.appendChild(node));
  return bar;
}

function handlingPlanDetails(plan) {
  const instructions = Array.isArray(plan.handling_instructions) ? plan.handling_instructions : [];
  const actions = Array.isArray(plan.handling_actions) ? plan.handling_actions : [];
  const wrapper = element("div", "family-system-handling-details");
  const grouped = new Map();
  instructions.forEach((item) => {
    const source = item && typeof item === "object" ? item : { phase: "通用处理", instruction: String(item || "") };
    const phase = source.phase || "通用处理";
    if (!grouped.has(phase)) grouped.set(phase, []);
    if (source.instruction) grouped.get(phase).push(source.instruction);
  });
  grouped.forEach((items, phase) => {
    const group = element("div", "family-system-handling-group");
    group.appendChild(element("h4", "family-system-handling-title", phase));
    const list = element("ul", "family-system-handling-list");
    items.forEach((instruction) => list.appendChild(element("li", "", instruction)));
    group.appendChild(list);
    wrapper.appendChild(group);
  });
  if (actions.length) {
    const group = element("div", "family-system-handling-group is-actions");
    group.appendChild(element("h4", "family-system-handling-title", "按时执行"));
    const list = element("ul", "family-system-handling-list");
    actions.forEach((action) => {
      const due = String(action.scheduled_at || "").replace("T", " ").slice(0, 16);
      list.appendChild(element("li", "", `${due || "未定时间"} · ${action.title || "食材处理"}`));
    });
    group.appendChild(list);
    wrapper.appendChild(group);
  }
  return wrapper;
}

function renderReminder(parent, model, handlers) {
  const sourceRows = model.dashboard.tasks_by_page[model.page] || [];
  const rows = model.reminder_category === "all" ? sourceRows : sourceRows.filter((item) => item.category_id === model.reminder_category);
  parent.appendChild(actionBar(
    button("新增事项", "family-system-button is-primary", handlers.addTask),
    button("管理分类", "family-system-button", handlers.manageTaskCategories),
    button("同步 Apple", "family-system-button", handlers.syncApple)
  ));
  const filters = element("div", "family-system-filter-row");
  const categories = model.dashboard.all_task_categories.filter((category) => category.status === "active" || sourceRows.some((task) => task.category_id === category.id));
  [["all", "全部分类"], ...categories.map((category) => [category.id, category.name])].forEach(([value, label]) => {
    filters.appendChild(button(label, model.reminder_category === value ? "is-active" : "", () => handlers.selectReminderCategory(value)));
  });
  parent.appendChild(filters);
  const panel = section(MODULES.reminder.pages.find(([id]) => id === model.page)?.[1] || "事务提醒", "Life Core 是事务权威；Apple 提醒事项是可恢复的执行投影。", rows.length);
  panel.appendChild(element("p", "family-system-boundary-note", "Apple 采购提醒完成后按计划数量直接入库；Apple 删除仍只暂停投影并等待家庭系统确认。"));
  if (!rows.length) panel.appendChild(emptyState("当前没有对应任务", "可直接新增事项，或由菜单、采购和维护计划生成。"));
  rows.forEach((task) => panel.appendChild(recordRow(task.title || "未命名任务", `${task.category_name || "未分类"} · ${task.due_at || "未设置时间"}`, task.status, [
    button("删除", "family-system-mini-button is-danger", () => handlers.deleteTask(task.id, task.revision)),
  ])));
  parent.appendChild(panel);
}

function renderDiet(parent, model, handlers) {
  if (model.page === "plans") {
    parent.appendChild(actionBar(
      button("一键自动生成菜单", "family-system-button is-primary", handlers.generateMealPlan),
      button("建立空白菜单", "family-system-button", handlers.createMealPlan)
    ));
    const rows = model.dashboard.meal_plans;
    const panel = section("菜单计划", "未激活菜单以独立 Markdown 为权威；激活时校验并冻结为 JSON 运行实例。", rows.length);
    if (!rows.length) panel.appendChild(emptyState("暂无菜单计划", "可选择任意日期区间，一键生成菜单草稿。"));
    rows.slice().sort((a, b) => mealPlanRange(b).start.localeCompare(mealPlanRange(a).start)).forEach((plan) => {
      const range = mealPlanRange(plan);
      const actions = [
        button("查看菜单", "family-system-mini-button", () => handlers.openMenuPlan(plan.id)),
        button("编辑说明", "family-system-mini-button", () => handlers.editMealPlan(plan.id)),
        plan.status === "draft" ? null : button("重算采购", "family-system-mini-button", () => handlers.rebuildMealPurchases(plan.id, plan.revision)),
      ];
      if (plan.status === "draft") {
        actions.unshift(button("激活", "family-system-mini-button is-primary", () => handlers.activateMealPlan(plan.id, plan.revision)));
        if (plan.generation_options) actions.unshift(button("重生成", "family-system-mini-button", () => handlers.regenerateMealPlan(plan.id, plan.revision)));
      }
      panel.appendChild(recordRow(plan.title || `${range.start} 至 ${range.end} 菜单`, `${range.start} 至 ${range.end} · ${plan.default_serving_count || (plan.participant_ids || []).length || 0} 人 · ${(plan.generation_warnings || []).length} 个待补齐 · ${(plan.handling_instructions || []).length} 条食材处理说明 · ${(plan.handling_actions || []).length} 项处理提醒`, plan.status, actions));
      if ((plan.handling_instructions || []).length || (plan.handling_actions || []).length) panel.appendChild(handlingPlanDetails(plan));
    });
    parent.appendChild(panel);
    return;
  }
  if (model.page === "recipes") {
    parent.appendChild(actionBar(button("新增菜谱", "family-system-button is-primary", handlers.addRecipe)));
    const panel = section("菜谱", "菜谱和安全约束以饮食资料 Markdown 为权威；修改只影响以后激活的菜单。", model.dashboard.recipes.length);
    if (!model.dashboard.recipes.length) panel.appendChild(emptyState("暂无菜谱", "新增菜谱后才能安排菜品。"));
    model.dashboard.recipes.forEach((recipe) => panel.appendChild(recordRow(recipe.name, recipeMeta(recipe), recipe.status, [
      button("查看", "family-system-mini-button", () => handlers.viewRecipe(recipe.id)),
      button("编辑", "family-system-mini-button", () => handlers.editRecipe(recipe.id)),
    ])));
    parent.appendChild(panel);
    return;
  }
  if (model.page === "profiles") {
    parent.appendChild(actionBar(button("新增饮食约束", "family-system-button is-primary", handlers.addConstraint)));
    const panel = section("成员饮食档案", "只保存本人或有权成员确认的过敏、忌口和偏好。", model.dashboard.members.length);
    if (!model.dashboard.members.length) panel.appendChild(emptyState("暂无成员档案", "请先在基础信息中新增家庭成员。"));
    model.dashboard.members.forEach((member) => panel.appendChild(recordRow(member.name, `${member.role || "member"} · ${model.constraint_counts[member.id] || 0} 条约束`, member.status)));
    parent.appendChild(panel);
    return;
  }
  if (model.page === "rules") {
    const rules = [...active(model.state.health_constraint), ...active(model.state.rule)];
    const panel = section("饮食规则", "现实可能性和硬约束优先；软偏好只排序或提示。", rules.length);
    if (!rules.length) panel.appendChild(emptyState("暂无已确认规则", "系统不会根据目录、历史行为或任务状态猜测家庭规则。"));
    rules.forEach((rule) => panel.appendChild(recordRow(rule.label || rule.target || rule.name || rule.id, `${rule.effect_level || rule.rule_kind || "规则"} · ${rule.member_id || "家庭"}`, rule.status)));
    parent.appendChild(panel);
    return;
  }
  const weeklyMenu = model.dashboard.weekly_menu;
  const menuActions = actionBar(
    button("一键自动生成菜单", "family-system-button is-primary", handlers.generateMealPlan),
    button("安排菜品", "family-system-button", handlers.scheduleDish),
    weeklyMenu?.plan?.status === "draft" && weeklyMenu.plan.generation_options ? button("重生成未锁定餐次", "family-system-button", () => handlers.regenerateMealPlan(weeklyMenu.plan.id, weeklyMenu.plan.revision)) : null,
    weeklyMenu?.plan?.status === "draft" ? button("确认并激活", "family-system-button", () => handlers.activateMealPlan(weeklyMenu.plan.id, weeklyMenu.plan.revision)) : null,
    weeklyMenu?.plan?.status === "active" ? button("结算菜单", "family-system-button", () => handlers.settleMealPlan(weeklyMenu.plan.id)) : null
  );
  if ((weeklyMenu?.plans || []).length > 1) {
    const selector = element("select", "family-system-filter-select");
    selector.setAttribute("aria-label", "选择菜单计划");
    weeklyMenu.plans.forEach((plan) => {
      const range = mealPlanRange(plan);
      const option = element("option", "", `${plan.title || `${range.start} 至 ${range.end}`} · ${plan.status}`);
      option.value = plan.id;
      option.selected = plan.id === weeklyMenu.plan?.id;
      selector.appendChild(option);
    });
    selector.addEventListener("change", () => handlers.selectMenuPlan(selector.value));
    menuActions.appendChild(selector);
  }
  parent.appendChild(menuActions);
  if (!weeklyMenu?.plan || !weeklyMenu.days.length) {
    const panel = section("菜单", "状态由菜品、餐次、采购和库存事实动态推导。", 0);
    panel.appendChild(emptyState("当前没有餐饮安排", "选择日期、餐次和人数，一键生成菜单草稿。"));
    parent.appendChild(panel);
    return;
  }
  const validDates = new Set(weeklyMenu.days.map((day) => day.date));
  const selectedDate = model.menu_date === "all" || validDates.has(model.menu_date) ? model.menu_date : weeklyMenu.default_date;
  renderMenuDaySwitcher(parent, weeklyMenu, selectedDate, handlers);
  if (selectedDate === "all") {
    const range = weeklyMenu.range || mealPlanRange(weeklyMenu.plan);
    const groups = weeklyMenu.week_groups || [weeklyMenu.days];
    const panel = section("全部日期", `${weeklyMenu.plan.title || range.start} · ${range.start} 至 ${range.end} · ${weeklyMenu.gap_count || 0} 个待补齐`, weeklyMenu.meal_count);
    groups.forEach((days, index) => {
      const block = element("section", "family-system-menu-range-block");
      block.appendChild(element("h3", "family-system-menu-range-title", `第 ${index + 1} 段 · ${days[0].date} 至 ${days[days.length - 1].date}`));
      const grid = element("div", "family-system-menu-week");
      days.forEach((day) => renderMenuDay(grid, day, model, handlers, true));
      block.appendChild(grid);
      panel.appendChild(block);
    });
    parent.appendChild(panel);
    return;
  }
  const day = weeklyMenu.days.find((item) => item.date === selectedDate) || weeklyMenu.days[0];
  const panel = section(`${day.weekday}菜单`, `${day.date} · ${weeklyMenu.plan.title || "菜单"}`, day.dish_count);
  renderMenuHandling(panel, day);
  const meals = element("div", "family-system-meal-groups is-daily");
  if (!day.meals.length) meals.appendChild(emptyState("当天没有餐饮安排", "当前菜单没有为这一天建立餐次。"));
  day.meals.forEach((meal) => renderMealGroup(meals, meal, model, handlers));
  panel.appendChild(meals);
  parent.appendChild(panel);
}

function renderInventoryFilters(parent, model, handlers) {
  const filters = element("div", "family-system-inventory-filters");
  const search = element("input", "family-system-search-input");
  search.type = "search";
  search.placeholder = "搜索库存物品";
  search.value = model.inventory_filter?.query || "";
  search.setAttribute("aria-label", "搜索库存物品");
  search.addEventListener("change", () => handlers.setInventoryFilter({ query: search.value }));
  search.addEventListener("search", () => handlers.setInventoryFilter({ query: search.value }));
  const group = element("select", "family-system-filter-select");
  group.setAttribute("aria-label", "按采购分区筛选库存");
  [["all", "全部分类"], ...(model.dashboard.inventory_groups || []).map((value) => [value, value])].forEach(([value, label]) => {
    const option = element("option", "", label);
    option.value = value;
    option.selected = (model.inventory_filter?.group || "all") === value;
    group.appendChild(option);
  });
  group.addEventListener("change", () => handlers.setInventoryFilter({ group: group.value }));
  const status = element("select", "family-system-filter-select");
  status.setAttribute("aria-label", "按库存状态筛选");
  [["available", "有库存"], ["depleted", "已耗尽"], ["all", "全部状态"]].forEach(([value, label]) => {
    const option = element("option", "", label);
    option.value = value;
    option.selected = (model.inventory_filter?.status || "available") === value;
    status.appendChild(option);
  });
  status.addEventListener("change", () => handlers.setInventoryFilter({ status: status.value }));
  append(filters, search, group, status);
  parent.appendChild(filters);
}

function renderInventoryItem(parent, item, handlers) {
  const wrapper = element("article", "family-system-inventory-item");
  const actions = [button("入库", "family-system-mini-button is-primary", () => handlers.receiveInventory(item.id))];
  if (item.primary_batch_id) actions.push(button("校准", "family-system-mini-button", () => handlers.calibrateInventory(item.primary_batch_id)));
  wrapper.appendChild(recordRow(
    item.item_name,
    `${item.available_quantity || 0} ${item.unit || ""} · ${item.purchase_group} · ${item.batch_count} 个批次 · ${item.tracking_policy}`,
    item.status,
    actions
  ));
  const details = element("details", "family-system-inventory-batches");
  const summary = element("summary", "", `查看批次与来源（${item.batch_count}）`);
  details.appendChild(summary);
  if (!item.batches.length) details.appendChild(element("p", "family-system-muted", "尚无入库批次"));
  item.batches.forEach((batch) => details.appendChild(recordRow(
    batch.item_name || batch.ingredient_name || item.item_name,
    `${quantityDisplay(batch, true)} · ${batch.intake_reason || batch.confirmation_mode || "计划实收"} · ${batch.recorded_at || batch.created_at || "时间未记录"}`,
    batch.status,
    batch.id === item.primary_batch_id ? [button("校准此批次", "family-system-mini-button", () => handlers.calibrateInventory(batch.id))] : []
  )));
  wrapper.appendChild(details);
  parent.appendChild(wrapper);
}

function renderPurchase(parent, model, handlers) {
  if (model.page === "sessions") {
    const rows = model.dashboard.purchase_sessions;
    const panel = section("采购批次", "一次购物、多个实收项和一笔支付使用稳定批次关联。", rows.length);
    if (!rows.length) panel.appendChild(emptyState("暂无采购批次", "确认一次集中采购后可建立批次。"));
    rows.forEach((item) => panel.appendChild(recordRow(item.title || item.id, `${item.purchased_at || item.created_at} · ${item.total_amount || 0} ${item.currency || "CNY"}`, item.status)));
    parent.appendChild(panel);
    return;
  }
  if (model.page === "aftersales") {
    const rows = model.dashboard.aftersales;
    const panel = section("售后", "退换、退款和补偿保留原采购与现实处理关系。", rows.length);
    if (!rows.length) panel.appendChild(emptyState("暂无售后记录", "发生现实售后时再建立记录。"));
    rows.forEach((item) => panel.appendChild(recordRow(item.title || item.id, item.reason || item.purchase_session_id || "", item.status)));
    parent.appendChild(panel);
    return;
  }
  if (model.page === "receipts") {
    parent.appendChild(actionBar(button("确认实收", "family-system-button is-primary", handlers.confirmReceipt), button("批量实收", "family-system-button", handlers.confirmReceiptsBatch)));
    const rows = model.dashboard.receipts;
    const panel = section("实收", "任务完成不等于实收；这里只展示用户明确确认的现实结果。", rows.length);
    if (!rows.length) panel.appendChild(emptyState("暂无实收记录", "完成现实采购后，再单独确认商品和数量。"));
    rows.forEach((receipt) => panel.appendChild(recordRow(receipt.actual_name || receipt.item_name || receipt.ingredient_name || receipt.id, `${quantityDisplay(receipt)} · ${receipt.purchase_group} · ${receipt.occurred_at || receipt.recorded_at || "时间未记录"}`, receipt.status)));
    parent.appendChild(panel);
    return;
  }
  if (model.page === "inventory") {
    parent.appendChild(actionBar(
      button("新增入库", "family-system-button is-primary", () => handlers.receiveInventory()),
      button("手动扣减", "family-system-button", handlers.recordConsumption),
      button("校准库存", "family-system-button", () => handlers.calibrateInventory())
    ));
    renderInventoryFilters(parent, model, handlers);
    const rows = model.dashboard.inventory_summary;
    const total = model.dashboard.inventory_summary_all.length;
    const panel = section("库存", `按物品汇总 ${total} 项登记库存；批次和流水可展开查看。`, rows.length);
    if (!rows.length) panel.appendChild(emptyState("没有符合条件的库存", "调整搜索、分类或状态筛选，或直接新增入库。", button("新增入库", "family-system-button is-primary", () => handlers.receiveInventory())));
    rows.forEach((item) => renderInventoryItem(panel, item, handlers));
    parent.appendChild(panel);
    return;
  }
  if (model.page === "movements") {
    const rows = model.dashboard.movements;
    const panel = section("库存流水", "流入、消耗和校准以不可变变化保留。", rows.length);
    if (!rows.length) panel.appendChild(emptyState("暂无库存流水", "确认实收、记录消耗或校准后会产生流水。"));
    rows.forEach((movement) => panel.appendChild(recordRow(movement.movement_kind || movement.kind || "库存变化", `${movement.quantity || movement.delta || 0} ${movement.unit || ""} · ${movement.occurred_at || movement.recorded_at || "时间未记录"}`, movement.status)));
    parent.appendChild(panel);
    return;
  }
  parent.appendChild(actionBar(button("新增采购", "family-system-button is-primary", handlers.addManualPurchase), button("确认实收", "family-system-button", handlers.confirmReceipt), button("批量实收", "family-system-button", handlers.confirmReceiptsBatch)));
  const rows = model.dashboard.demands;
  const summary = section("待买需求", "按超市采购路线分区；同类物品集中查看和采购。", rows.length);
  if (!rows.length) summary.appendChild(emptyState("当前没有待买需求", "菜单和库存满足时不会生成多余采购。"));
  parent.appendChild(summary);
  const purchaseGroups = Array.isArray(model.dashboard.purchase_groups) && model.dashboard.purchase_groups.length
    ? model.dashboard.purchase_groups
    : [{ group: "未分类", items: rows }];
  purchaseGroups.forEach(({ group, items }) => {
    const panel = section(group, `采购路线中的 ${group} 分区`, items.length);
    items.forEach((demand) => panel.appendChild(recordRow(demand.item_name || demand.ingredient_name || demand.id, `${demand.quantity || 0} ${demand.unit || ""} · ${demand.due_at || "未定"}`, demand.status)));
    parent.appendChild(panel);
  });
}

function renderFinance(parent, model, handlers) {
  if (model.page === "review") {
    const rows = model.dashboard.finance_review;
    const panel = section("待核对", "没有交易 ID或存在冲突的关联必须由人核对，系统不自动补记交易。", rows.length);
    if (!rows.length) panel.appendChild(emptyState("当前没有待核对关联", "所有已保存财务关联均有明确交易身份。"));
    rows.forEach((link) => panel.appendChild(recordRow(link.transaction_id || "缺少交易 ID", `${link.amount || 0} ${link.currency || "CNY"}`, link.status || "needs_review")));
    parent.appendChild(panel);
    return;
  }
  if (model.page === "transactions" || model.page === "overview") {
    parent.appendChild(actionBar(button("新增流水", "family-system-button is-primary", handlers.addFinanceTransaction), button("关联实收", "family-system-button", handlers.linkFinance)));
    const rows = model.dashboard.finance_transactions;
    const panel = section(model.page === "overview" ? "财务总览" : "财务流水", "插件表单与快捷指令共用 UUID 幂等写入；Family System 不连接银行。", rows.length);
    if (!rows.length) panel.appendChild(emptyState("暂无正式流水", "可在插件内录入，或把快捷指令命令放入 Life Core 命令箱。"));
    rows.slice().sort((a, b) => `${b.date || ""}${b.time || ""}`.localeCompare(`${a.date || ""}${a.time || ""}`)).forEach((item) => panel.appendChild(recordRow(item.name || item.id, `${item.date || ""} · ${item.direction || ""} ${item.amount || 0} ${item.currency || "CNY"}`, item.status)));
    parent.appendChild(panel);
    return;
  }
  const key = model.page === "accounts" ? "finance_accounts" : model.page === "budgets" ? "budgets" : model.page === "recurring" ? "recurring_items" : "balance_snapshots";
  const labels = { accounts: "账户", budgets: "预算", recurring: "固定项", balances: "余额快照" };
  const rows = model.dashboard[key] || [];
  const sourceNote = model.page === "balances" ? "余额快照是 JSON 运行事实。" : "账户、预算和固定项以财务配置 Markdown 为权威。";
  const panel = section(labels[model.page] || "财务", sourceNote, rows.length);
  if (!rows.length) panel.appendChild(emptyState(`暂无${labels[model.page] || "记录"}`, "通过正式表单建立后显示。"));
  rows.forEach((item) => panel.appendChild(recordRow(item.name || item.title || item.id, `${item.amount ?? item.balance ?? item.limit ?? ""} ${item.currency || "CNY"}`, item.status)));
  parent.appendChild(panel);
}

function renderAuthorityStatus(parent, model, handlers) {
  const conflicts = model.authority_conflicts || [];
  const panel = section("资料来源与权威状态", "六份模块 Markdown 保存资料定义；Life Core JSON 保存运行事实、事件与恢复状态。", 6);
  panel.appendChild(element("p", "family-system-boundary-note", conflicts.length
    ? `发现 ${conflicts.length} 份外部修改。受影响模块的新自动化已暂停，可在设置中预演采纳或恢复。`
    : "当前六份模块均与最后一次插件提交的 revision 和内容哈希一致。"));
  panel.appendChild(actionBar(
    model.authority_module_path ? button("打开当前模块资料", "family-system-button", handlers.openAuthorityModule) : null,
    button("校验资料", "family-system-button", handlers.validateAuthority),
    conflicts.length ? button("预演采纳", "family-system-button is-primary", handlers.adoptExternalAuthority) : null,
    conflicts.length ? button("恢复正式版", "family-system-button", handlers.restoreAuthority) : null
  ));
  parent.appendChild(panel);
}

function renderBasic(parent, model, handlers) {
  if (model.page === "members") {
    parent.appendChild(actionBar(button("新增成员", "family-system-button is-primary", handlers.addMember)));
    const rows = model.dashboard.members;
    const panel = section("家庭成员", "成员身份和角色以家庭资料 Markdown 为权威。", rows.length);
    if (!rows.length) panel.appendChild(emptyState("暂无家庭成员", "建立家庭后新增成员。"));
    rows.forEach((member) => panel.appendChild(recordRow(member.name, `${member.role || "member"} · ${model.constraint_counts[member.id] || 0} 条饮食约束`, member.status)));
    parent.appendChild(panel);
    return;
  }
  const mappings = {
    documents: ["document", "证件", model.dashboard.documents],
    contacts: ["contact", "联系人", model.dashboard.contacts],
    medical: ["medical_profile", "基础医疗", model.dashboard.medical_profiles],
    accounts: ["account_reference", "账号入口", model.dashboard.account_references],
  };
  if (mappings[model.page]) {
    const [type, label, rows] = mappings[model.page];
    parent.appendChild(actionBar(button(`新增${label}`, "family-system-button is-primary", () => handlers.addBasicRecord(type))));
    const panel = section(label, type === "account_reference" ? "家庭资料 Markdown 只保存入口和密码管理器引用，不保存密码。" : "资料字段以家庭资料 Markdown 为权威。", rows.length);
    if (!rows.length) panel.appendChild(emptyState(`暂无${label}`, "示例资料不会进入正式核心。"));
    rows.forEach((item) => panel.appendChild(recordRow(item.name || item.id, item.document_type || item.contact_type || item.service || item.owner_id || "", item.status)));
    parent.appendChild(panel);
    return;
  }
  const panel = section("家庭", "家庭资料 Markdown 是家庭身份与成员资料的业务权威。", model.household ? 1 : 0);
  if (!model.household) panel.appendChild(emptyState("尚未建立家庭", `将在 ${model.data_root} 创建空白 Life Core。`, button("建立空白家庭", "family-system-button is-primary", handlers.initialize)));
  else panel.appendChild(recordRow(model.household.name || "我的家庭", `${model.dashboard.members.length} 名成员 · ${model.data_root}`, model.household.status));
  parent.appendChild(panel);
  renderAuthorityStatus(parent, model, handlers);
}

function renderAsset(parent, model, handlers) {
  if (model.page === "plans") {
    parent.appendChild(actionBar(button("新增维护计划", "family-system-button is-primary", handlers.addMaintenancePlan)));
    const rows = model.dashboard.maintenance_plans;
    const panel = section("维护计划", "维护计划以资产计划 Markdown 为权威；触发后生成 JSON 事务并投影到 Apple。", rows.length);
    if (!rows.length) panel.appendChild(emptyState("暂无维护计划", "先建立资产，再安排保养、检查或保险事项。"));
    rows.forEach((item) => panel.appendChild(recordRow(item.name || item.id, `${item.kind || ""} · ${item.next_due_date || "未定日期"}`, item.status)));
    parent.appendChild(panel);
    return;
  }
  if (model.page === "services") {
    const rows = model.dashboard.service_records;
    const panel = section("维保记录", "现实发生的维修、保养和费用关联保留为结构化事实。", rows.length);
    if (!rows.length) panel.appendChild(emptyState("暂无维保记录", "完成一次维护后再记录现实结果。"));
    rows.forEach((item) => panel.appendChild(recordRow(item.title || item.id, `${item.completed_on || item.scheduled_on || ""} · ${item.provider || ""}`, item.status)));
    parent.appendChild(panel);
    return;
  }
  parent.appendChild(actionBar(button("新增资产", "family-system-button is-primary", handlers.addAsset), button("新增维护计划", "family-system-button", handlers.addMaintenancePlan)));
  const rows = model.dashboard.assets;
  const panel = section(model.page === "overview" ? "资产总览" : "资产档案", "资产与维护计划属于 Markdown 定义；已发生维保记录属于 JSON 事实。", rows.length);
  if (!rows.length) panel.appendChild(emptyState("暂无家庭资产", "当前旧系统没有真实资产记录，可从这里开始建立。"));
  rows.forEach((item) => panel.appendChild(recordRow(item.name || item.id, `${item.asset_type || "asset"} · ${item.location || "未设置位置"}`, item.condition || item.status)));
  parent.appendChild(panel);
}

function renderModule(parent, model, handlers) {
  if (model.module === "overview") renderOverview(parent, model, handlers);
  else if (model.module === "reminder") renderReminder(parent, model, handlers);
  else if (model.module === "diet") renderDiet(parent, model, handlers);
  else if (model.module === "purchase") renderPurchase(parent, model, handlers);
  else if (model.module === "finance") renderFinance(parent, model, handlers);
  else if (model.module === "basic") renderBasic(parent, model, handlers);
  else renderAsset(parent, model, handlers);
}

function renderMaterialDrawer(root, model, handlers) {
  if (!model.material_open) return;
  const backdrop = element("div", "family-system-drawer-backdrop");
  backdrop.addEventListener("click", handlers.toggleMaterials);
  const drawer = element("aside", "family-system-material-drawer");
  drawer.setAttribute("aria-label", "材质与外观");
  const head = element("div", "family-system-drawer-head");
  append(head, append(element("div", ""), element("strong", "", "材质与外观"), element("span", "", "只保存界面偏好")), button("关闭", "family-system-icon-button", handlers.toggleMaterials, "x", { "aria-label": "关闭材质抽屉" }));
  drawer.appendChild(head);
  const theme = element("section", "family-system-drawer-section");
  theme.appendChild(element("h3", "", "主题"));
  const themeButtons = element("div", "family-system-choice-grid");
  [["system", "跟随系统"], ["dark", "深色"], ["light", "浅色"]].forEach(([value, label]) => themeButtons.appendChild(button(label, model.visual.theme === value ? "is-active" : "", () => handlers.updateVisual({ theme: value }))));
  theme.appendChild(themeButtons);
  drawer.appendChild(theme);
  const accent = element("section", "family-system-drawer-section");
  accent.appendChild(element("h3", "", "强调色"));
  const accentButtons = element("div", "family-system-choice-grid is-colors");
  ACCENTS.forEach(([value, label]) => accentButtons.appendChild(button(label, `family-system-color-choice is-${value} ${model.visual.accent === value ? "is-active" : ""}`, () => handlers.updateVisual({ accent: value }))));
  accent.appendChild(accentButtons);
  drawer.appendChild(accent);
  const material = element("section", "family-system-drawer-section");
  material.appendChild(element("h3", "", "材质预设"));
  const materialButtons = element("div", "family-system-material-grid");
  MATERIALS.forEach(([value, label]) => {
    const item = button(label, `family-system-material-choice is-${value} ${model.visual.activeMaterial === value ? "is-active" : ""}`, () => handlers.updateVisual({ activeMaterial: value }));
    item.appendChild(element("span", "", "Aa"));
    materialButtons.appendChild(item);
  });
  material.appendChild(materialButtons);
  drawer.appendChild(material);
  const motion = element("section", "family-system-drawer-section");
  motion.appendChild(element("h3", "", "动态"));
  motion.appendChild(button(model.visual.motion === "reduced" ? "恢复完整动态" : "减少动态效果", "family-system-button", () => handlers.updateVisual({ motion: model.visual.motion === "reduced" ? "full" : "reduced" })));
  drawer.appendChild(motion);
  root.appendChild(backdrop);
  root.appendChild(drawer);
}

function renderDashboard(root, model, handlers) {
  root.textContent = "";
  root.className = "betagifted-family-system-view";
  root.dataset.variant = "workbench";
  root.dataset.module = model.module;
  root.dataset.page = model.page;
  root.dataset.theme = model.theme;
  root.dataset.motion = model.reduced_motion ? "reduced" : "full";
  root.dataset.accent = model.visual.accent;
  root.dataset.material = model.visual.activeMaterial;
  const shell = element("div", "family-system-shell");
  renderRail(shell, model, handlers);
  const core = element("main", "family-system-main");
  renderTopbar(core, model, handlers);
  renderLocalNav(core, model, handlers);
  const content = element("div", "family-system-content");
  if (model.error) content.appendChild(emptyState("读取失败", model.error, button("重新读取", "family-system-button", handlers.refresh)));
  else renderModule(content, model, handlers);
  core.appendChild(content);
  shell.appendChild(core);
  root.appendChild(shell);
  renderMaterialDrawer(root, model, handlers);
  return root;
}

class FamilySystemView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.stageTimer = null;
  }

  getViewType() { return VIEW_TYPE; }
  getDisplayText() { return "BetaGifted Family System"; }
  getIcon() { return "orbit"; }

  async onOpen() {
    await this.plugin.renderView(this);
    this.startStage();
  }

  startStage() {
    this.stopStage();
    this.stageTimer = setInterval(() => this.plugin.rotateStage(1, true), 5200);
  }

  stopStage() {
    if (this.stageTimer) clearInterval(this.stageTimer);
    this.stageTimer = null;
  }

  async onClose() { this.stopStage(); }
}

class FormModal extends Modal {
  constructor(app, options) {
    super(app);
    this.options = options;
    this.values = {};
  }

  onOpen() {
    this.modalEl.addClass("family-system-modal");
    this.titleEl.setText(this.options.title);
    if (this.options.description) this.contentEl.createEl("p", { text: this.options.description, cls: "family-system-modal-description" });
    const visibility = [];
    const refreshVisibility = () => visibility.forEach(({ field, setting }) => {
      const visible = typeof field.visibleWhen !== "function" || field.visibleWhen({ ...this.values });
      setting.settingEl.style.display = visible ? "" : "none";
    });
    this.options.fields.forEach((field) => {
      const setting = new Setting(this.contentEl).setName(field.label);
      visibility.push({ field, setting });
      if (field.description) setting.setDesc(field.description);
      const initial = field.value == null ? "" : String(field.value);
      this.values[field.id] = field.type === "checkbox" ? field.value !== false : initial;
      if (field.type === "checkbox") {
        setting.addToggle((toggle) => {
          toggle.setValue(field.value !== false);
          toggle.onChange((value) => { this.values[field.id] = value; if (field.onChange) field.onChange(value, this.values); refreshVisibility(); });
        });
      } else if (field.type === "select") {
        setting.addDropdown((dropdown) => {
          (field.options || []).forEach((option) => dropdown.addOption(String(option.value), option.label));
          dropdown.setValue(initial || String(field.options?.[0]?.value || ""));
          this.values[field.id] = dropdown.getValue();
          dropdown.onChange((value) => { this.values[field.id] = value; if (field.onChange) field.onChange(value, this.values); refreshVisibility(); });
        });
      } else if (field.type === "textarea") {
        setting.addTextArea((input) => input.setValue(initial).setPlaceholder(field.placeholder || "").onChange((value) => { this.values[field.id] = value; if (field.onChange) field.onChange(value, this.values); refreshVisibility(); }));
      } else {
        setting.addText((input) => {
          input.setValue(initial).setPlaceholder(field.placeholder || "").onChange((value) => { this.values[field.id] = value; if (field.onChange) field.onChange(value, this.values); refreshVisibility(); });
          if (field.type) input.inputEl.type = field.type;
        });
      }
    });
    refreshVisibility();
    const actions = this.contentEl.createDiv({ cls: "family-system-modal-actions" });
    const cancel = actions.createEl("button", { text: "取消" });
    cancel.addEventListener("click", () => this.close());
    const submit = actions.createEl("button", { text: this.options.submitLabel || "继续", cls: "mod-cta" });
    submit.addEventListener("click", async () => {
      try {
        await this.options.onSubmit({ ...this.values });
        this.close();
      } catch (error) {
        new Notice(error.message);
      }
    });
  }

  onClose() { this.contentEl.empty(); }
}

class RecipeDetailsModal extends Modal {
  constructor(app, recipe, onEditOrOptions) {
    super(app);
    this.recipe = recipe;
    const options = typeof onEditOrOptions === "function"
      ? { onEdit: onEditOrOptions }
      : (onEditOrOptions || {});
    this.onEdit = options.onEdit || null;
    this.allowEdit = options.allowEdit !== false && typeof this.onEdit === "function";
    this.context = options.context || null;
  }

  onOpen() {
    this.modalEl.addClass("family-system-modal", "family-system-recipe-modal");
    this.titleEl.setText(this.recipe.name || "菜谱详情");
    if (this.context) {
      const context = this.contentEl.createDiv({ cls: "family-system-recipe-context" });
      context.createEl("strong", { text: `${this.context.planned_date || "日期未定"} · ${this.context.meal_label || "餐次"}` });
      context.createEl("span", { text: "当前菜谱最新版" });
    }
    renderRecipeDetails(this.contentEl, this.recipe);
    const actions = this.contentEl.createDiv({ cls: "family-system-modal-actions" });
    const close = actions.createEl("button", { text: "关闭" });
    close.addEventListener("click", () => this.close());
    if (this.allowEdit) {
      const edit = actions.createEl("button", { text: "编辑菜谱", cls: "mod-cta" });
      edit.addEventListener("click", () => {
        this.close();
        this.onEdit(this.recipe.id);
      });
    }
  }

  onClose() { this.contentEl.empty(); }
}

class RecipeFormModal extends Modal {
  constructor(app, options) {
    super(app);
    this.options = options;
    this.recipe = options.recipe || null;
    this.inventoryItems = [...(options.inventoryItems || [])].sort((a, b) => String(a.name || "").localeCompare(String(b.name || ""), "zh-CN"));
    this.ingredientRows = [];
  }

  field(label, control, description) {
    const wrapper = this.contentEl.createDiv({ cls: "family-system-recipe-field" });
    wrapper.createEl("label", { text: label });
    if (description) wrapper.createEl("small", { text: description });
    wrapper.appendChild(control);
    return control;
  }

  input(type, value, placeholder) {
    const input = document.createElement("input");
    input.type = type;
    input.value = value == null ? "" : String(value);
    if (placeholder) input.placeholder = placeholder;
    return input;
  }

  select(options, value) {
    const select = document.createElement("select");
    options.forEach((item) => {
      const option = document.createElement("option");
      option.value = String(item.value);
      option.textContent = item.label;
      select.appendChild(option);
    });
    select.value = value == null ? String(options[0]?.value || "") : String(value);
    return select;
  }

  addIngredientRow(ingredient, requestedMode) {
    const original = ingredient && typeof ingredient === "object" ? ingredient : null;
    const mode = requestedMode || recipeIngredientMode(original, this.inventoryItems);
    const mappedId = original?.item_entity_id || this.inventoryItems.find((item) => item.source_item_id === original?.inventory_item_id)?.id || "";
    const row = this.ingredientContainer.createDiv({ cls: "family-system-recipe-ingredient-editor" });
    const modeSelect = this.select([
      { value: "tracked", label: "已登记库存物品" },
      { value: "untracked", label: "非库存消耗品" },
      ...(mode === "legacy" ? [{ value: "legacy", label: "保留现有未映射记录" }] : []),
    ], mode);
    const itemSelect = this.select(this.inventoryItems.length
      ? this.inventoryItems.map((item) => ({ value: item.id, label: `${item.name} · ${item.canonical_unit || item.unit || "未设单位"}` }))
      : [{ value: "", label: "暂无已登记物品" }], mappedId || this.inventoryItems[0]?.id || "");
    const nameInput = this.input("text", original?.name || "", "例如：清水");
    const quantityInput = this.input("number", original?.quantity ?? 1);
    quantityInput.min = "0.001";
    quantityInput.step = "any";
    const unitInput = this.input("text", original?.unit || "份", "克、毫升、个……");
    const specificitySelect = this.select([{ value: "general", label: "通用" }, { value: "specific", label: "专属" }], original?.specificity || "general");
    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "移除";
    remove.className = "family-system-mini-button";
    const labeled = (label, control) => {
      const wrap = element("label", "family-system-recipe-ingredient-control");
      wrap.appendChild(element("span", "", label));
      wrap.appendChild(control);
      row.appendChild(wrap);
    };
    labeled("类型", modeSelect);
    labeled("物品", itemSelect);
    labeled("名称", nameInput);
    labeled("数量", quantityInput);
    labeled("单位", unitInput);
    labeled("用途", specificitySelect);
    row.appendChild(remove);
    const draft = { row, original, modeSelect, itemSelect, nameInput, quantityInput, unitInput, specificitySelect };
    this.ingredientRows.push(draft);
    const refresh = () => {
      const tracked = modeSelect.value === "tracked";
      itemSelect.closest("label").style.display = tracked ? "" : "none";
      nameInput.closest("label").style.display = tracked ? "none" : "";
      if (tracked) {
        const item = this.inventoryItems.find((candidate) => candidate.id === itemSelect.value);
        if (item && (!unitInput.value || !original)) unitInput.value = item.canonical_unit || item.unit || "份";
      }
    };
    modeSelect.addEventListener("change", refresh);
    itemSelect.addEventListener("change", () => {
      const item = this.inventoryItems.find((candidate) => candidate.id === itemSelect.value);
      if (item) unitInput.value = item.canonical_unit || item.unit || unitInput.value;
    });
    remove.addEventListener("click", () => {
      this.ingredientRows = this.ingredientRows.filter((item) => item !== draft);
      row.remove();
    });
    refresh();
  }

  serializeIngredients() {
    if (!this.ingredientRows.length) throw new Error("菜谱至少需要一种食材");
    const ingredients = this.ingredientRows.map((row) => recipeIngredientDraftToRecord({
      original: row.original,
      mode: row.modeSelect.value,
      item_id: row.itemSelect.value,
      name: row.nameInput.value,
      quantity: row.quantityInput.value,
      unit: row.unitInput.value,
      specificity: row.specificitySelect.value,
    }, this.inventoryItems));
    const ids = new Set();
    ingredients.forEach((ingredient) => {
      if (ids.has(ingredient.id)) throw new Error(`菜谱食材重复：${ingredient.name}`);
      ids.add(ingredient.id);
    });
    return ingredients;
  }

  onOpen() {
    this.modalEl.addClass("family-system-modal", "family-system-recipe-modal", "family-system-recipe-form-modal");
    this.titleEl.setText(this.recipe ? "编辑菜谱" : "新增菜谱");
    this.contentEl.createEl("p", { text: "保存前会先预览 EffectSet；菜谱修改只影响以后新安排的餐次。", cls: "family-system-modal-description" });
    const base = this.contentEl.createDiv({ cls: "family-system-recipe-form-grid" });
    const previousContent = this.contentEl;
    this.contentEl = base;
    const name = this.field("菜谱名称", this.input("text", this.recipe?.name || ""));
    const category = this.field("分类", this.select(RECIPE_CATEGORIES.map((item) => ({ value: item, label: item })), this.recipe?.category || RECIPE_CATEGORIES[0]));
    const servings = this.field("份数", this.input("number", this.recipe?.servings || 3));
    servings.min = "1";
    const prepMinutes = this.field("制作时长（分钟）", this.input("number", this.recipe?.prep_minutes || 30));
    prepMinutes.min = "1";
    this.contentEl = previousContent;

    const mealField = this.contentEl.createDiv({ cls: "family-system-recipe-field is-full" });
    mealField.createEl("label", { text: "适用餐次" });
    const mealOptions = mealField.createDiv({ cls: "family-system-recipe-checks" });
    const mealChecks = RECIPE_MEAL_TYPES.map((mealType) => {
      const label = mealOptions.createEl("label");
      const input = label.createEl("input");
      input.type = "checkbox";
      input.checked = (this.recipe?.meal_types || ["午餐", "晚餐"]).includes(mealType);
      label.appendText(mealType);
      return { mealType, input };
    });

    this.ingredientContainer = this.contentEl.createDiv({ cls: "family-system-recipe-ingredient-editor-list" });
    const ingredientHeader = this.ingredientContainer.createDiv({ cls: "family-system-recipe-editor-head" });
    ingredientHeader.createEl("strong", { text: "食材" });
    ingredientHeader.createEl("span", { text: "库存食材必须选择已登记物品；清水等可标为非库存消耗品。" });
    const addActions = ingredientHeader.createDiv({ cls: "family-system-recipe-editor-actions" });
    const addTracked = addActions.createEl("button", { text: "添加库存食材" });
    addTracked.disabled = !this.inventoryItems.length;
    addTracked.addEventListener("click", () => this.addIngredientRow(null, "tracked"));
    const addUntracked = addActions.createEl("button", { text: "添加非库存食材" });
    addUntracked.addEventListener("click", () => this.addIngredientRow(null, "untracked"));
    (this.recipe?.ingredients || []).forEach((ingredient) => this.addIngredientRow(ingredient));
    if (!this.recipe?.ingredients?.length && this.inventoryItems.length) this.addIngredientRow(null, "tracked");

    const steps = document.createElement("textarea");
    steps.rows = 8;
    steps.value = (this.recipe?.steps || []).join("\n");
    steps.placeholder = "每行一个步骤，保存后按当前顺序编号";
    this.field("制作步骤", steps, "每行一个步骤；至少填写一条。 ");
    const tags = this.field("普通标签", this.input("text", (this.recipe?.tags || []).join("，"), "用逗号分隔"));
    const allergens = this.field("过敏原标签", this.input("text", (this.recipe?.allergen_tags || []).join("，"), "用逗号分隔"));

    const actions = this.contentEl.createDiv({ cls: "family-system-modal-actions" });
    const cancel = actions.createEl("button", { text: "取消" });
    cancel.addEventListener("click", () => this.close());
    const submit = actions.createEl("button", { text: "预览影响", cls: "mod-cta" });
    submit.addEventListener("click", async () => {
      submit.disabled = true;
      try {
        const mealTypes = mealChecks.filter((item) => item.input.checked).map((item) => item.mealType);
        const stepList = steps.value.split(/\n/).map((item) => item.trim()).filter(Boolean);
        const values = {
          name: name.value.trim(),
          category: category.value,
          meal_types: mealTypes,
          servings: Number(servings.value),
          prep_minutes: Number(prepMinutes.value),
          ingredients: this.serializeIngredients(),
          steps: stepList,
          tags: tags.value.split(/[，,]/).map((item) => item.trim()).filter(Boolean),
          allergen_tags: allergens.value.split(/[，,]/).map((item) => item.trim()).filter(Boolean),
        };
        if (!values.name) throw new Error("菜谱名称不能为空");
        if (!mealTypes.length) throw new Error("请至少选择一个适用餐次");
        if (!stepList.length) throw new Error("请至少填写一条制作步骤");
        await this.options.onSubmit(values);
        this.close();
      } catch (error) {
        submit.disabled = false;
        new Notice(error.message);
      }
    });
  }

  onClose() {
    this.ingredientRows = [];
    this.contentEl.empty();
  }
}

class TaskCategoryManagerModal extends Modal {
  constructor(app, categories, handlers) {
    super(app);
    this.categories = categories || [];
    this.handlers = handlers || {};
  }

  invoke(handler, category, index) {
    this.close();
    if (typeof handler === "function") handler(category, index);
  }

  onOpen() {
    this.modalEl.addClass("family-system-modal");
    this.modalEl.addClass("family-system-category-manager");
    this.titleEl.setText("管理事务分类");
    this.contentEl.createEl("p", { text: "显示名称完全自定义；Apple 路由决定进入哪张清单及完成后的业务后果。", cls: "family-system-modal-description" });
    const toolbar = this.contentEl.createDiv({ cls: "family-system-category-toolbar" });
    const add = toolbar.createEl("button", { text: "新增分类", cls: "mod-cta" });
    add.addEventListener("click", () => this.invoke(this.handlers.add));
    const routes = { purchase: "家庭采购", meal_handling: "食材处理", household: "家庭事务" };
    this.categories.forEach((category, index) => {
      const row = this.contentEl.createDiv({ cls: `family-system-category-row${category.status === "archived" ? " is-archived" : ""}` });
      const copy = row.createDiv({ cls: "family-system-category-copy" });
      copy.createEl("strong", { text: category.name });
      copy.createEl("span", { text: `${routes[category.route_kind] || category.route_kind}${category.is_default ? " · 默认" : ""}${category.status === "archived" ? " · 已停用" : ""}` });
      const actions = row.createDiv({ cls: "family-system-category-actions" });
      const action = (label, handler) => {
        const control = actions.createEl("button", { text: label });
        control.addEventListener("click", () => this.invoke(handler, category, index));
      };
      action("编辑", this.handlers.edit);
      if (category.status === "active" && !category.is_default) action("设为默认", this.handlers.setDefault);
      if (category.status === "active" && index > 0) action("上移", this.handlers.moveUp);
      if (category.status === "active" && index < this.categories.length - 1) action("下移", this.handlers.moveDown);
      if (category.status === "archived") action("恢复", this.handlers.restore);
      else if (!category.is_default) action("停用", this.handlers.archive);
    });
  }

  onClose() { this.contentEl.empty(); }
}

class ConfirmEffectsModal extends Modal {
  constructor(app, operation, onConfirm, onCancel) {
    super(app);
    this.operation = operation;
    this.onConfirm = onConfirm;
    this.onCancel = onCancel;
    this.settled = false;
  }

  onOpen() {
    this.modalEl.addClass("family-system-modal");
    this.titleEl.setText("确认一次家庭变化");
    this.contentEl.createEl("p", { text: this.operation.summary });
    const facts = this.contentEl.createDiv({ cls: "family-system-effect-preview" });
    facts.createEl("strong", { text: `将传播 ${this.operation.effects.length} 项确定后果` });
    this.operation.effects.slice(0, 8).forEach((item) => facts.createEl("div", { text: `${item.record_type} · ${item.note || item.record?.id || "待写入"}` }));
    if (this.operation.effects.length > 8) facts.createEl("div", { text: `另有 ${this.operation.effects.length - 8} 项` });
    if (this.operation.warnings?.length) this.contentEl.createEl("p", { text: `软提示：${this.operation.warnings.join("；")}`, cls: "family-system-warning" });
    const actions = this.contentEl.createDiv({ cls: "family-system-modal-actions" });
    const cancel = actions.createEl("button", { text: "取消" });
    cancel.addEventListener("click", () => this.close());
    const confirm = actions.createEl("button", { text: "确认并执行", cls: "mod-cta" });
    confirm.addEventListener("click", async () => {
      confirm.disabled = true;
      try {
        await this.onConfirm();
        this.settled = true;
        this.close();
      } catch (error) {
        confirm.disabled = false;
        new Notice(error.message);
      }
    });
  }

  onClose() {
    if (!this.settled && this.onCancel) Promise.resolve(this.onCancel()).catch(() => {});
    this.contentEl.empty();
  }
}

module.exports = {
  ACCENTS,
  ConfirmEffectsModal,
  FamilySystemView,
  FormModal,
  RecipeDetailsModal,
  RecipeFormModal,
  TaskCategoryManagerModal,
  MATERIALS,
  VIEW_TYPE,
  normalizedStageOffset,
  renderDashboard,
  renderRecipeDetails,
  recipeIngredientDraftToRecord,
  recipeIngredientMode,
  recipeMeta,
  statusLabel,
};
