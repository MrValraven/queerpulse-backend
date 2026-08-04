import { Controller, Get, Header, Param } from '@nestjs/common';
import { Public } from '../auth/decorators/public.decorator';
import { ChangemakersService } from './changemakers.service';
import {
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';

// Public, read-only directory backing `ChangemakersPage.tsx` and
// `ChangemakerStoryPage.tsx`. Only published profiles are exposed here.
// `@Public()` is required on every route: `JwtAuthGuard` is bound globally
// via `APP_GUARD`, so without it a logged-out visitor would be rejected
// before reaching the handler (see `DirectoryController` for the same
// pattern).
//
// Both routes carry a positive `Cache-Control`: the response is identical for
// every anonymous caller (no `@CurrentUser()`, no session-scoped filtering) —
// see AUDIT-2026-07-30.md §I "No CDN cache headers on public GETs" /
// `caching-and-cost.md`.
@ApiTags('Changemakers')
@Controller('changemakers')
export class ChangemakersController {
  constructor(private readonly changemakers: ChangemakersService) {}

  @Public()
  @Get()
  @Header('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=300')
  @ApiOperation({
    summary: 'List published changemaker profiles with directory stats.',
  })
  @ApiOkResponse({
    description:
      'Published changemaker profiles plus aggregate directory stats.',
  })
  list() {
    return this.changemakers.listPublic();
  }

  @Public()
  @Get(':slug')
  @Header('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=300')
  @ApiOperation({ summary: 'Get a single published changemaker by slug.' })
  @ApiOkResponse({ description: 'The published changemaker profile.' })
  @ApiNotFoundResponse({
    description: 'No published changemaker exists for this slug.',
  })
  getBySlug(@Param('slug') slug: string) {
    return this.changemakers.getPublicBySlug(slug);
  }
}
