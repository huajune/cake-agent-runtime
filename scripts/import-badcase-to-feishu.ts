import axios, { type AxiosInstance } from 'axios';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { feishuBitableConfig } from '../src/infra/feishu/constants/feishu-bitable.config';

type Role = 'user' | 'assistant';

type BadcaseRecord = {
  id: string;
  caseName: string;
  category?: string;
  userMessage: string;
  remark?: string;
  chatHistory?: string;
  markedAsTestSet?: boolean;
};

type BadcasePayload = {
  total: number;
  records: BadcaseRecord[];
};

type BitableField = {
  field_id: string;
  field_name: string;
  type: number;
};

type BitableRecord = {
  record_id: string;
  fields: Record<string, unknown>;
};

type RawMessage = {
  timestamp?: string;
  name: string;
  content: string;
};

type ParsedMessage = {
  role: Role;
  content: string;
};

type GeneratedCase = {
  caseName: string;
  category: string;
  message: string;
  historyText: string;
  expectedOutput: string;
  sourceId: string;
};

const TABLE_CONFIG = feishuBitableConfig.tables.testSuite;

const FIELD_ALIASES = {
  caseName: ['用例名称', '名称', 'case_name', 'name', '测试用例', '标题'],
  message: ['用户消息', '消息', 'message', '输入', 'input', '问题', 'question'],
  category: ['分类', '类别', 'category', '场景', '标签', 'tag', '错误类型'],
  history: ['聊天记录', '历史记录', '对话历史', 'history', '上下文', 'context'],
  expectedOutput: ['预期输出', '预期答案', 'expected', 'expected_output', '答案', 'answer'],
} as const;

const CATEGORY_ACCEPTANCE: Record<string, string> = {
  '2-地区识别错误': '已有明确地区或商圈线索时，应直接按该线索查岗或推荐，不要反问城市。',
  '3-岗位推荐问题': '已有足够查岗线索时，应直接推荐或查询，不要追加品牌、行业等非必要追问。',
  '4-情绪处理不当': '先接住候选人的情绪或限制，再给替代方案，不要机械推进流程。',
  '5-预约流程出错':
    '涉及约面时间或报名资料时，应先按当前岗位规则校验，并一次性收集当前需要的信息。',
  '6-其他': '避免复现反馈中提到的开场废话、重复昵称、自我限缩或兜圈子问题。',
  未分类: '回复应避免复现该 badcase 中指出的问题。',
};

const ANY_BRACKET_LINE_PATTERN = /^\[(\d{2}\/\d{2}\s+\d{2}:\d{2})\s+([^\]]+)\]\s*(.*)$/;

function parseArgs() {
  const args = process.argv.slice(2);
  return {
    apply: args.includes('--apply'),
    deleteLegacy: args.includes('--delete-legacy'),
    envPath: path.resolve(process.cwd(), '.env.local'),
    filePath: path.resolve(process.cwd(), 'data/badcase/badcase.json'),
  };
}

function parseEnv(filePath: string): Record<string, string> {
  return Object.fromEntries(
    fs
      .readFileSync(filePath, 'utf8')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'))
      .map((line) => {
        const index = line.indexOf('=');
        return index >= 0 ? [line.slice(0, index), line.slice(index + 1)] : [line, ''];
      }),
  );
}

function readBadcasePayload(filePath: string): BadcasePayload {
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as BadcasePayload;
}

function explicitRoleFromName(name: string): Role | null {
  if (/(候选人|candidate|用户)/iu.test(name)) return 'user';
  if (/(招募经理|经理|assistant|ai|招聘助手)/iu.test(name)) return 'assistant';
  return null;
}

function unwrapBracketContent(text: string): string {
  let current = text.trim();
  while (true) {
    const match = current.match(ANY_BRACKET_LINE_PATTERN);
    if (!match) return current.trim();
    current = match[3].trim();
  }
}

function normalizeUserMessage(text: string): string {
  return unwrapBracketContent(text).replace(/\s+/g, ' ').trim();
}

function canonicalize(text: string): string {
  return normalizeUserMessage(text).replace(/\s+/g, '').toLowerCase();
}

