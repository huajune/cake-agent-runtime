# Stage 1: Dependency Installation
FROM node:20-bookworm-slim AS deps
WORKDIR /app

# Install pnpm
RUN npm install -g pnpm

# Copy package files (including all workspace packages)
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

COPY web/package.json ./web/

# Install dependencies
RUN pnpm install --frozen-lockfile

# Stage 2: Build
FROM deps AS builder
WORKDIR /app

# Copy source code
COPY . .

# Build web frontend (outputs to public/web/)
RUN pnpm run build:web

# Build NestJS backend (nest-cli copies public/ into dist/)
RUN pnpm run build

# Prune to production dependencies only (removes devDependencies in-place)
RUN pnpm prune --prod

# Stage 3: Runner
FROM node:20-bookworm-slim AS runner
WORKDIR /app

ENV NODE_ENV=production

# Copy built artifacts and production-only dependencies
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/public ./public
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json

# Create logs directory
RUN mkdir -p logs

EXPOSE 8080

CMD ["node", "dist/main"]
