/**
 * 收资表单的持久化编排：loadOrCreate / persist / phone 到达 rebind。
 *
 * 职责边界：本服务**不做任何字段判断**——改表只经 `@resolution/collection` 的写路径
 * 纯函数（CLAUDE.md：memory 只持有事实，不实现字段判断）。这里只管从哪读、写到哪、
 * 人键变了怎么搬家。
 */

import { Injectable, Logger } from '@nestjs/common';
import {
  createForm,
  SESSION_CANDIDATE_REF,
  type BookingCollectionForm,
  type ContractFieldDef,
} from '@resolution/collection';
import { isStorableCandidatePhone } from '@resolution/candidate/phone';
import { CollectionFormStore } from '../stores/collection-form.store';

export interface CollectionFormScope {
  corpId: string;
  userId: string;
  jobId: number;
}

@Injectable()
export class CollectionFormService {
  private readonly logger = new Logger(CollectionFormService.name);

  constructor(private readonly store: CollectionFormStore) {}

  /**
   * 取当前表单；没有就按契约开一张空表。
   *
   * 读取顺序是人键优先：手机号已知就读人键表，读不到再回落 'session' 默认表——
   * 这样"先聊了半天才给手机号"的会话不会在 rebind 前后各丢一次进度。
   *
   * **契约漂移的处理**：读回来的表单可能是按旧契约开的（运营中途改了配置）。
   * 契约里新增的槽位补进来（不然新字段永远收不到），契约里已消失的槽位原样留着
   * ——留着的槽位不进 booking payload、不参与 verdictOf 的 empty 判定，
   * 但它承载着候选人已经答过的话，删掉等于把人家说过的话扔了。
   */
  async loadOrCreate(
    scope: CollectionFormScope,
    contract: readonly ContractFieldDef[],
    candidatePhone?: string | null,
  ): Promise<BookingCollectionForm> {
    const candidateRef = normalizeCandidateRef(candidatePhone);

    const existing =
      (candidateRef !== SESSION_CANDIDATE_REF
        ? await this.store.read({ ...scope, candidateRef })
        : null) ?? (await this.store.read({ ...scope, candidateRef: SESSION_CANDIDATE_REF }));

    if (!existing) {
      return createForm({ candidateRef, jobId: scope.jobId, contract });
    }
    return this.syncContractSlots(existing, contract);
  }

  async persist(scope: CollectionFormScope, form: BookingCollectionForm): Promise<void> {
    await this.store.write(scope, form);
  }

  /**
   * 手机号到达时把 'session' 默认表搬到人键表（D1）。
   *
   * 搬家而非重开：候选人往往是先答了姓名年龄、最后才给手机号，重开等于前面全白问。
   * 旧 key 写完新 key 后删，中间崩了最坏是留一份孤儿 session 表，随 TTL 过期。
   */
  async rebindToPhone(
    scope: CollectionFormScope,
    form: BookingCollectionForm,
    phone: string,
  ): Promise<BookingCollectionForm> {
    const candidateRef = normalizeCandidateRef(phone);
    if (candidateRef === SESSION_CANDIDATE_REF || form.candidateRef === candidateRef) {
      return form;
    }
    const previousRef = form.candidateRef;
    const rebound: BookingCollectionForm = { ...form, candidateRef };
    await this.store.write(scope, rebound);
    await this.store.remove({ ...scope, candidateRef: previousRef });
    this.logger.log(
      `[collection-form] 人键 rebind: ${previousRef} → ${candidateRef} (job=${scope.jobId})`,
    );
    return rebound;
  }

  /** 按最新契约补齐槽位；已有槽位一格不动（含它承载的候选人原话）。 */
  private syncContractSlots(
    form: BookingCollectionForm,
    contract: readonly ContractFieldDef[],
  ): BookingCollectionForm {
    const added = contract.filter((field) => !form.slots[field.labelId]);
    if (added.length === 0) return form;

    const slots = { ...form.slots };
    for (const field of added) {
      slots[field.labelId] = { labelId: field.labelId, state: 'empty', askCount: 0 };
    }
    this.logger.log(
      `[collection-form] 契约新增槽位补入: ${added.map((field) => field.labelId).join(',')}`,
    );
    return { ...form, slots };
  }
}

/** 人键归一：11 位可存手机号才作人键，否则回落会话默认表。 */
function normalizeCandidateRef(phone: string | null | undefined): string {
  const digits = (phone ?? '').replace(/\D/gu, '');
  return isStorableCandidatePhone(digits) ? digits : SESSION_CANDIDATE_REF;
}
