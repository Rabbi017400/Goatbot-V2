"use strict";

const fs = require("fs");
const path = require("path");

const tableDir = process.argv[2] || process.env.FCA_TABLES_DIR || path.join(__dirname, "tables-src");
const outFile = process.argv[3] || path.join(__dirname, "tables-spec.json");

const structRe = /^type\s+(\w+)\s+struct\s*\{$/;
const emptyStructRe = /^type\s+(\w+)\s+struct\s*\{\s*\}\s*$/;
const fieldRe = /^\s*([A-Za-z0-9_]+)\s+([A-Za-z0-9_\.\[\]\*]+)\s+`([^`]*)`/;
const tagRe = /(\w+):"([^"]*)"/g;

const files = fs.readdirSync(tableDir).filter((f) => f.endsWith(".go"));
const structs = {};

for (const file of files) {
  const src = fs.readFileSync(path.join(tableDir, file), "utf8").split("\n");
  let current = null;
  for (const line of src) {
    const em = line.match(emptyStructRe);
    if (em) {
      structs[em[1]] = { file, fields: [] };
      current = null;
      continue;
    }
    const sm = line.match(structRe);
    if (sm) {
      current = sm[1];
      structs[current] = { file, fields: [] };
      continue;
    }
    if (current) {
      if (line.startsWith("}")) {
        current = null;
        continue;
      }
      const fm = line.match(fieldRe);
      if (!fm) continue;
      const [, name, goType, tags] = fm;
      const tagsObj = {};
      let tm;
      tagRe.lastIndex = 0;
      while ((tm = tagRe.exec(tags)) !== null) tagsObj[tm[1]] = tm[2];
      const field = { name, goType };
      if (tagsObj.index !== undefined) field.index = parseInt(tagsObj.index, 10);
      if (tagsObj.conditionField) field.conditionField = tagsObj.conditionField;
      if (tagsObj.indexes) field.indexes = tagsObj.indexes;
      structs[current].fields.push(field);
    }
  }
}

// Extract SPTable from table.go
const tableGo = fs.readFileSync(path.join(tableDir, "table.go"), "utf8");
const spMatch = tableGo.match(/var SPTable = map\[string\]string\{([\s\S]*?)\n\}/);
const spTable = {};
if (spMatch) {
  const re = /"([^"]+)":\s*"([^"]+)"/g;
  let m;
  while ((m = re.exec(spMatch[1])) !== null) spTable[m[1]] = m[2];
}

fs.writeFileSync(outFile, JSON.stringify({ structs, spTable }, null, 2));
console.log("Wrote", outFile, "structs:", Object.keys(structs).length, "sp:", Object.keys(spTable).length);
