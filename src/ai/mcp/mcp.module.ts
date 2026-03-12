import { Module } from '@nestjs/common';
import { ToolModule } from '../tool/tool.module';
import { McpClientService } from './mcp-client.service';

@Module({
  imports: [ToolModule],
  providers: [McpClientService],
  exports: [McpClientService],
})
export class McpModule {}
