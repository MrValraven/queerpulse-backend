import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { seconds, Throttle } from '@nestjs/throttler';
import {
  CurrentUser,
  CurrentUserData,
} from '../auth/decorators/current-user.decorator';
import { Public } from '../auth/decorators/public.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { UserRole } from '../users/entities/user.entity';
import { CreateJoinRequestDto } from './dto/create-join-request.dto';
import { ListJoinRequestsQuery } from './dto/list-join-requests.query';
import { ReviewJoinRequestDto } from './dto/review-join-request.dto';
import {
  JoinRequestView,
  SubmittedJoinRequestView,
} from './join-request-response';
import { JoinRequestsService } from './join-requests.service';

@Controller('join-requests')
export class JoinRequestsController {
  constructor(private readonly joinRequestsService: JoinRequestsService) {}

  /**
   * PUBLIC: a stranger with no account asks for an invite. `@Public()` opts out
   * of `JwtAuthGuard` only — the global `CsrfGuard` still applies to this POST,
   * so the frontend must carry a CSRF token here exactly as it does for the
   * other public POSTs (`/auth/refresh`, `/auth/logout`).
   *
   * Throttled 3/hour, keyed BY IP: `HttpThrottlerGuard` (src/security) does not
   * override `getTracker`, so it inherits `ThrottlerGuard`'s default tracker,
   * which is the client IP (`req.ips[0] ?? req.ip`). That is the right key for
   * an unauthenticated route — there is no user to key on. Contrast
   * `UserPresignThrottlerGuard`, which exists precisely because it had to
   * override that default in order to track by user id instead.
   *
   * IP throttling is one of three spam controls and the weakest of them (shared
   * NAT lumps people together; an attacker can hop addresses). The other two do
   * not depend on the network: one open request per email, enforced by a partial
   * unique index, and a hard length cap on every field in the DTO.
   */
  @Public()
  @Throttle({ default: { limit: 3, ttl: seconds(3600) } })
  @Post()
  @HttpCode(HttpStatus.CREATED)
  submit(@Body() dto: CreateJoinRequestDto): Promise<SubmittedJoinRequestView> {
    return this.joinRequestsService.submit(dto);
  }

  @Get()
  @UseGuards(RolesGuard)
  @Roles(UserRole.Moderator, UserRole.Admin)
  list(@Query() query: ListJoinRequestsQuery): Promise<JoinRequestView[]> {
    return this.joinRequestsService.list(query.status);
  }

  @Patch(':id')
  @UseGuards(RolesGuard)
  @Roles(UserRole.Moderator, UserRole.Admin)
  review(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: CurrentUserData,
    @Body() dto: ReviewJoinRequestDto,
  ): Promise<JoinRequestView> {
    return this.joinRequestsService.review(id, user.userId, dto.status);
  }
}
