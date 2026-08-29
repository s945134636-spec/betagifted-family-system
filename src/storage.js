"use strict";

const {
  RECORD_TYPES,
  active,
  contentHash,
  deriveCurrentOrder,
  hashRecordType,
  joinVaultPath,
  normalizeVaultPath,
  normalizeVaultRoot,
  nowIso,
  projectionMarkdown,
  stableStringify,
  validateRecord,
} = require("./core");
const { buildImportPreview, scanMarkdownSources } = require("./importer");
const {
  DRAFT_RECORD_TYPES,
  MARKDOWN_RECORD_TYPES,
  MODULE_SPECS,
  STRUCTURED_RECORD_TYPES,
  authorityMapManifest,
  authorityModuleHash,
  authorityModuleKey,
  authorityModulePath,
  buildAuthorityIndex,
  createAuthorityModule,
  createMealPlanDraft,
  diffAuthorityModules,
  draftEffectFromRecordEffects,
  draftRootPath,
  mealPlanDraftPath,
  moduleEffectFromRecordEffects,
  parseAuthorityModule,
  parseMealPlanDraft,
  serializeAuthorityModule,
  serializeMealPlanDraft,
  validateAuthorityModule,
} = require("./authority");

const DIRECTORY_NAMES = Object.freeze({
  records: "records",
  events: "events",
  operations: "operations",
  decisions: "decisions",
  conflicts: "conflicts",
  projections: "projections",
  imports: "imports",
  backups: "backups",
  inboxPending: "inbox/pending",
  inboxProcessed: "inbox/processed",
  inboxRejected: "inbox/rejected",
  indexes: "indexes",
  leases: "leases",
});

const PORTABLE_BACKUP_SCHEMA = "family-system/backup-v1";

class CoreStorage {
  constructor(app, rootPath, clock, options) {
    this.app = app;
    this.rootPath = normalizeVaultPath(rootPath);
    this.authorityRoot = normalizeVaultRoot(options?.authorityRoot || this.rootPath.split("/").slice(0, -2).join("/") || "家庭管理系统");
    this.deviceId = String(options?.deviceId || "local-device");
    this.clock = clock;
    this.activeWrites = new Set();
    this.leaseTtlMs = Number(options?.leaseTtlMs || 60000);
  }

  setRoot(rootPath) {
    this.rootPath = normalizeVaultPath(rootPath);
  }

  setAuthorityRoot(authorityRoot) {
    this.authorityRoot = normalizeVaultRoot(authorityRoot);
  }

  path(...parts) {
    return [this.rootPath, ...parts.filter(Boolean)].join("/");
  }

