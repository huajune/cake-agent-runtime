import { Module } from '@nestjs/common';
import { CustomerController } from './customer.controller';
import { CustomerService } from './customer.service';
import { HttpModule } from '@infra/client-http/http.module';
import { ApiConfigModule } from '@infra/config/api-config.module';

@Module({
  imports: [HttpModule, ApiConfigModule],
  controllers: [CustomerController],
  providers: [CustomerService],
  exports: [CustomerService],
})
export class CustomerModule {}
