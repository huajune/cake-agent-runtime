#!/usr/bin/env node

/**
 * 使用 OpenAI-compatible Chat Completions 将 PR 信息整理为发布日志结构。
 *
 * 这个脚本只负责 LLM 调用和 JSON 输出；调用方负责失败兜底。
 */

const MAX_INPUT_CHARS = 24000;
const REQUEST_TIMEOUT_MS = Number(process.env.RELEASE_NOTES_LLM_TIMEOUT_MS || 45000);

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});

async function main() {
  const input = await readStdinJson();
  const apiKey = requiredEnv('RELEASE_NOTES_LLM_API_KEY');
  const baseUrl = requiredEnv('RELEASE_NOTES_LLM_BASE_URL');
  const model = normalizeModel(requiredEnv('RELEASE_NOTES_LLM_MODEL'));
  const endpoint = buildChatCompletionsUrl(baseUrl);
  const messages = buildMessages(input);
  const payload = {
    model,
    messages,
    response_format: { type: 'json_object' },
  };
  if (process.env.RELEASE_NOTES_LLM_TEMPERATURE) {
    payload.temperature = Number(process.env.RELEASE_NOTES_LLM_TEMPERATURE);
  }

  const response = await requestChatCompletion(endpoint, apiKey, payload);
  const content = extractMessageContent(response);
  const parsed = parseJsonObject(content);

  process.stdout.write(`${JSON.stringify(normalizeSections(parsed))}\n`);
}

function requiredEnv(name) {
  const value = (process.env[name] || '').trim();
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function normalizeModel(model) {
  const value = String(model || '').trim();
  if (!value.includes('/')) {
    return value;
  }
  return value.split('/').pop();
}

async function readStdinJson() {
  let raw = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) {
    raw += chunk;
  }

  if (!raw.trim()) {
    throw new Error('empty release input');
  }

  return JSON.parse(raw);
}

function buildMessages(input) {
  return [
    {
      role: 'system',
      content: [
        '你是蛋糕私域托管项目的发布经理，负责把 PR 变更整理成中文发版日志。',
        '你必须只根据输入的 PR 标题、PR body、commit message、文件列表总结，不要编造。',
        '输出必须是严格 JSON，不要 Markdown，不要解释。',
      ].join('\n'),
    },
    {
      role: 'user',
      content: buildPrompt(input),
    },
  ];
}

function buildPrompt(input) {
  const compactInput = truncateText(JSON.stringify(input, null, 2), MAX_INPUT_CHARS);

  return [
    '请把下面的 PR 信息整理成发布日志 JSON：',
    '',
    compactInput,
    '',
    '输出 schema：',
    '{',
    '  "businessUpdates": ["会直接进入飞书发版卡片的候选人/运营可感知改动"],',
    '  "summary": ["一句话业务摘要，覆盖重要 commit"],',
    '  "features": ["候选人或运营可感知的新能力/行为变化"],',
    '  "fixes": ["候选人或运营可感知的问题修复/误判降低/稳定性修复"],',
    '  "optimizations": ["不适合放进发版卡片、但值得记录的技术优化"],',
    '  "ops": ["CI/CD、告警、运维、发布流程变化"],',
    '  "config": ["环境变量或配置变化"],',
    '  "verification": ["验证记录"]',
    '}',
    '',
    '要求：',
    '1. businessUpdates 会直接进入飞书发版卡片的“业务改动（候选人/运营可感知）”，必须尽量完整覆盖候选人/运营能感知的 commit；features/fixes 仍按类别拆分保存。',
    '2. 读 commit message 时要逐条判断业务含义，不要只看 PR title。',
    '3. 每条控制在 14-36 个中文字符左右；可以保留必要的英文标识，例如 Vision、Agent、Dashboard、reply-fact-guard。',
    '4. 不要输出 PR 编号、作者、文件路径、测试命令，也不要输出“无/暂无”。',
    '5. 如果一个技术改动会影响运营排查或候选人体验，放到 features 或 fixes，不要丢到 optimizations。',
    '6. 合并重复项；不要把同一件事拆成过碎的多条，也不要把多件重要业务改动压成一条。',
  ].join('\n');
}

function buildChatCompletionsUrl(baseUrl) {
  const trimmed = baseUrl.trim().replace(/\/+$/, '');
  if (/\/chat\/completions$/i.test(trimmed)) {
    return trimmed;
  }
  if (/\/v1$/i.test(trimmed)) {
    return `${trimmed}/chat/completions`;
  }
  return `${trimmed}/v1/chat/completions`;
}

async function requestChatCompletion(endpoint, apiKey, payload) {
  try {
    return await postJson(endpoint, apiKey, payload);
  } catch (error) {
    if (!/HTTP (400|422)/.test(error.message)) {
      throw error;
    }

    const retryPayload = { ...payload };
    delete retryPayload.response_format;
    return postJson(endpoint, apiKey, retryPayload);
  }
}

async function postJson(endpoint, apiKey, payload) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const text = await response.text();

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${truncateText(text, 500)}`);
    }

    return JSON.parse(text);
  } finally {
    clearTimeout(timeout);
  }
}

function extractMessageContent(response) {
  const content = response?.choices?.[0]?.message?.content;
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === 'string' ? part : part?.text || ''))
      .join('')
      .trim();
  }
  throw new Error('LLM response did not contain message content');
}

function parseJsonObject(content) {
  const trimmed = String(content || '').trim();
  if (!trimmed) {
    throw new Error('LLM returned empty content');
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    const codeBlockMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (codeBlockMatch) {
      return JSON.parse(codeBlockMatch[1]);
    }

    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start >= 0 && end > start) {
      return JSON.parse(trimmed.slice(start, end + 1));
    }
  }

  throw new Error('LLM returned invalid JSON');
}

function normalizeSections(value) {
  const source = value && typeof value === 'object' ? value : {};
  const keys = [
    'businessUpdates',
    'summary',
    'features',
    'fixes',
    'optimizations',
    'ops',
    'config',
    'verification',
  ];
  const result = {};

  for (const key of keys) {
    result[key] = normalizeLines(source[key]);
  }

  return result;
}

function normalizeLines(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return Array.from(
    new Set(
      value
        .map((item) =>
          String(item || '')
            .replace(/^\s*(?:[-*+]\s+|\d+\.\s+)/, '')
            .trim(),
        )
        .filter(Boolean)
        .filter((item) => !/^(?:无|暂无|none|n\/a|待补充)$/i.test(item)),
    ),
  );
}

function truncateText(text, maxLength) {
  const value = String(text || '');
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength)}\n...[truncated]`;
}
