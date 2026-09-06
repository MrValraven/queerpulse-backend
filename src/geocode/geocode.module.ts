import { Module } from '@nestjs/common';
import { GeocodeController } from './geocode.controller';
import { GeocodeService } from './geocode.service';

@Module({
  controllers: [GeocodeController],
  providers: [GeocodeService],
  // Exported so a server-side write path can geocode without going back out
  // through the HTTP controller. `HousingListingsModule` uses it to turn a
  // lister's private street address into the precise pin behind the
  // address-privacy gate. The outbound call is rate-limited process-wide
  // (`nominatim-rate-limiter.ts`), so every server-side caller must treat it as
  // best-effort and never let a failure fail its own domain write.
  exports: [GeocodeService],
})
export class GeocodeModule {}
