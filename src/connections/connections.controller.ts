import {
  Body,
  Controller,
  Delete,
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
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { CreateConnectionDto } from './dto/create-connection.dto';
import { ListConnectionsQuery } from './dto/list-connections.query';
import { RespondConnectionDto } from './dto/respond-connection.dto';
import { ConnectionsService } from './connections.service';
import { Throttle, seconds } from '@nestjs/throttler';

@Controller('connections')
@UseGuards(ActiveMemberGuard)
export class ConnectionsController {
  constructor(private readonly connectionsService: ConnectionsService) {}

  @Get()
  list(
    @CurrentUser() user: CurrentUserData,
    @Query() query: ListConnectionsQuery,
  ) {
    return this.connectionsService.list(user.userId, query.tab ?? 'all');
  }

  @Throttle({ default: { limit: 30, ttl: seconds(60) } })
  @Post()
  create(
    @CurrentUser() user: CurrentUserData,
    @Body() dto: CreateConnectionDto,
  ) {
    return this.connectionsService.requestConnection(
      user.userId,
      dto.toSlug,
      dto.message,
    );
  }

  @Patch(':id')
  respond(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: CurrentUserData,
    @Body() dto: RespondConnectionDto,
  ) {
    return this.connectionsService.respond(id, user.userId, dto.action);
  }

  @Delete(':id')
  remove(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: CurrentUserData,
  ) {
    return this.connectionsService.remove(id, user.userId);
  }
}
