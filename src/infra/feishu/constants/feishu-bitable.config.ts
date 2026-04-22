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
  testStatus: string[]; // 测试状态（单选）
  lastTestTime: string[]; // 最近测试时间（日期时间）
  testBatch: string[]; // 测试批次（文本）
  failureCategory: string[]; // 失败分类（单选）- 测试场景分类
  errorReason: string[]; // 错误原因（单选）- Agent 错误归因
  similarityScore?: string[]; // 相似度分数（数字）- 回归验证平均相似度
}

export interface FeishuBitableConfig {
  tables: {
    chat: FeishuBitableTableConfig;
    badcase: FeishuBitableTableConfig;
    goodcase: FeishuBitableTableConfig;
    testSuite: FeishuBitableTableConfig;
    validationSet: FeishuBitableTableConfig;
    assetRelation: FeishuBitableTableConfig;
  };
}

export const feishuBitableConfig: FeishuBitableConfig = {
  tables: {
    chat: {
      // 聊天记录表
      appToken: 'WXQgb98iPauYsHsSYzMckqHcnbb', // 从 wiki 节点转换得到的实际 bitable token
      tableId: 'tblKNwN8aquh2JAy',
    },
    badcase: {
      // badcase 反馈表
      appToken: 'C0Y0bTzEga4dFQsmwlycaWvrn3c',
      tableId: 'tblZGWZguvorS36f',
    },
    goodcase: {
      // goodcase 反馈表
      appToken: 'C0Y0bTzEga4dFQsmwlycaWvrn3c',
      tableId: 'tblpV01GZ7tQVoFp',
    },
    testSuite: {
      // 测试/验证集表（汇总表）- 用例测试数据
      appToken: 'C0Y0bTzEga4dFQsmwlycaWvrn3c',
      tableId: 'tbltUtkNvnMa2zCh',
    },
    validationSet: {
      // 验证集表（回归验证数据）
      // 注意：与 testSuite 在同一个多维表格文档中，只是不同的 sheet
      appToken: 'C0Y0bTzEga4dFQsmwlycaWvrn3c',
      tableId: 'tbleJIWf910JDTDn',
    },
    assetRelation: {
      // 正式资产血缘/关联表
      appToken: 'C0Y0bTzEga4dFQsmwlycaWvrn3c',
      tableId: 'tbl9FV9CHRrg3fGy',
    },
  },
};

/**
 * 测试/验证集表字段名配置
 * 如飞书表格字段名变化，只需修改此处
 */
export const testSuiteFieldNames: TestSuiteFieldNames = {
  testStatus: ['测试状态'],
  lastTestTime: ['最近测试时间', '最近测试时间 (1)'],
  testBatch: ['测试批次'],
  failureCategory: ['分类', '错误分类'],
  errorReason: ['错误原因', '失败原因'],
  similarityScore: ['相似度分数', '平均相似度'],
};

/**
 * 验证集表字段名配置
 * 用于回归验证数据的读取和回写
 */
export interface ValidationSetFieldNames {
  participantName: string[]; // 候选人微信昵称（文本）
  conversation: string[]; // 完整对话记录（多行文本）
  similarityScore: string[]; // 相似度分数（数字）
  minSimilarityScore?: string[]; // 最低分（数字）
  evaluationSummary?: string[]; // 评估摘要（文本）
  factualAccuracy?: string[]; // 事实正确（数字）
  responseEfficiency?: string[]; // 提问效率（数字）
  processCompliance?: string[]; // 流程合规（数字）
  toneNaturalness?: string[]; // 话术自然（数字）
  lastTestTime: string[]; // 最近测试时间（日期时间）
  testBatch: string[]; // 测试批次（文本）
  testStatus?: string[]; // 测试状态（单选，可选）
}

export const validationSetFieldNames: ValidationSetFieldNames = {
  participantName: ['候选人微信昵称', '候选人姓名', '参与者', '姓名'],
  conversation: ['完整对话记录', '聊天记录', '对话记录', 'conversation', 'full_conversation'],
  similarityScore: ['相似度分数', '平均相似度'],
  minSimilarityScore: ['最低分'],
  evaluationSummary: ['评估摘要'],
  factualAccuracy: ['事实正确'],
  responseEfficiency: ['提问效率'],
  processCompliance: ['流程合规'],
  toneNaturalness: ['话术自然'],
  lastTestTime: ['最近测试时间', '最近测试时间 (1)'],
  testBatch: ['测试批次'],
  testStatus: ['测试状态'],
};
