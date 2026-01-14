import { Injectable, Logger } from '@nestjs/common';
import * as nodejieba from 'nodejieba';
import { SimilarityRating } from '../enums';
import { SimilarityResult } from '../dto/conversation-test.dto';

/**
 * 语义相似度服务
 *
 * 使用本地计算（分词 + TF-IDF + 余弦相似度）实现零成本的文本相似度评估
 * 主要用于对话验证测试中，比较 Agent 回复与真人回复的相似程度
 */
@Injectable()
export class SemanticSimilarityService {
  private readonly logger = new Logger(SemanticSimilarityService.name);

  /**
   * 停用词列表
   * 过滤常见的无意义词汇，提高相似度计算的准确性
   */
  private readonly stopWords = new Set([
    '的',
    '了',
    '是',
    '在',
    '我',
    '有',
    '和',
    '就',
    '不',
    '人',
    '都',
    '一',
    '一个',
    '上',
    '也',
    '很',
    '到',
    '说',
    '要',
    '去',
    '你',
    '会',
    '着',
    '没有',
    '看',
    '好',
    '自己',
    '这',
    '那',
    '她',
    '他',
    '它',
    '们',
    '什么',
    '怎么',
    '为什么',
    '哪',
    '啊',
    '呢',
    '吗',
    '吧',
    '嗯',
    '哦',
    '哈',
    '呀',
    '嘛',
    '哎',
    '喂',
    '可以',
    '能',
    '还',
    '但是',
    '因为',
    '所以',
    '如果',
    '那么',
    '这样',
    '那样',
    '这个',
    '那个',
    '这些',
    '那些',
    '什么样',
    '怎样',
    '多少',
    '几',
    '第',
  ]);

  constructor() {
    this.logger.log('SemanticSimilarityService initialized with nodejieba');
  }

  /**
   * 计算两段文本的语义相似度
   *
   * @param textA 第一段文本（通常是真人回复）
   * @param textB 第二段文本（通常是Agent回复）
   * @returns 相似度结果，包含分数、评级和分词详情
   */
  calculateSimilarity(textA: string, textB: string): SimilarityResult {
    // 预处理文本
    const cleanA = this.preprocessText(textA);
    const cleanB = this.preprocessText(textB);

    // 分词
    const tokensA = this.tokenize(cleanA);
    const tokensB = this.tokenize(cleanB);

    // 如果任一文本为空，返回0分
    if (tokensA.length === 0 || tokensB.length === 0) {
      return {
        score: 0,
        rating: SimilarityRating.POOR,
        expectedTokens: tokensA,
        actualTokens: tokensB,
        commonTokenCount: 0,
      };
    }

    // 构建词汇表（合并两个文本的词汇）
    const vocabulary = this.buildVocabulary(tokensA, tokensB);

    // 计算 TF-IDF 向量
    const corpus = [tokensA, tokensB];
    const vecA = this.computeTfIdfVector(tokensA, corpus, vocabulary);
    const vecB = this.computeTfIdfVector(tokensB, corpus, vocabulary);

    // 计算余弦相似度
    const cosineSim = this.cosineSimilarity(vecA, vecB);

    // 转换为百分制分数
    const score = Math.round(cosineSim * 100);

    // 计算共同词汇
    const setA = new Set(tokensA);
    const setB = new Set(tokensB);
    const commonTokenCount = [...setA].filter((t) => setB.has(t)).length;

    return {
      score,
      rating: this.getRating(score),
      expectedTokens: tokensA,
      actualTokens: tokensB,
      commonTokenCount,
    };
  }

  /**
   * 批量计算相似度
   *
   * @param pairs 文本对数组
   * @returns 相似度结果数组
   */
  calculateBatchSimilarity(pairs: Array<{ expected: string; actual: string }>): SimilarityResult[] {
    return pairs.map((pair) => this.calculateSimilarity(pair.expected, pair.actual));
  }

  /**
   * 根据分数获取评级
   */
  getRating(score: number): SimilarityRating {
    if (score >= 80) return SimilarityRating.EXCELLENT;
    if (score >= 60) return SimilarityRating.GOOD;
    if (score >= 40) return SimilarityRating.FAIR;
    return SimilarityRating.POOR;
  }

