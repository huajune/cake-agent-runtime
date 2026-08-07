# Claude Code Hooks

**Last Updated**: 2026-08-07

This directory contains automated hook scripts for Claude Code, including safety protection, code quality, and development workflow enhancements.

---

## 🛡️ Safety Protection Measures

### 1. Dangerous Command Blocklist

The following commands are **completely blocked** (configured in `.claude/settings.json` `deny` list):

```bash
git restore              # Restore files (DANGEROUS: loses uncommitted changes)
git reset --hard         # Hard reset (DANGEROUS: permanently deletes all uncommitted changes)
git clean                # Clean untracked files (DANGEROUS: permanently deletes files)
git checkout -- .        # Restore all files (DANGEROUS: loses working directory changes)
git checkout HEAD        # Checkout HEAD version (DANGEROUS: loses changes)
git stash drop           # Delete stash (DANGEROUS: unrecoverable)
git reflog delete        # Delete reflog (DANGEROUS: loses history)
rm -rf                   # Recursive force delete (DANGEROUS: permanent deletion)
```

### 2. Commands Requiring Confirmation

The following commands require explicit user confirmation (configured in `ask` list):

```bash
git reset                # Reset (requires confirmation)
git rebase               # Rebase operation (requires confirmation)
git push --force         # Force push (requires confirmation)
git push -f              # Force push shorthand (requires confirmation)
git stash                # Stash changes (requires confirmation)
```

### 3. Auto-Stage Modified Files

**Trigger**: After each use of `Write` or `Edit` tools

**Script**: `auto-stage-files.sh`

**Features**:
- Automatically add tracked file modifications to Git staging area
- Does not auto-add new files (prevents accidentally adding sensitive files)
- Displays confirmation message with staged file count

**Workflow**:
```bash
Claude Code modifies file
  ↓
npm run format (code formatting)
  ↓
auto-stage-files.sh (auto-stage)
  ↓
Display: ✅ Auto-staged X modified file(s)
```

### 4. Modified File Count Alert

**Trigger**: Every time user submits a new prompt

**Script**: `check-modified-files.sh`

**Features**:
- Checks current modified file count (staged + unstaged)
- Issues warning when file count > 10
- Reminds user to commit code promptly

**Warning Example**:
```
⚠️  WARNING: 15 file(s) have been modified
Consider committing your changes to avoid losing work!

To commit, run:
  git add -A
  git commit -m "<commit message>"
```

---

### 5. Session Start Reminder

**Trigger**: Every time a new Claude Code session starts

**Script**: `session-start.sh`

**Features**:
- Shows scenario-based guideline references (on-demand approach)
- Groups guidelines by work context (coding, committing, documenting, reviewing)
- Provides direct commands to view relevant guidelines
- Covers all 6 agent guideline files

**Output Example**:
```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📋 开发规范 - 按需查阅
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

💻 编写代码时：
  cat .claude/agents/code-standards.md
  cat .claude/agents/architecture-principles.md

📝 提交代码时：
  cat .claude/agents/commit-guidelines.md
...
```

---

## 📁 File Descriptions

- `session-start.sh` - **NEW** Session start reminder for development standards
- `auto-stage-files.sh` - Auto-stage modified files
- `check-modified-files.sh` - Check and alert on modified file count
- `README.md` - This document

---

## 🔧 Configuration File

Shared configuration: `.claude/settings.json`

Machine-specific permissions belong in the Git-ignored
`.claude/settings.local.json`. Never put tokens, passwords, or other credentials
in either file.

```json
{
  "permissions": {
    "deny": ["Bash(git restore:*)", ...],
    "ask": ["Bash(git reset:*)", ...]
  },
  "hooks": {
    "PostToolUse": [...],
    "UserPromptSubmit": [...]
  }
}
```

---

## ✅ Testing & Verification

Test if dangerous commands are blocked:
```bash
# These commands should be automatically rejected
git restore .
git reset --hard HEAD
rm -rf test/
```

Test auto-staging feature:
```bash
# After modifying a file, check
git status
# Should see file in staging area
```

Test file count alert:
```bash
# Create 10+ modified files
# Enter any prompt in Claude Code
# Should see warning message
```

---

## 🚨 Emergency Procedures

If you need to temporarily disable safety protection:

1. **Disable all hooks** (NOT recommended):
   ```json
   "disableAllHooks": true
   ```

2. **Temporarily remove dangerous command restrictions** (STRONGLY NOT recommended):
   Do not weaken the shared `deny` list. If the operation is unavoidable, run it
   manually in a terminal after reviewing its exact target.

3. **Execute manually in terminal**:
   If you truly need to execute dangerous operations, do it manually in VSCode terminal, not through Claude Code

---

## 📝 Maintenance Log

- 2026-08-07: Moved the shared hook and command safety baseline to
  `.claude/settings.json`; local settings are now ignored and must not contain
  credentials

- 2025-11-13 14:10:00: Directory renamed from `scripts/` to `hooks/`
  - Added SessionStart hook for development standards reminder
  - Updated all path references in settings.local.json
  - Enhanced README documentation

- 2025-11-05 16:30:00: Initial version, added basic safety protection
  - Blocked 8 dangerous commands
  - Requires confirmation for 5 high-risk commands
  - Auto-stage modified files
  - 10+ file modification alert

---

**Maintainer**: DuLiDay Team