  async ensureFolder(path) {
    const clean = normalizeVaultPath(path);
    const parts = clean.split("/");
    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      if (!this.app.vault.getAbstractFileByPath(current)) {
        try {
          await this.app.vault.createFolder(current);
        } catch (error) {
          if (!this.app.vault.getAbstractFileByPath(current)) throw error;
        }
      }
    }
  }

  async initialize() {
    await this.ensureFolder(this.rootPath);
    for (const directory of Object.values(DIRECTORY_NAMES)) await this.ensureFolder(this.path(directory));
    for (const type of STRUCTURED_RECORD_TYPES) await this.ensureFolder(this.path(DIRECTORY_NAMES.records, type));
    const manifestPath = this.path("manifest.json");
    let freshStore = false;
    if (!this.app.vault.getAbstractFileByPath(manifestPath)) {
      freshStore = true;
      await this.writeText(manifestPath, stableStringify({
        schema: "family-system/store-v4",
        schema_version: 4,
        created_at: nowIso(this.clock),
        authority: "family-system-hybrid-authority",
        authority_map: authorityMapManifest(this.authorityRoot),
        projection_policy: "hybrid-generated-summary",
      }));
    } else {
      const manifest = await this.readJson(manifestPath);
      if (manifest?.schema !== "family-system/store-v4" || Number(manifest?.schema_version) !== 4) {
        throw new Error("Family System 2.0 只接受 store-v4；请先在候选副本运行 2.0 迁移，禁止直接改写 store-v3");
      }
    }
    let createdModule = false;
    for (const key of Object.keys(MODULE_SPECS)) {
      const path = authorityModulePath(this.authorityRoot, key);
      if (!this.app.vault.getAbstractFileByPath(path)) {
        if (!freshStore) throw new Error(`store-v4 缺少权威模块，禁止静默建立空文件：${path}`);
        await this.writeText(path, serializeAuthorityModule(createAuthorityModule(key, [], { updated_at: nowIso(this.clock) })));
        createdModule = true;
      }
    }
    if (createdModule || !this.app.vault.getAbstractFileByPath(this.authorityIndexPath())) await this.rebuildAuthorityIndex();
  }

  async writeText(path, content) {
    const clean = normalizeVaultPath(path);
    await this.ensureFolder(clean.split("/").slice(0, -1).join("/"));
    this.activeWrites.add(clean);
    try {
      const file = this.app.vault.getAbstractFileByPath(clean);
      if (file) {
        if (typeof this.app.vault.process === "function") await this.app.vault.process(file, () => content);
        else await this.app.vault.modify(file, content);
      } else {
        await this.app.vault.create(clean, content);
      }
    } finally {
      this.activeWrites.delete(clean);
    }
  }

  async readText(path) {
    const file = this.app.vault.getAbstractFileByPath(normalizeVaultPath(path));
    if (!file) return null;
    return this.app.vault.read(file);
  }

  async readJson(path) {
    const content = await this.readText(path);
    if (content == null) return null;
    try {
      return JSON.parse(content);
    } catch (error) {
      throw new Error(`JSON 损坏：${path}`);
    }
  }

  async writeJson(path, value) {
    await this.writeText(path, `${stableStringify(value)}\n`);
  }

  async deleteText(path) {
    const clean = normalizeVaultPath(path);
    const file = this.app.vault.getAbstractFileByPath(clean);
    if (!file) return;
    this.activeWrites.add(clean);
    try {
      if (typeof this.app.fileManager?.trashFile === "function") await this.app.fileManager.trashFile(file);
      else if (typeof this.app.vault.trash === "function") await this.app.vault.trash(file, true);
      else throw new Error(`当前 Obsidian API 无法移除文件：${clean}`);
    } finally {
      this.activeWrites.delete(clean);
    }
  }

  async readAuthorityIndex() {
    return this.readJson(this.authorityIndexPath());
  }

  async saveAcceptedModule(moduleKey, module, content) {
    const serialized = content || serializeAuthorityModule(module);
    const hash = module.content_hash || authorityModuleHash(module);
    const snapshotPath = this.authoritySnapshotPath(moduleKey, hash);
    if (!this.app.vault.getAbstractFileByPath(snapshotPath)) await this.writeText(snapshotPath, serialized);
    const index = await this.readAuthorityIndex() || buildAuthorityIndex({}, this.authorityRoot, nowIso(this.clock));
    index.schema = "family-system/authority-index-v1";
    index.authority_root = this.authorityRoot;
    index.rebuilt_at = nowIso(this.clock);
    index.entries = index.entries || {};
    index.entries[moduleKey] = {
      path: this.modulePath(moduleKey),
      module_revision: Number(module.module_revision),
      content_hash: hash,
      record_ids: (module.records || []).map((record) => record.id).sort(),
      accepted_at: nowIso(this.clock),
      accepted_snapshot_path: snapshotPath,
    };
    await this.writeJson(this.authorityIndexPath(), index);
    return index.entries[moduleKey];
  }

  async rebuildAuthorityIndex() {
    const modules = {};
    for (const key of Object.keys(MODULE_SPECS)) {
      const content = await this.readText(this.modulePath(key));
      if (content == null) throw new Error(`缺少 Markdown 权威模块：${this.modulePath(key)}`);
      const module = parseAuthorityModule(content);
      modules[key] = module;
    }
    const index = buildAuthorityIndex(modules, this.authorityRoot, nowIso(this.clock));
    for (const [key, module] of Object.entries(modules)) {
      const content = await this.readText(this.modulePath(key));
      const snapshotPath = this.authoritySnapshotPath(key, module.content_hash);
      if (!this.app.vault.getAbstractFileByPath(snapshotPath)) await this.writeText(snapshotPath, content);
      index.entries[key].accepted_snapshot_path = snapshotPath;
    }
    index.drafts = {};
    for (const draft of await this.readMealPlanDrafts({ includeActivated: true, allowUnindexed: true })) {
      index.drafts[draft.draft_id] = {
        path: this.draftPath(draft.draft_id),
        draft_revision: draft.draft_revision,
        content_hash: draft.content_hash,
        status: draft.status,
        record_ids: draft.records.map((record) => record.id).sort(),
      };
    }
    await this.writeJson(this.authorityIndexPath(), index);
    return index;
  }

  async readAuthorityModule(moduleKey, options) {
    const path = this.modulePath(moduleKey);
    const content = await this.readText(path);
    if (content == null) throw new Error(`缺少 Markdown 权威模块：${path}`);
    const index = await this.readAuthorityIndex();
    const entry = index?.entries?.[moduleKey];
    try {
      const module = parseAuthorityModule(content, { check_hash: options?.candidate ? false : true });
      if (!options?.candidate && entry && module.content_hash !== entry.content_hash) throw new Error("当前文件不是最后一次正式提交版本");
      module.path = path;
      module.source_content = content;
      module.external_candidate = Boolean(entry && module.content_hash !== entry.content_hash);
      return module;
    } catch (error) {
      if (options?.candidate || !entry?.accepted_snapshot_path) throw error;
      const accepted = await this.readText(entry.accepted_snapshot_path);
      if (accepted == null) throw error;
      const module = parseAuthorityModule(accepted);
      module.path = path;
      module.source_content = accepted;
      module.external_candidate = true;
      module.candidate_error = error.message;
      return module;
    }
  }

  async readAuthorityModules() {
    const modules = {};
    for (const key of Object.keys(MODULE_SPECS)) modules[key] = await this.readAuthorityModule(key);
    return modules;
  }

  async writeAuthorityModule(module, expectedRevision, expectedHash) {
    const moduleKey = module.module_key;
    const currentContent = await this.readText(this.modulePath(moduleKey));
    if (currentContent == null) throw new Error(`缺少 Markdown 权威模块：${moduleKey}`);
    const current = parseAuthorityModule(currentContent);
    const index = await this.readAuthorityIndex();
    const acceptedHash = index?.entries?.[moduleKey]?.content_hash;
    if (acceptedHash && current.content_hash !== acceptedHash) throw new Error(`Markdown 权威存在外部修改：${moduleKey}`);
    if (Number(current.module_revision) !== Number(expectedRevision) || current.content_hash !== expectedHash) {
      const error = new Error(`Markdown 模块版本冲突：${moduleKey}`);
      error.code = "REVISION_CONFLICT";
      throw error;
    }
    const serialized = serializeAuthorityModule(module);
    await this.writeText(this.modulePath(moduleKey), serialized);
    const verified = parseAuthorityModule(await this.readText(this.modulePath(moduleKey)));
    if (verified.content_hash !== module.content_hash || Number(verified.module_revision) !== Number(module.module_revision)) throw new Error(`Markdown 模块写入核验失败：${moduleKey}`);
    await this.saveAcceptedModule(moduleKey, verified, serialized);
    return verified;
  }

  async restoreAuthorityModuleExact(moduleKey, module) {
    const serialized = serializeAuthorityModule(module);
    await this.writeText(this.modulePath(moduleKey), serialized);
    const verified = parseAuthorityModule(await this.readText(this.modulePath(moduleKey)));
    await this.saveAcceptedModule(moduleKey, verified, serialized);
    return verified;
  }

  async adoptAuthorityModule(module, expectedCandidateFileHash) {
    const path = this.modulePath(module.module_key);
    const candidateContent = await this.readText(path);
    if (contentHash(candidateContent || "") !== expectedCandidateFileHash) throw new Error(`外部候选在预演后再次变化：${module.module_key}`);
    parseAuthorityModule(candidateContent, { check_hash: false });
    const serialized = serializeAuthorityModule(module);
    await this.writeText(path, serialized);
    const verified = parseAuthorityModule(await this.readText(path));
    await this.saveAcceptedModule(module.module_key, verified, serialized);
    return verified;
  }

  recordPath(type, id) {
    if (!RECORD_TYPES.includes(type)) throw new Error(`未知记录类型：${type}`);
    return this.path(DIRECTORY_NAMES.records, type, `${id}.json`);
  }

  operationPath(id) {
    return this.path(DIRECTORY_NAMES.operations, `${id}.json`);
  }

  conflictPath(id) {
    return this.path(DIRECTORY_NAMES.conflicts, `${id}.json`);
  }

  importPath(id) {
    return this.path(DIRECTORY_NAMES.imports, `${id}.json`);
  }

  authorityIndexPath() {
    return this.path(DIRECTORY_NAMES.indexes, "markdown-authority.json");
  }

  leasePath() {
    return this.path(DIRECTORY_NAMES.leases, "writer.json");
  }

  authoritySnapshotPath(moduleKey, hash) {
    return this.path(DIRECTORY_NAMES.backups, "markdown-authority", moduleKey, `${hash}.md`);
  }

  modulePath(moduleKey) {
    return authorityModulePath(this.authorityRoot, moduleKey);
  }

  draftPath(draftId) {
    return mealPlanDraftPath(this.authorityRoot, draftId);
  }

  draftSnapshotPath(draftId, hash) {
    return this.path(DIRECTORY_NAMES.backups, "meal-plan-drafts", draftId, `${hash}.md`);
  }

  async saveAcceptedDraft(draft, content) {
    const serialized = content || serializeMealPlanDraft(draft);
    const snapshotPath = this.draftSnapshotPath(draft.draft_id, draft.content_hash);
    if (!this.app.vault.getAbstractFileByPath(snapshotPath)) await this.writeText(snapshotPath, serialized);
    const index = await this.readAuthorityIndex() || buildAuthorityIndex({}, this.authorityRoot, nowIso(this.clock));
    index.drafts = index.drafts || {};
    index.drafts[draft.draft_id] = {
      path: this.draftPath(draft.draft_id),
      draft_revision: Number(draft.draft_revision),
      content_hash: draft.content_hash,
      status: draft.status,
      record_ids: draft.records.map((record) => record.id).sort(),
      accepted_at: nowIso(this.clock),
      accepted_snapshot_path: snapshotPath,
    };
    await this.writeJson(this.authorityIndexPath(), index);
    return index.drafts[draft.draft_id];
  }

  async readMealPlanDraft(draftId, options) {
    const content = await this.readText(this.draftPath(draftId));
    if (content == null) return null;
    const draft = parseMealPlanDraft(content, { check_hash: options?.candidate ? false : true });
    draft.path = this.draftPath(draftId);
    draft.source_content = content;
    const entry = (await this.readAuthorityIndex())?.drafts?.[draftId];
    if (!options?.candidate && entry && entry.content_hash !== draft.content_hash) throw new Error(`菜单草稿存在待处理外部修改：${draftId}`);
    return draft;
  }

  async readMealPlanDrafts(options) {
    const prefix = `${draftRootPath(this.authorityRoot)}/`;
    const files = this.app.vault.getFiles().filter((file) => file.path.startsWith(prefix) && file.path.endsWith(".md"));
    const drafts = [];
    for (const file of files) {
      const content = await this.readText(file.path);
      const draft = parseMealPlanDraft(content);
      if (options?.allowUnindexed !== true) {
        const entry = (await this.readAuthorityIndex())?.drafts?.[draft.draft_id];
        if (entry && entry.content_hash !== draft.content_hash) throw new Error(`菜单草稿存在待处理外部修改：${draft.draft_id}`);
      }
      draft.path = file.path;
      draft.source_content = content;
      if (options?.includeActivated || draft.status === "draft") drafts.push(draft);
    }
    return drafts;
  }

  async writeMealPlanDraft(draft, expectedRevision, expectedHash) {
    const path = this.draftPath(draft.draft_id);
    const currentContent = await this.readText(path);
    const current = currentContent == null ? null : parseMealPlanDraft(currentContent);
    if (Number(current?.draft_revision || 0) !== Number(expectedRevision || 0) || (current && current.content_hash !== expectedHash)) {
      throw new Error(`菜单草稿版本冲突：${draft.draft_id}`);
    }
    const serialized = serializeMealPlanDraft(draft);
    await this.writeText(path, serialized);
    const verified = parseMealPlanDraft(await this.readText(path));
    await this.saveAcceptedDraft(verified, serialized);
    return verified;
  }

  inboxPath(status, id) {
    const directory = status === "processed" ? DIRECTORY_NAMES.inboxProcessed : status === "rejected" ? DIRECTORY_NAMES.inboxRejected : DIRECTORY_NAMES.inboxPending;
    return this.path(directory, `${id}.json`);
  }

  async readRecord(type, id) {
    if (MARKDOWN_RECORD_TYPES.includes(type)) {
      const moduleKey = authorityModuleKey(type);
      const module = await this.readAuthorityModule(moduleKey);
      return module.records.find((record) => record.record_type === type && record.id === id) || null;
    }
    return this.readJson(this.recordPath(type, id));
  }

  async readRecords(type) {
    if (MARKDOWN_RECORD_TYPES.includes(type)) {
      const module = await this.readAuthorityModule(authorityModuleKey(type));
      return module.records.filter((record) => record.record_type === type);
    }
    const prefix = `${this.path(DIRECTORY_NAMES.records, type)}/`;
    const files = this.app.vault.getFiles().filter((file) => file.path.startsWith(prefix) && file.path.endsWith(".json"));
    const records = [];
    for (const file of files) {
      const record = await this.readJson(file.path);
      if (record) records.push(record);
    }
    return records;
  }

  async readDirectoryJson(directory) {
    const prefix = `${this.path(directory)}/`;
    const files = this.app.vault.getFiles().filter((file) => file.path.startsWith(prefix) && file.path.endsWith(".json"));
    const records = [];
    for (const file of files) {
      const item = await this.readJson(file.path);
      if (item) records.push(item);
    }
    return records;
  }

  async pendingInboxCommands() {
    return (await this.readDirectoryJson(DIRECTORY_NAMES.inboxPending)).sort((left, right) => String(left.recorded_at || "").localeCompare(String(right.recorded_at || "")) || String(left.id || "").localeCompare(String(right.id || "")));
  }

  async settleInboxCommand(command, status, result) {
    const id = String(command.id || require("./core").uuidFromSeed(`inbox:${contentHash(command)}`));
    const receipt = {
      schema: "family-system/inbox-receipt-v1",
      command_id: id,
      status,
      operation_id: result?.operation_id || result?.id || null,
      error: result?.error || null,
      source_hash: contentHash(command),
      settled_at: nowIso(this.clock),
      command,
    };
    await this.writeJson(this.inboxPath(status, id), receipt);
    const pending = this.app.vault.getAbstractFileByPath(this.inboxPath("pending", id));
    if (pending) await this.deleteText(pending.path);
    return receipt;
  }

  portableBackupPath(createdAt) {
    const stamp = String(createdAt || nowIso(this.clock)).replace(/[:.]/g, "-");
    return this.path(DIRECTORY_NAMES.backups, "portable", `family-system-backup-${stamp}.json`);
  }

  async createPortableBackup() {
    const manifest = await this.readJson(this.path("manifest.json"));
    if (manifest?.schema !== "family-system/store-v4") throw new Error("只有有效的 store-v4 可以生成便携备份");
    const applying = (await this.readDirectoryJson(DIRECTORY_NAMES.operations)).filter((item) => item.status === "applying");
    if (applying.length) throw new Error(`存在尚未恢复的写入操作，暂不能备份：${applying.map((item) => item.operation_id).join("、")}`);
    const files = [];
    const addFile = async (scope, path, relativePath) => {
      const content = await this.readText(path);
      if (content == null) throw new Error(`备份源文件缺失：${path}`);
      files.push({ scope, relative_path: relativePath, sha256: contentHash(content), content });
    };
    for (const key of Object.keys(MODULE_SPECS)) await addFile("authority_module", this.modulePath(key), key);
    const draftRoot = `${draftRootPath(this.authorityRoot)}/`;
    const drafts = this.app.vault.getFiles().filter((file) => file.path.startsWith(draftRoot) && file.path.endsWith(".md"));
    for (const file of drafts) await addFile("authority_draft", file.path, file.path.slice(draftRoot.length));
    const dataPrefix = `${this.rootPath}/`;
    const excludedPrefixes = [
      `${this.path(DIRECTORY_NAMES.backups)}/`,
      `${this.path(DIRECTORY_NAMES.leases)}/`,
      `${this.path(DIRECTORY_NAMES.projections)}/`,
      `${this.path(DIRECTORY_NAMES.indexes)}/`,
      `${this.path(DIRECTORY_NAMES.records, "projection_status")}/`,
    ];
    const dataFiles = this.app.vault.getFiles().filter((file) => file.path.startsWith(dataPrefix)
      && !excludedPrefixes.some((prefix) => file.path.startsWith(prefix))
      && file.path !== this.path("manifest.json"));
    for (const file of dataFiles) await addFile("data", file.path, file.path.slice(dataPrefix.length));
    files.sort((left, right) => `${left.scope}:${left.relative_path}`.localeCompare(`${right.scope}:${right.relative_path}`));
    const createdAt = nowIso(this.clock);
    const bundle = {
      schema: PORTABLE_BACKUP_SCHEMA,
      created_at: createdAt,
      source: { data_root: this.rootPath, authority_root: this.authorityRoot, manifest },
      files,
      file_count: files.length,
      bundle_hash: contentHash(files.map(({ scope, relative_path, sha256 }) => ({ scope, relative_path, sha256 }))),
    };
    const path = this.portableBackupPath(createdAt);
    await this.writeJson(path, bundle);
    const verified = await this.verifyPortableBackup(path);
    return { ...verified, path };
  }

  async verifyPortableBackup(path) {
    const bundle = await this.readJson(path);
    if (bundle?.schema !== PORTABLE_BACKUP_SCHEMA || !Array.isArray(bundle.files)) throw new Error("不是有效的 Family System 便携备份");
    const seen = new Set();
    for (const file of bundle.files) {
      const key = `${file.scope}:${file.relative_path}`;
      if (seen.has(key)) throw new Error(`备份包含重复文件：${key}`);
      seen.add(key);
      if (!["authority_module", "authority_draft", "data"].includes(file.scope)) throw new Error(`备份文件范围无效：${file.scope}`);
      if (normalizeVaultPath(file.relative_path) !== file.relative_path || file.relative_path.includes("..")) throw new Error(`备份相对路径无效：${file.relative_path}`);
      if (contentHash(String(file.content || "")) !== file.sha256) throw new Error(`备份文件哈希不匹配：${key}`);
    }
    const expected = contentHash(bundle.files.map(({ scope, relative_path, sha256 }) => ({ scope, relative_path, sha256 })));
    if (expected !== bundle.bundle_hash) throw new Error("便携备份总哈希不匹配");
    return { status: "valid", schema: bundle.schema, created_at: bundle.created_at, file_count: bundle.files.length, bundle_hash: bundle.bundle_hash };
  }

  async restorePortableBackupCandidate(path, targetDataRoot, targetAuthorityRoot) {
    const verification = await this.verifyPortableBackup(path);
    const bundle = await this.readJson(path);
    const dataRoot = normalizeVaultPath(targetDataRoot);
    const authorityRoot = normalizeVaultRoot(targetAuthorityRoot);
    const dataPrefix = `${dataRoot}/`;
    const modulePaths = Object.keys(MODULE_SPECS).map((key) => authorityModulePath(authorityRoot, key));
    const targetHasFiles = this.app.vault.getFiles().some((file) => file.path.startsWith(dataPrefix) || modulePaths.includes(file.path) || file.path.startsWith(`${draftRootPath(authorityRoot)}/`));
    if (targetHasFiles) throw new Error("恢复候选目标必须为空");
    const candidate = new CoreStorage(this.app, dataRoot, this.clock, { authorityRoot, deviceId: this.deviceId });
    await candidate.ensureFolder(dataRoot);
    for (const file of bundle.files) {
      const targetPath = file.scope === "authority_module"
        ? authorityModulePath(authorityRoot, file.relative_path)
        : file.scope === "authority_draft"
          ? joinVaultPath(draftRootPath(authorityRoot), file.relative_path)
          : joinVaultPath(dataRoot, file.relative_path);
      await candidate.writeText(targetPath, file.content);
    }
    const sourceManifest = bundle.source?.manifest || {};
    await candidate.writeJson(candidate.path("manifest.json"), {
      ...sourceManifest,
      schema: "family-system/store-v4",
      schema_version: 4,
      authority_map: authorityMapManifest(authorityRoot),
      restored_at: nowIso(this.clock),
      restored_from_backup_hash: bundle.bundle_hash,
    });
    await candidate.rebuildAuthorityIndex();
    const state = await candidate.loadState();
    await candidate.writeProjection();
    const candidateValidation = await candidate.validateAuthority();
    if (candidateValidation.status !== "valid") throw new Error(`恢复候选完整性校验失败：${candidateValidation.errors.join("；")}`);
    const report = {
      schema: "family-system/backup-restore-report-v1",
      status: "candidate_ready",
      restored_at: nowIso(this.clock),
      backup_hash: bundle.bundle_hash,
      data_root: dataRoot,
      authority_root: authorityRoot,
      file_count: verification.file_count,
      validation: { status: candidateValidation.status, modules: candidateValidation.modules, definition_records: candidateValidation.records },
      record_counts: Object.fromEntries(RECORD_TYPES.map((type) => [type, (state[type] || []).length])),
    };
    await candidate.writeJson(candidate.path(DIRECTORY_NAMES.imports, `portable-restore-${bundle.bundle_hash.slice(0, 12)}.json`), report);
    return report;
  }

  async loadState() {
    const state = {};
    const modules = await this.readAuthorityModules();
    for (const type of MARKDOWN_RECORD_TYPES) {
      const module = modules[authorityModuleKey(type)];
      state[type] = module.records.filter((record) => record.record_type === type);
    }
    for (const type of STRUCTURED_RECORD_TYPES) state[type] = await this.readRecords(type);
    const drafts = await this.readMealPlanDrafts();
    for (const draft of drafts) {
      for (const record of draft.records) {
        if (!DRAFT_RECORD_TYPES.includes(record.record_type)) continue;
        state[record.record_type] = state[record.record_type] || [];
        if (!state[record.record_type].some((item) => item.id === record.id)) state[record.record_type].push(record);
      }
    }
    state.__authority_modules = modules;
    state.__meal_plan_drafts = Object.fromEntries(drafts.map((draft) => [draft.draft_id, draft]));
    state.operations = await this.readDirectoryJson(DIRECTORY_NAMES.operations);
    state.conflicts = await this.readDirectoryJson(DIRECTORY_NAMES.conflicts);
    state.imports = await this.readDirectoryJson(DIRECTORY_NAMES.imports);
    return state;
  }

  async writeRecord(record, expectedRevision) {
    if (MARKDOWN_RECORD_TYPES.includes(record.record_type)) throw new Error(`Markdown 权威记录必须通过模块 EffectSet 写入：${record.record_type}`);
    const errors = validateRecord(record);
    if (errors.length) throw new Error(`记录无效：${errors.join("；")}`);
    const current = await this.readRecord(record.record_type, record.id);
    const currentRevision = current ? current.revision : 0;
    if (Number(expectedRevision || 0) !== currentRevision) {
      const error = new Error(`版本冲突：${record.record_type}/${record.id} 预期 ${expectedRevision || 0}，实际 ${currentRevision}`);
      error.code = "REVISION_CONFLICT";
      throw error;
    }
    const next = { ...record, revision: currentRevision + 1, created_at: current?.created_at || record.created_at, updated_at: nowIso(this.clock) };
    await this.writeJson(this.recordPath(next.record_type, next.id), next);
    const verified = await this.readRecord(next.record_type, next.id);
    if (!verified || verified.revision !== next.revision || contentHash(verified) !== contentHash(next)) throw new Error(`写入核验失败：${next.record_type}/${next.id}`);
    return next;
  }

  async applyEffect(item) {
    if (["upsert_json_record", "upsert_record"].includes(item.kind)) return this.writeRecord(item.record, item.expected_revision);
    if (item.kind === "upsert_markdown_module" && item.note === "external_adoption") return this.adoptAuthorityModule(item.record, item.expected_candidate_file_hash);
    if (item.kind === "upsert_markdown_module") return this.writeAuthorityModule(item.record, item.expected_revision, item.expected_hash);
    if (item.kind === "restore_markdown_module") return this.restoreAuthorityModuleExact(item.module_key, item.record);
    if (["upsert_markdown_draft", "move_markdown_draft"].includes(item.kind)) return this.writeMealPlanDraft(item.record, item.expected_revision, item.expected_hash);
    throw new Error(`不支持的效果：${item.kind}`);
  }

  async compensateEffect(item, operationId) {
    if (item.kind === "upsert_markdown_module") return this.restoreAuthorityModuleExact(item.module_key, item.before);
    if (item.kind === "restore_markdown_module") return this.restoreAuthorityModuleExact(item.module_key, item.before);
    if (["upsert_markdown_draft", "move_markdown_draft"].includes(item.kind)) {
      if (!item.before) return this.deleteText(this.draftPath(item.draft_id));
      const current = await this.readMealPlanDraft(item.draft_id, { candidate: true });
      const restored = createMealPlanDraft(item.before.draft_id, item.before.records, {
        ...item.before,
        draft_revision: Number(current?.draft_revision || item.record.draft_revision),
        updated_at: nowIso(this.clock),
      });
      return this.writeMealPlanDraft(restored, current?.draft_revision || item.record.draft_revision, current?.content_hash || item.record.content_hash);
    }
    const current = await this.readRecord(item.record_type, item.record.id);
    if (!current) return null;
    const at = nowIso(this.clock);
    const restored = item.before
      ? { ...item.before, revision: current.revision, updated_at: at, compensated_by: operationId }
      : { ...current, revision: current.revision, tombstone: true, status: "compensated", updated_at: at, compensated_by: operationId };
    return this.writeRecord(restored, current.revision);
  }

  async verifyEffect(item) {
    if (["upsert_json_record", "upsert_record"].includes(item.kind)) {
      const current = await this.readRecord(item.record_type, item.record.id);
      return Boolean(current && Number(current.revision) === Number(item.expected_revision) + 1);
    }
    if (["upsert_markdown_module", "restore_markdown_module"].includes(item.kind)) {
      try {
        const current = await this.readAuthorityModule(item.module_key, { candidate: true });
        return current.content_hash === item.record.content_hash && Number(current.module_revision) === Number(item.record.module_revision);
      } catch (_) { return false; }
    }
    if (["upsert_markdown_draft", "move_markdown_draft"].includes(item.kind)) {
      try {
        const current = await this.readMealPlanDraft(item.draft_id, { candidate: true });
        return Boolean(current && current.content_hash === item.record.content_hash && Number(current.draft_revision) === Number(item.record.draft_revision));
      } catch (_) { return false; }
    }
    return false;
  }

  async prepareHybridEffects(operation, state) {
    if ((operation.effects || []).every((item) => item.kind !== "upsert_record")) return { ...operation, schema: "family-system/effect-set-v2" };
    const commandType = operation.command?.command_type;
    const activatingDraftId = commandType === "meal-plan.activate" ? operation.command.payload.id : null;
    const draftRecordEffects = [];
    const creatingDraftIds = new Set((operation.effects || [])
      .filter((item) => item.record_type === "meal_plan" && item.record?.status === "draft")
      .map((item) => item.record.id));
    for (const item of operation.effects || []) {
      if (!DRAFT_RECORD_TYPES.includes(item.record_type)) continue;
      const planId = item.record_type === "meal_plan" ? item.record.id : item.record.source_plan_id;
      const sourceDraft = state.__meal_plan_drafts?.[planId];
      if ((sourceDraft || creatingDraftIds.has(planId)) && planId !== activatingDraftId) draftRecordEffects.push(item);
    }
    const grouped = new Map();
    for (const item of operation.effects || []) {
      if (!MARKDOWN_RECORD_TYPES.includes(item.record_type)) continue;
      const key = authorityModuleKey(item.record_type);
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key).push(item);
    }
    const emitted = new Set();
    const effects = [];
    let draftEmitted = false;
    for (const item of operation.effects || []) {
      if (draftRecordEffects.includes(item)) {
        if (!draftEmitted) {
          const draftId = draftRecordEffects.find((effect) => effect.record_type === "meal_plan")?.record.id
            || draftRecordEffects[0]?.record.source_plan_id;
          effects.push(draftEffectFromRecordEffects(state.__meal_plan_drafts?.[draftId] || null, draftId, draftRecordEffects, { recorded_at: operation.command.recorded_at }));
          draftEmitted = true;
        }
        continue;
      }
      const key = MARKDOWN_RECORD_TYPES.includes(item.record_type) ? authorityModuleKey(item.record_type) : null;
      if (!key) {
        effects.push({ ...item, kind: "upsert_json_record" });
        continue;
      }
      if (emitted.has(key)) continue;
      emitted.add(key);
      effects.push(moduleEffectFromRecordEffects(state.__authority_modules[key], grouped.get(key), { recorded_at: operation.command.recorded_at }));
    }
    if (activatingDraftId) {
      const draft = state.__meal_plan_drafts?.[activatingDraftId];
      if (!draft) throw new Error(`找不到菜单草稿：${activatingDraftId}`);
      const existingIds = new Set(effects.filter((item) => item.kind === "upsert_json_record").map((item) => `${item.record_type}:${item.record.id}`));
      for (const record of draft.records) {
        const key = `${record.record_type}:${record.id}`;
        if (existingIds.has(key)) {
          const existing = effects.find((item) => `${item.record_type}:${item.record.id}` === key);
          existing.expected_revision = 0;
          existing.before = null;
          continue;
        }
        effects.unshift({
          effect_id: require("./core").createId("effect", `activate-snapshot:${operation.operation_id}:${key}`),
          kind: "upsert_json_record",
          record_type: record.record_type,
          record: { ...record, draft_source_revision: record.revision },
          before: null,
          expected_revision: 0,
          note: "freeze_markdown_draft",
        });
      }
      const activatedDraft = createMealPlanDraft(draft.draft_id, draft.records, {
        ...draft,
        status: "activated",
        activated_at: operation.command.occurred_at,
        draft_revision: draft.draft_revision + 1,
        updated_at: operation.command.recorded_at,
      });
      effects.push({
        effect_id: require("./core").createId("effect", `activate-draft:${operation.operation_id}:${draft.draft_id}`),
        kind: "move_markdown_draft",
        draft_id: draft.draft_id,
        record_type: "meal_plan_draft",
        record: activatedDraft,
        before: draft,
        expected_revision: draft.draft_revision,
        expected_hash: draft.content_hash,
        note: "mark_draft_activated",
      });
    }
    return { ...operation, schema: "family-system/effect-set-v2", effects };
  }

  async readOperation(id) {
    return this.readJson(this.operationPath(id));
  }

  async saveOperation(operation) {
    const next = { ...operation, updated_at: nowIso(this.clock) };
    await this.writeJson(this.operationPath(next.operation_id || next.id), next);
    return next;
  }

  async saveImportPreview(report) {
    await this.writeJson(this.importPath(report.id), report);
    return report;
  }

  async createConflict(input) {
    const at = nowIso(this.clock);
    const conflict = {
      schema: "family-system/conflict-v1",
      id: input.id,
      conflict_type: input.conflict_type,
      subject_id: input.subject_id || null,
      operation_id: input.operation_id || null,
      details: input.details || {},
      status: "open",
      created_at: at,
      updated_at: at,
    };
    await this.writeJson(this.conflictPath(conflict.id), conflict);
    return conflict;
  }

  async acquireWriterLease(operationId) {
    const now = new Date(nowIso(this.clock));
    const existing = await this.readJson(this.leasePath());
    if (existing && existing.status !== "released" && new Date(existing.expires_at).getTime() > now.getTime()) {
      throw new Error(`另一设备正在写入：${existing.device_id}`);
    }
    const applying = (await this.readDirectoryJson(DIRECTORY_NAMES.operations)).filter((item) => item.status === "applying" && item.operation_id !== operationId);
    if (applying.length) throw new Error(`存在尚未恢复的写入操作：${applying.map((item) => item.operation_id).join("、")}`);
    const token = require("./core").createId("lease", `${this.deviceId}:${operationId}:${now.toISOString()}`);
    const lease = {
      schema: "family-system/writer-lease-v1",
      token,
      device_id: this.deviceId,
      operation_id: operationId,
      acquired_at: now.toISOString(),
      heartbeat_at: now.toISOString(),
      expires_at: new Date(now.getTime() + this.leaseTtlMs).toISOString(),
    };
    await this.writeJson(this.leasePath(), lease);
    const verified = await this.readJson(this.leasePath());
    if (verified?.token !== token) throw new Error("未能取得跨设备写入租约");
    return lease;
  }

  async refreshWriterLease(lease) {
    const current = await this.readJson(this.leasePath());
    if (!current || current.token !== lease.token) throw new Error("跨设备写入租约已丢失");
    const now = new Date(nowIso(this.clock));
    const next = { ...current, heartbeat_at: now.toISOString(), expires_at: new Date(now.getTime() + this.leaseTtlMs).toISOString() };
    await this.writeJson(this.leasePath(), next);
    return next;
  }

  async releaseWriterLease(lease) {
    if (!lease) return;
    const current = await this.readJson(this.leasePath());
    if (!current || current.token !== lease.token) return;
    await this.writeJson(this.leasePath(), { ...current, released_at: nowIso(this.clock), expires_at: nowIso(this.clock), status: "released" });
  }

  async checkAuthorityModification(path) {
    const clean = normalizeVaultPath(path);
    if (this.activeWrites.has(clean)) return null;
    const moduleKey = Object.keys(MODULE_SPECS).find((key) => this.modulePath(key) === clean);
    if (!moduleKey) return null;
    const index = await this.readAuthorityIndex();
    const expected = index?.entries?.[moduleKey];
    if (!expected) return null;
    const content = await this.readText(clean);
    let candidate = null;
    let candidateError = null;
    try { candidate = parseAuthorityModule(content, { check_hash: false }); } catch (error) { candidateError = error.message; }
    if (candidate && candidate.content_hash === expected.content_hash && authorityModuleHash(candidate) === expected.content_hash) return null;
    const actualHash = contentHash(content || "");
    const id = require("./core").uuidFromSeed(`authority-conflict:${moduleKey}:${actualHash}`);
    const existing = await this.readJson(this.conflictPath(id));
    if (existing) return existing;
    return this.createConflict({
      id,
      conflict_type: "markdown_authority_modified_externally",
      subject_id: moduleKey,
      details: {
        module_key: moduleKey,
        path: clean,
        expected_hash: expected.content_hash,
        actual_file_hash: actualHash,
        candidate_hash: candidate ? authorityModuleHash(candidate) : null,
        error: candidateError,
        policy: "preview_adopt_or_restore",
      },
    });
  }

  async scanAuthorityModifications() {
    const found = [];
    for (const key of Object.keys(MODULE_SPECS)) {
      const conflict = await this.checkAuthorityModification(this.modulePath(key));
      if (conflict) found.push(conflict);
    }
    return found;
  }

  async assertAuthorityReadyForCommand(command) {
    await this.scanAuthorityModifications();
    const open = (await this.readDirectoryJson(DIRECTORY_NAMES.conflicts)).filter((item) => item.status === "open" && item.conflict_type === "markdown_authority_modified_externally");
    if (!open.length) return;
    const type = String(command.command_type || "");
    const dependencies = new Set();
    if (type === "initialize-household" || type === "add-member" || type.startsWith("basic.") || type.includes("constraint")) dependencies.add("basic");
    if (type.includes("recipe") || type.includes("meal") || type.includes("dish") || type === "schedule-dish") ["diet", "basic", "purchase", "task"].forEach((key) => dependencies.add(key));
    if (type.includes("purchase") || type.includes("inventory") || type.includes("receipt")) ["purchase", "task"].forEach((key) => dependencies.add(key));
    if (type.includes("finance") || type.includes("budget") || type.includes("recurring")) dependencies.add("finance");
    if (type.includes("task")) dependencies.add("task");
    if (type.includes("asset") || type.includes("maintenance") || type.includes("service")) dependencies.add("asset");
    if (type === "record.create" || type === "record.update" || type === "record.archive" || type === "record.restore") {
      const key = authorityModuleKey(command.payload?.record_type);
      if (key) dependencies.add(key);
    }
    const blocked = open.filter((item) => dependencies.has(item.details?.module_key));
    if (blocked.length) throw new Error(`依赖的 Markdown 权威存在待处理外部修改：${blocked.map((item) => MODULE_SPECS[item.details.module_key]?.title || item.details.module_key).join("、")}`);
  }

  async resolveAuthorityConflicts(moduleKey, resolution) {
    const conflicts = await this.readDirectoryJson(DIRECTORY_NAMES.conflicts);
    const resolved = [];
    for (const conflict of conflicts) {
      if (conflict.status !== "open" || conflict.conflict_type !== "markdown_authority_modified_externally" || conflict.details?.module_key !== moduleKey) continue;
      const next = { ...conflict, status: "resolved", resolution, resolved_at: nowIso(this.clock), updated_at: nowIso(this.clock) };
      await this.writeJson(this.conflictPath(next.id), next);
      resolved.push(next.id);
    }
    return resolved;
  }

  async planAuthorityAdoption(command) {
    const moduleKey = String(command.payload.module_key || "");
    if (!MODULE_SPECS[moduleKey]) throw new Error("请选择有效的 Markdown 权威模块");
    const accepted = await this.readAuthorityModule(moduleKey);
    const candidateContent = await this.readText(this.modulePath(moduleKey));
    const candidate = parseAuthorityModule(candidateContent, { check_hash: false });
    const validation = validateAuthorityModule(candidate, { check_hash: false });
    if (validation.length) throw new Error(validation.join("；"));
    const changes = diffAuthorityModules(accepted, candidate);
    if (!changes.length && candidate.body === accepted.body) throw new Error("没有可采纳的外部修改");
    const immutable = ["id", "record_type", "schema", "household_id", "created_at", "recorded_at"];
    const recordEffects = changes.map((change) => {
      if (change.before && immutable.some((field) => change.after?.[field] !== change.before?.[field])) throw new Error(`${change.record_type}/${change.id} 修改了不可变字段`);
      const after = change.action === "archive" ? change.after : { ...change.after, revision: change.before?.revision || 0, updated_at: command.recorded_at };
      return {
        effect_id: require("./core").createId("effect", `adopt:${command.id}:${change.id}`),
        kind: "upsert_record",
        record_type: change.record_type,
        record: after,
        before: change.before,
        expected_revision: change.before?.revision || 0,
        note: `external_${change.action}`,
      };
    });
    const moduleEffect = moduleEffectFromRecordEffects(accepted, recordEffects, { recorded_at: command.recorded_at });
    moduleEffect.record.body = candidate.body;
    moduleEffect.record.content_hash = authorityModuleHash(moduleEffect.record);
    moduleEffect.note = "external_adoption";
    moduleEffect.expected_candidate_file_hash = contentHash(candidateContent);
    return {
      schema: "family-system/effect-set-v2",
      id: command.id,
      operation_id: command.id,
      command,
      status: "prepared",
      effects: [moduleEffect],
      applied_effect_ids: [],
      invariants: [],
      warnings: [],
      summary: `采纳 ${MODULE_SPECS[moduleKey].title} 外部修改：${changes.length} 条记录变化`,
      authority_changes: changes.map(({ action, id, record_type }) => ({ action, id, record_type })),
      created_at: command.recorded_at,
    };
  }

  async planAuthorityRestore(command) {
    const moduleKey = String(command.payload.module_key || "");
    if (!MODULE_SPECS[moduleKey]) throw new Error("请选择有效的 Markdown 权威模块");
    const accepted = await this.readAuthorityModule(moduleKey);
    let candidate = null;
    try { candidate = await this.readAuthorityModule(moduleKey, { candidate: true }); } catch (_) {}
    return {
      schema: "family-system/effect-set-v2",
      id: command.id,
      operation_id: command.id,
      command,
      status: "prepared",
      effects: [{
        effect_id: require("./core").createId("effect", `restore:${command.id}:${moduleKey}`),
        kind: "restore_markdown_module",
        module_key: moduleKey,
        record_type: "authority_module",
        record: accepted,
        before: candidate || accepted,
        expected_revision: candidate?.module_revision || accepted.module_revision,
        expected_hash: candidate?.content_hash || null,
        note: "restore_last_accepted",
      }],
      applied_effect_ids: [],
      invariants: [],
      warnings: [],
      summary: `恢复 ${MODULE_SPECS[moduleKey].title} 的最后正式版本`,
      created_at: command.recorded_at,
    };
  }

  async validateAuthority() {
    await this.scanAuthorityModifications();
    const state = await this.loadState();
    const errors = [];
    const seen = new Map();
    for (const type of RECORD_TYPES) {
      for (const record of state[type] || []) {
        if (seen.has(record.id)) errors.push(`跨模块重复 ID：${record.id}`);
        seen.set(record.id, type);
      }
    }
    const openAuthorityConflicts = (state.conflicts || []).filter((item) => item.status === "open" && item.conflict_type === "markdown_authority_modified_externally");
    openAuthorityConflicts.forEach((item) => errors.push(`${MODULE_SPECS[item.details?.module_key]?.title || item.details?.module_key} 存在待处理外部修改${item.details?.error ? `：${item.details.error}` : ""}`));
    const entityIds = new Set((state.entity || []).filter((item) => !item.tombstone).map((item) => item.id));
    const memberIds = new Set((state.member || []).filter((item) => !item.tombstone).map((item) => item.id));
    const recipeIds = new Set((state.recipe || []).filter((item) => !item.tombstone).map((item) => item.id));
    const categoryIds = new Set((state.task_category || []).filter((item) => !item.tombstone).map((item) => item.id));
    const assetIds = new Set((state.asset || []).filter((item) => !item.tombstone).map((item) => item.id));
    const accountIds = new Set((state.finance_account || []).filter((item) => !item.tombstone).map((item) => item.id));
    for (const recipe of (state.recipe || []).filter((item) => !item.tombstone)) {
      for (const ingredient of recipe.ingredients || []) {
        if (ingredient.item_entity_id && !entityIds.has(ingredient.item_entity_id)) errors.push(`菜谱 ${recipe.name} 引用了不存在物品 ${ingredient.item_entity_id}`);
      }
    }
    for (const constraint of (state.health_constraint || []).filter((item) => !item.tombstone)) if (constraint.member_id && !memberIds.has(constraint.member_id)) errors.push(`饮食约束 ${constraint.id} 引用了不存在成员 ${constraint.member_id}`);
    for (const plan of (state.meal_plan || []).filter((item) => !item.tombstone)) for (const memberId of plan.participant_ids || []) if (!memberIds.has(memberId)) errors.push(`菜单 ${plan.id} 引用了不存在成员 ${memberId}`);
    for (const dish of (state.dish_plan || []).filter((item) => !item.tombstone)) if (!recipeIds.has(dish.recipe_id)) errors.push(`菜品实例 ${dish.id} 引用了不存在菜谱 ${dish.recipe_id}`);
    for (const task of (state.task || []).filter((item) => !item.tombstone)) if (task.category_id && !categoryIds.has(task.category_id)) errors.push(`事务 ${task.id} 引用了不存在分类 ${task.category_id}`);
    for (const plan of (state.maintenance_plan || []).filter((item) => !item.tombstone)) if (plan.asset_id && !assetIds.has(plan.asset_id)) errors.push(`维护计划 ${plan.id} 引用了不存在资产 ${plan.asset_id}`);
    for (const transaction of (state.finance_transaction || []).filter((item) => !item.tombstone)) if (transaction.account_id && !accountIds.has(transaction.account_id)) errors.push(`财务流水 ${transaction.id} 引用了不存在账户 ${transaction.account_id}`);
    return { status: errors.length ? "invalid" : "valid", errors, modules: Object.keys(MODULE_SPECS).length, records: MARKDOWN_RECORD_TYPES.reduce((sum, type) => sum + (state[type] || []).length, 0) };
  }

  async hashTypes(types) {
    const state = await this.loadState();
    const hashes = {};
    types.forEach((type) => { hashes[type] = hashRecordType(state, type); });
    return hashes;
  }

  async writeProjection() {
    const state = await this.loadState();
    const generatedAt = nowIso(this.clock);
    const derived = deriveCurrentOrder(state, generatedAt);
    const markdown = projectionMarkdown(state, derived, generatedAt);
    const projectionPath = this.path(DIRECTORY_NAMES.projections, "当前秩序.md");
    await this.writeText(projectionPath, markdown);
    const existing = active(state.projection_status).find((item) => item.projection_path === projectionPath);
    const record = {
      schema: "family-system/projection_status-v1",
      record_type: "projection_status",
      id: existing?.id || require("./core").uuidFromSeed(`projection:${projectionPath}`),
      household_id: active(state.household)[0]?.id || "",
      revision: existing?.revision || 0,
      created_at: existing?.created_at || generatedAt,
      updated_at: generatedAt,
      recorded_at: generatedAt,
      tombstone: false,
      projection_path: projectionPath,
      content_hash: contentHash(markdown),
      source_revision_hash: contentHash(RECORD_TYPES.map((type) => hashRecordType(state, type))),
      status: "current",
    };
    await this.writeRecord(record, existing?.revision || 0);
    return { path: projectionPath, hash: record.content_hash };
  }

  async checkProjectionModification(path) {
    const clean = normalizeVaultPath(path);
    if (this.activeWrites.has(clean) || !clean.startsWith(`${this.path(DIRECTORY_NAMES.projections)}/`) || !clean.endsWith(".md")) return null;
    const state = await this.loadState();
    const status = active(state.projection_status).find((item) => item.projection_path === clean);
    if (!status) return null;
    const content = await this.readText(clean);
    const actualHash = contentHash(content || "");
    if (actualHash === status.content_hash) return null;
    const id = require("./core").uuidFromSeed(`projection-conflict:${clean}:${actualHash}`);
    if (state.conflicts.some((item) => item.id === id)) return null;
    return this.createConflict({
      id,
      conflict_type: "projection_modified_externally",
      subject_id: status.id,
      details: { projection_path: clean, expected_hash: status.content_hash, actual_hash: actualHash, policy: "candidate_only" },
    });
  }

  async previewImport(roots, householdId) {
    void roots;
    void householdId;
    throw new Error("Family System 2.0 已停用 Markdown→JSON 单向导入；请使用 store-v4 候选迁移器或权威外部修改采纳流程");
  }
}

