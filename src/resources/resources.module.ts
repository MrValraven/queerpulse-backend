import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { GlossaryTerm } from './entities/glossary-term.entity';
import { Resource } from './entities/resource.entity';
import {
  GlossaryController,
  ResourcesController,
} from './resources.controller';
import { ResourcesService } from './resources.service';

@Module({
  imports: [TypeOrmModule.forFeature([Resource, GlossaryTerm])],
  controllers: [ResourcesController, GlossaryController],
  providers: [ResourcesService],
})
export class ResourcesModule {}
