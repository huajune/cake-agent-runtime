import { Module } from '@nestjs/common';
import { ContactController } from './contact.controller';
import { ContactService } from './contact.service';
import { HttpModule } from '@core/client-http';
import { ApiConfigModule } from '@core/config';

@Module({
  imports: [HttpModule, ApiConfigModule],
  controllers: [ContactController],
  providers: [ContactService],
})
export class ContactModule {}
