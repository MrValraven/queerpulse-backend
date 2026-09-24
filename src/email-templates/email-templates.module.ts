import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AdminEmailTemplatesController } from './admin-email-templates.controller';
import { EmailTemplate } from './entities/email-template.entity';
import { EmailTemplatesController } from './email-templates.controller';
import { EmailTemplatesService } from './email-templates.service';

@Module({
  imports: [TypeOrmModule.forFeature([EmailTemplate])],
  controllers: [EmailTemplatesController, AdminEmailTemplatesController],
  providers: [EmailTemplatesService],
})
export class EmailTemplatesModule {}