class LifeCoreService {
  constructor(storage, clock) {
    this.storage = storage;
    this.clock = clock;
    this.commitQueue = Promise.resolve();
  }

  async initializeStore() {
    await this.storage.initialize();
    return this.recoverApplyingOperations();
  }

  async preview(command) {
    await this.storage.initialize();
    if (command.command_type === "authority.validate") {
      const validation = await this.storage.validateAuthority();
      const operation = {
        schema: "family-system/effect-set-v2",
        id: command.id,
        operation_id: command.id,
        command,
        status: "prepared",
        effects: [],
        applied_effect_ids: [],
        invariants: [],
        warnings: validation.errors,
        summary: validation.status === "valid" ? `Markdown 权威校验通过：${validation.records} 条记录` : `Markdown 权威校验失败：${validation.errors.length} 项`,
        validation,
        created_at: command.recorded_at,
      };
      await this.storage.saveOperation(operation);
      return operation;
    }
    if (command.command_type === "authority.adopt-external") {
      const operation = await this.storage.planAuthorityAdoption(command);
      await this.storage.saveOperation(operation);
      return operation;
    }
    if (command.command_type === "authority.restore-module") {
      const operation = await this.storage.planAuthorityRestore(command);
      await this.storage.saveOperation(operation);
      return operation;
    }
    await this.storage.assertAuthorityReadyForCommand(command);
    const state = await this.storage.loadState();
    if (command.command_type === "meal-plan.rebuild-purchases") {
      const plan = (state.meal_plan || []).find((item) => item.id === command.payload.id && !item.tombstone);
      if (plan?.status === "draft") throw new Error("菜单草稿不会提前生成采购；请在激活预演中核对采购与事务后再提交");
    }
    const corePlanned = require("./core").planCommand(command, state);
    const planned = await this.storage.prepareHybridEffects(corePlanned, state);
    planned.invariant_hashes_before = await this.storage.hashTypes(planned.invariants);
    await this.storage.saveOperation(planned);
    return planned;
  }

