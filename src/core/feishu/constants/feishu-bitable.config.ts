/**
 * 飞书多维表格配置（支持多表）
 * 目前仅配置聊天记录表，如需扩展可在 tables 下新增。
 */
export interface FeishuBitableTableConfig {
  appToken: string;
  tableId: string;
}

/**
 * 测试/验证集表字段名配置
 * 用于回写飞书时定位正确的字段
 */
export interface TestSuiteFieldNames {
  testStatus: string; // 测试状态（单选）
  lastTestTime: string; // 最近测试时间（日期时间）
  testBatch: string; // 测试批次（文本）
  failureCategory: string; // 失败分类（单选）- 测试场景分类
  errorReason: string; // 错误原因（单选）- Agent 错误归因
  similarityScore?: string; // 相似度分数（数字）- 回归验证平均相似度
}

export interface FeishuBitableConfig {
  appId: string;
  appSecret: string;
  tables: {
    chat: FeishuBitableTableConfig;
    badcase: FeishuBitableTableConfig;
    goodcase: FeishuBitableTableConfig;
    testSuite: FeishuBitableTableConfig;
    validationSet: FeishuBitableTableConfig;
  };
}

export const feishuBitableConfig: FeishuBitableConfig = {
  // 飞书开放平台应用凭证
  appId: 'cli_a9ae9bcd92f99cc0',
  appSecret: 'SCcwMAhNyB014U3sBG5BuhhOmfgaDQJg',
  tables: {
    chat: {
      // 聊天记录表
      appToken: 'WXQgb98iPauYsHsSYzMckqHcnbb', // 从 wiki 节点转换得到的实际 bitable token
      tableId: 'tblKNwN8aquh2JAy',
    },
    badcase: {
      // badcase 反馈表
      appToken: 'WXQgb98iPauYsHsSYzMckqHcnbb',
      tableId: 'tbllFuw1BVwpvyrI',
    },
    goodcase: {
      // goodcase 反馈表
      appToken: 'WXQgb98iPauYsHsSYzMckqHcnbb',
      tableId: 'tblmI0UBzhknkIOm',
    },
    testSuite: {
      // 测试/验证集表（汇总表）- 用例测试数据
      appToken: 'WXQgb98iPauYsHsSYzMckqHcnbb',
      tableId: 'tblCRHFQqqJDJeSx',
    },
    validationSet: {
      // 验证集表（回归验证数据）
      // 注意：与 testSuite 在同一个多维表格文档中，只是不同的 sheet
      appToken: 'WXQgb98iPauYsHsSYzMckqHcnbb',
      tableId: 'tblfVcyKmPsFwUhy',
    },
  },
};

/**
 * 测试/验证集表字段名配置
 * 如飞书表格字段名变化，只需修改此处
 */
export const testSuiteFieldNames: TestSuiteFieldNames = {
  testStatus: '测试状态',
  lastTestTime: '最近测试时间',
  testBatch: '测试批次',
  failureCategory: '分类',
  errorReason: '错误原因',
  similarityScore: '相似度分数',
};

/**
 * 验证集表字段名配置
 * 用于回归验证数据的读取和回写
 */
export interface ValidationSetFieldNames {
  participantName: string; // 候选人微信昵称（文本）
  conversation: string; // 完整对话记录（多行文本）
  similarityScore: string; // 相似度分数（数字）
  lastTestTime: string; // 最近测试时间（日期时间）
  testBatch: string; // 测试批次（文本）
  testStatus?: string; // 测试状态（单选，可选）
}

export const validationSetFieldNames: ValidationSetFieldNames = {
  participantName: '候选人微信昵称',
  conversation: '完整对话记录',
  similarityScore: '相似度分数',
  lastTestTime: '最近测试时间',
  testBatch: '测试批次',
  testStatus: '测试状态',
};
