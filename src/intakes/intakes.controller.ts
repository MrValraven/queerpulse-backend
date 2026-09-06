import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Throttle, seconds } from '@nestjs/throttler';
import {
  ApiBadRequestResponse,
  ApiCookieAuth,
  ApiCreatedResponse,
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
import { Public } from '../auth/decorators/public.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { OptionalJwtAuthGuard } from '../auth/guards/optional-jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { QueueAssignmentDto } from '../common/queue-assignment.dto';
import { UserRole } from '../users/entities/user.entity';
import { ConcernStatusQuery } from './dto/concern-status.query';
import { CreateIntakeDto } from './dto/create-intake.dto';
import { ListIntakesQuery } from './dto/list-intakes.query';
import { UpdateIntakeStatusDto } from './dto/update-intake-status.dto';
import type { ConcernStatusDTO } from './intakes-response';
import { IntakesService } from './intakes.service';

/**
 * Generic intake-form endpoint. A single `POST /intakes/:kind` backs every
 * "apply / suggest / sign up" modal in the app (grants, glossary edits,
 * sober-host, panel signups, and the three incubator forms). `:kind` is
 * validated against the allowlist in the service; the body is a bounded,
 * schema-less `payload`.
 *
 * Auth is deliberately mixed on the one route: `@Public()` lifts the global
 * mandatory JWT so a logged-out visitor can submit a public form, and
 * `OptionalJwtAuthGuard` attaches `req.user` when a valid session cookie is
 * present so the submission gets attributed. Member-only kinds are enforced in
 * the service (401 when anonymous).
 */
@ApiTags('Intakes')
@Controller('intakes')
export class IntakesController {
  constructor(private readonly intakes: IntakesService) {}

  @Public()
  @UseGuards(OptionalJwtAuthGuard)
  @Throttle({ default: { limit: 8, ttl: seconds(60) } })
  @Post(':kind')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Submit an intake form of the given kind.' })
  @ApiCreatedResponse({ description: 'The submission was recorded.' })
  @ApiBadRequestResponse({
    description: 'Unknown kind, or a payload that exceeds the size bounds.',
  })
  @ApiUnauthorizedResponse({
    description: 'A member-only kind was submitted anonymously.',
  })
  submit(
    @Param('kind') kind: string,
    @Body() body: CreateIntakeDto,
    // Populated best-effort by OptionalJwtAuthGuard; undefined when anonymous.
    @CurrentUser() user: CurrentUserData | undefined,
  ) {
    return this.intakes.submit(kind, body.payload, user);
  }

  /**
   * PUBLIC (PRD-261): whoever holds a concern's reference code asks where that
   * concern stands. The code is the entire credential — an anonymous submitter
   * has no account to sign in to and the platform sends no mail, so this route
   * plus the code they kept is the only way they ever learn their report was
   * picked up, resolved, or closed.
   *
   * Declared BEFORE `@Get()` so Nest matches this two-segment path first.
   *
   * Throttled 20/hour, keyed by IP through `HttpThrottlerGuard`'s inherited
   * default tracker — the same figure and the same reasoning as
   * `GET /join-requests/status`. The code carries 256 bits, so throttling is
   * not what makes guessing infeasible; it is here so an unauthenticated read
   * that touches the database is not free amplification. Looser than the 8/min
   * on submit because reloading a status page is a normal thing for one person
   * to do repeatedly, and someone waiting on a report about harm will.
   *
   * ONE 404 FOR EVERY FAILURE — unknown code, well-formed code that was never
   * issued, a code minted for some other intake kind. A response that
   * distinguished them would make the route an oracle for probing codes, and
   * the rows behind these codes name people. A malformed code never reaches
   * the service: the query DTO's charset and length bounds turn it into a 400
   * first.
   */
  @Public()
  @Throttle({ default: { limit: 20, ttl: seconds(3600) } })
  @Get('concerns/status')
  @ApiOperation({ summary: 'Check the status of your own concern.' })
  @ApiOkResponse({ description: 'Where the concern stands.' })
  @ApiBadRequestResponse({ description: 'A malformed reference code.' })
  @ApiNotFoundResponse({
    description: 'The code does not resolve to a concern.',
  })
  async concernStatus(
    @Query() query: ConcernStatusQuery,
  ): Promise<ConcernStatusDTO> {
    const view = await this.intakes.getConcernStatus(query.token);
    if (!view) {
      throw new NotFoundException('Concern not found');
    }
    return view;
  }

  @UseGuards(ActiveMemberGuard, RolesGuard)
  @Roles(UserRole.Admin)
  @ApiCookieAuth('access_token')
  @Get()
  @ApiOperation({ summary: 'List intake submissions for triage (admin).' })
  @ApiOkResponse({ description: 'A page of intake submissions, newest first.' })
  @ApiUnauthorizedResponse({ description: 'Not authenticated.' })
  @ApiForbiddenResponse({ description: 'Requires the admin role.' })
  list(@Query() query: ListIntakesQuery) {
    return this.intakes.list(query);
  }

  /**
   * Claim or release one submission (OPS-04).
   *
   * The same route shape, body and semantics as
   * `PATCH /mod/reports/:id/assignment`: self-assign only, 409 when someone
   * else holds it, release only what you hold (admins override both, so the
   * console cannot deadlock on an account that is gone). Declared BEFORE
   * `PATCH :id` so Nest matches the two-segment path first, and carrying the
   * SAME per-method gate the other two admin routes on this controller
   * carry — this class has no class-level guard because `POST :kind` is
   * deliberately public.
   */
  @UseGuards(ActiveMemberGuard, RolesGuard)
  @Roles(UserRole.Admin)
  @ApiCookieAuth('access_token')
  @Patch(':id/assignment')
  @ApiOperation({ summary: 'Claim or release an intake submission (admin).' })
  @ApiOkResponse({ description: 'The updated submission.' })
  @ApiUnauthorizedResponse({ description: 'Not authenticated.' })
  @ApiForbiddenResponse({ description: 'Requires the admin role.' })
  @ApiNotFoundResponse({ description: 'No submission with that id.' })
  setAssignment(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: QueueAssignmentDto,
    @CurrentUser() admin: CurrentUserData,
  ) {
    return this.intakes.setAssignment(
      id,
      admin.userId,
      admin.role,
      body.assign,
    );
  }

  @UseGuards(ActiveMemberGuard, RolesGuard)
  @Roles(UserRole.Admin)
  @ApiCookieAuth('access_token')
  @Patch(':id')
  @ApiOperation({
    summary: 'Move a submission through triage (admin).',
    description:
      'The governance-concern dashboard marks a concern reviewing / resolved ' +
      '/ dismissed; the other eleven kinds flip to the plain `reviewed`. ' +
      'Every move stamps the acting admin and the time. `new` is not an ' +
      'accepted target.',
  })
  @ApiOkResponse({ description: 'The updated submission.' })
  @ApiBadRequestResponse({ description: 'An invalid target status.' })
  @ApiUnauthorizedResponse({ description: 'Not authenticated.' })
  @ApiForbiddenResponse({ description: 'Requires the admin role.' })
  @ApiNotFoundResponse({ description: 'No submission with that id.' })
  updateStatus(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: UpdateIntakeStatusDto,
    @CurrentUser() admin: CurrentUserData,
  ) {
    return this.intakes.updateStatus(id, body.status, admin.userId);
  }
}
