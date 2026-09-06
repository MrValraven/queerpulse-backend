import { Module } from '@nestjs/common';
import { LinkPreviewFeatureGuard } from './link-preview-feature.guard';
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
 */
@Module({
  controllers: [LinkPreviewController],
  providers: [
    LinkPreviewService,
    LinkPreviewFeatureGuard,
    LinkPreviewThrottlerGuard,
  ],
})
export class LinkPreviewModule {}
