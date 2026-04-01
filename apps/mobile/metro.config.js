const { getDefaultConfig } = require("expo/metro-config");
const path = require("path");

const projectRoot = __dirname;
const monorepoRoot = path.resolve(projectRoot, "../..");

const config = getDefaultConfig(projectRoot);

// ── Fix 1: Watch the monorepo root so Metro can find hoisted deps ──
config.watchFolders = [monorepoRoot];

// ── Fix 2: Tell Metro where to find node_modules ──
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, "node_modules"),
  path.resolve(monorepoRoot, "node_modules"),
];

// ── Fix 3: Block .pnpm store — this is the OOM fix ──
// Metro tries to crawl into .pnpm's deeply nested symlinks and runs out of memory
config.resolver.blockList = [
  /.*\.pnpm\/.*/,
  /.*node_modules\/\.cache\/.*/,
];

// ── Fix 4: Ensure proper resolution for monorepo packages ──
config.resolver.disableHierarchicalLookup = false;

module.exports = config;