  async commit(effectSetId) {
    const run = () => this.commitPrepared(effectSetId);
    const queued = this.commitQueue.then(run, run);
    this.commitQueue = queued.then(() => null, () => null);
    return queued;
  }

  async commitPrepared(effectSetId) {
    let operation = await this.storage.readOperation(effectSetId);
    if (!operation) throw new Error(`找不到 EffectSet：${effectSetId}`);
    if (["committed", "committed_with_pending_projection"].includes(operation.status)) return operation;
    if (!["prepared", "compensated"].includes(operation.status)) throw new Error(`当前状态不能提交：${operation.status}`);
    let lease = await this.storage.acquireWriterLease(operation.operation_id);
    operation = await this.storage.saveOperation({ ...operation, status: "applying", applied_effect_ids: [] });
    const applied = [];
    try {
      for (const item of operation.effects) {
        lease = await this.storage.refreshWriterLease(lease);
        await this.storage.applyEffect(item);
        applied.push(item);
        operation = await this.storage.saveOperation({ ...operation, applied_effect_ids: applied.map((effect) => effect.effect_id) });
      }
      const afterHashes = await this.storage.hashTypes(operation.invariants || []);
      for (const type of operation.invariants || []) {
        if (afterHashes[type] !== operation.invariant_hashes_before[type]) throw new Error(`反向不变量被破坏：${type}`);
      }
      try {
        const projection = await this.storage.writeProjection();
        operation = await this.storage.saveOperation({ ...operation, status: "committed", projection, completed_at: nowIso(this.clock) });
      } catch (projectionError) {
        operation = await this.storage.saveOperation({ ...operation, status: "committed_with_pending_projection", projection_error: projectionError.message, completed_at: nowIso(this.clock) });
      }
      return operation;
    } catch (error) {
      const compensationErrors = [];
      for (const item of [...applied].reverse()) {
        try {
          await this.storage.compensateEffect(item, operation.operation_id);
        } catch (compensationError) {
          compensationErrors.push(compensationError.message);
        }
      }
      const status = compensationErrors.length ? "failed" : "compensated";
      operation = await this.storage.saveOperation({ ...operation, status, error: error.message, compensation_errors: compensationErrors });
      if (compensationErrors.length) {
        await this.storage.createConflict({
          id: require("./core").uuidFromSeed(`compensation:${operation.operation_id}`),
          conflict_type: "compensation_failed",
          operation_id: operation.operation_id,
          details: { error: error.message, compensation_errors: compensationErrors },
        });
      }
      throw error;
    } finally {
      await this.storage.releaseWriterLease(lease);
    }
  }

