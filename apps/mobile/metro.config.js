const { getDefaultConfig } = require("expo/metro-config");
const path = require("path");

const projectRoot = __dirname;
const monorepoRoot = path.resolve(projectRoot, "../..");

const config = getDefaultConfig(projectRoot);

// Watch the monorepo root so Metro can find hoisted deps
config.watchFolders = [...(config.watchFolders ?? []), monorepoRoot];

// Tell Metro where to find node_modules (pnpm hoists to monorepo root)
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, "node_modules"),
  path.resolve(monorepoRoot, "node_modules"),
];

// With node-linker=hoisted in .npmrc, pnpm installs packages as real
// directories (no .pnpm virtual-store symlinks). This flag is a no-op in
// that mode but is kept for safety in case any workspace-internal symlinks
// remain (e.g. local package links).
config.resolver.unstable_enableSymlinks = true;

module.exports = config;
