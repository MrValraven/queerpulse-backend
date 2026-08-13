import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Handle, HandleOwnerKind } from '../handles/entities/handle.entity';
import { NotificationType } from '../notifications/entities/notification.entity';
import { NotificationsService } from '../notifications/notifications.service';
import { Profile } from '../users/entities/profile.entity';
import { SubprofileItemInputDTO } from './dto/replace-items.dto';
import {
  Subprofile,
  SubprofileKind,
  SubprofileLinkVisibility,
  SubprofileStatus,
  SubprofileVisibility,
} from './entities/subprofile.entity';
import {
  SubprofileItem,
  SubprofileSection,
} from './entities/subprofile-item.entity';
import { SubprofileMember } from './entities/subprofile-member.entity';
import { CollaboratorView } from './subprofile-response';
import { SubprofileCreditsService } from './subprofile-credits.service';
import { SubprofilePublicReadService } from './subprofile-public-read.service';

// --- fixtures ---------------------------------------------------------------

function makeSubprofile(overrides: Partial<Subprofile> = {}): Subprofile {
  return {
    id: 'sp-1',
    userId: 'user-1',
    user: undefined as never,
    kind: SubprofileKind.Developer,
    slug: 'nightform',
    handle: 'nightform',
    displayName: 'Nightform',
    avatarUrl: null,
    tagline: null,
    bio: null,
    coverUrl: null,
    accent: null,
    availability: null,
    ctaLabel: null,
    ctaUrl: null,
    linkVisibility: SubprofileLinkVisibility.Unlinked,
    visibility: SubprofileVisibility.Open,
    status: SubprofileStatus.Published,
    position: 0,
    skinData: null,
    removedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeItem(overrides: Partial<SubprofileItem> = {}): SubprofileItem {
  return {
    id: 'it-1',
    subprofileId: 'sp-1',
    section: SubprofileSection.Projects,
    title: 'Thing',
    subtitle: null,
    description: null,
    url: null,
    imageUrl: null,
    date: null,
    meta: null,
    tags: [],
    isFeatured: false,
    collaborators: [],
    position: 0,
    venue: null,
    doors: null,
    ticketUrl: null,
    gigState: null,
    medium: null,
    dimensions: null,
    edition: null,
    workState: null,
    structured: null,
    createdAt: new Date(),
    ...overrides,
  };
}

function makeHandleRow(overrides: Partial<Handle> = {}): Handle {
  return {
    name: 'alice',
    ownerKind: HandleOwnerKind.Profile,
    userId: 'user-2',
    user: undefined as never,
    subprofileId: null,
    subprofile: null,
    createdAt: new Date(),
    ...overrides,
  };
}

// A resolved "member" collaborator card, the shape `SubprofilePublicReadService
// .resolveHandles` (mocked here) hands back — the only shape
// `computeNewlyCreditedHandles`'s before/after diff actually reads (`type`).
function memberCollaboratorView(
  overrides: Partial<CollaboratorView> = {},
): CollaboratorView {
  return {
    handle: 'alice',
    type: 'member',
    name: 'Alice A',
    avatarUrl: null,
    slug: 'alice',
    ...overrides,
  };
}

describe('SubprofileCreditsService', () => {
  let service: SubprofileCreditsService;
  let itemsRepo: jest.Mocked<Pick<Repository<SubprofileItem>, 'find'>>;
  let membersRepo: jest.Mocked<Pick<Repository<SubprofileMember>, 'find'>>;
  let handleRegistry: jest.Mocked<Pick<Repository<Handle>, 'find'>>;
  let profilesRepo: jest.Mocked<Pick<Repository<Profile>, 'findOne'>>;
  let notifications: { create: jest.Mock };
  let publicRead: { resolveHandles: jest.Mock };

  beforeEach(async () => {
    itemsRepo = { find: jest.fn().mockResolvedValue([]) };
    membersRepo = { find: jest.fn().mockResolvedValue([]) };
    handleRegistry = { find: jest.fn().mockResolvedValue([]) };
    profilesRepo = { findOne: jest.fn().mockResolvedValue(null) };
    notifications = { create: jest.fn().mockResolvedValue(null) };
    // `resolveHandles` is the one cross-service dependency
    // `computeNewlyCreditedHandles` leans on for the BEFORE set (the
    // persona-wide existing collaborators' resolved type). Defaults to "no
    // handles resolve to anything" so a test that doesn't touch it is
    // unaffected; individual tests below override per-case.
    publicRead = { resolveHandles: jest.fn().mockResolvedValue(new Map()) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SubprofileCreditsService,
        { provide: getRepositoryToken(SubprofileItem), useValue: itemsRepo },
        { provide: getRepositoryToken(SubprofileMember), useValue: membersRepo },
        { provide: getRepositoryToken(Handle), useValue: handleRegistry },
        { provide: getRepositoryToken(Profile), useValue: profilesRepo },
        { provide: NotificationsService, useValue: notifications },
        { provide: SubprofilePublicReadService, useValue: publicRead },
      ],
    }).compile();

    service = module.get(SubprofileCreditsService);
  });

  // --- computeNewlyCreditedHandles --------------------------------------------

  describe('computeNewlyCreditedHandles', () => {
    it('returns a genuinely new collaborator handle on a first save (no prior items)', async () => {
      itemsRepo.find.mockResolvedValue([]); // nothing on the persona yet
      const incomingResolvedByHandle = new Map([
        ['alice', memberCollaboratorView({ handle: 'alice' })],
      ]);

      const result = await service.computeNewlyCreditedHandles(
        'sp-1',
        'owner-1',
        SubprofileSection.Projects,
        incomingResolvedByHandle,
      );

      expect(result).toEqual(['alice']);
      expect(itemsRepo.find).toHaveBeenCalledWith({
        where: { subprofileId: 'sp-1' },
      });
      // The BEFORE resolve is over the persona-wide existing collaborator
      // handles (none here), scoped to the owner as viewer.
      expect(publicRead.resolveHandles).toHaveBeenCalledWith([], 'owner-1');
    });

    it('does not re-fire when re-saving the same section with the same collaborator (dedup)', async () => {
      // This SAME section already credits @alice before this save.
      const existingItem = makeItem({
        section: SubprofileSection.Projects,
        collaborators: ['alice'],
      });
      itemsRepo.find.mockResolvedValue([existingItem]);
      publicRead.resolveHandles.mockResolvedValue(
        new Map([['alice', memberCollaboratorView({ handle: 'alice' })]]),
      );
      const incomingResolvedByHandle = new Map([
        ['alice', memberCollaboratorView({ handle: 'alice' })],
      ]);

      const result = await service.computeNewlyCreditedHandles(
        'sp-1',
        'owner-1',
        SubprofileSection.Projects,
        incomingResolvedByHandle,
      );

      // @alice was already credited (in the very section being replaced), so
      // re-saving the same content must not read as a new credit.
      expect(result).toEqual([]);
    });

    it('does not treat a handle already credited in an untouched OTHER section as new', async () => {
      // @alice is credited in the "gigs" section, which this save (to
      // "projects") never touches.
      const existingItemInOtherSection = makeItem({
        id: 'it-other',
        section: SubprofileSection.Gigs,
        collaborators: ['alice'],
      });
      itemsRepo.find.mockResolvedValue([existingItemInOtherSection]);
      publicRead.resolveHandles.mockResolvedValue(
        new Map([['alice', memberCollaboratorView({ handle: 'alice' })]]),
      );
      // This save's own section now also credits @alice.
      const incomingResolvedByHandle = new Map([
        ['alice', memberCollaboratorView({ handle: 'alice' })],
      ]);

      const result = await service.computeNewlyCreditedHandles(
        'sp-1',
        'owner-1',
        SubprofileSection.Projects,
        incomingResolvedByHandle,
      );

      expect(result).toEqual([]);
    });

    it('only counts a "persona" type collaborator as new, never as a member credit', async () => {
      itemsRepo.find.mockResolvedValue([]);
      const incomingResolvedByHandle = new Map([
        [
          'other-persona',
          {
            handle: 'other-persona',
            type: 'persona' as const,
            name: 'Other Persona',
            avatarUrl: null,
            slug: null,
          },
        ],
      ]);

      const result = await service.computeNewlyCreditedHandles(
        'sp-1',
        'owner-1',
        SubprofileSection.Projects,
        incomingResolvedByHandle,
      );

      expect(result).toEqual([]);
    });
  });

  // --- emitSubprofileCreditNotifications --------------------------------------

  describe('emitSubprofileCreditNotifications', () => {
    it('emits exactly one notification for a newly-credited member handle, with the right payload', async () => {
      const sp = makeSubprofile();
      membersRepo.find.mockResolvedValue([
        { userId: 'user-1' } as SubprofileMember, // owner only, not @alice
      ]);
      handleRegistry.find.mockResolvedValue([
        makeHandleRow({ name: 'alice', userId: 'user-2' }),
      ]);
      const items: SubprofileItemInputDTO[] = [
        { title: 'Collab track', collaborators: ['alice'] } as SubprofileItemInputDTO,
      ];

      await service.emitSubprofileCreditNotifications(
        sp,
        'sp-1',
        ['alice'],
        items,
        [['alice']],
      );

      expect(notifications.create).toHaveBeenCalledTimes(1);
      expect(notifications.create).toHaveBeenCalledWith(
        'user-2',
        NotificationType.SubprofileCredit,
        {
          subprofileName: 'Nightform',
          subprofileSlugOrHandle: 'nightform',
          itemTitle: 'Collab track',
          deepLink: '/p/nightform',
        },
        'user-1',
      );
    });

    it('emits exactly one notification PER newly-credited handle, never once for the whole batch', async () => {
      const sp = makeSubprofile();
      membersRepo.find.mockResolvedValue([{ userId: 'user-1' } as SubprofileMember]);
      handleRegistry.find.mockResolvedValue([
        makeHandleRow({ name: 'alice', userId: 'user-2' }),
        makeHandleRow({ name: 'bob', userId: 'user-3' }),
      ]);
      const items: SubprofileItemInputDTO[] = [
        {
          title: 'Collab track',
          collaborators: ['alice', 'bob'],
        } as SubprofileItemInputDTO,
      ];

      await service.emitSubprofileCreditNotifications(
        sp,
        'sp-1',
        ['alice', 'bob'],
        items,
        [['alice', 'bob']],
      );

      expect(notifications.create).toHaveBeenCalledTimes(2);
      expect(notifications.create).toHaveBeenCalledWith(
        'user-2',
        NotificationType.SubprofileCredit,
        expect.objectContaining({ itemTitle: 'Collab track' }),
        'user-1',
      );
      expect(notifications.create).toHaveBeenCalledWith(
        'user-3',
        NotificationType.SubprofileCredit,
        expect.objectContaining({ itemTitle: 'Collab track' }),
        'user-1',
      );
    });

    it('excludes the persona owner from notification even when their own handle is in newlyCreditedHandles (self-credit)', async () => {
      const sp = makeSubprofile();
      // The owner is the persona's only member.
      membersRepo.find.mockResolvedValue([{ userId: 'user-1' } as SubprofileMember]);
      // The credited handle's registered owner IS the persona's own owner.
      handleRegistry.find.mockResolvedValue([
        makeHandleRow({ name: 'nightowner', userId: 'user-1' }),
      ]);
      const items: SubprofileItemInputDTO[] = [
        {
          title: 'Solo track',
          collaborators: ['nightowner'],
        } as SubprofileItemInputDTO,
      ];

      await service.emitSubprofileCreditNotifications(
        sp,
        'sp-1',
        ['nightowner'],
        items,
        [['nightowner']],
      );

      expect(notifications.create).not.toHaveBeenCalled();
    });

    it('excludes a fellow co-owner from notification, not only the creator', async () => {
      const sp = makeSubprofile({ userId: 'creator-1' });
      // 'co-owner-2' co-owns the persona alongside the creator.
      membersRepo.find.mockResolvedValue([
        { userId: 'creator-1' } as SubprofileMember,
        { userId: 'co-owner-2' } as SubprofileMember,
      ]);
      handleRegistry.find.mockResolvedValue([
        makeHandleRow({ name: 'coowner', userId: 'co-owner-2' }),
      ]);
      const items: SubprofileItemInputDTO[] = [
        { title: 'Team piece', collaborators: ['coowner'] } as SubprofileItemInputDTO,
      ];

      await service.emitSubprofileCreditNotifications(
        sp,
        'sp-1',
        ['coowner'],
        items,
        [['coowner']],
      );

      expect(notifications.create).not.toHaveBeenCalled();
    });

    it('does nothing when no newly-credited handle resolves to a registered member', async () => {
      const sp = makeSubprofile();
      handleRegistry.find.mockResolvedValue([]); // handle no longer registered
      const items: SubprofileItemInputDTO[] = [
        { title: 'Collab track', collaborators: ['ghost'] } as SubprofileItemInputDTO,
      ];

      await service.emitSubprofileCreditNotifications(
        sp,
        'sp-1',
        ['ghost'],
        items,
        [['ghost']],
      );

      expect(notifications.create).not.toHaveBeenCalled();
      // Never even loads the persona's members when there is nothing to check
      // them against.
      expect(membersRepo.find).not.toHaveBeenCalled();
    });
  });
});
