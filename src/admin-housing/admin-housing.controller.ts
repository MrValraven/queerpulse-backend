import {
  Body,
  Controller,
  Delete,
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
import { Roles } from '../auth/decorators/roles.decorator';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import {} from '../auth/decorators/current-user.decorator';
import { UserRole } from '../users/entities/user.entity';
import { HousingService } from '../housing/housing.service';
import { CreateCoopDto } from '../housing/dto/create-coop.dto';
import { UpdateCoopDto } from '../housing/dto/update-coop.dto';
import { TriageHousingJoinRequestDto } from '../housing/dto/triage-join-request.dto';
import { ListCoopJoinRequestsQuery } from '../housing/dto/list-coop-join-requests.query';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

@UseGuards(ActiveMemberGuard, RolesGuard)
@Roles(UserRole.Admin)
@ApiTags('Admin — Housing')
@ApiCookieAuth('access_token')
@ApiUnauthorizedResponse({ description: 'Not authenticated.' })
@ApiForbiddenResponse({ description: 'Requires the admin role.' })
@Controller('admin/housing')
export class AdminHousingController {
  constructor(private readonly housing: HousingService) {}

  @ApiOperation({ summary: 'List every housing co-op for admin management.' })
  @ApiOkResponse({ description: 'The co-ops.' })
  @Get('coops')
  listCoops() {
    return this.housing.listAllForAdmin();
  }

  @ApiOperation({ summary: 'Create a housing co-op.' })
  @ApiCreatedResponse({ description: 'The created co-op.' })
  @ApiBadRequestResponse({ description: 'Malformed request body.' })
  @ApiConflictResponse({ description: 'Slug already in use.' })
  @Post('coops')
  createCoop(@Body() dto: CreateCoopDto) {
    return this.housing.createCoop(dto);
  }

  @ApiOperation({ summary: 'Update a housing co-op.' })
  @ApiOkResponse({ description: 'The updated co-op.' })
  @ApiBadRequestResponse({ description: 'Malformed request body or id.' })
  @ApiNotFoundResponse({ description: 'Co-op not found.' })
  @ApiConflictResponse({ description: 'Slug already in use.' })
  @Patch('coops/:id')
  updateCoop(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateCoopDto,
  ) {
    return this.housing.updateCoop(id, dto);
  }

  @ApiOperation({ summary: 'Delete a housing co-op.' })
  @ApiNoContentResponse({ description: 'Co-op deleted.' })
  @ApiBadRequestResponse({ description: 'Malformed id.' })
  @ApiNotFoundResponse({ description: 'Co-op not found.' })
  @Delete('coops/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  deleteCoop(@Param('id', ParseUUIDPipe) id: string) {
    return this.housing.deleteCoop(id);
  }

  @ApiOperation({
    summary:
      'List one page of co-op join requests, newest first, optionally ' +
      'filtered by status and co-op slug.',
    description:
      'Answers with a `{ items, total, page, pageSize }` page (ENG-41). It ' +
      'used to answer with a flat array of the newest 200 requests in every ' +
      'status, so a platform with more than 200 requests hid the rest with ' +
      'nothing in the response saying so, and a console filtering to pending ' +
      'in the browser could show an empty queue while people waited. `total` ' +
      'is the size of the whole filtered queue, not of this page. Omitting ' +
      '`status` still returns every status.',
  })
  @ApiOkResponse({
    description: 'One page of join requests, with the queue total.',
  })
  @ApiBadRequestResponse({ description: 'Malformed query parameters.' })
  @Get('join-requests')
  listJoinRequests(@Query() query: ListCoopJoinRequestsQuery) {
    return this.housing.listJoinRequests(query);
  }

  @ApiOperation({ summary: 'Triage (approve/reject) a co-op join request.' })
  @ApiOkResponse({ description: 'The updated join request.' })
  @ApiBadRequestResponse({ description: 'Malformed request body or id.' })
  @ApiNotFoundResponse({ description: 'Join request not found.' })
  @Patch('join-requests/:id')
  triageJoinRequest(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: TriageHousingJoinRequestDto,
  ) {
    return this.housing.triageJoinRequest(id, dto.action);
  }

  // Operator-identity-verified marker: set through the existing PATCH coops/:id
  // (`UpdateCoopDto.operatorVerified`) — no dedicated route needed.
}
