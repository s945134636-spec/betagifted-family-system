"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const root = path.resolve(__dirname, "..");
const mainSource = fs.readFileSync(path.join(root, "main.js"), "utf8");
const styles = fs.readFileSync(path.join(root, "styles.css"), "utf8");

const modules = {
  overview: ["overview"],
  reminder: ["overview", "today", "upcoming", "all", "completed"],
  diet: ["menu", "plans", "recipes", "profiles", "rules"],
  purchase: ["demands", "sessions", "receipts", "inventory", "movements", "aftersales"],
  finance: ["overview", "transactions", "budgets", "accounts", "recurring", "balances", "review"],
  basic: ["household", "members", "documents", "contacts", "medical", "accounts"],
  asset: ["overview", "assets", "plans", "services"],
};

function baseModel(theme = "dark", motion = "full") {
  const dashboard = {
    module_counts: { overview: 2, reminder: 2, diet: 2, purchase: 2, finance: 1, basic: 3, asset: 0 },
    metrics: [["待处理信号", 2, "跨模块聚合"], ["今日事务", 1, "插件内任务投影"], ["近期计划", 1, "当前及未来餐次"], ["数据核验", 12, "有效记录类型"]],
    signals: [{ id: "risk", module: "diet", page: "menu", severity: "warning", title: "清蒸测试鱼", detail: "等待采购" }],
    tasks_by_page: {},
    task_categories: [
      { id: "category-purchase", name: "日常采买", route_kind: "purchase", sort_order: 0, is_default: true, status: "active", revision: 1 },
      { id: "category-household", name: "家庭安排", route_kind: "household", sort_order: 1, is_default: true, status: "active", revision: 1 },
    ],
    all_task_categories: [
      { id: "category-purchase", name: "日常采买", route_kind: "purchase", sort_order: 0, is_default: true, status: "active", revision: 1 },
      { id: "category-household", name: "家庭安排", route_kind: "household", sort_order: 1, is_default: true, status: "active", revision: 1 },
    ],
    inventory_items: [{ id: "item-fish", name: "测试鱼", entity_kind: "ingredient_item", canonical_unit: "条", status: "active" }],
    recipes: [{ id: "recipe", name: "清蒸测试鱼", category: "主菜", meal_types: ["午餐", "晚餐"], prep_minutes: 25, ingredients: [{ id: "item-fish", name: "测试鱼", quantity: 1, unit: "条", item_entity_id: "item-fish", inventory_policy: "tracked" }], servings: 3, tags: ["清淡"], allergen_tags: ["鱼类"], steps: ["处理测试鱼，并保留足够长的说明用于详情窄窗换行。", "蒸熟后调味。"], revision: 1, status: "active" }],
    members: [{ id: "m1", name: "成员甲", role: "maintainer", status: "active" }, { id: "m2", name: "成员乙", role: "member", status: "active" }, { id: "m3", name: "成员丙", role: "member", status: "active" }],
    demands: [{ id: "demand", ingredient_name: "测试鱼", quantity: 1, unit: "条", status: "open" }],
    receipts: [{ id: "receipt", ingredient_name: "测试鱼", actual_name: "测试鱼", quantity: 1, unit: "条", status: "active" }],
    batches: [{ id: "batch", item_entity_id: "item-fish", ingredient_id: "item-fish", ingredient_name: "测试鱼", available_quantity: 1, unit: "条", tracking_policy: "exact_unit", recorded_at: "2026-08-22T18:00:00Z", status: "available" }],
    inventory_summary: [{ id: "item-fish", item_entity_id: "item-fish", item_name: "测试鱼", purchase_group: "水产海鲜", tracking_policy: "exact_unit", canonical_unit: "条", available_quantity: 1, unit: "条", status: "available", batch_count: 1, available_batch_count: 1, primary_batch_id: "batch", batches: [{ id: "batch", item_entity_id: "item-fish", ingredient_id: "item-fish", ingredient_name: "测试鱼", available_quantity: 1, unit: "条", tracking_policy: "exact_unit", recorded_at: "2026-08-22T18:00:00Z", status: "available" }] }],
    inventory_summary_all: [{ id: "item-fish", item_entity_id: "item-fish", item_name: "测试鱼", purchase_group: "水产海鲜", tracking_policy: "exact_unit", canonical_unit: "条", available_quantity: 1, unit: "条", status: "available", batch_count: 1, available_batch_count: 1, primary_batch_id: "batch", batches: [{ id: "batch", ingredient_name: "测试鱼", available_quantity: 1, unit: "条", status: "available" }] }],
    inventory_groups: ["水产海鲜"],
    movements: [{ id: "move", movement_kind: "receipt", quantity: 1, unit: "条", status: "active" }],
    finance_links: [{ id: "link", transaction_id: "txn-test", amount: 36, currency: "CNY", status: "active", planned_purchase: true }],
    finance_review: [{ id: "review", amount: 18, currency: "CNY", status: "needs_review" }],
    finance_transactions: [{ id: "txn", date: "2026-08-22", name: "采购", amount: 36, currency: "CNY", status: "confirmed" }],
    finance_accounts: [{ id: "account", name: "现金", currency: "CNY", status: "active" }],
    budgets: [{ id: "budget", name: "餐饮", amount: 1000, currency: "CNY", status: "active" }],
    recurring_items: [{ id: "recurring", name: "宽带", amount: 100, currency: "CNY", status: "active" }],
    balance_snapshots: [{ id: "balance", account_id: "account", balance: 1000, currency: "CNY", status: "active" }],
    meal_plans: [{
      id: "plan", title: "本周菜单", week_start: "2026-08-22", status: "active",
      handling_instructions: Array.from({ length: 19 }, (_, index) => ({
        id: `instruction-${index}`,
        phase: index < 6 ? "周六下午采购后处理" : index < 12 ? "每晚解冻安排" : index < 16 ? "剩余饭菜衔接" : "储存安全边界",
        instruction: `第 ${index + 1} 条食材处理说明，包含较长的分装、冷藏、解冻与生熟分开要求，用于验证窄窗安全换行。`,
      })),
      handling_actions: Array.from({ length: 6 }, (_, index) => ({ id: `action-${index}`, scheduled_at: `2026-08-${String(22 + index).padStart(2, "0")}T20:00:00`, title: `食材处理任务 ${index + 1}` })),
    }],
    purchase_sessions: [{ id: "session", name: "周六采购", status: "active" }],
    aftersales: [{ id: "case", title: "测试售后", status: "open" }],
    documents: [{ id: "document", name: "证件引用", status: "active" }],
    contacts: [{ id: "contact", name: "物业", status: "active" }],
    medical_profiles: [{ id: "medical", name: "成员健康", status: "active" }],
    account_references: [{ id: "account-reference", name: "服务账号", status: "active" }],
    assets: [{ id: "asset", name: "冰箱", status: "active" }],
    maintenance_plans: [{ id: "maintenance", name: "冰箱清洁", status: "active" }],
    service_records: [{ id: "service", name: "冰箱维修", status: "active" }],
  };
  const tasks = [
    { id: "task-open", title: "采购：测试鱼", category: "purchase", category_id: "category-purchase", category_name: "日常采买", due_at: "2026-08-14T18:00:00", status: "open" },
    { id: "task-done", title: "已完成测试任务", category: "household", category_id: "category-household", category_name: "家庭安排", due_at: "2026-08-13T18:00:00", status: "completed" },
  ];
  dashboard.tasks_by_page = { overview: [tasks[0]], today: [tasks[0]], upcoming: [], all: tasks, completed: [tasks[1]] };
  let mealIndex = 0;
  let dishIndex = 0;
  const menuDays = Array.from({ length: 7 }, (_, dayIndex) => {
    const date = `2026-08-${String(22 + dayIndex).padStart(2, "0")}`;
    const mealLabels = dayIndex === 0 ? ["晚餐"] : ["午餐", "晚餐"];
    const meals = mealLabels.map((mealLabel) => {
      const currentMeal = mealIndex++;
      const dishCount = currentMeal < 8 ? 3 : 2;
      return {
        id: `menu-slot-${currentMeal}`,
        planned_date: date,
        meal_label: mealLabel,
        note: `${mealLabel}处理衔接：临做前清洗，需要解冻的食材提前移入冷藏室。`,
        status: "planned",
        dishes: Array.from({ length: dishCount }, () => ({ id: `menu-dish-${dishIndex++}`, recipe_id: "recipe", revision: 1, status: "ready", missing: [], missing_requirements: [], omitted: [], omitted_requirements: [], meal_slot: { id: `menu-slot-${currentMeal}`, planned_date: date, meal_label: mealLabel } })),
      };
    });
    return {
      date,
      weekday: ["周六", "周日", "周一", "周二", "周三", "周四", "周五"][dayIndex],
      date_label: date.slice(5),
      is_today: dayIndex === 1,
      meals,
      meal_count: meals.length,
      dish_count: meals.reduce((sum, meal) => sum + meal.dishes.length, 0),
      handling_actions: dayIndex < 6 ? [{
        id: `day-action-${dayIndex}`,
        title: dayIndex === 0 ? "采购后分装、标注并冷藏或冷冻" : `移入冷藏解冻：第 ${dayIndex + 1} 天所需食材`,
        scheduled_at: `${date}T20:00:00`,
        status: "planned",
        instructions: [{ id: `day-instruction-${dayIndex}`, instruction: "按餐次密封分装，区分生熟；叶菜保持干燥，临做前再清洗。" }],
      }] : [],
    };
  });
  menuDays[1].meals[0].dishes[0].status = "completed";
  menuDays[1].meals[1].dishes[0].status = "skipped";
  Object.assign(menuDays[1].meals[0].dishes[1], {
    status: "adaptable",
    missing: ["测试鱼"],
    missing_requirements: [{ id: "requirement-missing", ingredient_name: "测试鱼", missing_quantity: 1, unit: "条" }],
  });
  Object.assign(menuDays[1].meals[1].dishes[1], {
    status: "adapted",
    omitted: ["测试鱼"],
    omitted_requirements: [{ id: "requirement-omitted", ingredient_name: "测试鱼", quantity: 1, unit: "条" }],
  });
  dashboard.weekly_menu = { plan: dashboard.meal_plans[0], days: menuDays, default_date: "2026-08-23", meal_count: 13, dish_count: 34 };
  return {
    module: "overview",
    page: "overview",
    pages: Object.fromEntries(Object.entries(modules).map(([key, pages]) => [key, pages[0]])),
    menu_date: "2026-08-23",
    reminder_category: "all",
    inventory_filter: { query: "", group: "all", status: "available" },
    core_section: "order",
    stage_index: 0,
    material_open: false,
    title: "家庭系统",
    data_root: "家庭管理系统/00_系统核心/life-core",
    household: { id: "household", name: "脱敏测试家庭", status: "active" },
    store_status: "ready",
    theme,
    reduced_motion: motion === "reduced",
    visual: { theme, motion, accent: "ocean", activeMaterial: "cyan", selectedSlot: 0, materials: {} },
    error: null,
    recipe_names: { recipe: "清蒸测试鱼" },
    constraint_counts: { m1: 1 },
    dashboard,
    derived: {
      ready: [],
      at_risk: [{ id: "dish-risk", recipe_id: "recipe", status: "at_risk", missing: ["测试鱼"], meal_slot: { id: "slot", planned_date: "2026-08-18", meal_label: "晚餐" } }],
      adaptable: [{ id: "dish", revision: 1, recipe_id: "recipe", status: "adaptable", missing: ["测试鱼"], missing_requirements: [{ id: "requirement", ingredient_name: "测试鱼" }], omitted: [], omitted_requirements: [], meal_slot: { id: "slot", planned_date: "2026-08-17", meal_label: "晚餐" } }],
      adapted: [],
      blocked: [],
      dish_states: [{ id: "dish", revision: 1, recipe_id: "recipe", status: "adaptable", missing: ["测试鱼"], missing_requirements: [{ id: "requirement", ingredient_name: "测试鱼" }], omitted: [], omitted_requirements: [], meal_slot: { id: "slot", planned_date: "2026-08-17", meal_label: "晚餐" } }],
      pending_decisions: [], recovery_count: 0,
    },
    state: {
      member: dashboard.members, health_constraint: [{ id: "rule", target: "坚果", effect_level: "hard_constraint", status: "active" }],
      recipe: dashboard.recipes, meal_slot: [], dish_plan: [], ingredient_requirement: [], purchase_demand: dashboard.demands,
      receipt: dashboard.receipts, inventory_batch: dashboard.batches, inventory_movement: dashboard.movements,
      finance_link: dashboard.finance_links, task: tasks, task_projection: [], relationship: [], fact: [], intent: [], evidence: [],
      finance_transaction: dashboard.finance_transactions, finance_account: dashboard.finance_accounts, budget: dashboard.budgets,
      recurring_item: dashboard.recurring_items, balance_snapshot: dashboard.balance_snapshots, meal_plan: dashboard.meal_plans,
      purchase_session: dashboard.purchase_sessions, aftersale_case: dashboard.aftersales, document: dashboard.documents,
      contact: dashboard.contacts, medical_profile: dashboard.medical_profiles, account_reference: dashboard.account_references,
      asset: dashboard.assets, maintenance_plan: dashboard.maintenance_plans, service_record: dashboard.service_records,
      task_category: dashboard.all_task_categories,
      domain_event: [{ id: "event", event_type: "test.confirmed", recorded_at: "2026-08-14T10:00:00Z", aggregate_id: "household", status: "active" }],
      rule: [], decision_request: [], projection_status: [], import_mapping: [], operations: [], conflicts: [], imports: [], household: [],
    },
  };
}

