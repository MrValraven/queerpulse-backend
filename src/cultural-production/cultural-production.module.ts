import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { MediaCropsModule } from '../media-crops/media-crops.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { Profile } from '../users/entities/profile.entity';
import { UserStaffRole } from '../users/entities/user-staff-role.entity';
import { User } from '../users/entities/user.entity';
import { AdminCulturalProductionController } from './admin-cultural-production.controller';
import { CulturalGuidesService } from './cultural-guides.service';
import { CulturalIdeasService } from './cultural-ideas.service';
import { CulturalTasksService } from './cultural-tasks.service';
import { CulturalGuide } from './entities/cultural-guide.entity';
import { CulturalIdeaBacker } from './entities/cultural-idea-backer.entity';
import { CulturalIdeaComment } from './entities/cultural-idea-comment.entity';
import { CulturalIdea } from './entities/cultural-idea.entity';
import { CulturalTaskAssignee } from './entities/cultural-task-assignee.entity';
import { CulturalTask } from './entities/cultural-task.entity';

/**
 * The staff Cultural Production page at `admin/cultural-production`: one
 * controller and three services (ideas with backing and comments, tasks with
 * assignees, the due count, the staff picker and guide batches, and guides).
 * Exports nothing; no other module reads these tables, and the access-loss
 * hook (`cultural-task-assignee-access.ts`) runs raw SQL inside the admin
 * members transaction.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      // Read-only, and only for `RolesOrStaffGuard` on this module's admin
      // controller: it resolves the caller's additive staff grants when their
      // account tier alone does not satisfy `@Roles(...)`. Same registration
      // precedent as `LeadsModule`.
      UserStaffRole,

      // The six Cultural Production tables, plus the people the services
      // read for staff summaries and eligibility.
      CulturalIdea,
      CulturalIdeaBacker,
      CulturalIdeaComment,
      CulturalTask,
      CulturalTaskAssignee,
      CulturalGuide,
      User,
      Profile,
    ]),
    // Exports `MediaCropService` (avatar crops on staff summaries).
    MediaCropsModule,
    // Exports `NotificationsService` (the two task assignment notices).
    NotificationsModule,
  ],
  controllers: [AdminCulturalProductionController],
  providers: [
    CulturalIdeasService,
    CulturalTasksService,
    CulturalGuidesService,
  ],
})
export class CulturalProductionModule {}
