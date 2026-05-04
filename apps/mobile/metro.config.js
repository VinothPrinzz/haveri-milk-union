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

// Required for pnpm: all packages in node_modules are symlinks pointing into
// .pnpm/; without this Metro refuses to resolve them (EISDIR / not-found).
config.resolver.unstable_enableSymlinks = true;

module.exports = config;
