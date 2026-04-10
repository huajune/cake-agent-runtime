# Stage 1: Dependency Installation
FROM node:20-bookworm-slim AS deps
WORKDIR /app

# Install pnpm
RUN npm install -g pnpm

# Copy package files (including all workspace packages)
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

COPY web/package.json ./web/

# Install dependencies (skip postinstall scripts — supabase CLI binary download not needed in Docker)
RUN pnpm install --frozen-lockfile --ignore-scripts

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

EXPOSE 8585

CMD ["node", "dist/main"]
