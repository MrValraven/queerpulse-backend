import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  CurrentUser,
  CurrentUserData,
} from '../auth/decorators/current-user.decorator';
import { Public } from '../auth/decorators/public.decorator';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { Feature } from '../common/feature.decorator';
import { DirectoryService } from './directory.service';
import { CreateReviewDto } from './dto/create-review.dto';
import { ListDirectoryQuery } from './dto/list-directory.query';

/**
 * Public, read-only directory over the businesses (`listings`) table, backing
 * the marketing surfaces (`/local/directory`, `/host`). Deliberately a
 * SEPARATE controller from `ListingsController`: that one carries a class-level
 * `ActiveMemberGuard`, and `ActiveMemberGuard` does NOT honor `@Public()` (it
 * unconditionally requires an active member), so public reads cannot live under
 * it. Every route here is `@Public()` and there is no class guard.
 *
 * `spaces` is a static segment declared before the `:slug` detail route (added
 * in a later sub-project) so route matching resolves it literally.
 */
@Feature('listings')
@Controller('directory')
export class DirectoryController {
  constructor(private readonly directoryService: DirectoryService) {}

  // Host page "Partner spaces" — live listings flagged as partner venues.
  @Public()
  @Get('spaces')
  listPartnerSpaces() {
    return this.directoryService.listPartnerSpaces();
  }

  // Public directory grid — every live listing, optionally filtered.
  @Public()
  @Get()
  listDirectory(@Query() query: ListDirectoryQuery) {
    return this.directoryService.listDirectory(query);
  }

  // Public Safe Spaces page — verified + removed safe spaces with hero stats.
  @Public()
  @Get('safe-spaces')
  listSafeSpaces() {
    return this.directoryService.listSafeSpaces();
  }

  // Public Safe Space detail (verified or removed).
  @Public()
  @Get('safe-spaces/:slug')
  getSafeSpace(@Param('slug') slug: string) {
    return this.directoryService.getSafeSpaceBySlug(slug);
  }

  // Directory detail — declared AFTER the static `spaces`/`safe-spaces` routes
  // so route matching resolves those literally rather than as `:slug`.
  @Public()
  @Get(':slug')
  getDirectoryListing(@Param('slug') slug: string) {
    return this.directoryService.getDirectoryBySlug(slug);
  }

  // Public: paginated reviews for a listing.
  @Public()
  @Get(':slug/reviews')
  listReviews(@Param('slug') slug: string, @Query('page') page?: string) {
    return this.directoryService.listReviews(
      slug,
      page ? Number(page) : undefined,
    );
  }

  // Member-gated: leave a review. Guarded per-route (the controller has no
  // class guard, so the reads above stay public); state-changing, so it also
  // requires the global CSRF token like every other mutation.
  @Post(':slug/reviews')
  @UseGuards(ActiveMemberGuard)
  addReview(
    @CurrentUser() user: CurrentUserData,
    @Param('slug') slug: string,
    @Body() dto: CreateReviewDto,
  ) {
    return this.directoryService.addReview(slug, user.userId, dto);
  }
}
