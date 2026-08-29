"use strict";

const { Notice, Plugin, PluginSettingTab, Setting, requestUrl } = require("obsidian");
const { PURCHASE_GROUP_ORDER, active, addDateDays, commandEnvelope, createId, dateRangeInclusive, deriveCurrentOrder, indexRecords, joinVaultPath, mealPlanRange, normalizeVaultPath, normalizeVaultRoot } = require("./core");
const { MODULE_SPECS } = require("./authority");
const { CoreStorage, LifeCoreService } = require("./storage");
const { ConfirmEffectsModal, FamilySystemView, FormModal, RecipeDetailsModal, RecipeFormModal, TaskCategoryManagerModal, VIEW_TYPE, renderDashboard, renderRecipeDetails, recipeIngredientDraftToRecord, recipeIngredientMode, recipeMeta } = require("./ui");
const { DEFAULT_PAGES, MODULES, buildFamilySystemViewModel, normalizeModule, normalizePage } = require("./view-model");

const MATERIAL_DEFAULTS = Object.freeze({
  cyan: Object.freeze({ a: "#36F5DF", b: "#00A8CA", c: "#235DA8", opacity: 78, blur: 20, speed: 100 }),
  original: Object.freeze({ a: "#FF4AA9", b: "#FF8849", c: "#AA49FF", opacity: 72, blur: 20, speed: 100 }),
  rain: Object.freeze({ a: "#FF693F", b: "#2D65FF", c: "#4821AC", opacity: 70, blur: 20, speed: 100 }),
  chrome: Object.freeze({ a: "#F6FFFF", b: "#74837E", c: "#1B2421", opacity: 68, blur: 18, speed: 100 }),
});

const VISUAL_DEFAULTS = Object.freeze({
  theme: "system",
  accent: "ocean",
  motion: "full",
  activeMaterial: "cyan",
  selectedSlot: 0,
  materials: MATERIAL_DEFAULTS,
});

const DEFAULT_SETTINGS = Object.freeze({
  dataRoot: "家庭管理系统/00_系统核心/life-core",
  authorityRoot: "家庭管理系统",
  deviceId: "",
  title: "家庭系统",
  householdName: "我的家庭",
  defaultPurchaseTime: "18:00",
  onboardingCompleted: false,
  appleIntegrationEnabled: false,
  companionBaseUrl: "http://127.0.0.1:41729",
  purchaseGroupOrder: PURCHASE_GROUP_ORDER.join("\n"),
  autoOpen: false,
  visual: VISUAL_DEFAULTS,
});

const APPLE_LISTS = Object.freeze({
  purchase: "家庭采购",
  meal_handling: "食材处理",
  household: "家庭事务",
});

const UI_AUTHORITY_MODULES = Object.freeze({ basic: "basic", finance: "finance", asset: "asset", purchase: "purchase", diet: "diet", reminder: "task" });

function taskCategory(task) {
  if (task?.category && APPLE_LISTS[task.category]) return task.category;
  if (task?.source_type === "purchase_demand") return "purchase";
  if (task?.source_type === "meal_handling") return "meal_handling";
  return "household";
}

function appleProjectionTask(task, state) {
  const category = taskCategory(task);
  const demandId = task.source_id || (task.source_ids || [])[0];
  const demand = active(state.purchase_demand).find((item) => item.id === demandId);
  const group = task.purchase_group || active(state.entity).find((item) => item.id === demand?.ingredient_id)?.purchase_group || "未分类";
  const title = category === "purchase" && demand
    ? `${group}｜${demand.ingredient_name}｜${demand.quantity} ${demand.unit}`
    : task.title;
  return {
    source_key: task.source_key || `task:${task.id}`,
    task_id: task.id,
    title,
    notes: task.notes || demand?.note || "",
    due_at: task.due_at || null,
    priority: Number(task.priority || 0),
    completed: ["completed", "receipt_confirmed"].includes(task.status),
    kind: category === "purchase" ? "purchase" : "task",
    category,
    list_title: APPLE_LISTS[category],
    projection_enabled: !task.tombstone && !["projection_paused", "cancelled", "archived"].includes(task.status),
  };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function bounded(value, minimum, maximum, fallback) {
  const number = Number(value);
  return Math.max(minimum, Math.min(maximum, Number.isFinite(number) ? number : fallback));
}

function validColor(value, fallback) {
  return /^#[0-9a-f]{6}$/i.test(String(value || "")) ? String(value) : fallback;
}

function normalizeVisual(input) {
  const value = input && typeof input === "object" ? input : {};
  const materials = {};
  Object.entries(MATERIAL_DEFAULTS).forEach(([key, fallback]) => {
    const item = value.materials && typeof value.materials[key] === "object" ? value.materials[key] : {};
    materials[key] = {
      a: validColor(item.a || item.color, fallback.a),
      b: validColor(item.b, fallback.b),
      c: validColor(item.c, fallback.c),
      opacity: bounded(item.opacity, 45, 100, fallback.opacity),
      blur: bounded(item.blur, 4, 30, fallback.blur),
      speed: bounded(item.speed, 50, 300, fallback.speed),
    };
  });
  return {
    theme: ["system", "dark", "light"].includes(value.theme) ? value.theme : VISUAL_DEFAULTS.theme,
    accent: ["ocean", "emerald", "iris", "amber", "sakura"].includes(value.accent) ? value.accent : VISUAL_DEFAULTS.accent,
    motion: ["full", "reduced"].includes(value.motion) ? value.motion : VISUAL_DEFAULTS.motion,
    activeMaterial: Object.prototype.hasOwnProperty.call(MATERIAL_DEFAULTS, value.activeMaterial) ? value.activeMaterial : VISUAL_DEFAULTS.activeMaterial,
    selectedSlot: Math.max(0, Math.min(3, Math.trunc(Number(value.selectedSlot) || 0))),
    materials,
  };
}

function normalizeSettings(saved) {
  const value = saved && typeof saved === "object" ? saved : {};
  const legacyVisual = {
    theme: value.theme,
    accent: value.accent,
    motion: value.motion,
    activeMaterial: value.material,
  };
  return {
    dataRoot: normalizeVaultPath(value.dataRoot || DEFAULT_SETTINGS.dataRoot),
    authorityRoot: normalizeVaultRoot(String(value.authorityRoot || "").trim() || DEFAULT_SETTINGS.authorityRoot),
    deviceId: String(value.deviceId || ""),
    title: String(value.title || DEFAULT_SETTINGS.title),
    householdName: String(value.householdName || DEFAULT_SETTINGS.householdName),
    defaultPurchaseTime: /^\d{2}:\d{2}$/.test(String(value.defaultPurchaseTime || "")) ? String(value.defaultPurchaseTime) : DEFAULT_SETTINGS.defaultPurchaseTime,
    onboardingCompleted: value.onboardingCompleted === true,
    appleIntegrationEnabled: value.appleIntegrationEnabled === true,
    companionBaseUrl: normalizeLoopbackUrl(value.companionBaseUrl || DEFAULT_SETTINGS.companionBaseUrl),
    purchaseGroupOrder: String(value.purchaseGroupOrder || DEFAULT_SETTINGS.purchaseGroupOrder),
    autoOpen: value.autoOpen === true,
    visual: normalizeVisual(value.visual || legacyVisual),
  };
}

function normalizeLoopbackUrl(value) {
  const url = new URL(String(value || DEFAULT_SETTINGS.companionBaseUrl));
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) throw new Error("伴生服务只允许 127.0.0.1 回环地址");
  return url.href.replace(/\/$/, "");
}

function effectiveTheme(visual) {
  if (visual.theme !== "system") return visual.theme;
  return typeof document !== "undefined" && document.body?.classList?.contains("theme-light") ? "light" : "dark";
}

function reducedMotion(visual) {
  return visual.motion === "reduced" || (typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches);
}

function handlingInstructionsText(items) {
  return (items || []).map((item) => {
    if (!item || typeof item !== "object") return `通用处理｜${String(item || "")}`;
    return `${item.phase || "通用处理"}｜${item.instruction || ""}`;
  }).filter((line) => !line.endsWith("｜")).join("\n");
}

function parseHandlingInstructionsText(value, existing) {
  const byPhase = new Map();
  (existing || []).forEach((item) => {
    const phase = item && typeof item === "object" ? item.phase || "通用处理" : "通用处理";
    if (!byPhase.has(phase)) byPhase.set(phase, []);
    byPhase.get(phase).push(item);
  });
  const phaseCounts = new Map();
  return String(value || "").split(/\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
    const delimiter = line.indexOf("｜");
    const phase = (delimiter >= 0 ? line.slice(0, delimiter) : "通用处理").trim() || "通用处理";
    const instruction = (delimiter >= 0 ? line.slice(delimiter + 1) : line).trim();
    const index = phaseCounts.get(phase) || 0;
    phaseCounts.set(phase, index + 1);
    const previous = byPhase.get(phase)?.[index];
    return { ...(previous && typeof previous === "object" ? previous : {}), phase, instruction };
  }).filter((item) => item.instruction);
}

function handlingActionsText(items) {
  return (items || []).map((item) => {
    const scheduled = String(item?.scheduled_at || "").replace("T", " ").slice(0, 16);
    return scheduled && item?.title ? `${scheduled}｜${item.title}` : "";
  }).filter(Boolean).join("\n");
}

function parseHandlingActionsText(value, existing) {
  const previous = Array.isArray(existing) ? existing : [];
  return String(value || "").split(/\n/).map((line) => line.trim()).filter(Boolean).map((line, index) => {
    const delimiter = line.indexOf("｜");
    if (delimiter < 0) throw new Error(`第 ${index + 1} 条处理提醒缺少“｜”分隔`);
    const scheduled = line.slice(0, delimiter).trim().replace(" ", "T");
    const title = line.slice(delimiter + 1).trim();
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(scheduled) || !title) throw new Error(`第 ${index + 1} 条处理提醒应为“日期 时间｜标题”`);
    return { ...(previous[index] || {}), scheduled_at: `${scheduled}:00`, title, task_required: true, projection_policy: "apple-reminders", status: previous[index]?.status || "planned" };
  });
}

function splitMenuValues(value) {
  return [...new Set(String(value || "").split(/[，,、]/).map((item) => item.trim()).filter(Boolean))];
}

function parseDailyMealOverrides(value) {
  const result = {};
  String(value || "").split(/\n/).map((line) => line.trim()).filter(Boolean).forEach((line, index) => {
    const [date, meals] = line.split("｜").map((item) => String(item || "").trim());
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || meals == null) throw new Error(`第 ${index + 1} 条逐日餐次格式无效`);
    result[date] = splitMenuValues(meals);
  });
  return result;
}

