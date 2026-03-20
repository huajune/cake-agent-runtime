---
name: agents-overview
description: >
  Overview and navigation guide for all Claude Code agent guidelines.
  Start here to understand the agent documentation structure.
visibility: global
priority: high
---

# Claude Code Agents - Documentation Guide

> Central navigation for all agent guidelines and best practices

**Last Updated**: 2025-11-05 16:35:00
**Project**: DuLiDay 企业微信服务

---

## 📚 Documentation Structure

This directory contains modular guidelines for Claude Code agents. Each file focuses on a specific aspect of development:

### 🎯 Quick Navigation

| Document                                                       | Purpose                                | When to Use                       |
| -------------------------------------------------------------- | -------------------------------------- | --------------------------------- |
| **[code-standards.md](code-standards.md)**                     | TypeScript, NestJS, coding conventions | Writing or modifying backend code |
| **[frontend-standards.md](frontend-standards.md)**             | React, SCSS Modules, component design  | Writing or modifying frontend code |
| **[architecture-principles.md](architecture-principles.md)**   | SOLID, design patterns, biz module conventions | Designing features or refactoring |
| **[development-workflow.md](development-workflow.md)**         | Git workflow, testing, deployment      | Daily development tasks           |
| **[performance-optimization.md](performance-optimization.md)** | Performance tuning, monitoring         | Optimizing system performance     |
| **[code-quality-guardian.md](code-quality-guardian.md)**       | Automated quality checks               | Before committing code            |
| **[tune-prompt.md](tune-prompt.md)**                           | Prompt refinement harness (agent testing) | After observing suboptimal agent behavior |

---

## 🎓 For New Developers

**Start with these documents in order:**

1. **[code-standards.md](code-standards.md)** - Learn the backend coding conventions
2. **[frontend-standards.md](frontend-standards.md)** - Learn the frontend coding conventions
3. **[architecture-principles.md](architecture-principles.md)** - Understand the system design
4. **[development-workflow.md](development-workflow.md)** - Master the workflow

---

## 🔧 For Experienced Developers

**Quick reference by task:**

- **Adding a backend feature** → [code-standards.md](code-standards.md) + [architecture-principles.md](architecture-principles.md)
- **Adding a frontend feature** → [frontend-standards.md](frontend-standards.md) + [architecture-principles.md](architecture-principles.md)
- **Fixing a bug** → [code-standards.md](code-standards.md) / [frontend-standards.md](frontend-standards.md)
- **Performance issue** → [performance-optimization.md](performance-optimization.md)
- **Code review** → [code-quality-guardian.md](code-quality-guardian.md)
- **Refactoring** → [architecture-principles.md](architecture-principles.md)

---

## 🏗️ System Architecture Overview

```
src/
├── core/           # Infrastructure layer (config, http, logging)
├── common/         # Shared utilities (conversation management)
├── agent/          # AI integration layer
└── modules/        # Business modules (message, chat, contact, etc.)
```

**Key Principles:**

- Clean layered architecture
- Dependency injection (NestJS)
- Single responsibility per module
- Interface-based abstractions

---

## 📖 Documentation Principles

Each guideline document follows these principles:

1. **Focused** - One clear topic per file
2. **Practical** - Real examples from this project
3. **Actionable** - Clear dos and don'ts
4. **Maintained** - Updated with project evolution

---

## 🚀 Quick Reference

### Technology Stack

- **Framework**: NestJS 10.3.0
- **Language**: TypeScript 5.3.3
- **Runtime**: Node.js 20.x+
- **HTTP Client**: Axios
- **Logging**: Winston
- **Validation**: class-validator
- **API Docs**: Swagger

### Key Commands

```bash
npm run start:dev     # Development mode
npm run build         # Production build
npm run format        # Format code
npm run lint          # Lint code
npm run test          # Run tests
```

---

## 📝 Contributing to Documentation

When updating these guidelines:

1. Keep files under 500 lines
2. Use real project examples
3. Update the "Last Updated" date
4. Follow markdown best practices
5. Add cross-references where helpful

---

## 🔗 Related Documentation

- **Project README**: [../README.md](../../README.md)
- **API Documentation**: Available at `/api/docs` when running
- **Enterprise WeChat API**: https://s.apifox.cn/34adc635-40ac-4161-8abb-8cd1eea9f445
- **AI Agent API**: https://docs.wolian.cc/

---

**Questions?** Check the specific guideline document or reach out to the team.