  async recoverApplyingOperations() {
    const operations = (await this.storage.readDirectoryJson(DIRECTORY_NAMES.operations)).filter((item) => item.status === "applying");
    const recovered = [];
    for (const operation of operations) {
      let lease = null;
      try {
        lease = await this.storage.acquireWriterLease(operation.operation_id);
        const applied = [];
        for (const effect of operation.effects || []) if (await this.storage.verifyEffect(effect)) applied.push(effect);
        if (applied.length === (operation.effects || []).length) {
          let projection = null;
          let status = "committed";
          let projectionError = null;
          try { projection = await this.storage.writeProjection(); } catch (error) { status = "committed_with_pending_projection"; projectionError = error.message; }
          recovered.push(await this.storage.saveOperation({ ...operation, status, applied_effect_ids: applied.map((item) => item.effect_id), projection, projection_error: projectionError, recovered_at: nowIso(this.clock), completed_at: nowIso(this.clock) }));
          continue;
        }
        const compensationErrors = [];
        for (const effect of [...applied].reverse()) {
          try { await this.storage.compensateEffect(effect, operation.operation_id); } catch (error) { compensationErrors.push(error.message); }
        }
        const status = compensationErrors.length ? "failed" : "compensated";
        recovered.push(await this.storage.saveOperation({ ...operation, status, applied_effect_ids: applied.map((item) => item.effect_id), recovered_at: nowIso(this.clock), recovery_action: "compensate_partial", compensation_errors: compensationErrors }));
        if (compensationErrors.length) await this.storage.createConflict({
          id: require("./core").uuidFromSeed(`recovery:${operation.operation_id}`),
          conflict_type: "startup_recovery_failed",
          operation_id: operation.operation_id,
          details: { compensation_errors: compensationErrors },
        });
      } finally {
        await this.storage.releaseWriterLease(lease);
      }
    }
    return { status: "ok", recovered };
  }

