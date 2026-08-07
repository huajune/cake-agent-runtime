# syntax=docker/dockerfile:1.7

# Stage 1: Dependency Installation
FROM node:24-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d AS deps
WORKDIR /app

# npm registry。生产机 2026-08-07 实测无法连通 registry.npmjs.org
# （HTTP 000、connect=0.000000s、45s 超时——TCP 连接根本没建立），
# registry-1.docker.io 同样不通，而 api.github.com 与 registry.npmmirror.com
# 均正常（后者 HTTP 200 / 0.73s）。该机 daemon.json 早已配置 20 个国内
# Docker 镜像源，npm 是最后一个仍在直连境外源的环节。
#
# 锁文件为 lockfileVersion 9.0，不含任何写死的 registry URL 或 tarball 字段，
# URL 由 registry 配置拼出，integrity 为内容哈希跨源一致，故换源不影响
# --frozen-lockfile 的可重现性。
#
# 该变量同时被 npm 与 pnpm 读取，一处覆盖下方两步安装。
# 出站恢复后可改回 https://registry.npmjs.org 或经由 --build-arg 覆盖。
ARG NPM_REGISTRY=https://registry.npmmirror.com
ENV npm_config_registry=${NPM_REGISTRY}

# Install a fixed pnpm version to keep dependency resolution reproducible.
RUN npm install -g pnpm@10.34.5 --ignore-scripts

# Copy package files (including all workspace packages)
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

COPY web/package.json ./web/

# Install dependencies (skip postinstall scripts — supabase CLI binary download not needed in Docker)
RUN --mount=type=cache,id=cake-agent-runtime-pnpm-store,target=/pnpm/store \
  pnpm config set store-dir /pnpm/store \
  && pnpm config set engine-strict true \
  && pnpm install --frozen-lockfile --ignore-scripts

# Stage 2: Build
FROM deps AS builder
WORKDIR /app

# Copy source code
COPY . .

# Build web frontend (outputs to public/web/)
ARG API_GUARD_TOKEN
ARG NEXT_PUBLIC_SUPABASE_URL
ARG NEXT_PUBLIC_SUPABASE_ANON_KEY
ENV API_GUARD_TOKEN=$API_GUARD_TOKEN
ENV NEXT_PUBLIC_SUPABASE_URL=$NEXT_PUBLIC_SUPABASE_URL
ENV NEXT_PUBLIC_SUPABASE_ANON_KEY=$NEXT_PUBLIC_SUPABASE_ANON_KEY
RUN test -n "$API_GUARD_TOKEN" \
 && test -n "$NEXT_PUBLIC_SUPABASE_URL" \
 && test -n "$NEXT_PUBLIC_SUPABASE_ANON_KEY"
RUN pnpm run build:web

# Build NestJS backend (nest-cli copies public/ into dist/)
RUN pnpm run build

# Prune to production dependencies only (removes devDependencies in-place)
RUN CI=true pnpm prune --prod

# Stage 3: Runner
FROM node:24-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d AS runner
WORKDIR /app

ENV NODE_ENV=production

# Copy built artifacts and production-only dependencies
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/public ./public
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json

# Create logs directory
RUN mkdir -p logs

EXPOSE 8585

CMD ["node", "dist/main"]
