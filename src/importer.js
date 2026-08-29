"use strict";

const { contentHash, normalizeVaultPath, recordBase, uuidFromSeed } = require("./core");

const CANONICAL_IMPORT_TYPES = Object.freeze({
  "family-system/member-v1": "member",
  "family-system/health-constraint-v1": "health_constraint",
  "family-system/recipe-v1": "recipe",
});

function parseImportRoots(value) {
  const roots = Array.isArray(value) ? value : String(value || "").split(/\n|,/);
  return [...new Set(roots.map((root) => root.trim()).filter(Boolean).map(normalizeVaultPath))];
}

function sourceStableId(frontmatter, path) {
  const candidate = frontmatter?.id || frontmatter?.uuid || frontmatter?.stable_id;
  if (candidate && /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(String(candidate))) return String(candidate).toLowerCase();
  return uuidFromSeed(`import:${path}`);
}

function normalizeImportedRecord(source, householdId, recordedAt) {
  const type = CANONICAL_IMPORT_TYPES[source.frontmatter?.type];
  if (!type) return null;
  const base = {
    ...source.frontmatter,
    id: sourceStableId(source.frontmatter, source.path),
    imported_from: source.path,
    imported_source_hash: source.hash,
    import_authority: "one_way_confirmed_import",
  };
  delete base.type;
  delete base.uuid;
  delete base.stable_id;
  return recordBase(type, base, { household_id: householdId, recorded_at: recordedAt });
}

function buildImportPreview(sources, options) {
  const recordedAt = options.recorded_at;
  const householdId = options.household_id;
  const mapping = [];
  const canonicalRecords = [];
  const unsupported = [];
  const missingFields = [];
  const conflicts = [];
  const seenIds = new Map();
  sources.forEach((source) => {
    const record = normalizeImportedRecord(source, householdId, recordedAt);
    if (!record) {
      unsupported.push({ path: source.path, type: source.frontmatter?.type || "unknown", hash: source.hash });
      return;
    }
    if (!record.name && ["member", "recipe"].includes(record.record_type)) missingFields.push({ path: source.path, fields: ["name"] });
    if (seenIds.has(record.id) && seenIds.get(record.id) !== source.path) conflicts.push({ id: record.id, paths: [seenIds.get(record.id), source.path], reason: "duplicate_id" });
    seenIds.set(record.id, source.path);
    mapping.push({ source_path: source.path, source_hash: source.hash, target_id: record.id, record_type: record.record_type });
    canonicalRecords.push(record);
  });
  const report = {
    schema: "family-system/import-preview-v1",
    id: uuidFromSeed(`import-preview:${recordedAt}:${sources.map((item) => item.path).sort().join("|")}`),
    created_at: recordedAt,
    source_roots: options.source_roots,
    source_count: sources.length,
    supported_count: canonicalRecords.length,
    unsupported_count: unsupported.length,
    mapping,
    missing_fields: missingFields,
    conflicts,
    unsupported,
    canonical_records: canonicalRecords,
    source_manifest_hash: contentHash(sources.map((item) => ({ path: item.path, hash: item.hash })).sort((a, b) => a.path.localeCompare(b.path))),
    status: conflicts.length || missingFields.length ? "needs_review" : "ready",
  };
  return report;
}

async function scanMarkdownSources(app, roots) {
  const sourceRoots = parseImportRoots(roots);
  const files = app.vault.getMarkdownFiles().filter((file) => sourceRoots.some((root) => file.path === root || file.path.startsWith(`${root}/`)));
  const sources = [];
  for (const file of files) {
    const content = await app.vault.read(file);
    const cache = app.metadataCache.getFileCache(file);
    sources.push({
      path: file.path,
      hash: contentHash(content),
      frontmatter: cache?.frontmatter ? { ...cache.frontmatter } : {},
      title: file.basename,
    });
  }
  return { roots: sourceRoots, sources };
}

module.exports = {
  CANONICAL_IMPORT_TYPES,
  buildImportPreview,
  normalizeImportedRecord,
  parseImportRoots,
  scanMarkdownSources,
  sourceStableId,
};
