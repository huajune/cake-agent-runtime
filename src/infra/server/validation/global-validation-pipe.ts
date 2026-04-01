import { ValidationPipe } from '@nestjs/common';

/**
 * 统一的全局请求校验配置。
 *
 * 目标：
 * - 打开 DTO 运行时校验，让 class-validator 真正生效
 * - 自动做基础类型转换（string -> number/boolean）
 * - 拒绝未声明字段，避免脏数据悄悄进入业务层
 */
export function createGlobalValidationPipe(): ValidationPipe {
  return new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
    transformOptions: {
      enableImplicitConversion: true,
    },
    validationError: {
      target: false,
      value: false,
    },
  });
}
