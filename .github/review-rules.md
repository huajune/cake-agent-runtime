# AI Code Review Rules

This repository contains two codebases. Apply the relevant rules based on which files are changed.

---

## Backend (`src/`)

**Tech Stack**: NestJS 10.3 | TypeScript 5.3 | Node.js 20+ | Bull Queue | Redis (Upstash) | Supabase

### Architecture

DDD layered architecture:

- `core/` — infrastructure (HTTP client, Redis, Supabase, alert). **Cannot import from `biz/`, `wecom/`, or `agent/`**
- `agent/` — AI Agent domain
- `biz/` — business domain (monitoring, user, message, hosting-config)
- `wecom/` — WeChat Enterprise domain

### Backend Critical (must block PR)

- Bugs and logic errors
- Security vulnerabilities (hardcoded secrets, SQL injection, XSS)
- Unhandled exceptions or missing error handling
- Layer violations: `core/` importing `biz/`, `wecom/`, or `agent/`
- Hardcoded secrets or credentials
- Using `console.log` instead of NestJS `Logger`
- **New `.ts` files (services, controllers, utils, etc.) must have a corresponding `*.spec.ts` unit test file. Block the PR if tests are missing.**

### Backend Code Quality (should fix)

- TypeScript strict typing — no `any` abuse
- Proper dependency injection (no `new Service()`)
- Config values via `ConfigService` / env vars, not hardcoded
- Service size <= 500 lines (Single Responsibility Principle)
- Naming conventions: kebab-case files, PascalCase classes, camelCase variables

### Backend Architecture (should fix)

- Services placed in the correct domain
- No business logic leaking into controllers
- Controllers only handle HTTP concerns (validation, response)

---

## Web (`web/`)

**Tech Stack**: React 18 | TypeScript 5.6 | Vite | Tailwind CSS | TanStack React Query | Zustand | Axios

### Web Directory Structure

- `api/services/` — API service modules (one per backend domain)
- `api/types/` — TypeScript interfaces for API data
- `components/` — reusable UI components
- `view/{module}/list/` — page views
- `hooks/` — custom React hooks (per domain)
- `utils/` — utility functions
- `constants/` — app constants

### Web Critical (must block PR)

- XSS vulnerabilities (unescaped `dangerouslySetInnerHTML`, unescaped user input)
- Hardcoded API URLs, tokens, or credentials
- Missing error handling on API calls (Axios/React Query)
- Memory leaks (uncleared timers, unsubscribed listeners, missing cleanup in useEffect)

### Web Code Quality (should fix)

- TypeScript strict typing — no `any` abuse
- React best practices:
  - No business logic in components — extract to custom hooks
  - Proper dependency arrays in `useEffect` / `useMemo` / `useCallback`
  - No inline object/function definitions in JSX props (causes unnecessary re-renders)
  - Use React Query for server state, Zustand for client state — don't mix
- API layer separation: all HTTP calls must go through `api/services/`, not called directly in components
- Component files <= 300 lines — extract sub-components or hooks if too large
- Naming: PascalCase components, camelCase hooks (`useXxx`), kebab-case files

### Web Architecture (should fix)

- New API types must be in `api/types/`, not inline
- Shared logic must be in `hooks/` or `utils/`, not duplicated across views
- Route paths must use `/web` prefix (basename configuration)

---

## Suggestions (non-blocking, both codebases)

- Code improvements and optimizations
- Better naming or structure
- Missing test coverage for critical paths
- Accessibility improvements (web)

## Review Output Format

- Use `gh pr review` with inline comments for specific line-level issues
- Use `gh pr comment` for an overall summary
- Categorize findings by severity: Critical / Should Fix / Suggestion
- Only post GitHub comments — do not output review text as plain messages

## Review Decision

- If there are **Critical** issues: use `gh pr review --request-changes`
- If there are **no Critical** issues (only Should Fix / Suggestions or no issues): use `gh pr review --approve`
- Always include a brief summary in the review body explaining the decision
