FROM node:20-alpine AS base

RUN npm install -g pnpm@9

WORKDIR /app

# Copy workspace manifests and configs first (better layer caching)
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json ./

# Copy workspace packages needed by the API
COPY packages/db/ packages/db/

# Copy the API app
COPY apps/api/ apps/api/

# Install all workspace dependencies
RUN pnpm install --frozen-lockfile

# Build @hmu/db first — the API imports from its dist/
RUN pnpm --filter @hmu/db build

# Build the API
RUN pnpm --filter api build

EXPOSE 3001

CMD ["node", "apps/api/dist/server.js"]
