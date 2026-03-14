const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const srcDir = path.join(__dirname, "..", "src");
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

collectJsFiles(srcDir);

if (jsFiles.length === 0) {
  console.log("No src/**/*.js files found for smoke check.");
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
