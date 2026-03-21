const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const projectDirs = [
  path.join(__dirname, "..", "src"),
  path.join(__dirname, "..", "scripts")
];
const jsFiles = [];

function collectJsFiles(dirPath) {
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      collectJsFiles(entryPath);
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".js")) {
      jsFiles.push(entryPath);
    }
  }
}

for (const dirPath of projectDirs) {
  collectJsFiles(dirPath);
}

if (jsFiles.length === 0) {
  console.log("No project JS files found for smoke check.");
  process.exit(0);
}

let failed = false;
for (const filePath of jsFiles) {
  try {
    const source = fs.readFileSync(filePath, "utf8");
    new vm.Script(source, { filename: filePath });
  } catch (error) {
    console.error(`Syntax error in ${filePath}`);
    console.error(error);
    failed = true;
  }
}

if (failed) {
  process.exit(1);
}
