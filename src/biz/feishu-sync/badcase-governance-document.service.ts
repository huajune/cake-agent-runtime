import { createHash } from 'crypto';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FeishuApiService } from '@infra/feishu/services/api.service';

interface FeishuResponse<T> {
  code: number;
  msg: string;
  data?: T;
}

interface WikiNode {
  obj_type: string;
  obj_token: string;
  title: string;
  space_id: string;
}

interface DocxBlock {
  block_id: string;
  parent_id?: string;
  block_type: number;
  children?: string[];
  [key: string]: unknown;
}

export interface BadcaseGovernanceDocumentItem {
  recordId: string;
  badcaseId?: string;
  title?: string;
  category?: string;
  status: string;
  batchId?: string;
  evidenceSummary?: string;
}

export interface BadcaseGovernanceDocumentUpdate {
  items: BadcaseGovernanceDocumentItem[];
  occurredAt?: Date;
  /**
   * 调用方指定的稳定事件 ID（如每日巡检的 `bcg-daily-triage-20260730`）。
   * 不传则按 items 内容哈希生成。两种命名不会互相去重，同一批变更只能用一种。
   */
  eventId?: string;
  /** 追加成功后是否顺带刷新「一、整体进展」「五、当前剩余问题」的统计数字，默认 true */
  refreshSummary?: boolean;
  /** 刷新统计所需的未解决数分布；缺省则跳过刷新 */
  summaryCounts?: BadcaseOpenCounts;
}

export interface BadcaseOpenCounts {
  待分析: number;
  处理中: number;
  待验证: number;
}

export interface BadcaseSummaryRefreshResult {
  attempted: boolean;
  updatedBlocks: number;
  total: number;
  error?: string;
}

@Injectable()
export class BadcaseGovernanceDocumentService {
  private readonly logger = new Logger(BadcaseGovernanceDocumentService.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly feishuApi: FeishuApiService,
  ) {}

  async checkAccess(): Promise<{
    success: boolean;
    title: string;
    documentId: string;
    blockCount: number;
    insertionIndex: number;
  }> {
    const document = await this.loadDocument();
    return {
      success: true,
      title: document.node.title,
      documentId: document.documentId,
      blockCount: document.blocks.length,
      insertionIndex: document.insertionIndex,
    };
  }

