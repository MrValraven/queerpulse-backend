import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AdminModResponseTemplatesController } from './admin-mod-response-templates.controller';
import { ModResponseTemplate } from './entities/mod-response-template.entity';
import { ModResponseTemplatesController } from './mod-response-templates.controller';
import { ModResponseTemplatesService } from './mod-response-templates.service';

@Module({
  imports: [TypeOrmModule.forFeature([ModResponseTemplate])],
  controllers: [
    ModResponseTemplatesController,
    AdminModResponseTemplatesController,
  ],
  providers: [ModResponseTemplatesService],
  exports: [ModResponseTemplatesService],
})
export class ModResponseTemplatesModule {}