async function boot(page, width, theme) {
  await page.setViewportSize({ width, height: 980 });
  await page.emulateMedia({ colorScheme: theme, reducedMotion: "no-preference" });
  await page.setContent(`<!doctype html><html><head><style>${styles}</style></head><body class="theme-${theme}" style="margin:0"><div id="root" style="width:100%;height:940px"></div></body></html>`);
  await page.evaluate((source) => {
    window.module = { exports: {} };
    HTMLElement.prototype.addClass = function(...names) { this.classList.add(...names); };
    HTMLElement.prototype.createEl = function(tag, options = {}) {
      const node = document.createElement(tag);
      if (options.text != null) node.textContent = String(options.text);
      if (options.cls) node.className = options.cls;
      this.appendChild(node);
      return node;
    };
    HTMLElement.prototype.createDiv = function(options = {}) { return this.createEl("div", options); };
    HTMLElement.prototype.empty = function() { this.replaceChildren(); };
    HTMLElement.prototype.appendText = function(value) { this.appendChild(document.createTextNode(String(value))); };
    HTMLElement.prototype.setText = function(value) { this.textContent = String(value); };
    class ItemView {}
    class Modal {
      constructor(app) {
        this.app = app;
        this.modalEl = document.createElement("div");
        this.modalEl.className = "modal";
        this.titleEl = this.modalEl.createEl("h2", { cls: "modal-title" });
        this.contentEl = this.modalEl.createDiv({ cls: "modal-content" });
      }
      open() { document.body.appendChild(this.modalEl); if (this.onOpen) this.onOpen(); }
      close() { if (this.onClose) this.onClose(); this.modalEl.remove(); }
    }
    class Plugin {}
    class PluginSettingTab {}
    class Setting {}
    window.require = (id) => {
      if (id !== "obsidian") throw new Error(`unexpected require ${id}`);
      return { ItemView, Modal, Plugin, PluginSettingTab, Setting, Notice: class {}, setIcon(node, icon) { node.dataset.icon = icon; node.appendChild(document.createTextNode("•")); } };
    };
    Function("module", "require", source)(window.module, window.require);
    window.handlers = new Proxy({}, { get: () => () => {} });
  }, mainSource);
}