  async recover(operationId, action) {
    const operation = await this.storage.readOperation(operationId);
    if (!operation) throw new Error(`找不到操作：${operationId}`);
    if (action === "retry_projection") {
      const projection = await this.storage.writeProjection();
      return this.storage.saveOperation({ ...operation, status: "committed", projection, projection_error: null });
    }
    if (action === "mark_manual") {
      await this.storage.createConflict({
        id: require("./core").uuidFromSeed(`manual:${operationId}`),
        conflict_type: "manual_takeover",
        operation_id: operationId,
        details: { previous_status: operation.status },
      });
      return this.storage.saveOperation({ ...operation, status: "needs_review" });
    }
    if (action === "discard_preview") {
      if (operation.status !== "prepared") throw new Error("只有尚未提交的预演可以放弃");
      return this.storage.saveOperation({ ...operation, status: "previewed", discarded_at: nowIso(this.clock) });
    }
    if (action === "undo") {
      if (!["committed", "committed_with_pending_projection"].includes(operation.status)) throw new Error("只有已提交操作可以撤销");
      const undoId = require("./core").createId("undo", `${operationId}:${nowIso(this.clock)}`);
      const undo = {
        schema: "family-system/effect-set-v2",
        id: undoId,
        operation_id: undoId,
        command: { schema: "family-system/command-v1", id: undoId, command_type: "undo-operation", causation_id: operationId, correlation_id: operation.command.correlation_id, recorded_at: nowIso(this.clock) },
        effects: [],
        status: "applying",
        applied_effect_ids: [],
        summary: `撤销操作 ${operationId}`,
        created_at: nowIso(this.clock),
      };
      await this.storage.saveOperation(undo);
      for (const item of [...operation.effects].reverse()) await this.storage.compensateEffect(item, undoId);
      const reverseEvent = require("./core").recordBase("domain_event", {
        event_type: "operation.reversed",
        aggregate_id: operationId,
        actor_id: "local-user",
        authority: "explicit_user_decision",
        occurred_at: nowIso(this.clock),
        causation_id: operationId,
        correlation_id: operation.command.correlation_id,
        payload: { reversed_operation_id: operationId },
      }, { household_id: operation.command.household_id || "", recorded_at: nowIso(this.clock) });
      await this.storage.writeRecord(reverseEvent, 0);
      await this.storage.writeProjection();
      return this.storage.saveOperation({ ...undo, status: "committed", completed_at: nowIso(this.clock), reversed_operation_id: operationId });
    }
    throw new Error(`不支持的恢复动作：${action}`);
  }

