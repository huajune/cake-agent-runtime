import { Injectable, Logger } from '@nestjs/common';
import { CustomerService } from '@wecom/customer/customer.service';
import { normalizeGenderValue } from '@memory/facts/high-confidence-facts';

export interface CandidateGenderLookupParams {
  token?: string;
  imBotId?: string;
  imContactId?: string;
  wecomUserId?: string;
  externalUserId?: string;
}

@Injectable()
export class CandidateProfileEnrichmentService {
  private readonly logger = new Logger(CandidateProfileEnrichmentService.name);

  constructor(private readonly customerService: CustomerService) {}

  async lookupGenderFromCustomerDetail(
    params: CandidateGenderLookupParams,
  ): Promise<'男' | '女' | null> {
    const token = params.token?.trim();
    const imBotId = params.imBotId?.trim();
    const imContactId = params.imContactId?.trim();
    const wecomUserId = params.wecomUserId?.trim();
    const externalUserId = params.externalUserId?.trim();
    const hasSystemLocator = Boolean(imBotId && imContactId);
    const hasWecomLocator = Boolean(wecomUserId && externalUserId);

    if (!token || (!hasSystemLocator && !hasWecomLocator)) {
      return null;
    }

    try {
      const detail = await this.customerService.getCustomerDetailV2({
        token,
        imBotId,
        imContactId,
        wecomUserId,
        externalUserId,
      });
      return normalizeGenderValue(detail?.data?.gender);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `getCustomerDetailV2 失败，跳过性别补全: ${message} (imBotId=${imBotId ?? '-'}, wecomUserId=${wecomUserId ?? '-'})`,
      );
      return null;
    }
  }
}