  async appendUpdate(update: BadcaseGovernanceDocumentUpdate): Promise<{
    success: boolean;
    skipped: boolean;
    dryRun: boolean;
    eventId: string;
    summary?: BadcaseSummaryRefreshResult;
    error?: string;
  }> {
    if (update.items.length === 0) {
      return { success: true, skipped: true, dryRun: true, eventId: '' };
    }

    const eventId = update.eventId?.trim() || this.buildEventId(update.items);
    const writeEnabled =
      this.configService.get<string>('BADCASE_GOVERNANCE_DOC_SYNC_ENABLED', 'false') === 'true';
    try {
      const document = await this.loadDocument();
      if (document.blocks.some((block) => this.readBlockText(block).includes(eventId))) {
        // 事件已存在：追加跳过，但统计数字仍要对齐到最新（同日多次运行时数字才不会停在首次的值）
        const summary = await this.refreshSummary(update);
        return { success: true, skipped: true, dryRun: !writeEnabled, eventId, summary };
      }

      // 同日已有小节时追加到它末尾，否则在「四、」之前新建当日小节。
      const dayTitle = this.buildDayTitle(update.occurredAt || new Date());
      const daySectionIndex = this.resolveDaySectionAppendIndex(document, dayTitle);
      const insertAt = daySectionIndex ?? document.insertionIndex;
      const children = this.buildUpdateBlocks(update, eventId, daySectionIndex !== null);
      if (!writeEnabled) {
        this.logger.log(
          `[BadcaseGovernanceDoc] dry-run event=${eventId} items=${update.items.length} ` +
            `index=${insertAt} mode=${daySectionIndex === null ? 'new-section' : 'append-to-day'}`,
        );
        return { success: true, skipped: false, dryRun: true, eventId };
      }

      const response = await this.feishuApi.post<FeishuResponse<Record<string, unknown>>>(
        `/docx/v1/documents/${document.documentId}/blocks/${document.documentId}/children`,
        {
          index: insertAt,
          children,
        },
        { params: { document_revision_id: -1 } },
      );
      if (response.data.code !== 0) {
        throw new Error(`${response.data.code} ${response.data.msg}`);
      }
      this.logger.log(
        `[BadcaseGovernanceDoc] 已追加治理进展 event=${eventId} items=${update.items.length}`,
      );
      const summary = await this.refreshSummary(update);
      return { success: true, skipped: false, dryRun: false, eventId, summary };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`[BadcaseGovernanceDoc] 更新失败 event=${eventId}: ${message}`);
      return { success: false, skipped: false, dryRun: !writeEnabled, eventId, error: message };
    }
  }

  /**
   * 把「一、整体进展」和「五、当前剩余问题」里的统计数字对齐到真实未解决数。
   *
   * 追加式写入只动「三、主要治理批次」，这两处静态数字不改就会逐日变假
   * （7-28 写的 55 到 7-30 已经是 60）。按章节定位后逐块 PATCH，只改数字与更新时间，
   * 不重排结构；任何一处没找到都记 warn 而不是抛错——文档是人和机器共同维护的，
   * 措辞被人改过时应当降级为"少改一处"，不能因此让整次同步失败。
   */
  async refreshSummary(
    update: BadcaseGovernanceDocumentUpdate,
  ): Promise<BadcaseSummaryRefreshResult> {
    const counts = update.summaryCounts;
    if (update.refreshSummary === false || !counts) {
      return { attempted: false, updatedBlocks: 0, total: 0 };
    }
    const total = counts.待分析 + counts.处理中 + counts.待验证;
    const writeEnabled =
      this.configService.get<string>('BADCASE_GOVERNANCE_DOC_SYNC_ENABLED', 'false') === 'true';

    try {
      const document = await this.loadDocument();
      const rewrites = this.collectSummaryRewrites(document, counts, total, update.occurredAt);
      if (rewrites.length === 0) {
        this.logger.warn('[BadcaseGovernanceDoc] 未定位到任何统计数字块，跳过刷新');
        return { attempted: true, updatedBlocks: 0, total };
      }
      if (!writeEnabled) {
        this.logger.log(
          `[BadcaseGovernanceDoc] dry-run 统计刷新 total=${total} blocks=${rewrites.length}`,
        );
        return { attempted: true, updatedBlocks: 0, total };
      }
      for (const rewrite of rewrites) {
        await this.patchBlockText(
          document.documentId,
          rewrite.blockId,
          rewrite.blockType,
          rewrite.text,
        );
      }
      this.logger.log(
        `[BadcaseGovernanceDoc] 统计数字已刷新 total=${total} blocks=${rewrites.length}`,
      );
      return { attempted: true, updatedBlocks: rewrites.length, total };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`[BadcaseGovernanceDoc] 统计刷新失败: ${message}`);
      return { attempted: true, updatedBlocks: 0, total, error: message };
    }
  }

  private collectSummaryRewrites(
    document: { node: WikiNode; documentId: string; blocks: DocxBlock[] },
    counts: BadcaseOpenCounts,
    total: number,
    occurredAt?: Date,
  ): Array<{ blockId: string; blockType: number; text: string }> {
    const blockById = new Map(document.blocks.map((block) => [block.block_id, block]));
    const root = blockById.get(document.documentId);
    // 按文档顺序展开根级块及其后代。
    //
    // 只扫根级会漏掉容器块内部的文本：文档抬头的「当前剩余 N 个未解决问题」与
    // 「更新时间：…」写在高亮块（callout, block_type 19）里，callout 自身没有文本、
    // 文本挂在它的 children 上，因此旧实现的正则永远匹配不到，抬头数字长期停在
    // 首次写入的值（2026-08-06 巡检实测：正文已刷成 39，抬头仍是 65）。
    const order: DocxBlock[] = [];
    const walk = (ids: string[] | undefined, depth: number) => {
      for (const id of ids || []) {
        const block = blockById.get(id);
        if (!block) continue;
        order.push(block);
        if (depth > 0) walk(block.children, depth - 1);
      }
    };
    walk(root?.children, 3);
    // 章节标题恒在根级，展开后仍能正确切分区间。
    const headingIndex = (prefix: string) =>
      order.findIndex(
        (block) => block.block_type === 4 && this.readBlockText(block).startsWith(prefix),
      );
    const sectionThree = headingIndex('三、');
    const sectionFive = headingIndex('五、');

    // 「三、主要治理批次」里逐日追加的条目也可能出现「待分析」等字样，
    // 所以两组规则各自限定扫描区间，绝不跨进批次流水。
    const headRange = order.slice(0, sectionThree >= 0 ? sectionThree : order.length);
    const tailRange = sectionFive >= 0 ? order.slice(sectionFive) : [];

    const dateText = this.formatSummaryDate(occurredAt || new Date());
    const rewrites: Array<{ blockId: string; blockType: number; text: string }> = [];
    const pushFirstMatch = (
      range: DocxBlock[],
      pattern: RegExp,
      replace: (text: string) => string,
    ) => {
      const block = range.find((item) => pattern.test(this.readBlockText(item)));
      if (!block) return;
      const current = this.readBlockText(block);
      const next = replace(current);
      if (next === current) return;
      rewrites.push({ blockId: block.block_id, blockType: block.block_type, text: next });
    };

    pushFirstMatch(headRange, /当前剩余\s*\d+\s*个未解决问题/, (text) =>
      text.replace(/当前剩余\s*\d+\s*个未解决问题/, `当前剩余 ${total} 个未解决问题`),
    );
    pushFirstMatch(headRange, /^更新时间：/, () => `更新时间：${dateText}`);
    pushFirstMatch(tailRange, /目前剩余\s*\d+\s*个未解决问题/, (text) =>
      text.replace(/目前剩余\s*\d+\s*个未解决问题/, `目前剩余 ${total} 个未解决问题`),
    );
    for (const [label, value] of [
      ['待分析', counts.待分析],
      ['处理中', counts.处理中],
      ['待验证', counts.待验证],
    ] as const) {
      const pattern = new RegExp(`^${label}：\\s*\\d+\\s*个`);
      pushFirstMatch(tailRange, pattern, (text) => text.replace(pattern, `${label}：${value} 个`));
    }
    return rewrites;
  }

  private formatSummaryDate(date: Date): string {
    const parts = new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
    }).formatToParts(date);
    const pick = (type: Intl.DateTimeFormatPartTypes) =>
      parts.find((item) => item.type === type)?.value || '';
    return `${pick('year')} 年 ${pick('month')} 月 ${pick('day')} 日`;
  }

  private async patchBlockText(
    documentId: string,
    blockId: string,
    blockType: number,
    text: string,
  ): Promise<void> {
    const response = await this.feishuApi.patch<FeishuResponse<Record<string, unknown>>>(
      `/docx/v1/documents/${documentId}/blocks/${blockId}`,
      {
        update_text_elements: {
          elements: [this.textElement(text)],
        },
      },
      { params: { document_revision_id: -1 } },
    );
    if (response.data.code !== 0) {
      throw new Error(
        `块 ${blockId}(type=${blockType}) 更新失败: ${response.data.code} ${response.data.msg}`,
      );
    }
  }

  private async loadDocument(): Promise<{
    node: WikiNode;
    documentId: string;
    blocks: DocxBlock[];
    insertionIndex: number;
  }> {
    const wikiToken = this.configService
      .get<string>('FEISHU_BADCASE_GOVERNANCE_WIKI_TOKEN', '')
      .trim();
    if (!wikiToken) {
      throw new Error('缺少 FEISHU_BADCASE_GOVERNANCE_WIKI_TOKEN');
    }
    const nodeResponse = await this.feishuApi.get<FeishuResponse<{ node: WikiNode }>>(
      '/wiki/v2/spaces/get_node',
      { params: { token: wikiToken } },
    );
    const node = nodeResponse.data.data?.node;
    if (nodeResponse.data.code !== 0 || !node || node.obj_type !== 'docx') {
      throw new Error(
        `Wiki 节点无法解析为 docx: ${nodeResponse.data.code} ${nodeResponse.data.msg}`,
      );
    }

    const blocks = await this.getAllBlocks(node.obj_token);
    const root = blocks.find((block) => block.block_id === node.obj_token);
    const sectionFour = blocks.find(
      (block) =>
        block.parent_id === node.obj_token &&
        block.block_type === 4 &&
        this.readBlockText(block).startsWith('四、'),
    );
    if (!root?.children || !sectionFour) {
      throw new Error('未找到文档根块或“四、”章节，无法确定安全插入位置');
    }
    const insertionIndex = root.children.indexOf(sectionFour.block_id);
    if (insertionIndex < 0) {
      throw new Error('“四、”章节不在文档根块 children 中');
    }
    return {
      node,
      documentId: node.obj_token,
      blocks,
      insertionIndex,
    };
  }

  private async getAllBlocks(documentId: string): Promise<DocxBlock[]> {
    const blocks: DocxBlock[] = [];
    let pageToken: string | undefined;
    do {
      const response = await this.feishuApi.get<
        FeishuResponse<{ items: DocxBlock[]; has_more?: boolean; page_token?: string }>
      >(`/docx/v1/documents/${documentId}/blocks`, {
        params: {
          page_size: 500,
          document_revision_id: -1,
          ...(pageToken ? { page_token: pageToken } : {}),
        },
      });
      if (response.data.code !== 0) {
        throw new Error(`读取文档块失败: ${response.data.code} ${response.data.msg}`);
      }
      blocks.push(...(response.data.data?.items || []));
      pageToken = response.data.data?.has_more ? response.data.data.page_token : undefined;
    } while (pageToken);
    return blocks;
  }

  /** 当日小节标题（不含时分）：同一天的多次治理事件共用它。 */
  private buildDayTitle(occurredAt: Date): string {
    const parts = new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai',
      month: 'numeric',
      day: 'numeric',
    }).formatToParts(occurredAt);
    const pick = (type: Intl.DateTimeFormatPartTypes) =>
      parts.find((item) => item.type === type)?.value || '';
    return `${pick('month')} 月 ${pick('day')} 日`;
  }

  /**
   * 定位当日小节，返回「该小节末尾」在根级 children 中的插入位置。
   *
   * 小节范围 = 当日 H3 起，到下一个根级标题（H2/H3）之前；找不到下一个标题时
   * 退回「四、」章节之前的安全位置。返回 null 表示当日还没有小节，需新建。
   */
  private resolveDaySectionAppendIndex(
    document: { documentId: string; blocks: DocxBlock[]; insertionIndex: number },
    dayTitle: string,
  ): number | null {
    const blockById = new Map(document.blocks.map((block) => [block.block_id, block]));
    const children = blockById.get(document.documentId)?.children || [];
    const expected = `${dayTitle}：BadCase 治理更新`;
    const headingAt = children.findIndex((id) => {
      const block = blockById.get(id);
      return block?.block_type === 5 && this.readBlockText(block).trim() === expected;
    });
    if (headingAt < 0) return null;
    for (let i = headingAt + 1; i < children.length; i += 1) {
      const type = blockById.get(children[i])?.block_type;
      if (type === 4 || type === 5) return i;
    }
    return document.insertionIndex;
  }

  private buildUpdateBlocks(
    update: BadcaseGovernanceDocumentUpdate,
    eventId: string,
    existingDaySection: boolean,
  ): Array<Record<string, unknown>> {
    const occurredAt = update.occurredAt || new Date();
    const displayedItems = update.items.slice(0, 40);
    // 同日多次运行只保留一个小节：已存在当日小节时只追加条目，不再新建标题。
    // 旧实现按「月 日 时:分」建标题，2026-08-06 单日跑了 11 次巡检就堆出 20 个小节，
    // 同一条 case 在不同小节里状态互相矛盾，运营从上往下读看不出最终状态。
    const blocks: Array<Record<string, unknown>> = existingDaySection
      ? [...displayedItems.map((item) => this.bulletBlock(this.formatItem(item)))]
      : [
          this.heading3Block(`${this.buildDayTitle(occurredAt)}：BadCase 治理更新`),
          this.textBlock('本次更新：'),
          ...displayedItems.map((item) => this.bulletBlock(this.formatItem(item))),
        ];
    if (update.items.length > displayedItems.length) {
      blocks.push(
        this.bulletBlock(
          `另有 ${update.items.length - displayedItems.length} 条记录，详见对应测试批次。`,
        ),
      );
    }
    blocks.push(this.textBlock(`治理事件ID：${eventId}`));
    return blocks;
  }

  private formatItem(item: BadcaseGovernanceDocumentItem): string {
    const identity = item.badcaseId || item.recordId;
    const type = item.category || '未分类';
    const title = item.title ? `｜${item.title}` : '';
    const batch = item.batchId ? `；批次 ${item.batchId}` : '';
    const evidence = item.evidenceSummary ? `；${item.evidenceSummary}` : '';
    return `${type}｜${identity}${title}：${item.status}${batch}${evidence}`;
  }

  private buildEventId(items: BadcaseGovernanceDocumentItem[]): string {
    const source = items
      .map(
        (item) =>
          `${item.recordId}:${item.status}:${item.batchId || ''}:${item.evidenceSummary || ''}`,
      )
      .sort()
      .join('|');
    return `bcg-${createHash('sha256').update(source).digest('hex').slice(0, 16)}`;
  }

  private readBlockText(block: DocxBlock): string {
    const typed = block as Record<string, unknown>;
    for (const key of [
      'text',
      'heading1',
      'heading2',
      'heading3',
      'heading4',
      'heading5',
      'heading6',
      'bullet',
      'ordered',
    ]) {
      const data = typed[key] as
        | { elements?: Array<{ text_run?: { content?: string } }> }
        | undefined;
      if (data?.elements) {
        return data.elements.map((element) => element.text_run?.content || '').join('');
      }
    }
    return '';
  }

  private heading3Block(content: string): Record<string, unknown> {
    return {
      block_type: 5,
      heading3: { elements: [this.textElement(content)] },
    };
  }

  private textBlock(content: string): Record<string, unknown> {
    return {
      block_type: 2,
      text: { elements: content ? [this.textElement(content)] : [] },
    };
  }

  private bulletBlock(content: string): Record<string, unknown> {
    return {
      block_type: 12,
      bullet: { elements: [this.textElement(content)] },
    };
  }

  private textElement(content: string): Record<string, unknown> {
    return {
      text_run: {
        content,
        text_element_style: {},
      },
    };
  }
}
