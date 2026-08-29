"use strict";

const assert = require("assert");
const { buildImportPreview, parseImportRoots, sourceStableId } = require("../src/importer");

const sources = [
  { path: "隔离夹具/成员.md", hash: "aaa", frontmatter: { type: "family-system/member-v1", name: "脱敏成员" } },
  { path: "隔离夹具/菜谱.md", hash: "bbb", frontmatter: { type: "family-system/recipe-v1", name: "脱敏菜谱", ingredients: [] } },
  { path: "隔离夹具/未知.md", hash: "ccc", frontmatter: { type: "legacy-unknown/v9", name: "未知记录" } },
];

const preview = buildImportPreview(sources, {
  household_id: "11111111-1111-5111-8111-111111111111",
  source_roots: ["隔离夹具"],
  recorded_at: "2026-08-13T10:00:00.000Z",
});

assert.strictEqual(preview.source_count, 3);
assert.strictEqual(preview.supported_count, 2);
assert.strictEqual(preview.unsupported_count, 1);
assert.strictEqual(preview.canonical_records[0].import_authority, "one_way_confirmed_import");
assert.strictEqual(sourceStableId({}, "隔离夹具/成员.md"), sourceStableId({}, "隔离夹具/成员.md"));
assert.deepStrictEqual(parseImportRoots("隔离夹具\n另一个目录,隔离夹具"), ["隔离夹具", "另一个目录"]);
assert.throws(() => parseImportRoots("../仓库外"), /安全相对路径/);

console.log(JSON.stringify({ status: "ok", suite: "importer", supported: preview.supported_count, unsupported: preview.unsupported_count }));
