"use strict";

const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const modules = ["core", "authority", "importer", "storage", "view-model", "ui", "plugin"];
const entries = modules.map((name) => {
  const source = fs.readFileSync(path.join(root, "src", `${name}.js`), "utf8");
  return `${JSON.stringify(`./${name}`)}: function(module, exports, require) {\n${source}\n}`;
});

const output = `"use strict";
const __familySystemExternalRequire = require;
const __familySystemModules = {${entries.join(",\n")}};
const __familySystemCache = {};
function __familySystemRequire(id) {
  if (id === "obsidian") return __familySystemExternalRequire("obsidian");
  const normalized = id.endsWith(".js") ? id.slice(0, -3) : id;
  if (__familySystemCache[normalized]) return __familySystemCache[normalized].exports;
  const factory = __familySystemModules[normalized];
  if (!factory) return __familySystemExternalRequire(id);
  const module = { exports: {} };
  __familySystemCache[normalized] = module;
  factory(module, module.exports, __familySystemRequire);
  return module.exports;
}
module.exports = __familySystemRequire("./plugin");
`;

fs.writeFileSync(path.join(root, "main.js"), output, "utf8");
console.log(JSON.stringify({ status: "ok", modules: modules.length, bytes: Buffer.byteLength(output) }));
