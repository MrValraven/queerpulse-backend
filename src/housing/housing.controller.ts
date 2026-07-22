import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { Public } from '../auth/decorators/public.decorator';
import { Feature } from '../common/feature.decorator';
import { CreateJoinRequestDto } from './dto/create-join-request.dto';
import { HousingService } from './housing.service';

/**
 * Public co-op directory. `coops` is a static segment declared before the
 * `:slug`-style join-request route so route matching resolves it literally
 * (mirrors the pattern in `DirectoryController`).
 *
 * Product decision (maintainer-approved): join requests must be submittable
 * by ANYONE, including anonymous non-members — the public marketing page
 * collects a `name` field for exactly this reason. So both routes are
 * `@Public()` and there is no auth guard on the join-request route.
 *
 * `userId` is therefore always `null` here rather than best-effort read from
 * `request.user`: the global `JwtAuthGuard` (see `app.module.ts` /
 * `src/auth/guards/jwt-auth.guard.ts`) returns `true` immediately when
 * `@Public()` is set, WITHOUT calling `super.canActivate()` (the Passport JWT
 * strategy that populates `request.user`). So on a `@Public()` route
 * `request.user` is never populated, even with a valid session cookie — there
 * is nothing to read.
 */
@Feature('housing')
@Controller('housing')
export class HousingController {
  constructor(private readonly housing: HousingService) {}

  @Public()
  @Get('coops')
  listCoops() {
    return this.housing.listPublished();
  }

  @Public()
  @Post('coops/:slug/join-requests')
  submitJoinRequest(
    @Param('slug') slug: string,
    @Body() dto: CreateJoinRequestDto,
  ) {
    return this.housing.createJoinRequest(slug, dto, null);
  }
}
