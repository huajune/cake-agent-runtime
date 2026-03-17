---
name: documentation-standards
role: system
model: sonnet
visibility: global
description: >
  Documentation synchronization and writing standards for the DuLiDay WeChat Service.
  Ensures all code changes are properly documented and all documentation follows consistent standards.

tags:
  - documentation
  - standards
  - sync

priority: high
---

# Documentation Standards

> **FOR AI AGENTS**: Documentation synchronization rules and writing standards
>
> **FOR HUMAN DEVELOPERS**: Complete documentation guidelines and best practices

**Last Updated**: 2025-11-05 16:35:00
**Purpose**: Ensure documentation stays in sync with code and follows consistent quality standards
**Target Audience**: All developers and AI agents working on this project

---

## 🔴 Documentation Synchronization (Highest Priority)

### Core Principle

**Every code change MUST immediately update related documentation. This is a non-negotiable fundamental principle.**

```
Code Change → Check Related Docs → Update Synchronously → Commit Together
```

### Documentation Update Mapping

| Code Change Type | Required Documentation Updates |
|-----------------|-------------------------------|
| **Modify .env.example** | README.md (config examples + config table) |
| **Modify config/environment** | README.md + .env.example + development-guide.md |
| **Modify workflow/tools** | README.md (dev guide) + development-guide.md |
| **Add/modify features** | Architecture docs + README.md |
| **Modify APIs** | API docs + Swagger annotations |
| **Dependency upgrades** | package.json + README.md (tech stack) |

### Commit Message Standards

Explicitly state documentation updates in commit messages:

```bash
✅ Correct Example:
git commit -m "feat: update default AI model to Claude Sonnet 4.5

- Modified AGENT_DEFAULT_MODEL in .env.example
- Updated README.md config example
- Updated README.md config table
"

❌ Wrong Example:
git commit -m "feat: update default model"
# Missing documentation update information
```

### Dangers of Outdated Documentation

- ❌ New members cannot start project following documentation
- ❌ Team members use incorrect default values
- ❌ Development workflow descriptions don't match reality
- ❌ Reduced documentation credibility, eventually unmaintained

**Remember: Code Change = Code + Documentation Sync Update**

---

## 📝 Documentation Writing Standards

### Document Type Limits

| Document Type | Max Lines | Recommended | Description |
|--------------|-----------|-------------|-------------|
| **Architecture Docs** | 500 | 300-400 | System/module architecture design |
| **API Guides** | 600 | 300-500 | External API usage documentation |
| **Development Standards** | 400 | 200-300 | Code standards, best practices |

### Core Principles

✅ **Simplicity First**:
- Keep only **core implementation ideas** and **design decisions**
- Remove detailed examples, repetitive explanations, over-explanations
- Highlight core algorithms, key workflows, important configurations
- Don't write step-by-step tutorials, only record core patterns
- Use concise text workflows instead of complex diagrams
- Maximum 1 concise example per concept
- Target developers who understand the business, not beginners

❌ **Strictly Forbidden**:
- Exceeding recommended line limits
- Repeating explanations of same concepts
- Lengthy troubleshooting sections
- Detailed FAQ lists
- Excessive configuration examples
- Tutorial-style step-by-step guides
- Monitoring/debugging sections (unless core)
- Extension guides (unless core)
- Best practices sections (should be integrated into main text)

### File Naming Standards

**Use kebab-case consistently (lowercase + hyphens)**:

✅ **Correct Naming**:
```
development-guide.md
agent-service-architecture.md
huajuan-agent-api.md
auto-version-changelog.md
```

❌ **Wrong Naming**:
```
DEVELOPMENT_GUIDE.md      # ❌ All uppercase
DevelopmentGuide.md       # ❌ PascalCase
development_guide.md      # ❌ snake_case
developmentGuide.md       # ❌ camelCase
```

### Directory Structure Standards

**docs/ directory organized by function, max 3 levels deep**:

```
docs/
├── README.md                        # 📋 Documentation index (required)
├── architecture/                    # 🏗️ Architecture design docs
│   ├── agent-service.md
│   └── message-service.md
├── guides/                          # 📚 Usage and development guides
│   ├── development-guide.md
│   └── api-integration/            # API integration guides (optional subdirectory)
│       └── huajuan-agent-api.md
├── workflows/                       # 🔄 Workflows and standards
│   └── auto-version-changelog.md
└── product/                         # 📦 Product documentation
    ├── product-definition.md
    ├── product-roadmap.md
    └── business-flows.md
```