function parseChatHistory(rawText?: string): RawMessage[] {
  if (!rawText?.trim()) return [];

  const lines = rawText.split(/\r?\n/);
  const messages: RawMessage[] = [];
  let current: RawMessage | null = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const match = trimmed.match(ANY_BRACKET_LINE_PATTERN);
    if (match) {
      if (current) messages.push(current);
      current = {
        timestamp: match[1],
        name: match[2].trim(),
        content: unwrapBracketContent(match[3]),
      };
      continue;
    }

    if (current) {
      current.content += `\n${trimmed}`;
    }
  }

  if (current) messages.push(current);
  return messages;
}

function inferRoles(messages: RawMessage[]): ParsedMessage[] {
  const nameRoleMap = new Map<string, Role>();
  const parsed: ParsedMessage[] = [];
  let previousRole: Role | null = null;
  let previousName: string | null = null;

  for (const message of messages) {
    let role = explicitRoleFromName(message.name) ?? nameRoleMap.get(message.name) ?? null;

    if (!role) {
      if (!previousRole) {
        role = 'user';
      } else if (previousName && previousName === message.name) {
        role = previousRole;
      } else {
        role = previousRole === 'user' ? 'assistant' : 'user';
      }
    }

    nameRoleMap.set(message.name, role);
    parsed.push({
      role,
      content: message.content.trim(),
    });
    previousRole = role;
    previousName = message.name;
  }

  return mergeConsecutiveMessages(parsed);
}

function mergeConsecutiveMessages(messages: ParsedMessage[]): ParsedMessage[] {
  if (messages.length === 0) return [];

  const merged: ParsedMessage[] = [{ ...messages[0] }];
  for (let i = 1; i < messages.length; i++) {
    const current = messages[i];
    const previous = merged[merged.length - 1];

    if (previous.role === current.role) {
      previous.content = `${previous.content}\n${current.content}`.trim();
    } else {
      merged.push({ ...current });
    }
  }

  return merged;
}

function splitHistoryAndMessage(record: BadcaseRecord): {
  message: string;
  history: ParsedMessage[];
} {
  const normalizedMessage = normalizeUserMessage(record.userMessage);
  const parsedHistory = inferRoles(parseChatHistory(record.chatHistory));
  const canonicalMessage = canonicalize(normalizedMessage);

  for (let i = parsedHistory.length - 1; i >= 0; i--) {
    const message = parsedHistory[i];
    if (message.role !== 'user') continue;

    if (canonicalize(message.content) === canonicalMessage) {
      return {
        message: normalizeUserMessage(message.content),
        history: parsedHistory.slice(0, i),
      };
    }
  }

  const lastUserIndex = [...parsedHistory]
    .map((message, index) => ({ message, index }))
    .reverse()
    .find((item) => item.message.role === 'user')?.index;

  if (lastUserIndex != null) {
    return {
      message: normalizedMessage || normalizeUserMessage(parsedHistory[lastUserIndex].content),
      history: parsedHistory.slice(0, lastUserIndex),
    };
  }

  return { message: normalizedMessage, history: [] };
}

function formatHistoryText(history: ParsedMessage[]): string {
  return history
    .map((message) => `${message.role === 'user' ? '候选人' : '招募经理'}: ${message.content}`)
    .join('\n');
}

function buildExpectedOutput(record: BadcaseRecord): string {
  const category = record.category?.trim() || '未分类';
  const lines = [
    `修复目标：${record.remark?.trim() || '避免复现该 badcase 里的错误回复。'}`,
    `验收重点：${CATEGORY_ACCEPTANCE[category] || CATEGORY_ACCEPTANCE.未分类}`,
    `来源：badcase/${record.id}`,
  ];
  return lines.join('\n');
}

function buildGeneratedCase(record: BadcaseRecord): GeneratedCase {
  const { message, history } = splitHistoryAndMessage(record);
  const category = record.category?.trim() || '未分类';

  return {
    caseName: `badcase/${record.caseName || record.id}`,
    category,
    message,
    historyText: formatHistoryText(history),
    expectedOutput: buildExpectedOutput(record),
    sourceId: record.id,
  };
}

function chooseFieldName(fields: BitableField[], aliases: readonly string[]): string | undefined {
  const fieldNames = new Set(fields.map((field) => field.field_name));
  return aliases.find((alias) => fieldNames.has(alias));
}

function getFieldValue(record: BitableRecord, fieldName: string): string {
  const value = record.fields[fieldName];
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.join(', ');
  return value == null ? '' : String(value);
}

