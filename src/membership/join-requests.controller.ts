import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  CurrentUser,
  CurrentUserData,
} from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { UserRole } from '../users/entities/user.entity';
import { CreateJoinRequestDto } from './dto/create-join-request.dto';
import { ListJoinRequestsQuery } from './dto/list-join-requests.query';
import { ReviewJoinRequestDto } from './dto/review-join-request.dto';
import { JoinRequestsService } from './join-requests.service';

@Controller('join-requests')
export class JoinRequestsController {
  constructor(private readonly joinRequestsService: JoinRequestsService) {}

  // pending-ok: a pending user with no invite asks to join.
  @Post()
  submit(
    @CurrentUser() user: CurrentUserData,
    @Body() dto: CreateJoinRequestDto,
  ) {
    return this.joinRequestsService.submit(user.userId, dto.message);
  }

  @Get()
  @UseGuards(RolesGuard)
  @Roles(UserRole.Moderator, UserRole.Admin)
  list(@Query() query: ListJoinRequestsQuery) {
    return this.joinRequestsService.list(query.status);
  }

  @Patch(':id')
  @UseGuards(RolesGuard)
  @Roles(UserRole.Moderator, UserRole.Admin)
  review(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: CurrentUserData,
    @Body() dto: ReviewJoinRequestDto,
  ) {
    return this.joinRequestsService.review(id, user.userId, dto.status);
  }
}
