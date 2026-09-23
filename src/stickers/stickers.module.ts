import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Sticker } from './entities/sticker.entity';
import { StickerPack } from './entities/sticker-pack.entity';
import { StickersController } from './stickers.controller';
import { StickersService } from './stickers.service';

/**
 * The read side of the sticker catalogue.
 *
 * Exports `TypeOrmModule` so the messaging write path can inject the `Sticker`
 * repository directly to resolve a `stickerId` at send time, without importing
 * a service and without a module cycle.
 */
@Module({
  imports: [TypeOrmModule.forFeature([StickerPack, Sticker])],
  controllers: [StickersController],
  providers: [StickersService],
  exports: [TypeOrmModule, StickersService],
})
export class StickersModule {}
