FROM node:20-alpine AS base

RUN npm install -g pnpm@10

WORKDIR /app

# Copy workspace manifests and configs first (better layer caching)
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json ./

# Copy the workspace package the API imports from
COPY packages/db/ packages/db/

# Copy the API and worker apps — both run from this one image as separate
# Fly process groups (see fly.toml [processes]).
COPY apps/api/ apps/api/
COPY apps/worker/ apps/worker/

# package.json stubs for the remaining workspace members so pnpm can
# resolve the full workspace graph and --frozen-lockfile passes.
COPY apps/web/package.json apps/web/
COPY apps/mobile/package.json apps/mobile/

# Install all workspace dependencies
RUN pnpm install --frozen-lockfile

# Build @hmu/db first — the API imports from its dist/
RUN pnpm --filter @hmu/db build

# Build the API and the worker
RUN pnpm --filter api build
RUN pnpm --filter @hmu/worker build

EXPOSE 3001

# Default command (API). Fly overrides this per-process via [processes] in fly.toml.
CMD ["node", "apps/api/dist/server.js"]
