import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Handle } from './entities/handle.entity';
import { HandlesController } from './handles.controller';
import { HandlesService } from './handles.service';

/**
 * Owns the `handles` registry — the ONE global username namespace (design plan
 * PART C). Exports `HandlesService` so `profiles` (username rename) and
 * `subprofiles` (publish/unpublish handle claim/release) can transact against
 * the same namespace (Task C2).
 */
@Module({
  imports: [TypeOrmModule.forFeature([Handle])],
  controllers: [HandlesController],
  providers: [HandlesService],
  exports: [HandlesService],
})
export class HandlesModule {}