  /**
   * 文本预处理
   * 移除特殊字符、标点符号，统一格式
   */
  private preprocessText(text: string): string {
    if (!text) return '';

    return (
      text
        // 移除表情符号
        .replace(/[\u{1F600}-\u{1F64F}]/gu, '')
        .replace(/[\u{1F300}-\u{1F5FF}]/gu, '')
        .replace(/[\u{1F680}-\u{1F6FF}]/gu, '')
        .replace(/[\u{1F1E0}-\u{1F1FF}]/gu, '')
        .replace(/[\u{2600}-\u{26FF}]/gu, '')
        .replace(/[\u{2700}-\u{27BF}]/gu, '')
        // 移除标点符号
        .replace(/[，。！？、；：""''（）【】《》…—\-_,.!?;:"'()[\]<>]/g, ' ')
        // 移除多余空格
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase()
    );
  }

  /**
   * 中文分词
   * 使用 nodejieba 进行分词，并过滤停用词
   */
  private tokenize(text: string): string[] {
    if (!text) return [];

    // 使用精确模式分词
    const rawTokens = nodejieba.cut(text);

    // 过滤停用词和单字符
    return rawTokens.filter(
      (token: string) =>
        token.trim().length > 0 && !this.stopWords.has(token) && !/^\s+$/.test(token),
    );
  }

  /**
   * 构建词汇表
   */
  private buildVocabulary(tokensA: string[], tokensB: string[]): string[] {
    const vocabSet = new Set([...tokensA, ...tokensB]);
    return Array.from(vocabSet);
  }

  /**
   * 计算词频 (TF)
   */
  private computeTf(tokens: string[]): Map<string, number> {
    const tf = new Map<string, number>();
    const totalTokens = tokens.length;

    for (const token of tokens) {
      tf.set(token, (tf.get(token) || 0) + 1);
    }

    // 归一化
    for (const [token, count] of tf) {
      tf.set(token, count / totalTokens);
    }

    return tf;
  }

  /**
   * 计算逆文档频率 (IDF)
   */
  private computeIdf(token: string, corpus: string[][]): number {
    const documentCount = corpus.length;
    const documentsWithToken = corpus.filter((doc) => doc.includes(token)).length;

    // 加1平滑，避免除零
    return Math.log((documentCount + 1) / (documentsWithToken + 1)) + 1;
  }

  /**
   * 计算 TF-IDF 向量
   */
  private computeTfIdfVector(tokens: string[], corpus: string[][], vocabulary: string[]): number[] {
    const tf = this.computeTf(tokens);
    const vector: number[] = [];

    for (const word of vocabulary) {
      const tfValue = tf.get(word) || 0;
      const idfValue = this.computeIdf(word, corpus);
      vector.push(tfValue * idfValue);
    }

    return vector;
  }

  /**
   * 计算余弦相似度
   */
  private cosineSimilarity(vecA: number[], vecB: number[]): number {
    if (vecA.length !== vecB.length) {
      throw new Error('Vectors must have the same length');
    }

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < vecA.length; i++) {
      dotProduct += vecA[i] * vecB[i];
      normA += vecA[i] * vecA[i];
      normB += vecB[i] * vecB[i];
    }

    normA = Math.sqrt(normA);
    normB = Math.sqrt(normB);

    if (normA === 0 || normB === 0) {
      return 0;
    }

    return dotProduct / (normA * normB);
  }

  /**
   * 简单的 Jaccard 相似度（用于快速估算）
   * 计算两个集合的交集与并集的比值
   */
  calculateJaccardSimilarity(textA: string, textB: string): number {
    const tokensA = this.tokenize(this.preprocessText(textA));
    const tokensB = this.tokenize(this.preprocessText(textB));

    if (tokensA.length === 0 && tokensB.length === 0) return 1;
    if (tokensA.length === 0 || tokensB.length === 0) return 0;

    const setA = new Set(tokensA);
    const setB = new Set(tokensB);

    const intersection = [...setA].filter((x) => setB.has(x)).length;
    const union = new Set([...setA, ...setB]).size;

    return Math.round((intersection / union) * 100);
  }
}
