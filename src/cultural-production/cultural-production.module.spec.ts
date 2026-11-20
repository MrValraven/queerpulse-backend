import { getRepositoryToken } from '@nestjs/typeorm';
import { MediaCropsModule } from '../media-crops/media-crops.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { Profile } from '../users/entities/profile.entity';
import { UserStaffRole } from '../users/entities/user-staff-role.entity';
import { User } from '../users/entities/user.entity';
import { AdminCulturalProductionController } from './admin-cultural-production.controller';
import { CulturalGuidesService } from './cultural-guides.service';
import { CulturalIdeasService } from './cultural-ideas.service';
import { CulturalProductionModule } from './cultural-production.module';
import { CulturalTasksService } from './cultural-tasks.service';
import { CulturalGuide } from './entities/cultural-guide.entity';
import { CulturalIdeaBacker } from './entities/cultural-idea-backer.entity';
import { CulturalIdeaComment } from './entities/cultural-idea-comment.entity';
import { CulturalIdea } from './entities/cultural-idea.entity';
import { CulturalTaskAssignee } from './entities/cultural-task-assignee.entity';
import { CulturalTask } from './entities/cultural-task.entity';

type ImportedModule = { providers?: { provide?: unknown }[] };

const importedModulesOf = (): ImportedModule[] =>
  Reflect.getMetadata('imports', CulturalProductionModule) as ImportedModule[];

describe('CulturalProductionModule', () => {
  it('registers the six entities plus UserStaffRole, User and Profile', () => {
    const entityTokens = importedModulesOf().flatMap((importedModule) =>
      (importedModule.providers ?? []).map((provider) => provider.provide),
    );

    expect(entityTokens).toEqual(
      expect.arrayContaining([
        getRepositoryToken(CulturalIdea),
        getRepositoryToken(CulturalIdeaBacker),
        getRepositoryToken(CulturalIdeaComment),
        getRepositoryToken(CulturalTask),
        getRepositoryToken(CulturalTaskAssignee),
        getRepositoryToken(CulturalGuide),
        getRepositoryToken(UserStaffRole),
        getRepositoryToken(User),
        getRepositoryToken(Profile),
      ]),
    );
    expect(entityTokens).toHaveLength(9);
  });

  it('imports MediaCropsModule and NotificationsModule', () => {
    const importedModules = importedModulesOf() as unknown[];

    expect(importedModules).toContain(MediaCropsModule);
    expect(importedModules).toContain(NotificationsModule);
  });

  it('provides the three services', () => {
    const providers = Reflect.getMetadata(
      'providers',
      CulturalProductionModule,
    ) as unknown[];

    expect(providers).toEqual(
      expect.arrayContaining([
        CulturalIdeasService,
        CulturalTasksService,
        CulturalGuidesService,
      ]),
    );
    expect(providers).toHaveLength(3);
  });

  it('declares the one controller', () => {
    expect(
      Reflect.getMetadata('controllers', CulturalProductionModule),
    ).toEqual([AdminCulturalProductionController]);
  });

  it('exports nothing', () => {
    const exportedProviders = Reflect.getMetadata(
      'exports',
      CulturalProductionModule,
    ) as unknown[] | undefined;

    expect(exportedProviders ?? []).toEqual([]);
  });
});