### Directory Classification

| Directory | Purpose | File Type Examples |
|----------|---------|-------------------|
| **architecture/** | System architecture, module design | `*-service.md`, `system-design.md` |
| **guides/** | Development guides, usage manuals, API integration | `development-guide.md`, `*-api.md` |
| **workflows/** | Workflows, development standards, automation | `git-workflow.md`, `ci-cd.md` |
| **product/** | Product definition, requirements, roadmap | `product-*.md`, `business-*.md` |

### Document Creation Checklist

- [ ] File name uses kebab-case (lowercase + hyphens)
- [ ] File placed in correct category directory
- [ ] Directory hierarchy does not exceed 3 levels
- [ ] Updated `docs/README.md` index
- [ ] Updated work guidance files with references (if important document)

---

## 📄 Standard Document Structure

### Template

```markdown
# [Document Title]

## Table of Contents
- Core sections (4-6)

## 1. Architecture Overview
- Simplified architecture diagram (text is fine)
- File structure

## 2. Core Components
- Each component's core responsibilities (3-5 points)
- Key method signatures
- Key configuration parameters

## 3. Core Workflows
- Simplified workflow diagram (text is fine)
- Key decision points

## 4. Configuration Management
- Required configuration items
- Key configuration examples

## 5. Summary
- Core points
- Key metrics

---

**Last Updated**: YYYY-MM-DD
```

### Simplification Example

#### ❌ Verbose Example (Not Recommended)

```markdown
## Message Deduplication Mechanism

### 5.1 Deduplication Strategy

Message deduplication is a critical part of the message processing flow... (200 words explanation)

#### LRU Cache + TTL

We use LRU cache combined with TTL to implement deduplication... (150 words explanation)

```typescript
// Data structure
private readonly messageCache = new Map<string, number>();
// messageId → timestamp

// Capacity limits
private readonly maxSize = 10000;
private readonly ttl = 300000; // 5 minutes
```

#### Deduplication Logic

Below is the detailed deduplication logic implementation... (100 words explanation)

```typescript
// Full implementation code (30 lines)
```

#### Deduplication Flowchart

```
┌─────────────────────────────────────────────────────────────┐
│ Received message (messageId: msg-123)                        │
└─────────────────────────────────────────────────────────────┘
  (Detailed flowchart 20 lines)
```

### 5.2 Memory Management

#### LRU Eviction Strategy

... (200 words explanation)

#### Periodic Cleanup

... (150 words explanation)
```

#### ✅ Concise Example (Recommended)

```markdown
## 2.3 MessageDeduplicationService (Deduplication)

**Location**: [src/channels/wecom/message/services/message-deduplication.service.ts](...)

#### Deduplication Strategy
- **Data Structure**: `Map<messageId, timestamp>`
- **TTL**: Duplicates within 5 minutes are deduplicated
- **Capacity Management**: LRU strategy, max 10,000 entries
- **Performance**: O(1) lookup, periodic cleanup of expired records

```typescript
isDuplicate(messageId: string): boolean {
  const existingTimestamp = this.messageCache.get(messageId);
  if (existingTimestamp && (Date.now() - existingTimestamp) < this.ttl) {
    return true; // Duplicate message
  }
  this.messageCache.set(messageId, Date.now());
  return false;
}
```
```

---

## ✅ Documentation Checklist

Before submitting documentation, check:

- [ ] Total line count within recommended range?
- [ ] Each example essential?
- [ ] All redundant explanations removed?
- [ ] Troubleshooting/FAQ/monitoring/extension sections removed?
- [ ] Tutorial-style writing avoided?
- [ ] Table of contents concise (max 8 sections)?
- [ ] Concise text workflows instead of complex diagrams?
- [ ] Only 1 concise example per concept?

---

## 🔗 Related Documents

- [code-standards.md](code-standards.md) - Code quality standards
- [code-quality-guardian.md](code-quality-guardian.md) - AI agent quality checks
- [architecture-principles.md](architecture-principles.md) - Architecture design principles

---

**Remember**: Documentation is not a separate artifact, but an essential part of the code. Keeping documentation in sync with code is the basic quality of a professional developer.
