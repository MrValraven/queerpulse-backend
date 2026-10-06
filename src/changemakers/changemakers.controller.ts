import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { Feature } from '../common/feature.decorator';
import { ChangemakersService } from './changemakers.service';
import {
  ApiCookieAuth,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

// Member-only, read-only directory backing `ChangemakersPage.tsx` and
// `ChangemakerStoryPage.tsx` (the frontend gates `/changemakers` and
// `/changemaker/*` in `authGate.ts`). Only published profiles are exposed.
// The global `JwtAuthGuard` authenticates every route here and
// `ActiveMemberGuard` limits them to active members, so the responses carry no
// shared-cache headers.
@Feature('community')
@ApiTags('Changemakers')
@ApiCookieAuth()
@ApiUnauthorizedResponse({ description: 'Not authenticated.' })
@Controller('changemakers')
@UseGuards(ActiveMemberGuard)
export class ChangemakersController {
  constructor(private readonly changemakers: ChangemakersService) {}

  @Get()
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

  @Get(':slug')
  @ApiOperation({ summary: 'Get a single published changemaker by slug.' })
  @ApiOkResponse({ description: 'The published changemaker profile.' })
  @ApiNotFoundResponse({
    description: 'No published changemaker exists for this slug.',
  })
  getBySlug(@Param('slug') slug: string) {
    return this.changemakers.getPublicBySlug(slug);
  }
}
