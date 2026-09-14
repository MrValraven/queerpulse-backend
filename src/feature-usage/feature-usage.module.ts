import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AdminFeatureUsageController } from './admin-feature-usage.controller';
import { AdminFeatureUsageService } from './admin-feature-usage.service';
import { FeatureUsageDaily } from './entities/feature-usage-daily.entity';
import { FeatureUsageFlushService } from './feature-usage-flush.service';
import { FeatureUsageRetentionService } from './feature-usage-retention.service';
import { FeatureUsageTallyService } from './feature-usage-tally.service';

@Module({
  imports: [
    // FeatureUsageDaily is the only entity this module ever injects with
    // `@InjectRepository` (in FeatureUsageFlushService,
    // FeatureUsageRetentionService, and AdminFeatureUsageService). Every
    // depth and drill-down count in AdminFeatureUsageService goes through the
    // injected `DataSource` instead (`this.dataSource.createQueryBuilder(entity, …)`
    // and `this.dataSource.getRepository(Community)`), which needs the
    // target entity registered on the DataSource, not a `forFeature` entry in
    // this module. That registration already happens in each entity's own
    // home module (`CommunitiesModule` for `Community`, `ForumModule` for
    // `ForumPost`/`ForumThread`, and so on), all of which `AppModule` imports,
    // and `autoLoadEntities: true` (`src/database/database.module.ts`) makes
    // any entity registered by any imported module's `forFeature` call
    // available to the whole application, including here. Adding a `rows`
    // entity to `FEATURE_DEPTH` (`feature-depth.ts`) therefore needs no
    // change in this file, as long as its home module is already imported in
    // `AppModule`.
    TypeOrmModule.forFeature([FeatureUsageDaily]),
  ],
  controllers: [AdminFeatureUsageController],
  providers: [
    FeatureUsageTallyService,
    FeatureUsageFlushService,
    FeatureUsageRetentionService,
    AdminFeatureUsageService,
  ],
  exports: [FeatureUsageTallyService],
})
export class FeatureUsageModule {}