class FeishuClient {
  private readonly http: AxiosInstance;
  private readonly appId: string;
  private readonly appSecret: string;
  private token?: string;

  constructor(params: { appId: string; appSecret: string }) {
    this.appId = params.appId;
    this.appSecret = params.appSecret;
    this.http = axios.create({
      baseURL: 'https://open.feishu.cn/open-apis',
      timeout: 15000,
    });
  }

  async getToken(): Promise<string> {
    if (this.token) return this.token;

    const response = await this.http.post('/auth/v3/tenant_access_token/internal', {
      app_id: this.appId,
      app_secret: this.appSecret,
    });

    if (response.data.code !== 0) {
      throw new Error(`获取飞书 Token 失败: ${response.data.msg}`);
    }

    this.token = response.data.tenant_access_token;
    return this.token;
  }

  async getFields(appToken: string, tableId: string): Promise<BitableField[]> {
    const token = await this.getToken();
    const response = await this.http.get(`/bitable/v1/apps/${appToken}/tables/${tableId}/fields`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (response.data.code !== 0) {
      throw new Error(`获取字段失败: ${response.data.msg}`);
    }

    return response.data.data?.items ?? [];
  }

  async getAllRecords(appToken: string, tableId: string): Promise<BitableRecord[]> {
    const token = await this.getToken();
    const records: BitableRecord[] = [];
    let pageToken: string | undefined;

    do {
      const response = await this.http.get(`/bitable/v1/apps/${appToken}/tables/${tableId}/records`, {
        headers: { Authorization: `Bearer ${token}` },
        params: {
          page_size: 100,
          page_token: pageToken,
        },
      });

      if (response.data.code !== 0) {
        throw new Error(`获取记录失败: ${response.data.msg}`);
      }

      records.push(...(response.data.data?.items ?? []));
      pageToken = response.data.data?.page_token;
    } while (pageToken);

    return records;
  }

  async createRecord(
    appToken: string,
    tableId: string,
    fields: Record<string, unknown>,
  ): Promise<string> {
    const token = await this.getToken();
    const response = await this.http.post(
      `/bitable/v1/apps/${appToken}/tables/${tableId}/records`,
      { fields },
      { headers: { Authorization: `Bearer ${token}` } },
    );

    if (response.data.code !== 0) {
      throw new Error(`创建记录失败: ${response.data.msg}`);
    }

    return response.data.data.record.record_id as string;
  }

  async createField(
    appToken: string,
    tableId: string,
    fieldName: string,
    type: number,
  ): Promise<BitableField> {
    const token = await this.getToken();
    const response = await this.http.post(
      `/bitable/v1/apps/${appToken}/tables/${tableId}/fields`,
      {
        field_name: fieldName,
        type,
      },
      { headers: { Authorization: `Bearer ${token}` } },
    );

    if (response.data.code !== 0) {
      throw new Error(`创建字段失败: ${response.data.msg}`);
    }

    return response.data.data.field as BitableField;
  }

  async updateRecord(
    appToken: string,
    tableId: string,
    recordId: string,
    fields: Record<string, unknown>,
  ): Promise<void> {
    const token = await this.getToken();
    const response = await this.http.put(
      `/bitable/v1/apps/${appToken}/tables/${tableId}/records/${recordId}`,
      { fields },
      { headers: { Authorization: `Bearer ${token}` } },
    );

    if (response.data.code !== 0) {
      throw new Error(`更新记录失败: ${response.data.msg}`);
    }
  }

  async deleteRecord(appToken: string, tableId: string, recordId: string): Promise<void> {
    const token = await this.getToken();
    const response = await this.http.delete(
      `/bitable/v1/apps/${appToken}/tables/${tableId}/records/${recordId}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );

    if (response.data.code !== 0) {
      throw new Error(`删除记录失败: ${response.data.msg}`);
    }
  }
}

async function main() {
  const { apply, deleteLegacy, envPath, filePath } = parseArgs();
  const env = parseEnv(envPath);

  if (!env.FEISHU_APP_ID || !env.FEISHU_APP_SECRET) {
    throw new Error(`缺少飞书鉴权配置: ${envPath}`);
  }

  const payload = readBadcasePayload(filePath);
  const generatedCases = payload.records.map(buildGeneratedCase);

  const client = new FeishuClient({
    appId: env.FEISHU_APP_ID,
    appSecret: env.FEISHU_APP_SECRET,
  });

  const fields = await client.getFields(TABLE_CONFIG.appToken, TABLE_CONFIG.tableId);
  const records = await client.getAllRecords(TABLE_CONFIG.appToken, TABLE_CONFIG.tableId);
  let resolvedFields = {
    caseName: chooseFieldName(fields, FIELD_ALIASES.caseName),
    message: chooseFieldName(fields, FIELD_ALIASES.message),
    category: chooseFieldName(fields, FIELD_ALIASES.category),
    history: chooseFieldName(fields, FIELD_ALIASES.history),
    expectedOutput: chooseFieldName(fields, FIELD_ALIASES.expectedOutput),
  };

  if (!resolvedFields.caseName || !resolvedFields.message) {
    throw new Error(
      `testSuite 表缺少必要字段。解析结果: ${JSON.stringify(resolvedFields, null, 2)}`,
    );
  }

  const existingByCaseName = new Map<string, BitableRecord>();
  for (const record of records) {
    const caseName = getFieldValue(record, resolvedFields.caseName);
    if (caseName) existingByCaseName.set(caseName, record);
  }

  const legacyRecords = records.filter((record) => {
    const caseName = getFieldValue(record, resolvedFields.caseName);
    return caseName && !caseName.startsWith('badcase/');
  });

  console.log(
    JSON.stringify(
      {
        mode: deleteLegacy ? (apply ? 'delete-legacy' : 'delete-legacy-dry-run') : apply ? 'apply' : 'dry-run',
        sourceTotal: payload.records.length,
        generatedTotal: generatedCases.length,
        existingRecords: records.length,
        legacyRecords: legacyRecords.length,
        resolvedFields,
        samples: generatedCases.slice(0, 3),
        legacySamples: legacyRecords.slice(0, 10).map((record) => ({
          recordId: record.record_id,
          caseName: getFieldValue(record, resolvedFields.caseName),
        })),
      },
      null,
      2,
    ),
  );

  if (!apply) return;

  if (deleteLegacy) {
    let deleted = 0;
    for (const record of legacyRecords) {
      await client.deleteRecord(TABLE_CONFIG.appToken, TABLE_CONFIG.tableId, record.record_id);
      deleted++;
    }

    console.log(JSON.stringify({ deleted, keptBadcase: records.length - legacyRecords.length }, null, 2));
    return;
  }

  let createdExpectedOutputField = false;
  if (!resolvedFields.expectedOutput) {
    const createdField = await client.createField(
      TABLE_CONFIG.appToken,
      TABLE_CONFIG.tableId,
      '预期输出',
      1,
    );
    fields.push(createdField);
    resolvedFields = {
      ...resolvedFields,
      expectedOutput: chooseFieldName(fields, FIELD_ALIASES.expectedOutput),
    };
    createdExpectedOutputField = true;
  }

  let created = 0;
  let updated = 0;

  for (const testCase of generatedCases) {
    const fieldsToWrite: Record<string, unknown> = {
      [resolvedFields.caseName]: testCase.caseName,
      [resolvedFields.message]: testCase.message,
    };

    if (resolvedFields.category) {
      fieldsToWrite[resolvedFields.category] = testCase.category;
    }
    if (resolvedFields.history) {
      fieldsToWrite[resolvedFields.history] = testCase.historyText;
    }
    if (resolvedFields.expectedOutput) {
      fieldsToWrite[resolvedFields.expectedOutput] = testCase.expectedOutput;
    }

    const existing = existingByCaseName.get(testCase.caseName);
    if (existing) {
      await client.updateRecord(TABLE_CONFIG.appToken, TABLE_CONFIG.tableId, existing.record_id, fieldsToWrite);
      updated++;
      continue;
    }

    const recordId = await client.createRecord(TABLE_CONFIG.appToken, TABLE_CONFIG.tableId, fieldsToWrite);
    existingByCaseName.set(testCase.caseName, {
      record_id: recordId,
      fields: fieldsToWrite,
    });
    created++;
  }

  console.log(
    JSON.stringify(
      {
        created,
        updated,
        total: generatedCases.length,
        createdExpectedOutputField,
        expectedOutputField: resolvedFields.expectedOutput,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
