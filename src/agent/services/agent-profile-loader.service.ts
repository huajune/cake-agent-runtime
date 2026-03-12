import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { AgentProfile } from '../utils/agent-types';
import { ScenarioType, ContextStrategy } from '../utils/agent-enums';
import { AgentRegistryService } from './agent-registry.service';

/**
 * Profile 加载服务
 * 负责管理 Agent Profile 配置
 *
 * 职责：
 * 1. 提供硬编码的 profile 配置
 * 2. 从文件系统加载 .md prompt 文件
 * 3. 管理 profile 缓存（内存 Map）
 * 4. 提供 profile 注册、获取、重载接口
 * 5. 验证 profile 有效性
 */
@Injectable()
export class ProfileLoaderService implements OnModuleInit {
  private readonly logger = new Logger(ProfileLoaderService.name);
  private readonly profiles = new Map<string, AgentProfile>();
  private readonly profilesBasePath: string;
  private initialized = false;

  constructor(
    private readonly configService: ConfigService,
    private readonly registryService: AgentRegistryService,
  ) {
    // Prompt 文件基础路径 - profiles/ 文件夹
    // 开发模式: src/agent/services -> ../profiles
    // 生产模式: dist/agent/services -> ../profiles (需确保 profiles 目录被复制到 dist)
    const devPath = join(__dirname, '..', 'profiles');
    const prodPath = join(__dirname, '..', '..', '..', 'agent', 'profiles');

    // 优先使用开发路径，如果不存在则尝试生产路径
    this.profilesBasePath = existsSync(devPath) ? devPath : prodPath;
    this.logger.log(`Profile 配置文件路径: ${this.profilesBasePath}`);
  }

  /**
   * 模块初始化时自动加载配置
   */
  async onModuleInit() {
    await this.initializeProfiles();
  }

  /**
   * 获取 Profile（不包含品牌配置）
   * 返回 null 表示配置不存在，调用方应处理错误情况
   */
  getProfile(scenario: ScenarioType | string): AgentProfile | null {
    const profile = this.profiles.get(scenario);
    if (!profile) {
      this.logger.warn(`未找到场景 ${scenario} 的配置`);
      return null;
    }
    return profile;
  }

  /**
   * 获取所有可用的配置档案
   */
  getAllProfiles(): AgentProfile[] {
    return Array.from(this.profiles.values());
  }

  /**
   * 注册一个 Agent 配置档案
   */
  registerProfile(profile: AgentProfile): void {
    this.profiles.set(profile.name, profile);
    this.logger.log(`注册 Agent 配置: ${profile.name} - ${profile.description}`);
  }

  /**
   * 重新加载指定配置
   */
  async reloadProfile(profileName: string): Promise<boolean> {
    try {
      const reloadedProfile = await this.buildProfileByName(profileName);
      if (reloadedProfile) {
        this.registerProfile(reloadedProfile);
        this.logger.log(`配置 ${profileName} 已重新加载`);
        return true;
      }
      this.logger.warn(`无法重新加载配置 ${profileName}`);
      return false;
    } catch (error) {
      this.logger.error(`重新加载配置 ${profileName} 失败`, error);
      return false;
    }
  }

  /**
   * 重新加载所有配置
   */
  async reloadAllProfiles(): Promise<void> {
    try {
      this.profiles.clear();
      await this.initializeProfiles();
      this.logger.log(`所有配置已重新加载，共 ${this.profiles.size} 个`);
    } catch (error) {
      this.logger.error('重新加载所有配置失败', error);
    }
  }

  /**
   * 检查配置是否存在
   */
  hasProfile(profileName: string): boolean {
    return this.profiles.has(profileName);
  }

  /**
   * 删除配置档案
   */
  removeProfile(profileName: string): boolean {
    const removed = this.profiles.delete(profileName);
    if (removed) {
      this.logger.log(`配置 ${profileName} 已删除`);
    }
    return removed;
  }

  /**
   * 验证配置是否有效
   * 检查模型和工具是否在可用列表中
   */
  validateProfile(profile: AgentProfile): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    // 从注册表服务获取可用的模型和工具列表
    const availableModels = this.registryService.getAvailableModels();
    const availableTools = this.registryService.getAvailableTools();