function parseServingOverrides(value) {
  const result = {};
  String(value || "").split(/\n/).map((line) => line.trim()).filter(Boolean).forEach((line, index) => {
    const [date, meal, countText] = line.split("｜").map((item) => String(item || "").trim());
    const count = Number(countText);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !meal || !Number.isFinite(count) || count <= 0) throw new Error(`第 ${index + 1} 条单餐人数格式无效`);
    result[`${date}|${meal}`] = count;
  });
  return result;
}

class FamilySystemSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    new Setting(containerEl)
      .setName("Life Core 数据目录")
      .setDesc("结构化运行事实、事件、操作、冲突与技术状态目录；必须是仓库内相对路径。")
      .addText((text) => text.setValue(this.plugin.settings.dataRoot).onChange(async (value) => {
        this.plugin.settings.dataRoot = normalizeVaultPath(value);
        this.plugin.resetStorage();
        await this.plugin.persistSettings();
      }));
    new Setting(containerEl)
      .setName("Markdown 权威根目录")
      .setDesc("六份定义资料和菜单草稿所在目录；填写 . 表示 Vault 根目录。业务定义与运行 JSON 按领域各自唯一权威。")
      .addText((text) => text.setValue(this.plugin.settings.authorityRoot).onChange(async (value) => {
        this.plugin.settings.authorityRoot = normalizeVaultRoot(String(value || "").trim() || DEFAULT_SETTINGS.authorityRoot);
        this.plugin.resetStorage();
        await this.plugin.persistSettings();
      }));
    new Setting(containerEl)
      .setName("工作台标题")
      .addText((text) => text.setValue(this.plugin.settings.title).onChange(async (value) => {
        this.plugin.settings.title = value.trim() || "家庭系统";
        await this.plugin.persistSettings();
      }));
    new Setting(containerEl)
      .setName("默认家庭名称")
      .setDesc("只用于第一次建立空白 Life Core。")
      .addText((text) => text.setValue(this.plugin.settings.householdName).onChange(async (value) => {
        this.plugin.settings.householdName = value.trim() || "我的家庭";
        await this.plugin.persistSettings();
      }));
    new Setting(containerEl)
      .setName("默认采购截止时间")
      .setDesc("修改这里表示长期默认；具体采购项的改期只影响单次实例。")
      .addText((text) => {
        text.setValue(this.plugin.settings.defaultPurchaseTime).onChange(async (value) => {
          if (!/^\d{2}:\d{2}$/.test(value)) return;
          this.plugin.settings.defaultPurchaseTime = value;
          await this.plugin.persistSettings();
        });
        text.inputEl.type = "time";
      });
    new Setting(containerEl)
      .setName("采购路线顺序")
      .setDesc("每行一个采购分区；未列出的分区自动排在末尾。")
      .addTextArea((text) => text.setValue(this.plugin.settings.purchaseGroupOrder).onChange(async (value) => {
        this.plugin.settings.purchaseGroupOrder = value;
        await this.plugin.persistSettings();
      }));
    new Setting(containerEl)
      .setName("Markdown 权威校验")
      .setDesc("检查六个模块的 schema、哈希、稳定 ID 和菜谱物品引用，不改业务资料。")
      .addButton((control) => control.setButtonText("立即校验").onClick(() => this.plugin.validateAuthority()));
    new Setting(containerEl)
      .setName("外部修改处理")
      .setDesc("对检测到的第一项外部修改生成采纳预演，或恢复该模块最后正式版本。")
      .addButton((control) => control.setButtonText("预演采纳").onClick(() => this.plugin.reviewAuthorityConflict("authority.adopt-external")))
      .addButton((control) => control.setButtonText("预演恢复").onClick(() => this.plugin.reviewAuthorityConflict("authority.restore-module")));
    new Setting(containerEl)
      .setName("Apple 提醒扩展")
      .setDesc("默认关闭。启用后只连接当前 Mac 的 127.0.0.1 伴生服务；Obsidian 核心不依赖它。")
      .addToggle((toggle) => toggle.setValue(this.plugin.settings.appleIntegrationEnabled).onChange(async (value) => {
        this.plugin.settings.appleIntegrationEnabled = value;
        if (!value) this.plugin.sessionCompanionCredential = "";
        await this.plugin.persistSettings();
        this.display();
      }));
    if (this.plugin.settings.appleIntegrationEnabled) new Setting(containerEl)
      .setName("Family System 伴生服务")
      .setDesc("仅允许 127.0.0.1；默认端口 41729。")
      .addText((text) => text.setValue(this.plugin.settings.companionBaseUrl).onChange(async (value) => {
        this.plugin.settings.companionBaseUrl = normalizeLoopbackUrl(value);
        await this.plugin.persistSettings();
      }));
    if (this.plugin.settings.appleIntegrationEnabled) new Setting(containerEl)
      .setName("本机配对凭据")
      .setDesc("仅在本次 Obsidian 会话内使用；关闭插件或 Obsidian 后清除，不写入 Vault。")
      .addText((text) => {
        text.inputEl.type = "password";
        text.setValue(this.plugin.sessionCompanionCredential).onChange((value) => { this.plugin.sessionCompanionCredential = value.trim(); });
      });
    if (this.plugin.settings.appleIntegrationEnabled) new Setting(containerEl)
      .setName("核对 Mac 与 Apple 投影")
      .addButton((control) => control.setButtonText("核对并同步").onClick(() => this.plugin.syncAppleTasks()));
    new Setting(containerEl)
      .setName("便携备份")
      .setDesc("在 Life Core 的 backups/portable 中生成带逐文件哈希的本地备份；备份包含家庭资料，请按敏感文件保护。")
      .addButton((control) => control.setButtonText("创建并校验").onClick(() => this.plugin.createPortableBackup()))
      .addButton((control) => control.setButtonText("校验已有备份").onClick(() => this.plugin.verifyPortableBackup()));
    new Setting(containerEl)
      .setName("候选恢复")
      .setDesc("只恢复到全新空目录，不覆盖当前系统，也不会自动切换。")
      .addButton((control) => control.setButtonText("生成恢复候选").onClick(() => this.plugin.restorePortableBackupCandidate()));
    new Setting(containerEl)
      .setName("启动时打开家庭系统")
      .addToggle((toggle) => toggle.setValue(this.plugin.settings.autoOpen).onChange(async (value) => {
        this.plugin.settings.autoOpen = value;
        await this.plugin.persistSettings();
      }));
    new Setting(containerEl)
      .setName("减少动态效果")
      .setDesc("系统级减少动态设置始终优先。")
      .addToggle((toggle) => toggle.setValue(this.plugin.settings.visual.motion === "reduced").onChange(async (value) => {
        await this.plugin.updateVisual({ motion: value ? "reduced" : "full" });
      }));
  }
}

class BetaGiftedFamilySystemPlugin extends Plugin {
  async onload() {
    const savedSettings = await this.loadData();
    this.settings = normalizeSettings(savedSettings);
    this.sessionCompanionCredential = "";
    this.onboardingOpened = false;
    if (savedSettings && Object.prototype.hasOwnProperty.call(savedSettings, "companionCredential")) await this.saveData(this.settings);
    if (!this.settings.deviceId) {
      this.settings.deviceId = createId("device");
      await this.saveData(this.settings);
    }
    this.currentModule = "overview";
    this.pages = { ...DEFAULT_PAGES };
    this.menuDate = null;
    this.menuPlanId = null;
    this.reminderCategory = "all";
    this.inventoryFilter = { query: "", group: "all", status: "available" };
    this.coreSection = "order";
    this.stageIndex = 0;
    this.materialOpen = false;
    this.refreshTimer = null;
    this.modelCache = null;
    this.modelPromise = null;
    this.modelLoadCount = 0;
    this.resetStorage();
    this.registerView(VIEW_TYPE, (leaf) => new FamilySystemView(leaf, this));
    this.addRibbonIcon("home", "打开家庭系统", () => this.activateView());
    this.addCommand({ id: "open-dashboard", name: "打开家庭系统", callback: () => this.activateView() });
    this.addCommand({ id: "generate-meal-plan", name: "一键自动生成菜单草稿", callback: () => this.generateMealPlan() });
    this.addCommand({ id: "initialize-life-core", name: "建立空白 Life Core", callback: () => this.initializeHousehold() });
    this.addCommand({ id: "validate-markdown-authority", name: "校验 Markdown 权威资料", callback: () => this.validateAuthority() });
    this.addCommand({ id: "adopt-external-authority-change", name: "预演采纳 Markdown 外部修改", callback: () => this.reviewAuthorityConflict("authority.adopt-external") });
    this.addCommand({ id: "restore-authority-module", name: "预演恢复 Markdown 正式版本", callback: () => this.reviewAuthorityConflict("authority.restore-module") });
    this.addCommand({ id: "process-command-inbox", name: "处理快捷指令命令箱", callback: () => this.processInbox(true) });
    this.addCommand({ id: "sync-apple-tasks", name: "同步 Apple 事务投影", callback: () => this.syncAppleTasks() });
    this.addCommand({ id: "create-portable-backup", name: "创建并校验便携备份", callback: () => this.createPortableBackup() });
    this.addCommand({ id: "verify-portable-backup", name: "校验便携备份", callback: () => this.verifyPortableBackup() });
    this.addCommand({ id: "restore-portable-backup-candidate", name: "从便携备份生成恢复候选", callback: () => this.restorePortableBackupCandidate() });
    this.addCommand({ id: "check-store-upgrade-readiness", name: "检查升级准备状态", callback: () => this.checkUpgradeReadiness() });
    this.addSettingTab(new FamilySystemSettingTab(this.app, this));
    ["create", "modify", "delete"].forEach((eventName) => {
      this.registerEvent(this.app.vault.on(eventName, (file) => this.onVaultChange(file)));
    });
    this.app.workspace.onLayoutReady(async () => {
      if (this.app.vault.getAbstractFileByPath(this.storage.path("manifest.json"))) await this.processInbox(false);
      if (this.settings.autoOpen) await this.activateView();
    });
  }

  onunload() {
    this.sessionCompanionCredential = "";
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
  }

  resetStorage() {
    this.storage = new CoreStorage(this.app, this.settings.dataRoot, null, { authorityRoot: this.settings.authorityRoot, deviceId: this.settings.deviceId });
    this.service = new LifeCoreService(this.storage);
    this.invalidateModel();
  }

