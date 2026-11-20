import {
  resetImageUrlBaseForTesting,
  setImageUrlBase,
  toImageUrl,
} from '../common/image-url';
import type { CropRect } from '../media-crops/crop-rect';
import { UserRole } from '../users/entities/user.entity';
import {
  canDeleteCulturalItem,
  toCulturalGuide,
  toCulturalGuideListItem,
  toCulturalIdea,
  toCulturalIdeaListItem,
  toCulturalStaffSummary,
  toCulturalTask,
  toCulturalTaskListItem,
  type CulturalCaller,
  type CulturalIdeaStats,
  type CulturalStaffProfileRow,
  type CulturalStaffSummaryDTO,
  type CulturalTaskLinks,
} from './cultural-response';
import type { CulturalGuide } from './entities/cultural-guide.entity';
import type { CulturalIdeaComment } from './entities/cultural-idea-comment.entity';
import type { CulturalIdea } from './entities/cultural-idea.entity';
import type { CulturalTask } from './entities/cultural-task.entity';

const API_BASE_URL = 'https://api.example.test';
// A well-formed storage key: `toImageUrl` drops anything that does not parse as one.
const AVATAR_KEY =
  'persona/11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222.jpg';
const AVATAR_CROP: CropRect = {
  x: 0.1,
  y: 0.1,
  width: 0.5,
  height: 0.5,
  aspect: '1:1',
};
const CROPS = new Map<string, CropRect>([[AVATAR_KEY, AVATAR_CROP]]);

const AUTHOR_ID = '6f1c2a40-8b3d-4e5f-9a10-1b2c3d4e5f60';
const OTHER_ID = '7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const IDEA_ID = '8b2c3d4e-5f6a-4b7c-9d8e-0f1a2b3c4d5e';
const TASK_ID = '9c3d4e5f-6a7b-4c8d-8e9f-1a2b3c4d5e6f';
const GUIDE_ID = 'ad4e5f6a-7b8c-4d9e-9f0a-2b3c4d5e6f7a';
const CREATED_AT = new Date('2026-11-04T18:30:00.000Z');
const UPDATED_AT = new Date('2026-11-05T09:15:00.000Z');

const AUTHOR_CALLER: CulturalCaller = {
  userId: AUTHOR_ID,
  role: UserRole.Member,
};
const OTHER_MEMBER: CulturalCaller = {
  userId: OTHER_ID,
  role: UserRole.Member,
};

function profileRow(
  overrides: Partial<CulturalStaffProfileRow> = {},
): CulturalStaffProfileRow {
  return {
    userId: AUTHOR_ID,
    slug: 'ana-silva',
    firstName: 'Ana',
    lastName: 'Silva',
    avatarUrl: AVATAR_KEY,
    photoVisible: true,
    ...overrides,
  };
}

function summaryOf(userId: string): CulturalStaffSummaryDTO {
  return {
    id: userId,
    slug: `slug-${userId}`,
    displayName: 'Ana Silva',
    avatarUrl: null,
    avatarCrop: null,
  };
}

const PEOPLE = new Map<string, CulturalStaffSummaryDTO>([
  [AUTHOR_ID, summaryOf(AUTHOR_ID)],
  [OTHER_ID, summaryOf(OTHER_ID)],
]);

function ideaOf(overrides: Partial<CulturalIdea> = {}): CulturalIdea {
  return {
    id: IDEA_ID,
    title: 'Board games in the park',
    description: 'A sunny afternoon of games.',
    eventType: 'board_game_night',
    status: 'new',
    authorId: AUTHOR_ID,
    createdAt: CREATED_AT,
    updatedAt: UPDATED_AT,
    ...overrides,
  };
}

function taskOf(overrides: Partial<CulturalTask> = {}): CulturalTask {
  return {
    id: TASK_ID,
    title: 'Book the venue',
    notes: 'Ask about the back room capacity',
    status: 'todo',
    dueOn: '2026-12-01',
    eventOn: '2026-12-10',
    ideaId: IDEA_ID,
    guideId: GUIDE_ID,
    authorId: AUTHOR_ID,
    completedAt: null,
    createdAt: CREATED_AT,
    updatedAt: UPDATED_AT,
    ...overrides,
  };
}

