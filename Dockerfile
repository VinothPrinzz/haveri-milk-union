FROM node:20-alpine AS base

RUN npm install -g pnpm@10

WORKDIR /app

# Copy workspace manifests and configs first (better layer caching)
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json ./

# Copy workspace packages needed by the API
COPY packages/db/ packages/db/

# Copy the API app
COPY apps/api/ apps/api/

# Copy package.json stubs for all other workspace members so pnpm can
# resolve the full workspace graph and --frozen-lockfile passes.
COPY apps/worker/package.json apps/worker/
COPY apps/web/package.json apps/web/
COPY apps/mobile/package.json apps/mobile/

# Install all workspace dependencies
RUN pnpm install --frozen-lockfile

# Build @hmu/db first — the API imports from its dist/
RUN pnpm --filter @hmu/db build

# Build the API
RUN pnpm --filter api build

EXPOSE 3001

CMD ["node", "apps/api/dist/server.js"]
