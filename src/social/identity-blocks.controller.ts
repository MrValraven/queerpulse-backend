import {
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiNoContentResponse,
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
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { ListPageQuery } from './dto/list-page.query';
import { IdentityBlocksService } from './identity-blocks.service';

/**
 * Task 14: blocking a whole business, persona or company, addressed by
 * identity id. A path of its own, apart from `/blocks/:slug`, so no member
 * handle can ever be read as one of these routes. Always on, like the person
 * blocks: no `@Feature` flag.
 */
@ApiTags('Blocks')
@ApiCookieAuth()
@Controller('identity-blocks')
@UseGuards(ActiveMemberGuard)
export class IdentityBlocksController {
  constructor(private readonly identityBlocks: IdentityBlocksService) {}

  @Get()
  @ApiOperation({
    summary: 'List businesses, personas and companies you have blocked',
  })
  @ApiOkResponse({ description: 'A page of identity-block records.' })
  @ApiUnauthorizedResponse({
    description: 'Not an authenticated active member.',
  })
  list(@CurrentUser() user: CurrentUserData, @Query() query: ListPageQuery) {
    return this.identityBlocks.listIdentityBlocks(user.userId, query.page);
  }

  /** Idempotent: blocking an identity twice returns the one row. */
  @Post(':identityId')
  @ApiOperation({
    summary: 'Block a business, persona or company by identity id',
  })
  @ApiCreatedResponse({
    description: 'The identity-block record (new or pre-existing).',
  })
  @ApiBadRequestResponse({
    description:
      'The identity is a person (use a person block), or one you answer for.',
  })
  @ApiNotFoundResponse({ description: 'No identity with that id.' })
  @ApiUnauthorizedResponse({
    description: 'Not an authenticated active member.',
  })
  block(
    @CurrentUser() user: CurrentUserData,
    @Param('identityId', ParseUUIDPipe) identityId: string,
  ) {
    return this.identityBlocks.blockIdentity(user.userId, identityId);
  }

  /** Idempotent: lifting a block that does not exist succeeds. */
  @Delete(':identityId')
  @HttpCode(204)
  @ApiOperation({ summary: 'Unblock a business, persona or company' })
  @ApiNoContentResponse({ description: 'No block remains.' })
  @ApiUnauthorizedResponse({
    description: 'Not an authenticated active member.',
  })
  unblock(
    @CurrentUser() user: CurrentUserData,
    @Param('identityId', ParseUUIDPipe) identityId: string,
  ) {
    return this.identityBlocks.unblockIdentity(user.userId, identityId);
  }
}
