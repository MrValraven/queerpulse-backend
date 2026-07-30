import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../auth/decorators/public.decorator';
import { Feature } from '../common/feature.decorator';
import { RoadmapService } from './roadmap.service';

/**
 * Public, read-only surface behind `/about/roadmap`. Deliberately a SEPARATE
 * controller from `RoadmapController`: that one carries a class-level
 * `ActiveMemberGuard`, and `ActiveMemberGuard` does NOT honor `@Public()` (it
 * unconditionally requires an active member), so the public read cannot live
 * under it — mirrors `DirectoryController`'s split from `ListingsController`.
 */
@Feature('roadmap')
@ApiTags('Roadmap')
@Controller('roadmap')
export class RoadmapPublicController {
  constructor(private readonly roadmapService: RoadmapService) {}

  @ApiOperation({ summary: 'Get the public roadmap (unauthenticated)' })
  @ApiOkResponse({
    description:
      'Hero stats plus shipped, building, planned, and top-idea entries.',
  })
  @Public()
  @Get()
  getPublic() {
    return this.roadmapService.getPublic();
  }
}
