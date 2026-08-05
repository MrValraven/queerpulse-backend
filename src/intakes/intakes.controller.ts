import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
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
import { UserRole } from '../users/entities/user.entity';
import { CreateIntakeDto } from './dto/create-intake.dto';
import { ListIntakesQuery } from './dto/list-intakes.query';
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
}
