import { Module } from '@nestjs/common';
import { LinkPreviewFeatureGuard } from './link-preview-feature.guard';
import { LinkPreviewImageController } from './link-preview-image.controller';
import { LinkPreviewImageService } from './link-preview-image.service';
import { LinkPreviewThrottlerGuard } from './link-preview-throttler.guard';
import { LinkPreviewController } from './link-preview.controller';
import { LinkPreviewService } from './link-preview.service';

/**
 * Link unfurls for every surface where a member can paste a URL: messaging,
 * forum threads and replies, and the feed cards built from them. Self-contained
 * — no entities/migration (the service caches in-memory with a short TTL;
 * previews are re-derivable public metadata, not durable state). Registered in
 * `AppModule`.
 *
 * Both guards are listed as providers for the reason `AuthModule` gives for
 * `RefreshSessionThrottlerGuard`: they resolve under DI either way (
 * `ThrottlerModule` is `@Global()`), so listing them is about making the
 * enhancers visible to anyone reading the module.
 *
 * SEC-23: a card's image is served by `LinkPreviewImageController` from a
 * signed address, so the browser never loads it from the linked host.
 */
@Module({
  controllers: [LinkPreviewController, LinkPreviewImageController],
  providers: [
    LinkPreviewService,
    LinkPreviewImageService,
    LinkPreviewFeatureGuard,
    LinkPreviewThrottlerGuard,
  ],
})
export class LinkPreviewModule {}
