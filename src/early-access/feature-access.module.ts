import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { FeatureEarlyAccessGrant } from './entities/feature-early-access-grant.entity';
import { FeatureAccessService } from './feature-access.service';

/**
 * Entity-only: registers the grant repository and exports
 * `FeatureAccessService`, with no other imports, so the Events, Quizshow, Auth
 * and App modules can import it without a cycle. The admin grant and revoke
 * flow lives in `EarlyAccessModule`.
 */
@Module({
  imports: [TypeOrmModule.forFeature([FeatureEarlyAccessGrant])],
  providers: [FeatureAccessService],
  exports: [FeatureAccessService],
})
export class FeatureAccessModule {}
