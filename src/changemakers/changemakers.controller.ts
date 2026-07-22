import { Controller, Get, Param } from '@nestjs/common';
import { Public } from '../auth/decorators/public.decorator';
import { ChangemakersService } from './changemakers.service';

// Public, read-only directory backing `ChangemakersPage.tsx` and
// `ChangemakerStoryPage.tsx`. Only published profiles are exposed here.
// `@Public()` is required on every route: `JwtAuthGuard` is bound globally
// via `APP_GUARD`, so without it a logged-out visitor would be rejected
// before reaching the handler (see `DirectoryController` for the same
// pattern).
@Controller('changemakers')
export class ChangemakersController {
  constructor(private readonly changemakers: ChangemakersService) {}

  @Public()
  @Get()
  list() {
    return this.changemakers.listPublic();
  }

  @Public()
  @Get(':slug')
  getBySlug(@Param('slug') slug: string) {
    return this.changemakers.getPublicBySlug(slug);
  }
}