function guideOf(overrides: Partial<CulturalGuide> = {}): CulturalGuide {
  return {
    id: GUIDE_ID,
    title: 'Board game night',
    eventType: 'board_game_night',
    locale: 'en',
    summary: 'How we run it',
    sections: [
      {
        id: 'section-one',
        heading: 'Before',
        body: 'Pick the games',
        steps: [
          { id: 'step-one', text: 'Book the venue', daysBefore: 21 },
          { id: 'step-two', text: 'Post the event', daysBefore: 14 },
        ],
      },
      {
        id: 'section-two',
        heading: 'On the day',
        body: 'Set the tables',
        steps: [{ id: 'step-three', text: 'Open the doors', daysBefore: 0 }],
      },
    ],
    revision: 3,
    authorId: AUTHOR_ID,
    updatedById: OTHER_ID,
    createdAt: CREATED_AT,
    updatedAt: UPDATED_AT,
    ...overrides,
  };
}

const STATS: CulturalIdeaStats = {
  backerIds: [AUTHOR_ID, OTHER_ID],
  backerCount: 7,
  isBackedByMe: true,
  commentCount: 2,
  linkedTaskCount: 3,
  openLinkedTaskCount: 1,
};

const LINKS: CulturalTaskLinks = {
  assigneeIds: [OTHER_ID, AUTHOR_ID],
  idea: { id: IDEA_ID, title: 'Board games in the park' },
  guide: { id: GUIDE_ID, title: 'Board game night' },
};

