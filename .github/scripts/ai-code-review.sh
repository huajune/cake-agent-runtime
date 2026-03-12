#!/bin/bash

set -e

# AI Code Review Script
# This script calls Claude Code CLI to review code changes

DIFF_FILE="$1"
OUTPUT_FILE="$2"

# 检查参数
if [ -z "$DIFF_FILE" ] || [ -z "$OUTPUT_FILE" ]; then
  echo "Usage: $0 <diff_file> <output_file>"
  exit 1
fi

# 检查 API Key
if [ -z "$ANTHROPIC_API_KEY" ]; then
  echo "⚠️  ANTHROPIC_API_KEY not configured, skipping AI review"
  echo "⚠️ AI review was skipped (ANTHROPIC_API_KEY not configured)" > "$OUTPUT_FILE"
  echo "" >> "$OUTPUT_FILE"
  echo "To enable AI code review, please add your Anthropic API key as a repository secret named \`ANTHROPIC_API_KEY\`." >> "$OUTPUT_FILE"
  exit 0
fi

# 读取 diff 内容
DIFF_CONTENT=$(cat "$DIFF_FILE")

# 读取项目规范（如果存在）
PROJECT_RULES=""
if [ -f ".cursorrules" ]; then
  PROJECT_RULES=$(cat .cursorrules | head -c 10000)
fi

# 构建审查提示词
REVIEW_PROMPT="You are an expert code reviewer for a NestJS TypeScript project.

Project Context:
- Tech Stack: NestJS 10.3, TypeScript 5.3, Node.js 20+
- Architecture: DDD layered architecture with 4 business domains
- This is an enterprise WeChat intelligent service middleware

Project Coding Standards:
${PROJECT_RULES}

Please review the following code changes and provide:
1. **Critical Issues** (bugs, security, performance problems)
2. **Code Quality** (TypeScript best practices, NestJS patterns)
3. **Architecture Concerns** (violations of DDD principles, wrong layer usage)
4. **Suggestions** (improvements, optimizations)

Focus on:
- TypeScript strict typing (no any abuse)
- NestJS dependency injection patterns
- Proper error handling
- Security issues (hardcoded secrets, SQL injection, XSS)
- Performance issues
- Code maintainability

Code Changes:
\`\`\`diff
${DIFF_CONTENT}
\`\`\`

Provide your review in markdown format with clear sections."

# 使用 Claude Code CLI 执行审查
REVIEW_TEXT=$(claude -p "$REVIEW_PROMPT" 2>/tmp/claude-error.txt)
EXIT_CODE=$?

if [ $EXIT_CODE -ne 0 ]; then
  ERROR_MSG=$(cat /tmp/claude-error.txt 2>/dev/null || echo "Unknown error")
  echo "❌ AI Review Failed" > "$OUTPUT_FILE"
  echo "" >> "$OUTPUT_FILE"
  echo "**Error:** $ERROR_MSG" >> "$OUTPUT_FILE"
  rm -f /tmp/claude-error.txt
  exit 1
fi

rm -f /tmp/claude-error.txt

# 验证审查结果不为空
if [ -z "$REVIEW_TEXT" ]; then
  echo "❌ AI review returned empty response" > "$OUTPUT_FILE"
  echo "" >> "$OUTPUT_FILE"
  echo "Please check the ANTHROPIC_API_KEY secret is valid." >> "$OUTPUT_FILE"
  exit 1
fi

# 保存审查结果
echo "$REVIEW_TEXT" > "$OUTPUT_FILE"

echo "✅ AI review completed successfully"
