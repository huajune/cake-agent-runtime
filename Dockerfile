# Stage 1: Dependency Installation
FROM node:20-bookworm-slim AS deps
WORKDIR /app

# Install pnpm
RUN npm install -g pnpm

# Copy package files
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY dashboard/package.json ./dashboard/

# Install overall dependencies
RUN pnpm install --frozen-lockfile

# Stage 2: Build
FROM deps AS builder
WORKDIR /app

# Copy source code
COPY . .

# Build both backend and dashboard
# This builds backend into dist/ and dashboard into public/dashboard/
RUN pnpm run build
RUN pnpm run build:dashboard

# Stage 3: Runner
FROM node:20-bookworm-slim AS runner
WORKDIR /app

ENV NODE_ENV=production

# Copy built artifacts and production dependencies
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/public ./public
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json

# Create logs directory
RUN mkdir -p logs

EXPOSE 8080

# Start the application
CMD ["node", "dist/main"]

