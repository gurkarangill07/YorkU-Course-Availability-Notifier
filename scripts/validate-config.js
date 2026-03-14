const {
  validateRuntimeConfig,
  formatConfigValidationErrors
} = require("../src/config");

function readFlagValue(args, name) {
  const index = args.indexOf(name);
  if (index !== -1 && index < args.length - 1) {
    return args[index + 1];
  }
  const prefixed = args.find((arg) => arg.startsWith(`${name}=`));
  if (prefixed) {
    return prefixed.split("=").slice(1).join("=");
  }
  return null;
}

function printUsage() {
  console.log("Usage: node scripts/validate-config.js --runtime <api|worker|all>");
  console.log("Optional: pass --mode <worker-mode> for worker-specific validation.");
  console.log(
    "You can also set CONFIG_RUNTIME and CONFIG_MODE instead of passing flags."
  );
}

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  printUsage();
  process.exit(0);
}

const runtimeArg = readFlagValue(args, "--runtime");
const modeArg = readFlagValue(args, "--mode");
const runtimeEnv = String(process.env.CONFIG_RUNTIME || "").trim();
const modeEnv = String(process.env.CONFIG_MODE || "").trim();
const runtime = runtimeArg || runtimeEnv || "all";
const mode = modeArg || modeEnv || "";
const runtimes = runtime === "all" ? ["api", "worker"] : [runtime];

const errors = [];
const warnings = [];

for (const runtimeName of runtimes) {
  const result = validateRuntimeConfig({
    env: process.env,
    runtime: runtimeName,
    mode: runtimeName === "worker" ? mode : ""
  });
  for (const message of result.errors) {
    errors.push(`[${runtimeName}] ${message}`);
  }
  for (const message of result.warnings) {
    warnings.push(`[${runtimeName}] ${message}`);
  }
}

if (warnings.length > 0) {
  console.warn("Config validation warnings:");
  console.warn(`- ${warnings.join("\n- ")}`);
}

if (errors.length > 0) {
  console.error(formatConfigValidationErrors(errors));
  process.exit(1);
}

const modeSuffix = mode ? ` (mode: ${mode})` : "";
console.log(`Config validation passed for: ${runtimes.join(", ")}${modeSuffix}`);