  async discardPreview(operationId) {
    const operation = await this.storage.readOperation(operationId);
    if (!operation || operation.status !== "prepared") return operation;
    return this.storage.saveOperation({ ...operation, status: "previewed", discarded_at: nowIso(this.clock) });
  }

  async previewImport(roots) {
    return this.storage.previewImport(roots, "");
  }

  async commitImport(previewId) {
    void previewId;
    throw new Error("Family System 2.0 不允许提交旧单向导入");
  }

  async processInbox() {
    await this.storage.initialize();
    const commands = await this.storage.pendingInboxCommands();
    const results = [];
    for (const raw of commands) {
      const id = String(raw?.id || "");
      try {
        if (raw?.schema !== "family-system/command-v1" || !id || !raw.command_type) throw new Error("快捷指令命令格式无效");
        const existing = await this.storage.readOperation(id);
        let operation = existing;
        if (!operation) {
          const state = await this.storage.loadState();
          const household = active(state.household)[0];
          if (!household) throw new Error("Life Core 尚未建立家庭");
          const command = {
            ...raw,
            household_id: raw.household_id || household.id,
            actor_id: raw.actor_id || "shortcut-user",
            authority: raw.authority || "explicit_user_confirmation",
            recorded_at: raw.recorded_at || nowIso(this.clock),
            payload: { ...(raw.payload || {}), command_id: id },
          };
          operation = await this.preview(command);
          operation = await this.commit(operation.operation_id);
        }
        const receipt = await this.storage.settleInboxCommand(raw, "processed", operation);
        results.push(receipt);
      } catch (error) {
        const receipt = await this.storage.settleInboxCommand(raw || { id }, "rejected", { error: error.message });
        results.push(receipt);
      }
    }
    return results;
  }
}

module.exports = {
  CoreStorage,
  DIRECTORY_NAMES,
  LifeCoreService,
  PORTABLE_BACKUP_SCHEMA,
};
