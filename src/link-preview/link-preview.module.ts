import { Module } from '@nestjs/common';
import { LinkPreviewController } from './link-preview.controller';
import { LinkPreviewService } from './link-preview.service';

/**
 * Link unfurls for messaging. Self-contained — no entities/migration (the
 * service caches in-memory with a short TTL; previews are re-derivable public
 * metadata, not durable state). Registered in `AppModule` alongside
 * `MessagingModule`.
 */
@Module({
  controllers: [LinkPreviewController],
  providers: [LinkPreviewService],
})
export class LinkPreviewModule {}
