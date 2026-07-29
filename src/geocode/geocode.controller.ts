import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { Throttle, seconds } from '@nestjs/throttler';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { ResolveLinkDto } from './dto/resolve-link.dto';
import { GeocodeService } from './geocode.service';
import { ApiCookieAuth, ApiTags } from '@nestjs/swagger';

@ApiTags('Geocoding')
@ApiCookieAuth()
@Controller('geocode')
@UseGuards(ActiveMemberGuard)
export class GeocodeController {
  constructor(private readonly geocodeService: GeocodeService) {}

  // Tighter than the global throttle: this makes a server-side outbound fetch
  // to resolve the link, so it's a cost/SSRF-amplification surface worth capping.
  @Throttle({ default: { limit: 20, ttl: seconds(60) } })
  @Post('resolve-link')
  @HttpCode(200)
  resolveLink(@Body() dto: ResolveLinkDto) {
    return this.geocodeService.resolveLink(dto.url);
  }
}
