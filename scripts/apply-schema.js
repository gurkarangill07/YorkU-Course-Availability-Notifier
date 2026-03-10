#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const { Client } = require("pg");

async function main() {
  const databaseUrl = String(process.env.DATABASE_URL || "").trim();
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required to apply schema.");
  }

  const schemaPath = path.join(__dirname, "..", "db", "schema.sql");
  const schemaSql = fs.readFileSync(schemaPath, "utf8");

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query(schemaSql);
    console.log(`[schema] applied ${schemaPath}`);
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  const details = error && error.message ? error.message : String(error);
  console.error(`[schema] failed: ${details}`);
  process.exit(1);
});