async function render(page, model) {
  await page.evaluate((modelValue) => window.module.exports.__test.renderDashboard(document.getElementById("root"), modelValue, window.handlers), model);
}

async function report(page) {
  return page.evaluate(() => {
    const root = document.querySelector(".betagifted-family-system-view");
    const textNodes = [...root.querySelectorAll("*")].filter((node) => node.children.length === 0 && node.textContent.trim());
    const controls = [...root.querySelectorAll("button")];
    controls[0].focus();
    return {
      rootOverflow: root.scrollWidth - root.clientWidth,
      bodyOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      smallestText: Math.min(...textNodes.map((node) => parseFloat(getComputedStyle(node).fontSize))),
      smallestControl: Math.min(...controls.map((node) => node.getBoundingClientRect().height)),
      outline: getComputedStyle(controls[0]).outlineStyle,
      metrics: root.querySelectorAll(".family-system-metric").length,
      nav: root.querySelectorAll(".family-system-nav-item").length,
    };
  });
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const results = [];
  let handlingResult = null;
  try {
    const page = await browser.newPage();
    await boot(page, 1440, "dark");
    for (const [module, pages] of Object.entries(modules)) {
      for (const pageKey of pages) {
        const model = baseModel("dark");
        model.module = module;
        model.page = pageKey;
        model.pages[module] = pageKey;
        await render(page, model);
        assert.strictEqual(await page.locator(".family-system-nav-item").count(), 7, `${module}/${pageKey} primary navigation`);
        assert.strictEqual(await page.locator(".family-system-local-nav button").count(), pages.length, `${module}/${pageKey} secondary navigation`);
        assert(await page.locator(".family-system-content").innerText(), `${module}/${pageKey} should render content`);
      }
    }
    await page.close();

    const reminderPage = await browser.newPage();
    await boot(reminderPage, 390, "dark");
    const reminderModel = baseModel("dark");
    reminderModel.module = "reminder";
    reminderModel.page = "all";
    reminderModel.pages.reminder = "all";
    await render(reminderPage, reminderModel);
    const reminderResult = await report(reminderPage);
    assert(reminderResult.rootOverflow <= 1, `reminder/390 root overflow ${reminderResult.rootOverflow}`);
    assert(reminderResult.bodyOverflow <= 1, `reminder/390 body overflow ${reminderResult.bodyOverflow}`);
    assert.match(await reminderPage.locator(".family-system-action-bar").innerText(), /新增事项/);
    assert.match(await reminderPage.locator(".family-system-action-bar").innerText(), /管理分类/);
    assert.strictEqual(await reminderPage.locator(".family-system-filter-row button").count(), 3);
    assert.match(await reminderPage.locator(".family-system-content").innerText(), /日常采买/);
    await reminderPage.close();

    const handlingPage = await browser.newPage();
    await boot(handlingPage, 390, "dark");
    const handlingModel = baseModel("dark");
    handlingModel.module = "diet";
    handlingModel.page = "plans";
    handlingModel.pages.diet = "plans";
    await render(handlingPage, handlingModel);
    handlingResult = await report(handlingPage);
    assert(handlingResult.rootOverflow <= 1, `handling/390 root overflow ${handlingResult.rootOverflow}`);
    assert(handlingResult.bodyOverflow <= 1, `handling/390 body overflow ${handlingResult.bodyOverflow}`);
    assert.strictEqual(await handlingPage.locator(".family-system-handling-details").count(), 1);
    assert.strictEqual(await handlingPage.locator(".family-system-handling-list li").count(), 25);
    assert.match(await handlingPage.locator(".family-system-content .family-system-panel").innerText(), /19 条食材处理说明 · 6 项处理提醒/);
    await handlingPage.close();

    const recipePage = await browser.newPage();
    await boot(recipePage, 390, "dark");
    const recipeModel = baseModel("dark");
    recipeModel.module = "diet";
    recipeModel.page = "recipes";
    recipeModel.pages.diet = "recipes";
    await render(recipePage, recipeModel);
    const recipeResult = await report(recipePage);
    assert(recipeResult.rootOverflow <= 1, `recipes/390 root overflow ${recipeResult.rootOverflow}`);
    assert(recipeResult.bodyOverflow <= 1, `recipes/390 body overflow ${recipeResult.bodyOverflow}`);
    assert.match(await recipePage.locator(".family-system-content").innerText(), /主菜 · 午餐／晚餐 · 3 份 · 25 分钟/);
    assert.deepStrictEqual(await recipePage.locator(".family-system-record-side button").allInnerTexts(), ["查看", "编辑"]);
    await recipePage.close();

    const recipeModalPage = await browser.newPage();
    await boot(recipeModalPage, 390, "dark");
    const recipeFixture = baseModel("dark").dashboard.recipes[0];
    await recipeModalPage.evaluate((recipe) => {
      window.recipeFixture = recipe;
      window.recipeSubmissions = [];
      const inventoryItems = [{ id: "item-fish", source_item_id: "item-fish-source", name: "测试鱼", canonical_unit: "条", entity_kind: "ingredient_item" }];
      window.recipeInventoryItems = inventoryItems;
      new window.module.exports.__test.RecipeDetailsModal(null, recipe, () => {}).open();
    }, recipeFixture);
    assert.match(await recipeModalPage.locator(".family-system-recipe-modal").innerText(), /制作步骤/);
    assert.match(await recipeModalPage.locator(".family-system-recipe-modal").innerText(), /处理测试鱼/);
    assert.strictEqual(await recipeModalPage.getByRole("button", { name: "编辑菜谱" }).count(), 1);
    await recipeModalPage.getByRole("button", { name: "关闭" }).click();
    await recipeModalPage.evaluate(() => {
      new window.module.exports.__test.RecipeDetailsModal(null, window.recipeFixture, {
        allowEdit: false,
        context: { planned_date: "2026-08-23", meal_label: "午餐", dish_plan_id: "menu-dish-3" },
      }).open();
    });
    const menuRecipeText = await recipeModalPage.locator(".family-system-recipe-modal").innerText();
    assert.match(menuRecipeText, /2026-08-23 · 午餐/);
    assert.match(menuRecipeText, /当前菜谱最新版/);
    assert.match(menuRecipeText, /测试鱼/);
    assert.match(menuRecipeText, /处理测试鱼/);
    assert.strictEqual(await recipeModalPage.getByRole("button", { name: "编辑菜谱" }).count(), 0);
    await recipeModalPage.getByRole("button", { name: "关闭" }).click();
    await recipeModalPage.evaluate(() => {
      new window.module.exports.__test.RecipeFormModal(null, {
        recipe: window.recipeFixture,
        inventoryItems: window.recipeInventoryItems,
        onSubmit: async (values) => window.recipeSubmissions.push(values),
      }).open();
    });
    assert.strictEqual(await recipeModalPage.locator(".family-system-recipe-ingredient-editor").count(), 1);
    const nameField = recipeModalPage.locator(".family-system-recipe-field").filter({ hasText: "菜谱名称" }).locator("input");
    await nameField.fill("清蒸测试鱼（更新）");
    const stepField = recipeModalPage.locator(".family-system-recipe-field").filter({ hasText: "制作步骤" }).locator("textarea");
    await stepField.fill("处理测试鱼。\n蒸熟后少量调味。\n");
    await recipeModalPage.getByRole("button", { name: "预览影响" }).click();
    const submission = await recipeModalPage.evaluate(() => window.recipeSubmissions[0]);
    assert.strictEqual(submission.name, "清蒸测试鱼（更新）");
    assert.deepStrictEqual(submission.steps, ["处理测试鱼。", "蒸熟后少量调味。"]);
    assert.strictEqual(submission.ingredients[0].id, "item-fish");
    assert.strictEqual(submission.ingredients[0].item_entity_id, "item-fish");
    assert.strictEqual(await recipeModalPage.locator(".family-system-recipe-modal").count(), 0);
    assert((await recipeModalPage.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)) <= 1);
    await recipeModalPage.close();

    for (const width of [1440, 720, 390]) {
      for (const theme of ["light", "dark"]) {
        const detailPage = await browser.newPage();
        await boot(detailPage, width, theme);
        const recipe = baseModel(theme).dashboard.recipes[0];
        await detailPage.evaluate((recipeValue) => {
          const root = document.getElementById("root");
          root.className = "family-system-recipe-modal";
          window.module.exports.__test.renderRecipeDetails(root, recipeValue);
        }, recipe);
        const detail = await detailPage.evaluate(() => ({
          overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          ingredients: document.querySelectorAll(".family-system-recipe-ingredient").length,
          steps: document.querySelectorAll(".family-system-recipe-steps li").length,
          text: document.getElementById("root").innerText,
        }));
        assert(detail.overflow <= 1, `recipe-detail/${width}/${theme} overflow ${detail.overflow}`);
        assert.strictEqual(detail.ingredients, 1);
        assert.strictEqual(detail.steps, 2);
        assert.match(detail.text, /处理测试鱼/);
        assert.match(detail.text, /过敏原：鱼类/);
        await detailPage.close();
      }
    }

    const dailyMenuPage = await browser.newPage();
    await boot(dailyMenuPage, 390, "dark");
    const dailyMenuModel = baseModel("dark");
    dailyMenuModel.module = "diet";
    dailyMenuModel.page = "menu";
    dailyMenuModel.pages.diet = "menu";
    await dailyMenuPage.evaluate(() => {
      window.menuRecipeRequests = [];
      window.handlers = new Proxy({}, {
        get: (_target, key) => key === "viewRecipe"
          ? (...args) => window.menuRecipeRequests.push(args)
          : () => {},
      });
    });
    await render(dailyMenuPage, dailyMenuModel);
    const dailyMenuResult = await report(dailyMenuPage);
    assert(dailyMenuResult.rootOverflow <= 1, `daily-menu/390 root overflow ${dailyMenuResult.rootOverflow}`);
    assert(dailyMenuResult.bodyOverflow <= 1, `daily-menu/390 body overflow ${dailyMenuResult.bodyOverflow}`);
    assert.strictEqual(await dailyMenuPage.locator(".family-system-menu-switcher button").count(), 8);
    assert.strictEqual(await dailyMenuPage.locator(".family-system-menu-switcher button.is-active").innerText(), "周日 08-23");
    assert.strictEqual(await dailyMenuPage.locator(".family-system-meal-group").count(), 2);
    assert.strictEqual(await dailyMenuPage.getByRole("button", { name: "查看做法" }).count(), 6);
    const completedDish = dailyMenuPage.locator(".family-system-menu-dish").filter({ has: dailyMenuPage.locator(".family-system-badge.is-completed") });
    const skippedDish = dailyMenuPage.locator(".family-system-menu-dish").filter({ has: dailyMenuPage.locator(".family-system-badge.is-skipped") });
    assert.strictEqual(await completedDish.getByRole("button", { name: "查看做法" }).count(), 1);
    assert.strictEqual(await skippedDish.getByRole("button", { name: "查看做法" }).count(), 1);
    await dailyMenuPage.getByRole("button", { name: "查看做法" }).first().click();
    const menuRecipeRequest = await dailyMenuPage.evaluate(() => window.menuRecipeRequests[0]);
    assert.deepStrictEqual(menuRecipeRequest, ["recipe", {
      readOnly: true,
      context: { planned_date: "2026-08-23", meal_label: "午餐", dish_plan_id: "menu-dish-3" },
    }]);
    assert.strictEqual(await dailyMenuPage.getByRole("button", { name: "完成本餐" }).count(), 2);
    assert.strictEqual(await dailyMenuPage.getByRole("button", { name: "缺料也做" }).count(), 1);
    assert.strictEqual(await dailyMenuPage.getByRole("button", { name: "恢复原料" }).count(), 1);
    assert.strictEqual(await dailyMenuPage.getByText("已阻塞", { exact: true }).count(), 0);
    assert.match(await dailyMenuPage.locator(".family-system-content").innerText(), /缺少 测试鱼 · 仍可继续制作/);
    assert.strictEqual(await dailyMenuPage.getByRole("button", { name: "结算菜单" }).count(), 1);
    assert.strictEqual(await dailyMenuPage.locator(".family-system-day-handling").count(), 1);
    assert.match(await dailyMenuPage.locator(".family-system-content").innerText(), /午餐处理衔接/);
    await dailyMenuPage.close();

    const weekMenuPage = await browser.newPage();
    await boot(weekMenuPage, 1440, "light");
    const weekMenuModel = baseModel("light");
    weekMenuModel.module = "diet";
    weekMenuModel.page = "menu";
    weekMenuModel.pages.diet = "menu";
    weekMenuModel.menu_date = "all";
    await render(weekMenuPage, weekMenuModel);
    const weekMenuResult = await report(weekMenuPage);
    assert(weekMenuResult.rootOverflow <= 1, `week-menu/1440 root overflow ${weekMenuResult.rootOverflow}`);
    assert.strictEqual(await weekMenuPage.locator(".family-system-menu-day").count(), 7);
    assert.strictEqual(await weekMenuPage.locator(".family-system-meal-group").count(), 13);
    assert.strictEqual(await weekMenuPage.locator(".family-system-menu-dish").count(), 34);
    assert.strictEqual(await weekMenuPage.getByRole("button", { name: "查看做法" }).count(), 34);
    await weekMenuPage.close();

    const missingRecipePage = await browser.newPage();
    await boot(missingRecipePage, 390, "light");
    const missingRecipeModel = baseModel("light");
    missingRecipeModel.module = "diet";
    missingRecipeModel.page = "menu";
    missingRecipeModel.pages.diet = "menu";
    missingRecipeModel.recipe_names = {};
    await render(missingRecipePage, missingRecipeModel);
    const missingRecipeResult = await report(missingRecipePage);
    assert(missingRecipeResult.rootOverflow <= 1, `missing-recipe/390 root overflow ${missingRecipeResult.rootOverflow}`);
    assert.strictEqual(await missingRecipePage.getByRole("button", { name: "菜谱不可用" }).count(), 6);
    assert.strictEqual(await missingRecipePage.getByRole("button", { name: "菜谱不可用" }).first().isDisabled(), true);
    await missingRecipePage.close();

    const inventoryPage = await browser.newPage();
    await boot(inventoryPage, 390, "dark");
    const inventoryModel = baseModel("dark");
    inventoryModel.module = "purchase";
    inventoryModel.page = "inventory";
    inventoryModel.pages.purchase = "inventory";
    await render(inventoryPage, inventoryModel);
    const inventoryResult = await report(inventoryPage);
    assert(inventoryResult.rootOverflow <= 1, `inventory/390 root overflow ${inventoryResult.rootOverflow}`);
    assert(inventoryResult.bodyOverflow <= 1, `inventory/390 body overflow ${inventoryResult.bodyOverflow}`);
    assert.strictEqual(await inventoryPage.locator(".family-system-inventory-filters input[type=search]").count(), 1);
    assert.strictEqual(await inventoryPage.locator(".family-system-inventory-filters select").count(), 2);
    assert.strictEqual(await inventoryPage.locator(".family-system-inventory-item").count(), 1);
    assert.match(await inventoryPage.locator(".family-system-action-bar").innerText(), /新增入库/);
    assert.match(await inventoryPage.locator(".family-system-action-bar").innerText(), /手动扣减/);
    await inventoryPage.close();

    for (const width of [1440, 720, 390]) {
      for (const theme of ["light", "dark"]) {
        const current = await browser.newPage();
        await boot(current, width, theme);
        await render(current, baseModel(theme));
        const value = await report(current);
        assert(value.rootOverflow <= 1, `${width}/${theme} root overflow ${value.rootOverflow}`);
        assert(value.bodyOverflow <= 1, `${width}/${theme} body overflow ${value.bodyOverflow}`);
        assert(value.smallestText >= 12, `${width}/${theme} text ${value.smallestText}`);
        assert(value.smallestControl >= (width <= 760 ? 44 : 36), `${width}/${theme} control ${value.smallestControl}`);
        assert.notStrictEqual(value.outline, "none");
        assert.strictEqual(value.metrics, 4);
        assert.strictEqual(value.nav, 7);
        results.push({ width, theme, ...value });
        await current.close();
      }
    }

    const reduced = await browser.newPage();
    await boot(reduced, 390, "dark");
    await render(reduced, baseModel("dark", "reduced"));
    const reducedReport = await reduced.evaluate(() => ({
      motion: document.querySelector(".betagifted-family-system-view").dataset.motion,
      scenePosition: getComputedStyle(document.querySelector(".family-system-stage-scene")).position,
      cardTransform: getComputedStyle(document.querySelector(".family-system-stage-card")).transform,
    }));
    assert.strictEqual(reducedReport.motion, "reduced");
    assert.strictEqual(reducedReport.scenePosition, "static");
    assert.strictEqual(reducedReport.cardTransform, "none");
    await reduced.close();
  } finally {
    await browser.close();
  }
  console.log(JSON.stringify({ status: "ok", suite: "layout", pages: 34, scenarios: results.length, menu_scenarios: 2, recipe_scenarios: 8, handling_scenario: handlingResult, results }));
}

main().catch((error) => { console.error(error); process.exit(1); });
