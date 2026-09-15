import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiConflictResponse,
  ApiCookieAuth,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import {
  CurrentUser,
  CurrentUserData,
} from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { StaffRoles } from '../auth/decorators/staff-roles.decorator';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { RolesOrStaffGuard } from '../auth/guards/roles-or-staff.guard';
import { UserRole } from '../users/entities/user.entity';
import { AdminForumService } from './admin-forum.service';
import { ListReviewQueueQuery } from './dto/list-review-queue.query';
import { ReviewThreadDto } from './dto/review-thread.dto';
import { SetThreadOfficialDto } from './dto/set-thread-official.dto';

/**
 * Staff forum surface. Under the global Throttler → CSRF → JWT chain, plus
 * `ActiveMemberGuard` + `RolesOrStaffGuard` here.
 *
 * MODERATORS AS WELL AS ADMINS, at class level, which is a change from the
 * admin-only gate this controller carried when its only route was the
 * "QueerPulse Official" byline toggle. The review queue is moderation work in
 * the plainest sense — read a thread nobody else can see yet and decide whether
 * the forum sees it — and every comparable surface in the repo (reports,
 * appeals, ban-evasion escalations, `AdminModerationHealthController`) is open
 * to the moderator tier. Gating it to admins would mean the people who do the
 * reviewing cannot reach the queue, and `ForumThreadsService` already treats
 * `moderator` and `admin` identically everywhere else it touches a thread
 * (`isModeratorRole`, lock, pin, the unpublished-thread read bypass).
 *
 * An EMPTY `@StaffRoles()`, exactly as `AdminModerationHealthController` does
 * it. The empty list switches the grant axis off, so the class falls back to
 * its `@Roles(...)` alone and no additive staff grant reaches these routes.
 * That is deliberate: no grant in `staff-roles.registry.ts` opens the forum,
 * and a review queue serves the full text of threads that are deliberately
 * invisible to the platform, which is not a thing to hand out by delegation.
 * Written as an explicit decorator rather than by keeping `RolesGuard`, so that
 * granting one later is a visible edit rather than an accident.
 *
 * The byline toggle stays ADMIN-ONLY through a method-level `@Roles`, which
 * `RolesOrStaffGuard` honours through `getAllAndOverride` — see its docstring.
 *
 * NO `@Feature(...)` decorator anywhere here, matching this file's own
 * convention from the day it was written: the forum has no launch flag to gate
 * on, and adding one on the review routes alone would put two answers about the
 * same surface in one class.
 */
@UseGuards(ActiveMemberGuard, RolesOrStaffGuard)
@Roles(UserRole.Moderator, UserRole.Admin)
@StaffRoles()
@ApiTags('Admin — Forum')
@ApiCookieAuth('access_token')
@ApiUnauthorizedResponse({ description: 'Not authenticated.' })
@ApiForbiddenResponse({
  description:
    'Requires the moderator or admin role. No staff grant opens these routes.',
})
@Controller('admin/forum')
export class AdminForumController {
  constructor(private readonly adminForum: AdminForumService) {}

  @ApiOperation({
    summary:
      'Threads waiting on a review decision, newest first. Cursor-paginated.',
    description:
      'Every thread whose author held it back for the editors or the council and that nobody has decided on yet, excluding any the author has since withdrawn. These threads are invisible to every member-facing read path until they are approved, which is why the queue is staff-only.',
  })
  @ApiOkResponse({ description: 'A cursor page of threads awaiting review.' })
  @Get('review')
  listReviewQueue(
    @CurrentUser() user: CurrentUserData,
    @Query() query: ListReviewQueueQuery,
  ) {
    return this.adminForum.listReviewQueue(user, query.cursor, query.limit);
  }

  @ApiOperation({
    summary: 'Approve or reject a thread that is waiting on a review.',
    description:
      "Approving publishes the thread and fires the announcement it has been holding since it was created (profile activity, the topics link and its follow notifications, and the @mentions in the opening post). Rejecting leaves it invisible to everyone but its author and staff. Either way the author is notified, with the reviewer's optional note. A thread that is not still pending answers 409.",
  })
  @ApiOkResponse({ description: 'The reviewed thread.' })
  @ApiNotFoundResponse({ description: 'Thread not found.' })
  @ApiConflictResponse({
    description: 'This thread is not waiting on a review.',
  })
  @Post('threads/:slug/review')
  reviewThread(
    @CurrentUser() user: CurrentUserData,
    @Param('slug') slug: string,
    @Body() dto: ReviewThreadDto,
  ) {
    return this.adminForum.reviewThread(slug, user, dto);
  }

  @ApiOperation({
    summary:
      'Toggle a thread between its real author and "QueerPulse Official".',
  })
  @ApiOkResponse({ description: 'The updated thread.' })
  @ApiNotFoundResponse({ description: 'Thread not found.' })
  @ApiForbiddenResponse({ description: 'Requires the admin role.' })
  // Narrowed back to admins inside a moderator-tier class. Speaking as the
  // platform is not moderation: `ForumThread.isOfficial` says QueerPulse itself
  // posted a thread, and the composer only offers the checkbox to admins. The
  // class carries an empty `@StaffRoles()`, so there is no class-level grant
  // here for a method-level `@Roles` to leave open.
  @Roles(UserRole.Admin)
  @Patch('threads/:slug/official')
  setThreadOfficial(
    @CurrentUser() user: CurrentUserData,
    @Param('slug') slug: string,
    @Body() dto: SetThreadOfficialDto,
  ) {
    return this.adminForum.setThreadOfficial(slug, user, dto.isOfficial);
  }
}
