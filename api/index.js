const path = require("path");
const { createApiApp } = require("../src/apiServer");
const { loadConfig } = require("../src/config");
const { createDb } = require("../src/db");

const rootDir = path.join(__dirname, "..");

let appPromise = null;

async function buildApp() {
  const config = loadConfig(process.env);
  const db = createDb({ databaseUrl: config.databaseUrl });
  await db.ensureCompatibility();
  return createApiApp({
    db,
    env: process.env,
    rootDir
  });
}

module.exports = async (req, res) => {
  if (!appPromise) {
    appPromise = buildApp();
  }

  const app = await appPromise;
  return app(req, res);
};
