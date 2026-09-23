import { Module } from '@nestjs/common';
import { StickersModule } from '../stickers/stickers.module';
import { AdminStickersController } from './admin-stickers.controller';
import { AdminStickersService } from './admin-stickers.service';

/**
 * The guarded authoring surface for the sticker catalogue, in this codebase's
 * convention of a dedicated `Admin*Controller` in its own `admin-*` module.
 *
 * Imports `StickersModule` for its exported repositories rather than
 * re-registering the entities, so there is one owner of those tables.
 */
@Module({
  imports: [StickersModule],
  controllers: [AdminStickersController],
  providers: [AdminStickersService],
})
export class AdminStickersModule {}
