"use strict";

const assert = require("assert");
const Module = require("module");

const originalLoad = Module._load;
class StubItemView {}
class StubModal {}
class StubPlugin {}
class StubSettingTab {}
class StubSetting {}
Module._load = function(request, parent, isMain) {
  if (request === "obsidian") return { ItemView: StubItemView, Modal: StubModal, Notice: class {}, Plugin: StubPlugin, PluginSettingTab: StubSettingTab, Setting: StubSetting, setIcon() {} };
  return originalLoad.call(this, request, parent, isMain);
};
let PluginClass;
try { PluginClass = require("../main.js"); } finally { Module._load = originalLoad; }

const state = Object.fromEntries(PluginClass.__test.RECORD_TYPES.map((type) => [type, []]));
state.operations = [];
state.conflicts = [];
state.imports = [];
state.household = [{ id: "household", name: "测试家庭", status: "active" }];
let reads = 0;
const plugin = Object.create(PluginClass.prototype);
plugin.settings = PluginClass.__test.normalizeSettings({});
plugin.currentModule = "overview";
plugin.pages = { ...PluginClass.__test.DEFAULT_PAGES };
plugin.coreSection = "order";
plugin.stageIndex = 0;
plugin.materialOpen = false;
plugin.modelCache = null;
plugin.modelPromise = null;
plugin.modelLoadCount = 0;
plugin.app = { vault: { getAbstractFileByPath: (path) => path.endsWith("/manifest.json") ? { path } : null } };
plugin.storage = { path: (...parts) => ["家庭管理系统/00_系统核心/life-core", ...parts].join("/"), loadState: async () => { reads += 1; return state; } };

(async () => {
  await plugin.loadModel();
  plugin.currentModule = "diet";
  plugin.pages.diet = "recipes";
  await plugin.loadModel();
  plugin.currentModule = "purchase";
  await plugin.loadModel();
  assert.strictEqual(reads, 1, "module switches must reuse one Life Core snapshot");
  plugin.invalidateModel();
  await plugin.loadModel();
  assert.strictEqual(reads, 2, "explicit invalidation must reload once");

  let refreshes = 0;
  let projectionChecks = 0;
  plugin.storage = { rootPath: "家庭管理系统/00_系统核心/life-core", checkProjectionModification: async () => { projectionChecks += 1; } };
  plugin.refreshTimer = null;
  plugin.refreshViews = async () => { refreshes += 1; };
  plugin.onVaultChange({ path: "别的目录/record.json" });
  plugin.onVaultChange({ path: "家庭管理系统/00_系统核心/life-core/records/member/a.json" });
  plugin.onVaultChange({ path: "家庭管理系统/00_系统核心/life-core/records/member/b.json" });
  plugin.onVaultChange({ path: "家庭管理系统/00_系统核心/life-core/projections/overview.md" });
  await new Promise((resolve) => setTimeout(resolve, 260));
  assert.strictEqual(refreshes, 1, "bursty scoped changes must debounce to one refresh");
  assert.strictEqual(projectionChecks, 1, "last projection change must be checked once");
  plugin.currentModule = "overview";
  plugin.materialOpen = false;
  plugin.stageIndex = 0;
  plugin.settings.visual.motion = "full";
  plugin.refreshViews = async () => { refreshes += 1; };
  await plugin.rotateStage(1, true);
  assert.strictEqual(plugin.stageIndex, 1, "automatic stage rotation must advance across six modules");
  console.log(JSON.stringify({ status: "ok", suite: "cache", reads, refreshes, projectionChecks }));
})().catch((error) => { console.error(error); process.exit(1); });
