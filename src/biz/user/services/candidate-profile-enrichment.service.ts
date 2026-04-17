import { Injectable } from '@nestjs/common';
import { CustomerService } from '@wecom/customer/customer.service';

export interface CandidateGenderLookupParams {
  token?: string;
  imBotId?: string;
  imContactId?: string;
  wecomUserId?: string;
  externalUserId?: string;
}

@Injectable()
export class CandidateProfileEnrichmentService {
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

    const detail = await this.customerService.getCustomerDetailV2({
      token,
      imBotId,
      imContactId,
      wecomUserId,
      externalUserId,
    });

    return this.normalizeGenderValue(detail?.data?.gender);
  }

  private normalizeGenderValue(value: unknown): '男' | '女' | null {
    if (typeof value === 'number') {
      if (value === 1) return '男';
      if (value === 2) return '女';
      return null;
    }

    if (typeof value !== 'string') {
      return null;
    }

    const text = value.trim();
    if (!text) return null;
    if (text === '1') return '男';
    if (text === '2') return '女';
    if (/^(male|man)$/i.test(text)) return '男';
    if (/^(female|woman)$/i.test(text)) return '女';
    if (/(^|[^女])男/.test(text)) return '男';
    if (/女/.test(text)) return '女';
    return null;
  }
}
