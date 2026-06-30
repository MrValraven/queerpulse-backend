import { Module } from '@nestjs/common';
import { CsrfController } from './csrf.controller';

// CsrfGuard is registered as the first global APP_GUARD in AppModule so CSRF
// validates independently of (and before) auth/throttling.
@Module({
  controllers: [CsrfController],
})
export class SecurityModule {}
