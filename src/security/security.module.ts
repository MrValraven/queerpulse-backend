import { Module } from '@nestjs/common';
import { CsrfController } from './csrf.controller';

// CsrfGuard is bound as a global APP_GUARD in AppModule, THIRD in the chain:
// throttler, then the launched-feature gate, then CSRF, then JWT, then the
// lockdown kill switch. That order is load-bearing and documented at the
// `providers` array in app.module.ts. CSRF runs before authentication (it is
// independent of who you are) but after rate limiting, so a flood of forged
// mutations is counted rather than merely rejected.
@Module({
  controllers: [CsrfController],
})
export class SecurityModule {}
