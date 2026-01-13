/**
 * 飞书多维表格配置（支持多表）
 * 目前仅配置聊天记录表，如需扩展可在 tables 下新增。
 */
export interface FeishuBitableTableConfig {
  appToken: string;
  tableId: string;
}

/**
 * 测试集表字段名配置
 * 用于回写飞书时定位正确的字段
 */
export interface TestSuiteFieldNames {
  testStatus: string; // 测试状态（单选）
  lastTestTime: string; // 最近测试时间（日期时间）
  testBatch: string; // 测试批次（文本）
  failureCategory: string; // 失败分类（单选）- 测试场景分类
  errorReason: string; // 错误原因（单选）- Agent 错误归因
}

export interface FeishuBitableConfig {
  appId: string;
  appSecret: string;
  tables: {
    chat: FeishuBitableTableConfig;
    badcase: FeishuBitableTableConfig;
    goodcase: FeishuBitableTableConfig;
    testSuite: FeishuBitableTableConfig;
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
      // 测试集表（汇总表）
      appToken: 'WXQgb98iPauYsHsSYzMckqHcnbb',
      tableId: 'tblCRHFQqqJDJeSx',
    },
  },
};

/**
 * 测试集表字段名配置
 * 如飞书表格字段名变化，只需修改此处
 */
export const testSuiteFieldNames: TestSuiteFieldNames = {
  testStatus: '测试状态',
  lastTestTime: '最近测试时间',
  testBatch: '测试批次',
  failureCategory: '分类',
  errorReason: '错误原因',
};
