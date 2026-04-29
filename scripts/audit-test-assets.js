#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const FIELD_ALIASES = {
  stableId: ['用例ID', 'caseId'],
  title: ['用例名称', '标题', '名称'],
  enabled: ['是否启用', '启用'],
  userMessage: ['用户消息'],
  history: ['聊天记录'],
  checkpoint: ['核心检查点'],
  expectedOutput: ['预期输出'],
  category: ['分类'],
};

const TEST_PHONE_NUMBERS = new Set(['13800000000']);

function parseArgs(argv) {
  const args = {
    file: 'tmp/curated-badcase-dataset-draft-20260428-trace-enriched.json',
    out: '',
  };

  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    const value = argv[i + 1];
    if (key === '--file' && value) {
      args.file = value;
      i += 1;
    } else if (key === '--out' && value) {
      args.out = value;
      i += 1;
    } else if (key === '--help') {
      printHelp();
      process.exit(0);
    }
  }

  return args;
}

function printHelp() {
  console.log(`Usage: node scripts/audit-test-assets.js [--file <curated-json>] [--out <report-json>]

Audits curated scenario test assets for common modeling problems:
- missing required fields
- current user message duplicated in history with non-exact text
- unprefixed history lines that import as user messages
- unsanitized phone numbers
- image placeholders without an image/vision fixture
- dynamic expectedOutput without a tool-result boundary
`);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(path.resolve(filePath), 'utf8'));
}

function extractScenarioCases(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload.cases)) return payload.cases;
  if (Array.isArray(payload.scenarioImportPayload?.cases)) {
    return payload.scenarioImportPayload.cases;
  }
  throw new Error('未找到 scenario cases；请传入 cases[] 或 scenarioImportPayload.cases');
}

function normalizeLocalCase(record) {
  return {
    recordId: record.recordId || record.record_id || null,
    caseId: stringValue(record.caseId || record.stableId || record.id),
    caseName: stringValue(record.caseName || record.title || record.name),
    enabled: record.enabled,
    category: stringValue(record.category),
    userMessage: stringValue(record.userMessage || record.message),
    chatHistory: stringValue(record.chatHistory || record.history),
    checkpoint: stringValue(record.checkpoint),
    expectedOutput: stringValue(record.expectedOutput || record.expected),
  };
}

function stringValue(value) {
  if (value === undefined || value === null) return '';
  if (Array.isArray(value)) return value.join('\n');
  return String(value);
}

function parseHistory(historyText) {
  if (!historyText.trim()) return [];

  return historyText
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => parseHistoryLine(line))
    .filter((message) => message.content.trim().length > 0);
}

function parseHistoryLine(line) {
  const bracketMatch = line.match(/^\[[\d/]+ [\d:]+ ([^\]]+)\]\s*(.*)$/);
  if (bracketMatch) {
    const speaker = bracketMatch[1].trim();
    return {
      role: isAssistantSpeaker(speaker) ? 'assistant' : 'user',
      content: bracketMatch[2],
      raw: line,
      unprefixed: false,
    };
  }

  if (/^(user|候选人):/i.test(line)) {
    return {
      role: 'user',
      content: line.replace(/^(user|候选人):\s*/i, ''),
      raw: line,
      unprefixed: false,
    };
  }

  if (/^(AI|assistant|招募经理|招聘经理|客服):/i.test(line)) {
    return {
      role: 'assistant',
      content: line.replace(/^(AI|assistant|招募经理|招聘经理|客服):\s*/i, ''),
      raw: line,
      unprefixed: false,
    };
  }

  return { role: 'user', content: line, raw: line, unprefixed: true };
}

function isAssistantSpeaker(speaker) {
  return ['招募经理', '招聘经理', '经理', '客服', 'AI', 'assistant'].includes(speaker);
}

function findExactCurrentMessageIndex(history, currentMessage) {
  const current = currentMessage.trim();
  if (!current) return -1;

  for (let i = history.length - 1; i >= 0; i -= 1) {
    const message = history[i];
    if (message.role === 'user' && message.content.trim() === current) {
      return i;
    }
  }

  return -1;
}

function findApproxCurrentMessageIndexes(history, currentMessage) {
  return history
    .map((message, index) => ({ message, index }))
    .filter(({ message }) => message.role === 'user' && isSimilar(message.content, currentMessage))
    .map(({ index }) => index);
}