    // 检查模型是否可用
    if (availableModels.length > 0 && !availableModels.includes(profile.model)) {
      errors.push(`模型 ${profile.model} 不在可用列表中`);
    }

    // 检查工具是否可用
    if (profile.allowedTools && profile.allowedTools.length > 0) {
      for (const tool of profile.allowedTools) {
        const toolInfo = availableTools.get(tool);
        if (!toolInfo && availableTools.size > 0) {
          errors.push(`工具 ${tool} 不在可用列表中`);
          continue;
        }

        // 检查工具所需的上下文是否提供
        if (toolInfo && toolInfo.requiredContext.length > 0) {
          const providedContext = { ...profile.context, ...profile.toolContext?.[tool] };
          for (const requiredKey of toolInfo.requiredContext) {
            if (!providedContext[requiredKey]) {
              errors.push(`工具 ${tool} 缺少必需的上下文: ${requiredKey}`);
            }
          }
        }
      }
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }

  // ==================== 私有方法 ====================

  /**
   * 初始化 Agent 配置档案
   */
  private async initializeProfiles(): Promise<void> {
    if (this.initialized) {
      this.logger.warn('配置已初始化，跳过重复初始化');
      return;
    }

    try {
      // 加载所有已注册的 Profile
      const profileNames = this.getRegisteredProfileNames();

      for (const name of profileNames) {
        const profile = await this.buildProfileByName(name);
        if (profile) {
          this.registerProfile(profile);
        }
      }

      this.initialized = true;
      this.logger.log(`配置初始化完成，已加载 ${this.profiles.size} 个配置档案`);
    } catch (error) {
      this.logger.error('配置初始化失败', error);
      this.initialized = true;
    }
  }

  /**
   * 获取所有已注册的 Profile 名称
   */
  private getRegisteredProfileNames(): string[] {
    return [ScenarioType.CANDIDATE_CONSULTATION];
  }

  /**
   * 根据名称构建 Profile
   */
  private async buildProfileByName(profileName: string): Promise<AgentProfile | null> {
    switch (profileName) {
      case ScenarioType.CANDIDATE_CONSULTATION:
        return this.buildCandidateConsultationProfile();
      default:
        this.logger.warn(`未知的 Profile 名称: ${profileName}`);
        return null;
    }
  }

  /**
   * 构建候选人咨询 Profile
   * 配置硬编码在此方法中，只有 .md 文件从文件系统加载
   */
  private async buildCandidateConsultationProfile(): Promise<AgentProfile> {
    const scenarioDir = join(this.profilesBasePath, 'candidate-consultation');

    // 从环境变量获取配置
    const model = this.configService.get<string>('AGENT_DEFAULT_MODEL', '');
    const allowedToolsEnv = this.configService.get<string>('AGENT_ALLOWED_TOOLS', '');
    const dulidayToken = this.configService.get<string>('DULIDAY_API_TOKEN', '');

    // 解析工具列表
    const allowedTools = allowedToolsEnv
      .split(',')
      .map((tool) => tool.trim())
      .filter((tool) => tool.length > 0);

    // 从文件系统加载 .md 文件
    const systemPrompt = await this.readTextFile(join(scenarioDir, 'system-prompt-v2.md'));

    // 记录配置加载情况
    if (dulidayToken) {
      this.logger.debug('✅ DULIDAY_API_TOKEN 已加载');
    } else {
      this.logger.warn('⚠️ DULIDAY_API_TOKEN 未设置');
    }

    const profile: AgentProfile = {
      name: ScenarioType.CANDIDATE_CONSULTATION,
      description: '候选人私聊咨询服务',
      model,
      promptType: 'weworkSystemPrompt',
      allowedTools,
      contextStrategy: ContextStrategy.SKIP,
      systemPrompt,
      context: {
        dulidayToken,
      },
    };

    this.logger.log(`成功加载配置: ${ScenarioType.CANDIDATE_CONSULTATION}`);
    return profile;
  }

  /**
   * 读取文本文件
   */
  private async readTextFile(filePath: string): Promise<string | undefined> {
    try {
      if (!existsSync(filePath)) {
        this.logger.warn(`文件不存在: ${filePath}`);
        return undefined;
      }
      return await readFile(filePath, 'utf-8');
    } catch (error) {
      this.logger.error(`读取文本文件失败: ${filePath}`, error);
      return undefined;
    }
  }
}