describe('cultural-response', () => {
  beforeEach(() => {
    setImageUrlBase(API_BASE_URL);
  });

  afterEach(() => {
    resetImageUrlBaseForTesting();
  });

  describe('toCulturalStaffSummary', () => {
    it('shows the avatar and its crop while the photo is visible', () => {
      expect(toCulturalStaffSummary(AUTHOR_ID, profileRow(), CROPS)).toEqual({
        id: AUTHOR_ID,
        slug: 'ana-silva',
        displayName: 'Ana Silva',
        avatarUrl: toImageUrl(AVATAR_KEY),
        avatarCrop: AVATAR_CROP,
      });
    });

    it('hides the avatar when the photo is hidden', () => {
      const summary = toCulturalStaffSummary(
        AUTHOR_ID,
        profileRow({ photoVisible: false }),
        CROPS,
      );
      expect(summary.avatarUrl).toBeNull();
      expect(summary.avatarCrop).toBeNull();
      expect(summary.displayName).toBe('Ana Silva');
      expect(summary.slug).toBe('ana-silva');
    });

    it('answers an empty name and slug for a missing profile', () => {
      expect(toCulturalStaffSummary(AUTHOR_ID, null, CROPS)).toEqual({
        id: AUTHOR_ID,
        slug: '',
        displayName: '',
        avatarUrl: null,
        avatarCrop: null,
      });
    });

    it('trims a name with an empty last name', () => {
      expect(
        toCulturalStaffSummary(AUTHOR_ID, profileRow({ lastName: '' }), CROPS)
          .displayName,
      ).toBe('Ana');
    });

    it('builds each summary with exactly five keys', () => {
      const profileWithExtras = {
        ...profileRow(),
        email: 'ana@example.test',
        bio: 'Hello',
      } as CulturalStaffProfileRow;
      const summary = toCulturalStaffSummary(
        AUTHOR_ID,
        profileWithExtras,
        CROPS,
      );
      expect(Object.keys(summary).sort()).toEqual([
        'avatarCrop',
        'avatarUrl',
        'displayName',
        'id',
        'slug',
      ]);
      expect(
        Object.keys(toCulturalStaffSummary(OTHER_ID, null, CROPS)),
      ).toHaveLength(5);
    });
  });

  describe('canDeleteCulturalItem', () => {
    it('lets the author and the staff tier delete', () => {
      expect(canDeleteCulturalItem(AUTHOR_ID, AUTHOR_CALLER)).toBe(true);
      expect(canDeleteCulturalItem(AUTHOR_ID, OTHER_MEMBER)).toBe(false);
      expect(
        canDeleteCulturalItem(AUTHOR_ID, {
          userId: OTHER_ID,
          role: UserRole.Moderator,
        }),
      ).toBe(true);
      expect(
        canDeleteCulturalItem(AUTHOR_ID, {
          userId: OTHER_ID,
          role: UserRole.Admin,
        }),
      ).toBe(true);
      expect(canDeleteCulturalItem(null, AUTHOR_CALLER)).toBe(false);
      expect(
        canDeleteCulturalItem(null, { userId: OTHER_ID, role: UserRole.Admin }),
      ).toBe(true);
    });
  });

  describe('ideas', () => {
    it('maps a list row with its stats, dates as ISO text', () => {
      const item = toCulturalIdeaListItem(
        ideaOf(),
        STATS,
        PEOPLE,
        OTHER_MEMBER,
      );
      expect(item).toEqual({
        id: IDEA_ID,
        title: 'Board games in the park',
        description: 'A sunny afternoon of games.',
        eventType: 'board_game_night',
        status: 'new',
        author: summaryOf(AUTHOR_ID),
        createdAt: '2026-11-04T18:30:00.000Z',
        updatedAt: '2026-11-05T09:15:00.000Z',
        backers: [summaryOf(AUTHOR_ID), summaryOf(OTHER_ID)],
        backerCount: 7,
        isBackedByMe: true,
        commentCount: 2,
        linkedTaskCount: 3,
        openLinkedTaskCount: 1,
        canDelete: false,
      });
    });

    it('answers a null author once the account is gone', () => {
      const item = toCulturalIdeaListItem(
        ideaOf({ authorId: null }),
        STATS,
        PEOPLE,
        AUTHOR_CALLER,
      );
      expect(item.author).toBeNull();
      expect(item.canDelete).toBe(false);
    });

    it('answers the missing-profile summary for a person the batch lacks', () => {
      const item = toCulturalIdeaListItem(
        ideaOf(),
        STATS,
        new Map(),
        AUTHOR_CALLER,
      );
      expect(item.author).toEqual({
        id: AUTHOR_ID,
        slug: '',
        displayName: '',
        avatarUrl: null,
        avatarCrop: null,
      });
    });

    it('counts the detail from every backer, comment and linked task', () => {
      const comment = {
        id: 'comment-one',
        ideaId: IDEA_ID,
        authorId: OTHER_ID,
        body: 'Count me in',
        createdAt: UPDATED_AT,
      } as CulturalIdeaComment;
      const goneComment = {
        id: 'comment-two',
        ideaId: IDEA_ID,
        authorId: null,
        body: 'Lovely',
        createdAt: UPDATED_AT,
      } as CulturalIdeaComment;
      const openTask = toCulturalTaskListItem(
        taskOf(),
        LINKS,
        PEOPLE,
        OTHER_MEMBER,
      );
      const doneTask = toCulturalTaskListItem(
        taskOf({ status: 'done', completedAt: UPDATED_AT }),
        LINKS,
        PEOPLE,
        OTHER_MEMBER,
      );
      const idea = toCulturalIdea(
        ideaOf(),
        {
          backerIds: [OTHER_ID],
          comments: [comment, goneComment],
          linkedTasks: [openTask, doneTask],
        },
        PEOPLE,
        OTHER_MEMBER,
      );
      expect(idea.backers).toEqual([summaryOf(OTHER_ID)]);
      expect(idea.backerCount).toBe(1);
      expect(idea.isBackedByMe).toBe(true);
      expect(idea.commentCount).toBe(2);
      expect(idea.linkedTaskCount).toBe(2);
      expect(idea.openLinkedTaskCount).toBe(1);
      expect(idea.comments).toEqual([
        {
          id: 'comment-one',
          body: 'Count me in',
          author: summaryOf(OTHER_ID),
          createdAt: '2026-11-05T09:15:00.000Z',
          canDelete: true,
        },
        {
          id: 'comment-two',
          body: 'Lovely',
          author: null,
          createdAt: '2026-11-05T09:15:00.000Z',
          canDelete: false,
        },
      ]);
      expect(idea.linkedTasks).toEqual([openTask, doneTask]);
    });
  });

  describe('tasks', () => {
    it('passes the days through as text and the dates as ISO', () => {
      const item = toCulturalTaskListItem(
        taskOf({ status: 'done', completedAt: UPDATED_AT }),
        LINKS,
        PEOPLE,
        AUTHOR_CALLER,
      );
      expect(item).toEqual({
        id: TASK_ID,
        title: 'Book the venue',
        status: 'done',
        dueOn: '2026-12-01',
        eventOn: '2026-12-10',
        hasNotes: true,
        assignees: [summaryOf(OTHER_ID), summaryOf(AUTHOR_ID)],
        idea: { id: IDEA_ID, title: 'Board games in the park' },
        guide: { id: GUIDE_ID, title: 'Board game night' },
        author: summaryOf(AUTHOR_ID),
        createdAt: '2026-11-04T18:30:00.000Z',
        updatedAt: '2026-11-05T09:15:00.000Z',
        completedAt: '2026-11-05T09:15:00.000Z',
        canDelete: true,
      });
    });

    it('carries notes on the task detail only', () => {
      const item = toCulturalTaskListItem(
        taskOf(),
        LINKS,
        PEOPLE,
        OTHER_MEMBER,
      );
      const detail = toCulturalTask(taskOf(), LINKS, PEOPLE, OTHER_MEMBER);
      expect(item).not.toHaveProperty('notes');
      expect(detail.notes).toBe('Ask about the back room capacity');
      expect(detail).toEqual({
        ...item,
        notes: 'Ask about the back room capacity',
      });
    });

    it('reads no notes as hasNotes false and null days as null', () => {
      const item = toCulturalTaskListItem(
        taskOf({ notes: '', dueOn: null, eventOn: null, authorId: null }),
        { assigneeIds: [], idea: null, guide: null },
        PEOPLE,
        OTHER_MEMBER,
      );
      expect(item.hasNotes).toBe(false);
      expect(item.dueOn).toBeNull();
      expect(item.eventOn).toBeNull();
      expect(item.completedAt).toBeNull();
      expect(item.assignees).toEqual([]);
      expect(item.idea).toBeNull();
      expect(item.guide).toBeNull();
      expect(item.author).toBeNull();
    });
  });

  describe('guides', () => {
    it('counts sections and steps on a guide list item and leaves sections off it', () => {
      const item = toCulturalGuideListItem(guideOf(), PEOPLE, OTHER_MEMBER);
      expect(item.sectionCount).toBe(2);
      expect(item.stepCount).toBe(3);
      expect(item).not.toHaveProperty('sections');
      expect(item).not.toHaveProperty('revision');
      expect(item.author).toEqual(summaryOf(AUTHOR_ID));
      expect(item.updatedBy).toEqual(summaryOf(OTHER_ID));
      expect(item.createdAt).toBe('2026-11-04T18:30:00.000Z');
      expect(item.canDelete).toBe(false);
    });

    it('answers null author and editor for a seeded guide', () => {
      const item = toCulturalGuideListItem(
        guideOf({ authorId: null, updatedById: null }),
        PEOPLE,
        { userId: OTHER_ID, role: UserRole.Moderator },
      );
      expect(item.author).toBeNull();
      expect(item.updatedBy).toBeNull();
      expect(item.canDelete).toBe(true);
    });

    it('carries every section, step and the revision on the detail', () => {
      const guide = toCulturalGuide(guideOf(), PEOPLE, AUTHOR_CALLER);
      expect(guide.revision).toBe(3);
      expect(guide.sectionCount).toBe(2);
      expect(guide.sections).toEqual([
        {
          id: 'section-one',
          heading: 'Before',
          body: 'Pick the games',
          steps: [
            { id: 'step-one', text: 'Book the venue', daysBefore: 21 },
            { id: 'step-two', text: 'Post the event', daysBefore: 14 },
          ],
        },
        {
          id: 'section-two',
          heading: 'On the day',
          body: 'Set the tables',
          steps: [{ id: 'step-three', text: 'Open the doors', daysBefore: 0 }],
        },
      ]);
    });
  });
});