  invalidateModel() {
    this.modelCache = null;
    this.modelPromise = null;
  }

  async persistSettings() {
    await this.saveData(this.settings);
    await this.refreshViews();
  }

  async activateView() {
    let leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0];
    if (!leaf) {
      leaf = this.app.workspace.getLeaf("tab");
      await leaf.setViewState({ type: VIEW_TYPE, active: true });
    }
    this.app.workspace.revealLeaf(leaf);
    const model = await this.loadBaseModel();
    if (!model.household && !this.settings.onboardingCompleted && !this.onboardingOpened) {
      this.onboardingOpened = true;
      this.initializeHousehold();
    }
  }

  onVaultChange(file) {
    if (!file?.path) return;
    const root = `${this.storage.rootPath}/`;
    const modulePath = typeof this.storage.modulePath === "function" && Object.keys(MODULE_SPECS).some((key) => this.storage.modulePath(key) === file.path);
    if (!file.path.startsWith(root) && !modulePath) return;
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(async () => {
      this.refreshTimer = null;
      try {
        if (file.path.includes("/projections/") && file.path.endsWith(".md")) await this.storage.checkProjectionModification(file.path);
        if (modulePath) await this.storage.checkAuthorityModification(file.path);
        if (file.path.includes("/inbox/pending/") && file.path.endsWith(".json")) await this.processInbox(false);
      } catch (error) {
        console.error("BetaGifted Family System authority/projection check failed", error);
      }
      this.invalidateModel();
      await this.refreshViews();
    }, 180);
  }

  async loadBaseModel() {
    if (this.modelCache) return this.modelCache;
    if (this.modelPromise) return this.modelPromise;
    this.modelPromise = (async () => {
      try {
        this.modelLoadCount += 1;
        if (!this.app.vault.getAbstractFileByPath(this.storage.path("manifest.json"))) {
          const state = Object.fromEntries(require("./core").RECORD_TYPES.map((type) => [type, []]));
          state.operations = [];
          state.conflicts = [];
          state.imports = [];
          return { household: null, state, derived: deriveCurrentOrder(state), recipe_names: {}, constraint_counts: {}, store_status: "not_initialized", authority_conflicts: [], authority_status: "等待建立", error: null };
        }
        const state = await this.storage.loadState();
        const household = active(state.household)[0] || null;
        const derived = deriveCurrentOrder(state);
        const recipes = indexRecords(active(state.recipe));
        const recipeNames = {};
        recipes.forEach((recipe, id) => { recipeNames[id] = recipe.name; });
        const constraintCounts = {};
        active(state.health_constraint).forEach((item) => { constraintCounts[item.member_id] = (constraintCounts[item.member_id] || 0) + 1; });
        const authorityConflicts = (state.conflicts || []).filter((item) => item.status === "open" && item.conflict_type === "markdown_authority_modified_externally");
        return {
          household,
          state,
          derived,
          recipe_names: recipeNames,
          constraint_counts: constraintCounts,
          store_status: household ? "ready" : "prepared",
          authority_conflicts: authorityConflicts,
          authority_status: authorityConflicts.length ? `待处理 ${authorityConflicts.length}` : "权威正常",
          error: null,
        };
      } catch (error) {
        const emptyState = Object.fromEntries(require("./core").RECORD_TYPES.map((type) => [type, []]));
        emptyState.operations = [];
        emptyState.conflicts = [];
        emptyState.imports = [];
        return {
          household: null,
          state: emptyState,
          derived: deriveCurrentOrder(emptyState),
          recipe_names: {},
          constraint_counts: {},
          store_status: "failed",
          authority_conflicts: [],
          authority_status: "读取失败",
          error: error.message,
        };
      }
    })();
    try {
      this.modelCache = await this.modelPromise;
      return this.modelCache;
    } finally {
      this.modelPromise = null;
    }
  }

  async loadModel() {
    const base = await this.loadBaseModel();
    const moduleKey = normalizeModule(this.currentModule);
    const pageKey = normalizePage(moduleKey, this.pages[moduleKey]);
    const dashboard = buildFamilySystemViewModel(base.state, base.derived, {
      now: new Date(),
      recipe_names: base.recipe_names,
      constraint_counts: base.constraint_counts,
      purchase_group_order: this.settings.purchaseGroupOrder.split(/\n/).map((item) => item.trim()).filter(Boolean),
      inventory_filter: this.inventoryFilter,
      menu_plan_id: this.menuPlanId,
    });
    return {
      ...base,
      ...dashboard,
      dashboard,
      module: moduleKey,
      page: pageKey,
      pages: { ...this.pages },
      menu_date: this.menuDate || dashboard.weekly_menu.default_date,
      menu_plan_id: dashboard.weekly_menu.plan?.id || null,
      reminder_category: this.reminderCategory,
      inventory_filter: { ...this.inventoryFilter },
      core_section: this.coreSection,
      stage_index: this.stageIndex,
      material_open: this.materialOpen,
      title: this.settings.title,
      data_root: this.settings.dataRoot,
      authority_root: this.settings.authorityRoot,
      authority_module_key: UI_AUTHORITY_MODULES[moduleKey] || null,
      authority_module_path: UI_AUTHORITY_MODULES[moduleKey]
        ? (typeof this.storage.modulePath === "function"
          ? this.storage.modulePath(UI_AUTHORITY_MODULES[moduleKey])
          : joinVaultPath(this.settings.authorityRoot, MODULE_SPECS[UI_AUTHORITY_MODULES[moduleKey]].relative_path))
        : null,
      visual: clone(this.settings.visual),
      theme: effectiveTheme(this.settings.visual),
      reduced_motion: reducedMotion(this.settings.visual),
      model_load_count: this.modelLoadCount,
    };
  }

  handlers() {
    return {
      navigateModule: async (moduleKey) => {
        this.currentModule = normalizeModule(moduleKey);
        this.pages[this.currentModule] = normalizePage(this.currentModule, this.pages[this.currentModule]);
        await this.refreshViews();
      },
      navigatePage: async (pageKey) => {
        this.pages[this.currentModule] = normalizePage(this.currentModule, pageKey);
        await this.refreshViews();
      },
      selectMenuDate: async (date) => {
        this.menuDate = date === "all" ? "all" : String(date || "");
        await this.refreshViews();
      },
      selectMenuPlan: async (id) => {
        this.menuPlanId = String(id || "") || null;
        this.menuDate = null;
        await this.refreshViews();
      },
      openMenuPlan: async (id) => {
        this.menuPlanId = String(id || "") || null;
        this.menuDate = null;
        this.pages.diet = "menu";
        await this.refreshViews();
      },
      selectReminderCategory: async (category) => {
        this.reminderCategory = category || "all";
        await this.refreshViews();
      },
      setInventoryFilter: async (patch) => {
        this.inventoryFilter = { ...this.inventoryFilter, ...(patch || {}) };
        await this.refreshViews();
      },
      coreSection: async (section) => {
        this.coreSection = ["order", "decision", "recovery"].includes(section) ? section : "order";
        await this.refreshViews();
      },
      rotateStage: (delta) => this.rotateStage(delta),
      openSignal: (signal) => this.openSignal(signal),
      refresh: () => this.refreshViews({ invalidate: true }),
      toggleTheme: () => this.toggleTheme(),
      toggleMaterials: () => this.toggleMaterials(),
      updateVisual: (patch) => this.updateVisual(patch),
      settings: () => this.openSettings(),
      openAuthorityModule: () => this.openAuthorityModule(UI_AUTHORITY_MODULES[this.currentModule]),
      validateAuthority: () => this.validateAuthority(),
      adoptExternalAuthority: () => this.reviewAuthorityConflict("authority.adopt-external"),
      restoreAuthority: () => this.reviewAuthorityConflict("authority.restore-module"),
      initialize: () => this.initializeHousehold(),
      addMember: () => this.addMember(),
      addBasicRecord: (type) => this.addBasicRecord(type),
      addConstraint: () => this.addConstraint(),
      addRecipe: () => this.addRecipe(),
      viewRecipe: (id, options) => this.viewRecipe(id, options),
      editRecipe: (id) => this.editRecipe(id),
      scheduleDish: () => this.scheduleDish(),
      generateMealPlan: () => this.generateMealPlan(),
      createMealPlan: () => this.createMealPlan(),
      activateMealPlan: (id, revision) => this.runCommand("meal-plan.activate", { id, expected_revision: revision, default_purchase_time: this.settings.defaultPurchaseTime }, "激活菜单"),
      regenerateMealPlan: (id, revision, slotIds) => this.runCommand("meal-plan.regenerate", { id, expected_revision: revision, meal_slot_ids: slotIds || [] }, slotIds?.length ? "重新生成单餐" : "重新生成菜单"),
      setMealSlotLock: (id, revision, locked) => this.runCommand("meal-slot.set-lock", { id, expected_revision: revision, locked }, locked ? "锁定餐次" : "解锁餐次"),
      editMealPlan: (id) => this.editMealPlan(id),
      rebuildMealPurchases: (id, revision) => this.runCommand("meal-plan.rebuild-purchases", { id, expected_revision: revision, default_purchase_time: this.settings.defaultPurchaseTime }, "重算菜单采购并抵扣库存"),
      completeMeal: (id, revision) => this.runCommand("meal.complete", { meal_slot_id: id, expected_revision: revision }, "完成本餐并扣减库存"),
      continueWithoutMissing: (id, revision) => this.runCommand("dish.continue-without-missing", { dish_plan_id: id, expected_revision: revision }, "缺料也继续制作"),
      restoreOmittedIngredients: (id, revision) => this.runCommand("dish.restore-omitted-ingredients", { dish_plan_id: id, expected_revision: revision }, "恢复本餐原料"),
      settleMealPlan: (id) => this.settleMealPlan(id),
      reschedule: (id) => this.rescheduleDish(id),
      skipDish: (id) => this.runCommand("skip-dish", { dish_plan_id: id }, "跳过菜品"),
      skipMeal: (id) => id && this.runCommand("skip-meal", { meal_slot_id: id }, "跳过整餐"),
      replaceDish: (id) => this.replaceDish(id),
      confirmReceipt: () => this.confirmReceipt(),
      confirmReceiptsBatch: () => this.confirmReceiptsBatch(),
      addManualPurchase: () => this.addManualPurchase(),
      receiveInventory: (itemId) => this.receiveInventory(itemId),
      recordConsumption: () => this.recordConsumption(),
      calibrateInventory: (batchId) => this.calibrateInventory(batchId),
      linkFinance: () => this.linkFinance(false),
      unplannedPurchase: () => this.linkFinance(true),
      addFinanceTransaction: () => this.addFinanceTransaction(),
      addTask: () => this.addTask(),
      deleteTask: (id, revision) => this.runCommand("task.delete", { id, expected_revision: revision }, "删除事务"),
      manageTaskCategories: () => this.manageTaskCategories(),
      addAsset: () => this.addAsset(),
      addMaintenancePlan: () => this.addMaintenancePlan(),
      syncApple: () => this.syncAppleTasks(),
      recover: (id, action) => this.recover(id, action),
    };
  }

  async openAuthorityModule(moduleKey) {
    if (!moduleKey) {
      new Notice("当前总览汇集多个权威来源，请进入具体模块打开资料文件");
      return;
    }
    const path = this.storage.modulePath(moduleKey);
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!file) {
      new Notice(`尚未找到资料文件：${path}`);
      return;
    }
    if (typeof this.app.workspace.openLinkText === "function") await this.app.workspace.openLinkText(path, "", false);
    else await this.app.workspace.getLeaf("tab").openFile(file);
  }

  async renderView(view) {
    const model = await this.loadModel();
    renderDashboard(view.contentEl, model, this.handlers());
  }

  async refreshViews({ invalidate = false } = {}) {
    if (invalidate) this.invalidateModel();
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
      if (leaf.view instanceof FamilySystemView) await this.renderView(leaf.view);
    }
  }

  async refreshAfterMutation() {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = null;
    this.invalidateModel();
    await this.refreshViews();
  }

  async updateVisual(patch) {
    this.settings.visual = normalizeVisual({ ...this.settings.visual, ...patch });
    await this.saveData(this.settings);
    await this.refreshViews();
  }

  async toggleTheme() {
    await this.updateVisual({ theme: effectiveTheme(this.settings.visual) === "dark" ? "light" : "dark" });
  }

  async toggleMaterials() {
    this.materialOpen = !this.materialOpen;
    await this.refreshViews();
  }

  async rotateStage(delta = 1, automatic = false) {
    if (automatic && (this.currentModule !== "overview" || this.materialOpen || reducedMotion(this.settings.visual))) return;
    const size = Object.keys(MODULES).length - 1;
    this.stageIndex = ((this.stageIndex + Number(delta || 0)) % size + size) % size;
    await this.refreshViews();
  }

  async openSignal(signal) {
    const moduleKey = normalizeModule(signal?.module || "overview");
    this.currentModule = moduleKey;
    if (signal?.page) this.pages[moduleKey] = normalizePage(moduleKey, signal.page);
    if (signal?.core_section || signal?.core) this.coreSection = signal.core_section || signal.core;
    await this.refreshViews();
  }

  openSettings() {
    this.app.setting.open();
    this.app.setting.openTabById(this.manifest.id);
  }

  async commandContext(payload) {
    const model = await this.loadModel();
    return commandEnvelope(payload.type, {
      ...payload.values,
      household_id: model.household?.id || payload.values.household_id || "",
      actor_id: payload.values.actor_id || active(model.state.member)[0]?.id || "local-user",
      default_purchase_time: this.settings.defaultPurchaseTime,
    });
  }

  async runCommand(type, values, label, options = {}) {
    try {
      const command = await this.commandContext({ type, values });
      const operation = await this.service.preview(command);
      new ConfirmEffectsModal(this.app, operation, async () => {
        const result = await this.service.commit(operation.operation_id);
        if (typeof options.onCommitted === "function") await options.onCommitted(result, operation);
        new Notice(`${label || operation.summary}：${result.status === "committed" ? "已完成" : "已提交，投影待恢复"}`);
        await this.refreshAfterMutation();
      }, async () => {
        await this.service.discardPreview(operation.operation_id);
        await this.refreshAfterMutation();
      }).open();
      return operation;
    } catch (error) {
      new Notice(error.message);
      throw error;
    }
  }

  async processInbox(notify = false) {
    try {
      const results = await this.service.processInbox();
      if (results.length) {
        await this.refreshAfterMutation();
        if (notify) new Notice(`命令箱处理完成：${results.filter((item) => item.status === "processed").length} 成功，${results.filter((item) => item.status === "rejected").length} 拒绝`);
      } else if (notify) new Notice("命令箱没有待处理项目");
      return results;
    } catch (error) {
      if (notify) new Notice(error.message);
      return [];
    }
  }

  async companionRequest(method, path, body) {
    if (!this.settings.appleIntegrationEnabled) throw new Error("Apple 提醒扩展尚未启用");
    if (!this.sessionCompanionCredential) throw new Error("请先在设置中输入本次会话的伴生配对凭据");
    const response = await requestUrl({
      url: `${normalizeLoopbackUrl(this.settings.companionBaseUrl)}${path}`,
      method,
      headers: { Authorization: `Bearer ${this.sessionCompanionCredential}`, "Content-Type": "application/json" },
      body: body == null ? undefined : JSON.stringify(body),
      throw: false,
    });
    if (response.status < 200 || response.status >= 300) throw new Error(response.json?.error || `伴生服务返回 ${response.status}`);
    return response.json;
  }

  async syncAppleTasks() {
    try {
      const status = await this.companionRequest("GET", "/v1/status");
      const availableLists = new Set(status.list_titles || []);
      if (status.version !== "1.2.0" || !status.authorized || !Object.values(APPLE_LISTS).every((title) => availableLists.has(title))) throw new Error("伴生服务必须为 1.2.0，并具备 EventKit 权限和三个专用清单");
      const model = await this.loadBaseModel();
      const tasks = (model.state.task || []).map((task) => appleProjectionTask(task, model.state));
      const result = await this.companionRequest("POST", "/v1/task-projections/sync", { operation_id: `apple-sync:${Date.now()}`, tasks });
      const eventResponse = await this.companionRequest("GET", "/v1/events");
      let processed = 0;
      let idempotent = 0;
      const failures = [];
      for (const event of eventResponse.events || []) {
        try {
          const existing = await this.storage.readOperation(event.id);
          const current = await this.storage.loadState();
          const recorded = (current.domain_event || []).some((item) => item.payload?.event_id === event.id);
          if (recorded || (existing && ["committed", "committed_with_pending_projection"].includes(existing.status))) {
            idempotent += 1;
          } else {
          const command = commandEnvelope("apple.projection-event", {
            command_id: event.id,
            household_id: model.household.id,
            actor_id: "apple-reminders",
            authority: "apple_execution_evidence",
            occurred_at: event.occurred_at,
            event_id: event.id,
            event_type: event.event_type,
            task_id: event.task_id,
            source_key: event.source_key,
          });
          const operation = await this.service.preview(command);
          await this.service.commit(operation.operation_id);
            processed += 1;
          }
          await this.companionRequest("POST", "/v1/events/ack", { event_ids: [event.id] });
        } catch (error) {
          failures.push({ event_id: event.id, error: error.message });
        }
      }
      if (processed || idempotent) await this.refreshAfterMutation();
      const response = { ...result, events_processed: processed, events_idempotent: idempotent, events_failed: failures };
      const removed = result.items?.filter((item) => item.status === "removed").length || 0;
      new Notice(`Apple 投影同步完成：${result.items?.filter((item) => item.status === "synced").length || 0} 项，移除 ${removed} 项；新处理 ${processed}，幂等 ${idempotent}，异常 ${failures.length}`);
      return response;
    } catch (error) {
      new Notice(`Apple 投影未同步：${error.message}`);
      throw error;
    }
  }

  initializeHousehold() {
    new FormModal(this.app, {
      title: "首次建立 Family System",
      description: "所有资料只保存在当前 Obsidian Vault。系统不会联网、上传、创建演示家庭或自动连接 Apple。提交后仍会展示完整 EffectSet 供你确认。",
      fields: [
        { id: "name", label: "家庭名称", value: this.settings.householdName },
        { id: "authority_root", label: "家庭资料目录", value: this.settings.authorityRoot, description: "六份可阅读的 Markdown 定义资料。" },
        { id: "data_root", label: "Life Core 目录", value: this.settings.dataRoot, description: "运行记录、事件、操作和备份目录。" },
        { id: "apple_enabled", label: "启用 Apple 提醒扩展", type: "checkbox", value: false, description: "可稍后开启；核心功能不依赖它。" },
        { id: "confirmed_local", label: "我已了解资料保存在当前 Vault，并自行负责 Vault 备份", type: "checkbox", value: false },
      ],
      submitLabel: "预览影响",
      onSubmit: async (values) => {
        if (values.confirmed_local !== true) throw new Error("请先确认本地数据与备份边界");
        this.settings.householdName = String(values.name || "").trim() || "我的家庭";
        this.settings.authorityRoot = normalizeVaultRoot(values.authority_root);
        this.settings.dataRoot = normalizeVaultPath(values.data_root);
        this.settings.appleIntegrationEnabled = values.apple_enabled === true;
        await this.saveData(this.settings);
        this.resetStorage();
        return this.runCommand("initialize-household", { name: this.settings.householdName }, "建立家庭", {
          onCommitted: async () => {
            this.settings.onboardingCompleted = true;
            await this.saveData(this.settings);
          },
        });
      },
    }).open();
  }

  async createPortableBackup() {
    try {
      const result = await this.storage.createPortableBackup();
      new Notice(`便携备份已创建并校验：${result.path}`);
      return result;
    } catch (error) {
      new Notice(error.message);
      throw error;
    }
  }

  verifyPortableBackup() {
    new FormModal(this.app, {
      title: "校验便携备份",
      description: "只读取备份并核对 schema、逐文件哈希和总哈希，不改当前数据。",
      fields: [{ id: "path", label: "Vault 内备份路径", placeholder: `${this.settings.dataRoot}/backups/portable/family-system-backup-….json` }],
      submitLabel: "开始校验",
      onSubmit: async ({ path }) => {
        const result = await this.storage.verifyPortableBackup(normalizeVaultPath(path));
        new Notice(`备份有效：${result.file_count} 个文件`);
        return result;
      },
    }).open();
  }

  restorePortableBackupCandidate() {
    const suffix = new Date().toISOString().slice(0, 10);
    new FormModal(this.app, {
      title: "生成恢复候选",
      description: "目标必须为空。系统只生成并校验候选，不覆盖或切换当前家庭系统。",
      fields: [
        { id: "path", label: "Vault 内备份路径" },
        { id: "authority_root", label: "候选资料目录", value: `家庭系统恢复候选-${suffix}` },
        { id: "data_root", label: "候选 Life Core 目录", value: `家庭系统恢复候选-${suffix}/00_系统核心/life-core` },
        { id: "confirmed_candidate", label: "我确认只生成候选，不自动切换", type: "checkbox", value: false },
      ],
      submitLabel: "生成候选",
      onSubmit: async (values) => {
        if (values.confirmed_candidate !== true) throw new Error("请确认候选恢复边界");
        const result = await this.storage.restorePortableBackupCandidate(normalizeVaultPath(values.path), normalizeVaultPath(values.data_root), normalizeVaultRoot(values.authority_root));
        new Notice(`恢复候选已就绪：${result.data_root}`);
        return result;
      },
    }).open();
  }

  async checkUpgradeReadiness() {
    try {
      const manifest = await this.storage.readJson(this.storage.path("manifest.json"));
      if (manifest?.schema !== "family-system/store-v4" || Number(manifest?.schema_version) !== 4) throw new Error("当前数据不是可直接升级的 store-v4");
      const validation = await this.storage.validateAuthority();
      if (validation.status !== "valid") throw new Error(`Markdown 权威校验失败：${validation.errors.length} 项`);
      const applying = (await this.storage.readDirectoryJson("operations")).filter((item) => item.status === "applying");
      if (applying.length) throw new Error(`存在尚未恢复的写入操作：${applying.map((item) => item.operation_id).join("、")}`);
      const conflicts = (await this.storage.readDirectoryJson("conflicts")).filter((item) => item.status === "open");
      if (conflicts.length) throw new Error(`存在 ${conflicts.length} 个待处理冲突`);
      new Notice(`升级准备检查通过：store-v4，${validation.records} 条定义记录；请在替换插件前另行创建并校验便携备份`);
      return { status: "ready", schema: manifest.schema, definitions: validation.records, applying_operations: 0, open_conflicts: 0 };
    } catch (error) {
      new Notice(error.message);
      throw error;
    }
  }

  addMember() {
    new FormModal(this.app, {
      title: "新增家庭成员",
      fields: [
        { id: "name", label: "成员名称" },
        { id: "role", label: "角色", type: "select", value: "member", options: [
          { value: "maintainer", label: "维护者" }, { value: "decision_maker", label: "决策者" },
          { value: "executor", label: "执行成员" }, { value: "member", label: "家庭成员" },
        ] },
      ],
      onSubmit: (values) => this.runCommand("add-member", values, "新增成员"),
    }).open();
  }

  addBasicRecord(type) {
    const definitions = {
      document: { title: "新增证件引用", fields: [{ id: "name", label: "名称" }, { id: "document_type", label: "证件类型" }, { id: "owner_id", label: "持有人 UUID" }, { id: "expires_on", label: "到期日期", type: "date" }, { id: "identifier_hint", label: "号码提示（请勿填完整号码）" }] },
      contact: { title: "新增重要联系人", fields: [{ id: "name", label: "名称" }, { id: "contact_type", label: "联系人类型" }, { id: "phone", label: "电话" }, { id: "availability", label: "可联系时间" }] },
      medical_profile: { title: "新增基础医疗资料", fields: [{ id: "name", label: "名称" }, { id: "owner_id", label: "成员 UUID" }, { id: "blood_type", label: "血型" }, { id: "allergies_text", label: "已确认过敏项（逗号分隔）" }, { id: "emergency_note", label: "紧急说明" }] },
      account_reference: { title: "新增账号入口", fields: [{ id: "name", label: "名称" }, { id: "service", label: "服务" }, { id: "login_url", label: "登录地址" }, { id: "login_hint", label: "登录提示" }, { id: "password_manager_item", label: "密码管理器条目" }] },
    };
    const definition = definitions[type];
    if (!definition) return new Notice("不支持的基础信息类型");
    new FormModal(this.app, {
      title: definition.title,
      description: type === "account_reference" ? "这里只保存入口和密码管理器引用，不保存密码、验证码或恢复密钥。" : "记录将写入 Life Core，并经过 EffectSet 确认。",
      fields: definition.fields,
      onSubmit: (values) => {
        const record = { ...values, status: "active" };
        if (type === "medical_profile") record.allergies = String(values.allergies_text || "").split(/[,，]/).map((item) => item.trim()).filter(Boolean);
        delete record.allergies_text;
        return this.runCommand("record.create", { record_type: type, record }, `新增 ${definition.title.replace("新增", "")}`);
      },
    }).open();
  }

  addManualPurchase() {
    return this.addTask({ purchaseOnly: true });
  }

  async addTask(options = {}) {
    const model = await this.loadModel();
    const categories = model.dashboard.task_categories.filter((item) => !item.virtual && (!options.purchaseOnly || item.route_kind === "purchase"));
    if (!categories.length) return new Notice("请先运行 1.3.0 分类迁移，再新增事项");
    const items = model.dashboard.inventory_items;
    const today = new Date().toISOString().slice(0, 10);
    const categoryFor = (values) => categories.find((item) => item.id === values.category_id) || categories[0];
    const isPurchase = (values) => categoryFor(values)?.route_kind === "purchase";
    const isManaged = (values) => isPurchase(values) && values.purchase_mode === "inventory_managed";
    const isNewItem = (values) => isManaged(values) && values.item_source === "new";
    const purchaseGroups = this.settings.purchaseGroupOrder.split(/\n/).map((item) => item.trim()).filter(Boolean);
    new FormModal(this.app, {
      title: options.purchaseOnly ? "新增采购" : "新增事项",
      description: options.purchaseOnly ? "默认纳入库存；也可明确选择仅建立购物提醒。" : "自定义分类决定 Apple 清单；采购是否进入库存必须在本次明确选择。",
      fields: [
        { id: "category_id", label: "分类", type: "select", value: categories[0].id, options: categories.map((item) => ({ value: item.id, label: item.name })) },
        { id: "purchase_mode", label: "采购处理", type: "select", value: options.purchaseOnly ? "inventory_managed" : "reminder_only", options: [{ value: "inventory_managed", label: "纳入库存" }, { value: "reminder_only", label: "仅购物提醒" }], visibleWhen: isPurchase },
        { id: "item_source", label: "物品来源", type: "select", value: items.length ? "existing" : "new", options: [{ value: "existing", label: "选择现有物品" }, { value: "new", label: "新建物品" }], visibleWhen: isManaged },
        { id: "item_entity_id", label: "现有物品", type: "select", value: items[0]?.id || "", options: items.map((item) => ({ value: item.id, label: `${item.name} · ${item.canonical_unit || item.unit || "未设单位"}` })), visibleWhen: (values) => isManaged(values) && values.item_source === "existing" },
        { id: "new_item_name", label: "新物品名称", visibleWhen: isNewItem },
        { id: "canonical_unit", label: "标准单位", placeholder: "例如：个、盒、卷、克", visibleWhen: isNewItem },
        { id: "purchase_group", label: "采购分区", type: "select", value: purchaseGroups[0] || "未分类", options: [...new Set([...purchaseGroups, "未分类"])].map((value) => ({ value, label: value })), visibleWhen: isNewItem },
        { id: "tracking_policy", label: "库存策略", type: "select", value: "estimated", options: [{ value: "exact_unit", label: "精确单位" }, { value: "estimated", label: "估算数量" }, { value: "manual_depletion", label: "手动耗尽" }], visibleWhen: isNewItem },
        { id: "quantity", label: "采购数量", type: "number", value: "1", visibleWhen: isManaged },
        { id: "unit", label: "采购单位", placeholder: "应与标准单位或已登记包装单位一致", visibleWhen: isManaged },
        { id: "title", label: "事项标题", placeholder: "纳入库存采购可留空并自动使用物品名称" },
        { id: "notes", label: "说明", type: "textarea" },
        { id: "due_date", label: "截止日期", type: "date", value: today },
        { id: "priority", label: "优先级", type: "select", value: "0", options: [{ value: "0", label: "普通" }, { value: "1", label: "高" }, { value: "9", label: "低" }] },
      ],
      onSubmit: (values) => {
        const category = categoryFor(values);
        if (!category) throw new Error("请选择有效分类");
        const dueAt = values.due_date ? `${values.due_date}T${this.settings.defaultPurchaseTime}:00` : null;
        if (category.route_kind !== "purchase") {
          return this.runCommand("task.create", {
            title: values.title,
            notes: values.notes,
            category: category.route_kind,
            category_id: category.id,
            due_at: dueAt,
            priority: values.priority,
            source_type: "manual",
          }, "新增事项");
        }
        const selectedItem = items.find((item) => item.id === values.item_entity_id);
        const unit = values.unit || selectedItem?.canonical_unit || selectedItem?.unit || values.canonical_unit;
        return this.runCommand("purchase.create-manual", {
          category_id: category.id,
          purchase_mode: values.purchase_mode,
          title: values.title,
          item_name: values.title,
          item_entity_id: values.purchase_mode === "inventory_managed" && values.item_source === "existing" ? values.item_entity_id : null,
          new_item: values.purchase_mode === "inventory_managed" && values.item_source === "new" ? {
            name: values.new_item_name,
            canonical_unit: values.canonical_unit || values.unit,
            purchase_group: values.purchase_group,
            tracking_policy: values.tracking_policy,
          } : null,
          quantity: values.quantity,
          unit,
          notes: values.notes,
          due_at: dueAt,
          priority: values.priority,
        }, "新增采购事项");
      },
    }).open();
  }

  async manageTaskCategories() {
    const model = await this.loadModel();
    const categories = model.dashboard.all_task_categories;
    if (categories.some((item) => item.virtual)) return new Notice("请先运行 1.3.0 分类迁移，再管理分类");
    const reorder = (category, direction) => {
      const ordered = [...categories].sort((a, b) => Number(a.sort_order || 0) - Number(b.sort_order || 0));
      const index = ordered.findIndex((item) => item.id === category.id);
      const target = index + direction;
      if (index < 0 || target < 0 || target >= ordered.length) return;
      [ordered[index], ordered[target]] = [ordered[target], ordered[index]];
      return this.runCommand("task-category.reorder", {
        items: ordered.map((item, sortOrder) => ({ id: item.id, sort_order: sortOrder, expected_revision: item.revision })),
      }, "调整分类顺序");
    };
    new TaskCategoryManagerModal(this.app, categories, {
      add: () => this.editTaskCategory(),
      edit: (category) => this.editTaskCategory(category),
      setDefault: (category) => this.runCommand("task-category.set-default", { id: category.id, expected_revision: category.revision }, "设置默认分类"),
      archive: (category) => this.runCommand("task-category.archive", { id: category.id, expected_revision: category.revision }, "停用分类"),
      restore: (category) => this.runCommand("task-category.restore", { id: category.id, expected_revision: category.revision }, "恢复分类"),
      moveUp: (category) => reorder(category, -1),
      moveDown: (category) => reorder(category, 1),
    }).open();
  }

  editTaskCategory(category = null) {
    const routeOptions = [{ value: "purchase", label: "家庭采购" }, { value: "meal_handling", label: "食材处理" }, { value: "household", label: "家庭事务" }];
    new FormModal(this.app, {
      title: category ? "编辑事务分类" : "新增事务分类",
      description: category ? "分类被事务使用后不能更改 Apple 路由；名称和顺序仍可调整。" : "名称完全自定义；Apple 路由决定投影清单和完成后果。",
      fields: [
        { id: "name", label: "分类名称", value: category?.name || "" },
        { id: "route_kind", label: "Apple 路由", type: "select", value: category?.route_kind || "household", options: routeOptions },
        { id: "sort_order", label: "排序", type: "number", value: String(category?.sort_order ?? 0) },
      ],
      onSubmit: (values) => category
        ? this.runCommand("task-category.update", { id: category.id, expected_revision: category.revision, patch: { name: values.name, route_kind: values.route_kind, sort_order: Number(values.sort_order) } }, "更新分类")
        : this.runCommand("task-category.create", { name: values.name, route_kind: values.route_kind, sort_order: Number(values.sort_order) }, "新增分类"),
    }).open();
  }

  addFinanceTransaction() {
    const today = new Date().toISOString().slice(0, 10);
    new FormModal(this.app, {
      title: "新增财务流水",
      description: "与快捷指令共用交易 UUID 和幂等规则，不连接银行。",
      fields: [
        { id: "date", label: "日期", type: "date", value: today },
        { id: "time", label: "时间", value: "" },
        { id: "direction", label: "方向", type: "select", value: "支出", options: [{ value: "支出", label: "支出" }, { value: "收入", label: "收入" }, { value: "转账", label: "转账" }] },
        { id: "amount", label: "金额", type: "number" },
        { id: "account_id", label: "账户 ID" },
        { id: "from_account_id", label: "转出账户 ID" },
        { id: "to_account_id", label: "转入账户 ID" },
        { id: "category", label: "类目" },
        { id: "name", label: "名称" },
        { id: "merchant", label: "商户" },
        { id: "status", label: "状态", type: "select", value: "confirmed", options: [{ value: "confirmed", label: "已确认" }, { value: "pending", label: "待确认" }] },
      ],
      onSubmit: (values) => this.runCommand("finance.transaction.capture", { ...values, transaction_id: crypto.randomUUID(), source: "dashboard" }, "新增财务流水"),
    }).open();
  }

  addAsset() {
    new FormModal(this.app, {
      title: "新增家庭资产",
      fields: [
        { id: "name", label: "名称" },
        { id: "asset_type", label: "类型", type: "select", value: "appliance", options: [{ value: "property", label: "房屋" }, { value: "vehicle", label: "车辆" }, { value: "appliance", label: "家电" }, { value: "valuable", label: "贵重物品" }] },
        { id: "location", label: "位置" },
        { id: "responsible_member_id", label: "负责人 UUID" },
        { id: "acquired_on", label: "取得日期", type: "date" },
        { id: "identifier_hint", label: "标识提示（不要填完整敏感号码）" },
      ],
      onSubmit: (values) => this.runCommand("record.create", { record_type: "asset", record: { ...values, status: "active", condition: "normal" } }, "新增家庭资产"),
    }).open();
  }

  async addMaintenancePlan() {
    const model = await this.loadBaseModel();
    const assets = active(model.state.asset);
    if (!assets.length) return new Notice("请先新增资产");
    new FormModal(this.app, {
      title: "新增维护计划",
      fields: [
        { id: "asset_id", label: "资产", type: "select", value: assets[0].id, options: assets.map((item) => ({ value: item.id, label: item.name })) },
        { id: "name", label: "计划名称" },
        { id: "kind", label: "类型", type: "select", value: "maintenance", options: [{ value: "maintenance", label: "保养" }, { value: "inspection", label: "检查" }, { value: "insurance", label: "保险" }, { value: "warranty", label: "保修" }, { value: "repair", label: "维修" }] },
        { id: "next_due_date", label: "下次日期", type: "date" },
        { id: "lead_days", label: "提前天数", type: "number", value: "7" },
      ],
      onSubmit: (values) => this.runCommand("record.create", { record_type: "maintenance_plan", record: { ...values, lead_days: Number(values.lead_days || 0), status: "active" } }, "新增维护计划"),
    }).open();
  }

  async createMealPlan() {
    const model = await this.loadModel();
    const participantIds = active(model.state.member).map((item) => item.id);
    const today = new Date().toISOString().slice(0, 10);
    new FormModal(this.app, {
      title: "建立空白菜单草稿",
      description: "建立独立 Markdown 菜单草稿；激活确认前不会生成运行采购或 Apple 事务。",
      fields: [
        { id: "range_start", label: "开始日期", type: "date", value: today },
        { id: "range_end", label: "结束日期", type: "date", value: addDateDays(today, 6) },
        { id: "title", label: "菜单标题" },
        { id: "guest_count", label: "访客人数", type: "number", value: "0" },
        { id: "handling_text", label: "食材处理说明（每行：阶段｜内容）", type: "textarea" },
        { id: "handling_actions_text", label: "处理提醒（每行：日期 时间｜标题）", type: "textarea" },
      ],
      onSubmit: (values) => this.runCommand("meal-plan.create", { plan: {
        range_start: values.range_start,
        range_end: values.range_end,
        title: values.title,
        status: "draft",
        participant_ids: participantIds,
        guest_count: Number(values.guest_count || 0),
        default_serving_count: Math.max(1, participantIds.length + Number(values.guest_count || 0)),
        handling_instructions: parseHandlingInstructionsText(values.handling_text),
        handling_actions: parseHandlingActionsText(values.handling_actions_text),
      } }, "建立空白菜单草稿"),
    }).open();
  }

  async generateMealPlan() {
    const model = await this.loadModel();
    const members = active(model.state.member);
    const recipes = active(model.state.recipe);
    if (!members.length) return new Notice("请先新增家庭成员");
    if (!recipes.length) return new Notice("请先新增菜谱");
    const start = new Date().toISOString().slice(0, 10);
    const end = addDateDays(start, 6);
    const fields = [
      { id: "range_start", label: "开始日期", type: "date", value: start },
      { id: "range_end", label: "结束日期", type: "date", value: end },
      { id: "title", label: "菜单标题", placeholder: "留空则按日期自动命名" },
      ...members.map((member, index) => ({ id: `member_${index}`, label: `参与成员：${member.name}`, type: "checkbox", value: true, description: "用于本人已确认的过敏、硬忌口和偏好校验。" })),
      { id: "guest_count", label: "访客人数", type: "number", value: "0" },
      { id: "meal_breakfast", label: "生成早餐", type: "checkbox", value: false },
      { id: "meal_lunch", label: "生成午餐", type: "checkbox", value: true },
      { id: "meal_dinner", label: "生成晚餐", type: "checkbox", value: true },
      { id: "meal_snack", label: "生成加餐", type: "checkbox", value: false },
      { id: "generation_strategy", label: "生成策略", type: "select", value: "balanced", options: [
        { value: "balanced", label: "均衡省心" },
        { value: "inventory_first", label: "库存优先" },
        { value: "time_first", label: "省时优先" },
      ] },
      { id: "avoid_repeat_days", label: "避免重复天数", type: "number", value: "7" },
      { id: "max_prep_minutes", label: "最大制作时间（可留空）", type: "number", value: "" },
      { id: "excluded_recipes", label: "排除菜谱（名称或 UUID）", type: "textarea", placeholder: "多个菜谱用逗号分隔" },
      { id: "excluded_tags", label: "排除标签", type: "textarea", placeholder: "多个标签用逗号分隔" },
      { id: "daily_meal_overrides", label: "逐日餐次覆盖", type: "textarea", placeholder: "每行：2026-09-01｜早餐,晚餐\n餐次留空表示当天不生成" },
      { id: "serving_overrides", label: "单餐人数覆盖", type: "textarea", placeholder: "每行：2026-09-01｜晚餐｜5" },
    ];
    new FormModal(this.app, {
      title: "一键自动生成菜单草稿",
      description: "只使用现有菜谱；生成结果先保存为 Markdown 草稿，确认激活前不会创建采购、Apple 事务或库存变化。超过 31 天会分段准备并在最终写入前统一确认。",
      fields,
      submitLabel: "生成并预览草稿",
      onSubmit: async (values) => {
        const dates = dateRangeInclusive(values.range_start, values.range_end);
        const participantIds = members.filter((_, index) => values[`member_${index}`]).map((item) => item.id);
        if (!participantIds.length) throw new Error("请至少选择一名家庭成员");
        const guestCount = Number(values.guest_count || 0);
        if (!Number.isInteger(guestCount) || guestCount < 0) throw new Error("访客人数必须是非负整数");
        const mealTypes = [
          values.meal_breakfast ? "早餐" : null,
          values.meal_lunch ? "午餐" : null,
          values.meal_dinner ? "晚餐" : null,
          values.meal_snack ? "加餐" : null,
        ].filter(Boolean);
        if (!mealTypes.length) throw new Error("请至少选择一个餐次");
        const requestedRecipes = splitMenuValues(values.excluded_recipes);
        const excludedRecipeIds = requestedRecipes.map((requested) => {
          const matched = recipes.find((recipe) => recipe.id === requested || recipe.name === requested);
          if (!matched) throw new Error(`找不到要排除的菜谱：${requested}`);
          return matched.id;
        });
        const payload = {
          range_start: values.range_start,
          range_end: values.range_end,
          title: values.title,
          participant_ids: participantIds,
          guest_count: guestCount,
          default_serving_count: participantIds.length + guestCount,
          meal_types: mealTypes,
          generation_strategy: values.generation_strategy,
          avoid_repeat_days: Number(values.avoid_repeat_days || 0),
          max_prep_minutes: values.max_prep_minutes === "" ? null : Number(values.max_prep_minutes),
          excluded_recipe_ids: excludedRecipeIds,
          excluded_tags: splitMenuValues(values.excluded_tags),
          daily_meal_overrides: parseDailyMealOverrides(values.daily_meal_overrides),
          serving_overrides: parseServingOverrides(values.serving_overrides),
        };
        if (dates.length > 31) {
          new Notice(`正在分段准备 ${dates.length} 天菜单；完成后仍需确认 EffectSet 才会写入草稿。`);
          const batchCount = Math.ceil(dates.length / 7);
          for (let index = 0; index < dates.length; index += 7) {
            new Notice(`菜单准备进度：${Math.min(index + 7, dates.length)}/${dates.length} 天（${Math.floor(index / 7) + 1}/${batchCount} 批）`);
            await new Promise((resolve) => setTimeout(resolve, 0));
          }
        }
        const operation = await this.runCommand("meal-plan.generate-draft", payload, "生成菜单草稿");
        if (operation?.command?.payload) this.menuPlanId = operation.command.payload.id || null;
        return operation;
      },
    }).open();
  }

  async editMealPlan(id) {
    const model = await this.loadModel();
    const plan = active(model.state.meal_plan).find((item) => item.id === id);
    if (!plan) return new Notice("找不到菜单计划");
    new FormModal(this.app, {
      title: "编辑菜单说明",
      description: "保存后仍通过 EffectSet 与 revision 回读；餐次和菜品在菜单页逐项维护。",
      fields: [
        { id: "title", label: "菜单标题", value: plan.title || "" },
        { id: "handling_text", label: "食材处理说明（每行：阶段｜内容）", type: "textarea", value: handlingInstructionsText(plan.handling_instructions) },
        { id: "handling_actions_text", label: "处理提醒（每行：日期 时间｜标题）", type: "textarea", value: handlingActionsText(plan.handling_actions) },
      ],
      onSubmit: (values) => this.runCommand("meal-plan.update", {
        id: plan.id,
        expected_revision: plan.revision,
        patch: {
          title: values.title,
          handling_instructions: parseHandlingInstructionsText(values.handling_text, plan.handling_instructions),
          handling_actions: parseHandlingActionsText(values.handling_actions_text, plan.handling_actions),
        },
      }, "编辑菜单说明"),
    }).open();
  }

  async settleMealPlan(id) {
    const model = await this.loadModel();
    const plan = active(model.state.meal_plan).find((item) => item.id === id);
    if (!plan) return new Notice("找不到菜单计划");
    const today = new Date().toISOString().slice(0, 10);
    const slots = active(model.state.meal_slot)
      .filter((item) => item.source_plan_id === plan.id && !["completed", "skipped"].includes(item.status))
      .sort((left, right) => String(left.planned_date).localeCompare(String(right.planned_date)) || String(left.meal_label).localeCompare(String(right.meal_label)));
    if (!slots.length) return new Notice("所选菜单餐次已经全部结算");
    new FormModal(this.app, {
      title: "结算菜单",
      description: "逐餐确认现实结果；过去和今天的餐次默认完成，未来餐次默认暂不处理。",
      fields: slots.map((slot, index) => ({
        id: `outcome_${index}`,
        label: `${slot.planned_date} · ${slot.meal_label}`,
        type: "select",
        value: slot.planned_date <= today ? "completed" : "leave",
        options: [{ value: "completed", label: "已完成并扣库存" }, { value: "skipped", label: "已跳过" }, { value: "leave", label: "暂不处理" }],
      })),
      submitLabel: "预览菜单结算",
      onSubmit: (values) => {
        const outcomes = slots.map((slot, index) => ({
          meal_slot_id: slot.id,
          expected_revision: slot.revision,
          outcome: values[`outcome_${index}`],
        })).filter((item) => item.outcome !== "leave");
        if (!outcomes.length) throw new Error("请至少选择一个需要结算的餐次");
        return this.runCommand("meal-plan.settle", { id: plan.id, expected_revision: plan.revision, outcomes }, "结算菜单");
      },
    }).open();
  }

  async addConstraint() {
    const model = await this.loadModel();
    const members = active(model.state.member);
    if (!members.length) return new Notice("请先新增家庭成员");
    new FormModal(this.app, {
      title: "新增已确认饮食约束",
      description: "只记录本人或有权成员明确确认的过敏、忌口与偏好，不提供诊断或营养处方。",
      fields: [
        { id: "member_id", label: "成员", type: "select", value: members[0].id, options: members.map((item) => ({ value: item.id, label: item.name })) },
        { id: "constraint_kind", label: "类型", type: "select", value: "allergy", options: [{ value: "allergy", label: "过敏／硬忌口" }, { value: "preference", label: "偏好" }] },
        { id: "target", label: "作用对象", placeholder: "例如：坚果、辣" },
        { id: "effect_level", label: "效力", type: "select", value: "hard_constraint", options: [{ value: "hard_constraint", label: "硬约束" }, { value: "soft_preference", label: "软偏好" }] },
      ],
      onSubmit: (values) => this.runCommand("add-health-constraint", values, "新增饮食约束"),
    }).open();
  }

  recipeInventoryItems(model) {
    return active(model.state.entity).filter((item) => ["ingredient_item", "inventory_item"].includes(item.entity_kind));
  }

  async addRecipe() {
    const model = await this.loadModel();
    new RecipeFormModal(this.app, {
      inventoryItems: this.recipeInventoryItems(model),
      onSubmit: (values) => this.runCommand("add-recipe", values, "新增菜谱"),
    }).open();
  }

  async viewRecipe(recipeId, options = {}) {
    const model = await this.loadModel();
    const recipe = active(model.state.recipe).find((item) => item.id === recipeId);
    if (!recipe) return new Notice("菜谱不可用：可能已归档、删除或刚被其他修改更新");
    new RecipeDetailsModal(this.app, recipe, {
      onEdit: options.readOnly ? null : (id) => this.editRecipe(id),
      allowEdit: !options.readOnly,
      context: options.context || null,
    }).open();
  }

  async editRecipe(recipeId) {
    const model = await this.loadModel();
    const recipe = active(model.state.recipe).find((item) => item.id === recipeId);
    if (!recipe) return new Notice("找不到菜谱，可能已被其他修改更新");
    new RecipeFormModal(this.app, {
      recipe,
      inventoryItems: this.recipeInventoryItems(model),
      onSubmit: (patch) => this.runCommand("recipe.update", {
        id: recipe.id,
        expected_revision: recipe.revision,
        patch,
      }, "编辑菜谱"),
    }).open();
  }

  async scheduleDish() {
    const model = await this.loadModel();
    const recipes = active(model.state.recipe);
    if (!recipes.length) return new Notice("请先新增菜谱");
    const plans = active(model.state.meal_plan).filter((item) => ["draft", "active"].includes(item.status));
    if (!plans.length) return new Notice("请先建立菜单草稿");
    const preferredPlan = plans.find((item) => item.status === "active") || plans[0];
    const today = new Date().toISOString().slice(0, 10);
    const preferredRange = mealPlanRange(preferredPlan);
    const defaultDate = today >= preferredRange.start && today <= preferredRange.end ? today : preferredRange.start;
    new FormModal(this.app, {
      title: "安排菜品到确定餐次",
      fields: [
        { id: "meal_plan_id", label: "菜单", type: "select", value: preferredPlan.id, options: plans.map((item) => { const range = mealPlanRange(item); return { value: item.id, label: `${item.title || `${range.start} 至 ${range.end}`} · ${item.status}` }; }) },
        { id: "recipe_id", label: "菜谱", type: "select", value: recipes[0].id, options: recipes.map((item) => ({ value: item.id, label: item.name })) },
        { id: "planned_date", label: "计划日期", type: "date", value: defaultDate },
        { id: "meal_label", label: "餐次", type: "select", value: "晚餐", options: [{ value: "早餐", label: "早餐" }, { value: "午餐", label: "午餐" }, { value: "晚餐", label: "晚餐" }, { value: "加餐", label: "加餐" }] },
        { id: "serving_count", label: "人数", type: "number", value: String(preferredPlan.default_serving_count || active(model.state.member).length || 1) },
      ],
      onSubmit: (values) => this.runCommand("schedule-dish", values, "安排菜品"),
    }).open();
  }

  rescheduleDish(dishId) {
    const today = new Date().toISOString().slice(0, 10);
    new FormModal(this.app, {
      title: "确认现实并改期",
      description: "此操作包含两个不同效力的输入：确认确实未购买，以及决定改期到确定新餐次。",
      fields: [
        { id: "new_date", label: "新日期", type: "date", value: today },
        { id: "new_meal_label", label: "新餐次", type: "select", value: "晚餐", options: [{ value: "早餐", label: "早餐" }, { value: "午餐", label: "午餐" }, { value: "晚餐", label: "晚餐" }] },
      ],
      onSubmit: (values) => this.runCommand("confirm-missing-and-reschedule", { ...values, dish_plan_id: dishId, confirmed_missing: true }, "菜品改期"),
    }).open();
  }

  async replaceDish(dishId) {
    const model = await this.loadModel();
    const dish = active(model.state.dish_plan).find((item) => item.id === dishId);
    const slot = active(model.state.meal_slot).find((item) => item.id === dish?.meal_slot_id);
    const recipes = active(model.state.recipe).filter((item) => item.id !== dish?.recipe_id);
    if (!dish || !slot || !recipes.length) return new Notice("没有可用的替换菜谱");
    new FormModal(this.app, {
      title: "替换当前实例中的菜品",
      description: "只影响当前餐次，不会改变长期默认规则。",
      fields: [{ id: "recipe_id", label: "替换为", type: "select", value: recipes[0].id, options: recipes.map((item) => ({ value: item.id, label: item.name })) }],
      onSubmit: (values) => this.runCommand("replace-dish", { ...values, dish_plan_id: dish.id, planned_date: slot.planned_date, meal_label: slot.meal_label, meal_slot_id: slot.id }, "替换菜品"),
    }).open();
  }

  async confirmReceipt() {
    const model = await this.loadModel();
    const demands = active(model.state.purchase_demand).filter((item) => item.status !== "fulfilled");
    if (!demands.length) return new Notice("没有待确认实收的计划采购");
    new FormModal(this.app, {
      title: "确认实际买到的商品",
      description: "用于未通过 Apple 自动入库的采购；包装单位必须已登记换算关系。",
      fields: [
        { id: "purchase_demand_id", label: "计划采购", type: "select", value: demands[0].id, options: demands.map((item) => ({ value: item.id, label: `${item.ingredient_name} · ${item.quantity} ${item.unit}` })) },
        { id: "actual_name", label: "实际商品", value: demands[0].ingredient_name },
        { id: "quantity", label: "实际数量", type: "number", value: String(demands[0].quantity) },
        { id: "unit", label: "单位", value: demands[0].unit },
        { id: "tracking_policy", label: "跟踪策略", type: "select", value: "estimated", options: [{ value: "exact", label: "精确单位" }, { value: "estimated", label: "估计量" }, { value: "manual_depletion", label: "用完时人工确认" }] },
      ],
      onSubmit: (values) => this.runCommand("confirm-receipt", values, "确认实收"),
    }).open();
  }

  async confirmReceiptsBatch() {
    const model = await this.loadModel();
    const demands = active(model.state.purchase_demand).filter((item) => item.status !== "fulfilled");
    if (!demands.length) return new Notice("没有待批量实收的计划采购");
    const fields = [];
    demands.forEach((demand, index) => {
      fields.push({ id: `selected_${index}`, label: `选择：${demand.ingredient_name}`, type: "checkbox", value: true, description: `${demand.quantity} ${demand.unit} · ${demand.purchase_group || "按物品档案分区"}` });
      fields.push({ id: `quantity_${index}`, label: `${demand.ingredient_name} · 实收数量`, type: "number", value: String(demand.quantity) });
      fields.push({ id: `unit_${index}`, label: `${demand.ingredient_name} · 单位`, value: demand.unit });
    });
    new FormModal(this.app, {
      title: "批量确认采购实收",
      description: "勾选需要入库的项目并逐行修改数量或单位；提交前会整批校验单位换算。",
      fields,
      submitLabel: "预览批量入库",
      onSubmit: (values) => {
        const items = demands.map((demand, index) => values[`selected_${index}`] ? {
          purchase_demand_id: demand.id,
          actual_name: demand.ingredient_name,
          quantity: values[`quantity_${index}`],
          unit: values[`unit_${index}`],
          tracking_policy: "estimated",
        } : null).filter(Boolean);
        return this.runCommand("confirm-receipts-batch", { items }, "批量确认实收");
      },
    }).open();
  }

  async receiveInventory(preselectedItemId = null) {
    const model = await this.loadModel();
    const items = model.dashboard.inventory_items;
    const selected = items.find((item) => item.id === preselectedItemId) || items[0] || null;
    const purchaseGroups = this.settings.purchaseGroupOrder.split(/\n/).map((item) => item.trim()).filter(Boolean);
    const isNewItem = (values) => values.item_source === "new";
    new FormModal(this.app, {
      title: "新增入库",
      description: "记录已经进入家庭的库存，不补造采购计划、付款或 Apple 任务。",
      fields: [
        { id: "item_source", label: "物品来源", type: "select", value: selected ? "existing" : "new", options: [{ value: "existing", label: "选择现有物品" }, { value: "new", label: "新建物品" }] },
        { id: "item_entity_id", label: "现有物品", type: "select", value: selected?.id || "", options: items.map((item) => ({ value: item.id, label: `${item.name} · ${item.canonical_unit || item.unit || "未设单位"}` })), visibleWhen: (values) => values.item_source === "existing" },
        { id: "new_item_name", label: "新物品名称", visibleWhen: isNewItem },
        { id: "canonical_unit", label: "标准单位", placeholder: "例如：个、盒、卷、克", visibleWhen: isNewItem },
        { id: "purchase_group", label: "采购分区", type: "select", value: purchaseGroups[0] || "未分类", options: [...new Set([...purchaseGroups, "未分类"])].map((value) => ({ value, label: value })), visibleWhen: isNewItem },
        { id: "tracking_policy", label: "库存策略", type: "select", value: "estimated", options: [{ value: "exact_unit", label: "精确单位" }, { value: "estimated", label: "估算数量" }, { value: "manual_depletion", label: "手动耗尽" }], visibleWhen: isNewItem },
        { id: "quantity", label: "入库数量", type: "number", value: "1" },
        { id: "unit", label: "入库单位", value: selected?.canonical_unit || selected?.unit || "", placeholder: "现有标准单位或已登记包装单位" },
        { id: "intake_reason", label: "入库来源", type: "select", value: "manual_purchase", options: [{ value: "manual_purchase", label: "手动购买" }, { value: "gift", label: "赠送" }, { value: "opening_balance", label: "期初登记" }, { value: "other", label: "其他" }] },
        { id: "note", label: "备注", type: "textarea" },
      ],
      submitLabel: "预览入库",
      onSubmit: (values) => this.runCommand("inventory.receive-manual", {
        item_entity_id: values.item_source === "existing" ? values.item_entity_id : null,
        new_item: values.item_source === "new" ? {
          name: values.new_item_name,
          canonical_unit: values.canonical_unit || values.unit,
          purchase_group: values.purchase_group,
          tracking_policy: values.tracking_policy,
        } : null,
        quantity: values.quantity,
        unit: values.unit,
        intake_reason: values.intake_reason,
        note: values.note,
      }, "新增入库"),
    }).open();
  }

  async recordConsumption() {
    const model = await this.loadModel();
    const batches = active(model.state.inventory_batch).filter((item) => Number(item.available_quantity) > 0);
    if (!batches.length) return new Notice("没有可消耗的库存批次");
    new FormModal(this.app, {
      title: "手动扣减库存",
      description: "只修正库存数量，不代替“完成本餐”，也不会改变菜单状态。",
      fields: [
        { id: "inventory_batch_id", label: "库存批次", type: "select", value: batches[0].id, options: batches.map((item) => ({ value: item.id, label: `${item.ingredient_name} · ${item.available_quantity} ${item.unit}` })) },
        { id: "quantity", label: "消耗数量", type: "number", value: "1" },
      ],
      onSubmit: (values) => this.runCommand("record-consumption", values, "手动扣减库存"),
    }).open();
  }

  async calibrateInventory(preselectedBatchId = null) {
    const model = await this.loadModel();
    const batches = active(model.state.inventory_batch);
    if (!batches.length) return new Notice("没有库存批次");
    const selected = batches.find((item) => item.id === preselectedBatchId) || batches[0];
    new FormModal(this.app, {
      title: "编辑库存",
      description: "可修改数量和单位。使用瓶、壶、袋等包装单位时，同时填写每包装折合量和标准单位。",
      fields: [
        { id: "inventory_batch_id", label: "库存批次", type: "select", value: selected.id, options: batches.map((item) => ({ value: item.id, label: `${item.ingredient_name} · ${item.available_quantity} ${item.unit}` })) },
        { id: "available_quantity", label: "当前可用量", type: "number", value: String(selected.available_quantity) },
        { id: "unit", label: "当前单位", value: selected.display_unit || selected.unit },
        { id: "package_size", label: "每包装折合量（可选）", type: "number", value: "" },
        { id: "package_size_unit", label: "折合标准单位（可选）", placeholder: "例如：升" },
      ],
      onSubmit: (values) => this.runCommand("inventory.adjust", values, "编辑库存"),
    }).open();
  }

  async linkFinance(unplanned) {
    const model = await this.loadModel();
    const receipts = active(model.state.receipt);
    if (!unplanned && !receipts.length) return new Notice("没有可关联的已确认实收");
    new FormModal(this.app, {
      title: unplanned ? "记录计划外购买的财务关联" : "关联已确认财务交易",
      description: unplanned ? "计划外购买只形成财务关联，不会进入库存。" : "这里只关联已经存在且已确认的交易，不创建银行或支付事实。",
      fields: [
        ...(unplanned ? [] : [{ id: "receipt_id", label: "实收记录", type: "select", value: receipts[0].id, options: receipts.map((item) => ({ value: item.id, label: `${item.ingredient_name} · ${item.quantity} ${item.unit}` })) }]),
        { id: "transaction_id", label: "已确认交易 ID" },
        { id: "amount", label: "金额", type: "number" },
        { id: "currency", label: "币种", value: "CNY" },
      ],
      onSubmit: (values) => this.runCommand(unplanned ? "record-unplanned-purchase" : "link-finance", values, unplanned ? "记录计划外支出" : "关联财务"),
    }).open();
  }

  async recover(id, action) {
    try {
      const result = await this.service.recover(id, action);
      new Notice(`恢复操作完成：${result.status}`);
      await this.refreshAfterMutation();
    } catch (error) {
      new Notice(error.message);
    }
  }

  async validateAuthority() {
    try {
      const model = await this.loadBaseModel();
      const command = commandEnvelope("authority.validate", { household_id: model.household?.id || "" });
      const operation = await this.service.preview(command);
      new Notice(operation.validation.status === "valid" ? `Markdown 权威校验通过：${operation.validation.records} 条记录` : `Markdown 权威校验失败：${operation.validation.errors.length} 项`);
      await this.service.discardPreview(operation.operation_id);
      return operation.validation;
    } catch (error) {
      new Notice(error.message);
      throw error;
    }
  }

  async reviewAuthorityConflict(commandType) {
    try {
      const conflicts = (await this.storage.readDirectoryJson("conflicts"))
        .filter((item) => item.status === "open" && item.conflict_type === "markdown_authority_modified_externally");
      if (!conflicts.length) return new Notice("没有待处理的 Markdown 外部修改");
      const conflict = conflicts[0];
      const moduleKey = conflict.details?.module_key;
      const state = await this.storage.loadState();
      const command = commandEnvelope(commandType, { module_key: moduleKey, household_id: active(state.household)[0]?.id || "" });
      const operation = await this.service.preview(command);
      new ConfirmEffectsModal(this.app, operation, async () => {
        const result = await this.service.commit(operation.operation_id);
        await this.storage.resolveAuthorityConflicts(moduleKey, commandType === "authority.adopt-external" ? "adopted" : "restored");
        new Notice(`${MODULE_SPECS[moduleKey].title}处理完成：${result.status}`);
        await this.refreshAfterMutation();
      }).open();
      return operation;
    } catch (error) {
      new Notice(error.message);
      throw error;
    }
  }
}

module.exports = BetaGiftedFamilySystemPlugin;
module.exports.__test = {
  APPLE_LISTS,
  appleProjectionTask,
  DEFAULT_SETTINGS,
  DEFAULT_PAGES,
  MATERIAL_DEFAULTS,
  MODULES,
  VISUAL_DEFAULTS,
  VIEW_TYPE,
  buildFamilySystemViewModel,
  effectiveTheme,
  normalizeSettings,
  normalizeVisual,
  handlingActionsText,
  handlingInstructionsText,
  parseHandlingActionsText,
  parseHandlingInstructionsText,
  reducedMotion,
  renderDashboard,
  renderRecipeDetails,
  recipeIngredientDraftToRecord,
  recipeIngredientMode,
  recipeMeta,
  RecipeDetailsModal,
  RecipeFormModal,
  ...require("./core"),
  ...require("./importer"),
  CoreStorage,
  LifeCoreService,
};
