import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { ModelRole } from '@/llm/llm.types';
import { LlmExecutorService } from '@/llm/llm-executor.service';
import type { GuardrailReviewPacket } from './review-packet.types';

export const SEMANTIC_REVIEW_FINDING_CODES = [
  'job_recommendation_not_best_supported',
  'brand_or_geo_ambiguity_ignored',
  'active_booking_state_conflict',
] as const;

const semanticReviewSchema = z.object({
  decision: z.enum(['pass', 'observe', 'revise', 'replan', 'block']),
  confidence: z.enum(['low', 'medium', 'high']),
  findings: z
    .array(
      z.object({
        code: z.enum(SEMANTIC_REVIEW_FINDING_CODES),
        evidencePath: z.string(),
        evidenceQuote: z.string(),
        userImpact: z.string(),
        repairMode: z.enum(['rewrite', 'replan']),
        feedbackToGenerator: z.string(),
      }),
    )
    .default([]),
});

export type SemanticReviewVerdict = z.infer<typeof semanticReviewSchema>;

@Injectable()
export class SemanticReviewerService {
  constructor(private readonly llm: LlmExecutorService) {}

  shouldReview(packet: GuardrailReviewPacket): boolean {
    const reply = packet.draftReply;
    const jobList = packet.evidence.jobList;
    const hasJobRecommendation =
      Boolean(jobList?.jobs.length || jobList?.markdownExcerpt) &&
      /推荐|这家|这个岗位|门店|距离|班次|薪资|地址|报名|预约/.test(reply);
    const hasGeoOrBrandAmbiguity =
      Boolean(packet.evidence.geocode) && /附近|地址|位置|门店|距离|城市|区|路/.test(reply);
    const hasBookingStateClaim =
      Boolean(packet.evidence.booking) && /预约|报名|面试|到店|二维码|地址|时间/.test(reply);
    return hasJobRecommendation || hasGeoOrBrandAmbiguity || hasBookingStateClaim;
  }

  async review(packet: GuardrailReviewPacket): Promise<SemanticReviewVerdict> {
    const result = await this.llm.generateStructured({
      role: ModelRole.Review,
      schema: semanticReviewSchema,
      outputName: 'SemanticOutputGuardrailReview',
      messages: [
        {
          role: 'system',
          content: [
            '你是招聘对话的语义出站守卫，负责最终确认候选人可见回复是否忠实、可发送。',
            '只基于输入里的 evidence packet 判断，不要凭常识补事实。',
            'jobList.markdownExcerpt 是岗位工具返回的 markdown 原文摘录（结构化 jobs 为空时它就是岗位事实的 ground truth，其中"品牌（门店）"格式里括号前是品牌名、括号内是门店名，不要把品牌名误读为城市）。',
            '只检查三类问题：',
            '1. job_recommendation_not_best_supported：岗位推荐与 jobList 证据、距离排序、候选人指定品牌或班次明显冲突。',
            '2. brand_or_geo_ambiguity_ignored：地理或品牌证据不确定，但回复直接下结论。',
            '3. active_booking_state_conflict：booking 证据显示已约/失败/线上线下/面试时间地址等状态，但回复与其冲突或漏关键状态。',
            '裁决要求：',
            '- 每条 finding 必须给出 evidencePath（指向 packet 中的证据字段）和 evidenceQuote（回复原文）。',
            '- feedbackToGenerator 写成可直接执行的改写指令，只描述候选人可见回复该怎么改。',
            '- 如果证据不足，只能 pass 或 observe，不要 revise/replan/block；把握不高时 confidence 填 low。',
          ].join('\n'),
        },
        {
          role: 'user',
          content: JSON.stringify(packet),
        },
      ],
    });

    return result.output as SemanticReviewVerdict;
  }
}