function normalizeForCompare(value) {
  return String(value || '')
    .replace(/\[[^\]]+\]/g, '')
    .replace(/[\s，,。.!！?？：:；;（）()、"“”'‘’👌🏻😂🤣😅🥲😭🥹]+/g, '')
    .toLowerCase();
}

function isSimilar(left, right) {
  const a = normalizeForCompare(left);
  const b = normalizeForCompare(right);
  if (!a || !b) return false;
  if (a === b) return true;
  if (a.length >= 5 && b.length >= 5 && (a.includes(b) || b.includes(a))) return true;
  const maxLength = Math.max(a.length, b.length);
  if (maxLength < 8) return false;
  return 1 - levenshtein(a, b) / maxLength >= 0.82;
}

function levenshtein(left, right) {
  const dp = Array.from({ length: right.length + 1 }, (_, index) => index);

  for (let i = 1; i <= left.length; i += 1) {
    let previous = dp[0];
    dp[0] = i;
    for (let j = 1; j <= right.length; j += 1) {
      const current = dp[j];
      dp[j] = Math.min(
        dp[j] + 1,
        dp[j - 1] + 1,
        previous + (left[i - 1] === right[j - 1] ? 0 : 1),
      );
      previous = current;
    }
  }

  return dp[right.length];
}

function hasDynamicFacts(value) {
  return /(\d+(?:\.\d+)?\s*(?:km|公里|米)|\d+\s*(?:元|块)\s*\/\s*(?:时|小时)|\d{1,2}:\d{2}|周[一二三四五六日天]|门店|地址|薪资|距离|面试|在招|岗位|健康证|年龄|学历|工作餐|员工餐)/.test(
    value,
  );
}

function hasToolBoundary(value) {
  return /(本轮工具|工具结果|动态事实|以.*工具|行为|检查点|不得|必须|应该|期望行为|核心检查点|失败判定|precheck|job_list|geocode|booking|invite_to_group)/i.test(
    value,
  );
}

function findPhoneNumbers(record) {
  return [
    ...JSON.stringify({
      userMessage: record.userMessage,
      chatHistory: record.chatHistory,
      checkpoint: record.checkpoint,
      expectedOutput: record.expectedOutput,
    }).matchAll(/(?<!\d)(1[3-9]\d{9})(?!\d)/g),
  ]
    .map((match) => match[1])
    .filter((phone) => !TEST_PHONE_NUMBERS.has(phone));
}

function auditScenarioCase(record) {
  const history = parseHistory(record.chatHistory);
  const exactCurrentIndex = findExactCurrentMessageIndex(history, record.userMessage);
  const approxCurrentIndexes = findApproxCurrentMessageIndexes(history, record.userMessage);
  const issues = [];
  const warnings = [];

  if (!record.caseId.trim()) issues.push('缺 caseId');
  if (!record.caseName.trim()) issues.push('缺 caseName');
  if (!record.userMessage.trim()) issues.push('缺 userMessage');
  if (!(record.checkpoint + record.expectedOutput).trim()) {
    issues.push('缺 checkpoint/expectedOutput');
  }

  if (exactCurrentIndex < 0 && approxCurrentIndexes.length > 0) {
    issues.push('history 含近似当前消息但无法精确裁剪');
  }

  const unprefixedLines = history.filter((message) => message.unprefixed);
  if (unprefixedLines.length > 0) {
    issues.push('history 有无角色前缀行会被当成用户消息');
  }

  const phones = findPhoneNumbers(record);
  if (phones.length > 0) issues.push('含未脱敏手机号');

  if (/\[图片消息\]/.test(record.userMessage) && !/https?:|data:image|imageUrl|图片描述|OCR|vision|save_image_description/i.test(
    `${record.chatHistory}\n${record.checkpoint}\n${record.expectedOutput}`,
  )) {
    issues.push('图片占位但无图片/描述 fixture');
  }

  if (
    hasDynamicFacts(record.expectedOutput) &&
    !hasToolBoundary(`${record.expectedOutput}\n${record.checkpoint}`)
  ) {
    warnings.push('expectedOutput 含动态事实但缺工具边界');
  }

  if (/生成期间|replay/i.test(`${record.caseName}\n${record.checkpoint}`)) {
    warnings.push('普通 scenario 无法真实模拟生成期间新消息');
  }

  return {
    recordId: record.recordId,
    caseId: record.caseId,
    caseName: record.caseName,
    enabled: record.enabled,
    historyMessages: history.length,
    exactCurrentIndex,
    approxCurrentIndexes,
    issues: Array.from(new Set(issues)),
    warnings: Array.from(new Set(warnings)),
  };
}

function summarize(results) {
  const issueCounts = {};
  const warningCounts = {};
  for (const result of results) {
    for (const issue of result.issues) issueCounts[issue] = (issueCounts[issue] || 0) + 1;
    for (const warning of result.warnings) {
      warningCounts[warning] = (warningCounts[warning] || 0) + 1;
    }
  }

  return {
    total: results.length,
    blocking: results.filter((result) => result.issues.length > 0).length,
    warnings: results.filter((result) => result.warnings.length > 0).length,
    issueCounts,
    warningCounts,
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const payload = readJson(args.file);
  const cases = extractScenarioCases(payload).map(normalizeLocalCase);
  const results = cases.map(auditScenarioCase);
  const report = {
    generatedAt: new Date().toISOString(),
    sourceFile: args.file,
    summary: summarize(results),
    results,
  };

  if (args.out) {
    fs.mkdirSync(path.dirname(path.resolve(args.out)), { recursive: true });
    fs.writeFileSync(path.resolve(args.out), `${JSON.stringify(report, null, 2)}\n`);
  }

  console.log(JSON.stringify(report, null, 2));
  if (report.summary.blocking > 0) {
    process.exitCode = 2;
  }
}

main();
