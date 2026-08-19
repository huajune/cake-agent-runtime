import { NestFactory, Reflector } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { AppModule } from './app.module';
import { ConfigService } from '@nestjs/config';
import { ResponseInterceptor } from '@infra/server/response/interceptors/response.interceptor';
import { HttpExceptionFilter } from '@infra/server/response/filters/http-exception.filter';
import { NestExpressApplication } from '@nestjs/platform-express';
import { join } from 'path';
import { networkInterfaces } from 'os';
import { execSync } from 'child_process';
import * as net from 'net';
import { createGlobalValidationPipe } from '@infra/server/validation/global-validation-pipe';
import { sleep } from '@infra/utils/async.util';

/** 应用创建前即可用（Nest Logger 未接管时回落 ConsoleLogger），端口清理阶段共用。 */
const bootstrapLogger = new Logger('Bootstrap');

/**
 * 获取本机局域网 IP 地址
 */
function getLocalIpAddress(): string {
  const nets = networkInterfaces();
  for (const name of Object.keys(nets)) {
    const netInfo = nets[name];
    if (!netInfo) continue;

    for (const netInterface of netInfo) {
      // 跳过非 IPv4 和内部地址
      if (netInterface.family === 'IPv4' && !netInterface.internal) {
        return netInterface.address;
      }
    }
  }
  return 'localhost';
}

/**
 * 检查端口是否被占用
 */
function isPortInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        resolve(true);
      } else {
        resolve(false);
      }
    });
    server.once('listening', () => {
      server.close();
      resolve(false);
    });
    server.listen(port);
  });
}

/**
 * 清理占用端口的进程
 */
function killProcessOnPort(port: number): boolean {
  try {
    // macOS/Linux: 使用 lsof 找到占用端口的进程并杀死
    const result = execSync(`lsof -ti :${port}`, { encoding: 'utf-8' }).trim();
    if (result) {
      const pids = result.split('\n');
      for (const pid of pids) {
        if (pid) {
          execSync(`kill -9 ${pid}`);
          bootstrapLogger.warn(`已终止占用端口 ${port} 的进程 (PID: ${pid})`);
        }
      }
      return true;
    }
  } catch {
    // 没有找到占用端口的进程，或者 kill 失败
  }
  return false;
}

/**
 * 确保端口可用（如果被占用则清理）
 */
async function ensurePortAvailable(port: number): Promise<void> {
  const inUse = await isPortInUse(port);
  if (inUse) {
    bootstrapLogger.warn(`端口 ${port} 被占用，正在清理...`);
    const killed = killProcessOnPort(port);
    if (killed) {
      // 等待端口释放
      await sleep(1000);
      const stillInUse = await isPortInUse(port);
      if (stillInUse) {
        throw new Error(`无法释放端口 ${port}，请手动检查`);
      }
      bootstrapLogger.log(`端口 ${port} 已释放`);
    } else {
      throw new Error(`端口 ${port} 被占用，无法自动清理`);
    }
  }
}

async function bootstrap() {
  // 先从环境变量获取端口，在创建应用前检查端口可用性
  const port = parseInt(process.env.PORT || '8585', 10);

  // 确保端口可用（如果被占用则自动清理）
  await ensurePortAvailable(port);

  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bodyParser: false });
  const bodyLimit = process.env.HTTP_JSON_LIMIT || '20mb';
  app.useBodyParser('json', { limit: bodyLimit });
  app.useBodyParser('urlencoded', { limit: bodyLimit, extended: true });

  // 启用 CORS
  app.enableCors();

  // 配置静态文件服务（用于监控页面）
  // 使用 process.cwd() 确保在开发和生产环境都能正确找到 public 目录
  const publicPath = join(process.cwd(), 'public');
  app.useStaticAssets(publicPath);

  // 获取 Reflector 实例（用于读取装饰器元数据）
  const reflector = app.get(Reflector);

  // 全局注册响应拦截器（统一包装响应；@RawResponse 标记的端点例外）
  app.useGlobalInterceptors(new ResponseInterceptor(reflector));

  // 全局注册参数校验管道（让 DTO 装饰器真正成为运行时防线）
  app.useGlobalPipes(createGlobalValidationPipe());

  // 全局注册异常过滤器（统一处理所有异常）
  app.useGlobalFilters(app.get(HttpExceptionFilter));

  // 启用关停钩子：发版 SIGTERM 时触发各模块生命周期钩子，
  // 让 MessageProcessor 排空 in-flight 消息后再退出，避免候选人消息被吞
  app.enableShutdownHooks();

  // 从配置服务获取运行环境（端口已在 bootstrap 开头直接读 process.env）
  const configService = app.get(ConfigService);
  const nodeEnv = configService.get<string>('NODE_ENV')!;

  await app.listen(port);

  const localIp = getLocalIpAddress();

  // 启动播报合并成单条多行日志：横幅观感保留，同时只带一个时间戳/上下文前缀，
  // 便于在部署日志里按 [Bootstrap] 一次性捞出「服务起没起、起在哪个端口/环境」。
  bootstrapLogger.log(
    [
      '========================================',
      '🚀 服务已启动',
      `📍 监听端口: ${port}`,
      `🌍 运行环境: ${nodeEnv}`,
      `🔗 本地访问: http://localhost:${port}`,
      `🌐 局域网访问: http://${localIp}:${port}`,
      `📊 监控仪表盘: http://${localIp}:${port}/web/`,
      `📦 API 响应格式: 统一包装（全局生效）`,
      '========================================',
    ].join('\n'),
  );
}
bootstrap();
