/**
 * 生产会话 6a75aab3ce406a6aee711d22 的脱敏策展形态。
 *
 * 只保留触发收资重发表的结构，不携带候选人姓名、电话等个人信息；同一份 fixture
 * 同时供收资策略与 job-list 工具回归测试使用，避免“策展集”和执行断言两套语料漂移。
 */
export const COLLECTION_FLOW_DEDUP_6A75AAB3 = {
  caseId: 'SCN-COLLECTION-DEDUP-6A75AAB3',
  caseName: '发过收资表后追问岗位细节，只回答并催缺口',
  sourceTrace: {
    chatIds: ['6a75aab3ce406a6aee711d22'],
  },
  history: [
    {
      role: 'assistant',
      content: [
        '需要补充下列资料，我来帮你约面试：',
        '姓名：',
        '联系电话：',
        '年龄：25',
        '性别：男',
        '身份（学生/社会人士）：社会人士',
        '学历：',
        '健康证：有/无',
        '学信网学籍状态：',
      ].join('\n'),
    },
  ],
  userMessage: '休息多久\n有饭么',
  expected: {
    replyOrder: ['answer_job_details', 'remind_missing_only'],
    forbidden: ['resend_full_collection_template'],
  },
} as const;
