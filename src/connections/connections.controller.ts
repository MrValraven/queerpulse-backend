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
import { Feature } from '../common/feature.decorator';
import { CreateConnectionDto } from './dto/create-connection.dto';
import { ListConnectionsQuery } from './dto/list-connections.query';
import { RespondConnectionDto } from './dto/respond-connection.dto';
import { ConnectionsService } from './connections.service';
import { Throttle, seconds } from '@nestjs/throttler';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

@Feature('connections')
@ApiTags('Connections')
@ApiCookieAuth('access_token')
@ApiUnauthorizedResponse({
  description: 'Requires an authenticated, active member session.',
})
@Controller('connections')
@UseGuards(ActiveMemberGuard)
export class ConnectionsController {
  constructor(private readonly connectionsService: ConnectionsService) {}

  @Get()
  @ApiOperation({ summary: 'List your connections (paginated, filtered by tab).' })
  @ApiOkResponse({ description: 'A page of connection list items.' })
  list(
    @CurrentUser() user: CurrentUserData,
    @Query() query: ListConnectionsQuery,
  ) {
    return this.connectionsService.list(user.userId, query.tab ?? 'all', query);
  }

  @Get('counts')
  @ApiOperation({ summary: 'Per-tab connection counts for the tab badges.' })
  @ApiOkResponse({ description: 'Counts keyed by tab.' })
  counts(@CurrentUser() user: CurrentUserData) {
    return this.connectionsService.counts(user.userId);
  }

  @Get('accepted')
  @ApiOperation({ summary: 'Slugs of your accepted connections.' })
  @ApiOkResponse({ description: 'The accepted connection slugs.' })
  accepted(@CurrentUser() user: CurrentUserData): Promise<string[]> {
    return this.connectionsService.getAcceptedConnectionSlugs(user.userId);
  }

  @Throttle({ default: { limit: 30, ttl: seconds(60) } })
  @Post()
  @ApiOperation({ summary: 'Send a connection request.' })
  @ApiCreatedResponse({ description: 'The created request as a list item.' })
  @ApiBadRequestResponse({ description: 'You cannot connect to yourself.' })
  @ApiForbiddenResponse({
    description:
      'Blocked, the member is not accepting connections, or an introduction is required.',
  })
  @ApiNotFoundResponse({ description: 'Member or introducer not found.' })
  @ApiConflictResponse({
    description: 'A request is already pending or you are already connected.',
  })
  create(
    @CurrentUser() user: CurrentUserData,
    @Body() dto: CreateConnectionDto,
  ) {
    return this.connectionsService.requestConnectionView(
      user.userId,
      dto.toSlug,
      dto.message,
      dto.introducerSlug,
      dto.reason,
    );
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Respond to a connection (accept, decline, block, or unblock).',
  })
  @ApiOkResponse({ description: 'The updated connection as a list item.' })
  @ApiForbiddenResponse({
    description: 'Not your connection, or you may not perform this action.',
  })
  @ApiNotFoundResponse({ description: 'Connection not found.' })
  @ApiConflictResponse({
    description: 'No pending request, or the connection is not blocked.',
  })
  respond(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: CurrentUserData,
    @Body() dto: RespondConnectionDto,
  ) {
    return this.connectionsService.respondView(id, user.userId, dto.action);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Remove a connection.' })
  @ApiOkResponse({ description: 'Removal acknowledged.' })
  @ApiForbiddenResponse({
    description: 'Not your connection, or you are blocked by the other member.',
  })
  @ApiNotFoundResponse({ description: 'Connection not found.' })
  remove(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: CurrentUserData,
  ) {
    return this.connectionsService.remove(id, user.userId);
  }
}
