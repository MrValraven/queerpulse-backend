import type { CurrentUserData } from '../auth/decorators/current-user.decorator';
import { toImageUrl } from '../common/image-url';
import type { CropRect } from '../media-crops/crop-rect';
import { cropFor } from '../media-crops/crop-response';
import {
  CULTURAL_IDEA_BACKERS_SHOWN,
  OPEN_CULTURAL_TASK_STATUSES,
  isCulturalStaffTierRole,
  type CulturalEventType,
  type CulturalGuideLocale,
  type CulturalGuideSectionRecord,
  type CulturalIdeaStatus,
  type CulturalTaskStatus,
} from './cultural-production.constants';
import { countGuideSteps } from './cultural-guide-sections';
import type { CulturalGuide } from './entities/cultural-guide.entity';
import type { CulturalIdeaComment } from './entities/cultural-idea-comment.entity';
import type { CulturalIdea } from './entities/cultural-idea.entity';
import type { CulturalTask } from './entities/cultural-task.entity';

/** A staff member: an author, an assignee, a backer or a picker row. Built
 *  field by field from `profiles` (`slug`, `first_name`, `last_name`,
 *  `avatar_url`, `photo_visible`) and the user id: a hidden photo gives a
 *  null url and crop, a missing profile an empty slug and name. */
export interface CulturalStaffSummaryDTO {
  /** The user id. */
  id: string;
  /** `profiles.slug`; `''` when the profile row is missing. */
  slug: string;
  /** `${firstName} ${lastName}`, trimmed; `''` when the profile row is missing. */
  displayName: string;
  /** `toImageUrl(avatar_url)`, else `null`. `null` while the member hides their photo. */
  avatarUrl: string | null;
  /** The stored crop for that avatar key. */
  avatarCrop: CropRect | null;
}

/** A linked idea or guide. */
export interface CulturalRefDTO {
  id: string;
  title: string;
}

/** One row of the ideas list. */
export interface CulturalIdeaListItemDTO {
  id: string;
  title: string;
  description: string;
  eventType: CulturalEventType;
  status: CulturalIdeaStatus;
  /** `null` once the account is gone. */
  author: CulturalStaffSummaryDTO | null;
  /** ISO. */
  createdAt: string;
  /** ISO. */
  updatedAt: string;
  /** The first 5 by `created_at ASC, user_id ASC`. */
  backers: CulturalStaffSummaryDTO[];
  backerCount: number;
  isBackedByMe: boolean;
  commentCount: number;
  linkedTaskCount: number;
  /** Linked tasks in `todo` or `doing`. */
  openLinkedTaskCount: number;
  /** The caller wrote it, or the caller is in the staff tier. */
  canDelete: boolean;
}

/** One comment on an idea. */
export interface CulturalIdeaCommentDTO {
  id: string;
  body: string;
  /** `null` once the account is gone. */
  author: CulturalStaffSummaryDTO | null;
  /** ISO. */
  createdAt: string;
  canDelete: boolean;
}

/** A whole idea with every backer, its comments and its linked tasks. */
export interface CulturalIdeaDTO extends CulturalIdeaListItemDTO {
  /** Every backer, by `created_at ASC, user_id ASC`. */
  backers: CulturalStaffSummaryDTO[];
  /** Oldest first. */
  comments: CulturalIdeaCommentDTO[];
  /** In `CULTURAL_TASK_ORDER_SQL` order. */
  linkedTasks: CulturalTaskListItemDTO[];
}

/** The ideas list. */
export interface CulturalIdeaListDTO {
  items: CulturalIdeaListItemDTO[];
  isTruncated: boolean;
}

/** One row of the tasks list. */
export interface CulturalTaskListItemDTO {
  id: string;
  title: string;
  status: CulturalTaskStatus;
  /** `YYYY-MM-DD`. */
  dueOn: string | null;
  /** `YYYY-MM-DD`, set by a guide batch. */
  eventOn: string | null;
  hasNotes: boolean;
  /** Every assignee, `assigned_at ASC, user_id ASC`. */
  assignees: CulturalStaffSummaryDTO[];
  idea: CulturalRefDTO | null;
  guide: CulturalRefDTO | null;
  /** `null` once the account is gone. */
  author: CulturalStaffSummaryDTO | null;
  /** ISO. */
  createdAt: string;
  /** ISO. */
  updatedAt: string;
  /** ISO, set exactly when the status is `done`. */
  completedAt: string | null;
  canDelete: boolean;
}

/** A whole task: the list row plus its notes. */
export interface CulturalTaskDTO extends CulturalTaskListItemDTO {
  notes: string;
}

/** The tasks list. `counts` read the `assignedTo` filter alone. */
export interface CulturalTaskListDTO {
  items: CulturalTaskListItemDTO[];
  counts: { todo: number; doing: number; done: number };
  isTruncated: boolean;
}

/** One checklist step of a guide section. */
export interface CulturalGuideStepDTO {
  id: string;
  text: string;
  daysBefore: number | null;
}

/** One section of a guide. */
export interface CulturalGuideSectionDTO {
  id: string;
  heading: string;
  body: string;
  steps: CulturalGuideStepDTO[];
}

/** One row of the guides list. It carries the counts and leaves the
 *  sections to the detail read. */
export interface CulturalGuideListItemDTO {
  id: string;
  title: string;
  eventType: CulturalEventType;
  locale: CulturalGuideLocale;
  summary: string;
  sectionCount: number;
  stepCount: number;
  /** `null` for the seeded guides. */
  author: CulturalStaffSummaryDTO | null;
  /** `null` until a person saves it. */
  updatedBy: CulturalStaffSummaryDTO | null;
  /** ISO. */
  createdAt: string;
  /** ISO. */
  updatedAt: string;
  canDelete: boolean;
}

/** A whole guide with its sections and the revision a save sends back. */
export interface CulturalGuideDTO extends CulturalGuideListItemDTO {
  sections: CulturalGuideSectionDTO[];
  revision: number;
}

/** The guides list. */
export interface CulturalGuideListDTO {
  items: CulturalGuideListItemDTO[];
}

/** The tasks a guide batch created, in creation order. */
export interface CulturalTaskBatchDTO {
  items: CulturalTaskListItemDTO[];
}

/** The staff picker answer. */
export interface CulturalStaffSearchDTO {
  items: CulturalStaffSummaryDTO[];
}

/** The caller fields the Cultural Production routes read: who they are and their tier. */
export type CulturalCaller = Pick<CurrentUserData, 'userId' | 'role'>;

/** The profile columns a staff summary comes from, keyed by its user id. */
export interface CulturalStaffProfileRow {
  userId: string;
  slug: string;
  firstName: string;
  lastName: string;
  avatarUrl: string | null;
  /** `profiles.photo_visible`: `false` shows no avatar. */
  photoVisible: boolean;
}

/** The counts and backer ids of one idea list row, read in grouped queries. */
export interface CulturalIdeaStats {
  /** The first 5 backer ids by `created_at ASC, user_id ASC`. */
  backerIds: string[];
  backerCount: number;
  isBackedByMe: boolean;
  commentCount: number;
  linkedTaskCount: number;
  openLinkedTaskCount: number;
}

/** What the idea detail read loads besides the idea row. */
export interface CulturalIdeaDetail {
  /** Every backer id by `created_at ASC, user_id ASC`. */
  backerIds: string[];
  /** Oldest first. */
  comments: CulturalIdeaComment[];
  /** Already mapped, in `CULTURAL_TASK_ORDER_SQL` order. */
  linkedTasks: CulturalTaskListItemDTO[];
}

/** The assignees and the linked idea and guide of one task. */
export interface CulturalTaskLinks {
  /** `assigned_at ASC, user_id ASC`. */
  assigneeIds: string[];
  idea: CulturalRefDTO | null;
  guide: CulturalRefDTO | null;
}

/** An image URL and the crop stored for its key. The crop is read only when
 *  the key resolves to a URL, so a dropped value carries no crop. */
function avatarOf(
  storedAvatar: string | null | undefined,
  crops: Map<string, CropRect>,
): { avatarUrl: string | null; avatarCrop: CropRect | null } {
  const avatarUrl = toImageUrl(storedAvatar);
  return {
    avatarUrl,
    avatarCrop: avatarUrl ? (cropFor(storedAvatar, crops) ?? null) : null,
  };
}

/** The avatar key a staff profile shows: its stored key while the member
 *  shows their photo, else `null`. A `null` key resolves to no url and no crop. */
function shownStaffAvatarKey(
  profile: Pick<CulturalStaffProfileRow, 'avatarUrl' | 'photoVisible'> | null,
): string | null {
  return profile?.photoVisible ? profile.avatarUrl : null;
}

/** Maps a staff member to their summary, built field by field so no other
 *  profile column reaches the answer. A missing profile gives an empty slug
 *  and name and no avatar; a hidden photo gives no avatar. */
export function toCulturalStaffSummary(
  userId: string,
  profile: CulturalStaffProfileRow | null,
  crops: Map<string, CropRect>,
): CulturalStaffSummaryDTO {
  const avatar = avatarOf(shownStaffAvatarKey(profile), crops);
  return {
    id: userId,
    slug: profile ? profile.slug : '',
    displayName: profile
      ? `${profile.firstName} ${profile.lastName}`.trim()
      : '',
    avatarUrl: avatar.avatarUrl,
    avatarCrop: avatar.avatarCrop,
  };
}

/** Whether the caller may delete an idea, comment, task or guide: they wrote
 *  it, or they are a Moderator or an Admin. A null author leaves delete to
 *  the staff tier. */
export function canDeleteCulturalItem(
  authorId: string | null,
  caller: CulturalCaller,
): boolean {
  if (isCulturalStaffTierRole(caller.role)) return true;
  return authorId !== null && authorId === caller.userId;
}

/** The summary of one person from the batch the service read. A person the
 *  batch has no row for answers the missing-profile summary. */
function personOf(
  userId: string,
  people: Map<string, CulturalStaffSummaryDTO>,
): CulturalStaffSummaryDTO {
  return people.get(userId) ?? toCulturalStaffSummary(userId, null, new Map());
}

/** The summary of an optional person: `null` once the account is gone. */
function optionalPersonOf(
  userId: string | null,
  people: Map<string, CulturalStaffSummaryDTO>,
): CulturalStaffSummaryDTO | null {
  return userId === null ? null : personOf(userId, people);
}

/** Whether a task status counts as open. */
function isOpenTaskStatus(status: CulturalTaskStatus): boolean {
  return (OPEN_CULTURAL_TASK_STATUSES as readonly string[]).includes(status);
}

/** Maps one idea list row. The service reads the stats and every person in
 *  batches and passes them in. */
export function toCulturalIdeaListItem(
  idea: CulturalIdea,
  stats: CulturalIdeaStats,
  people: Map<string, CulturalStaffSummaryDTO>,
  caller: CulturalCaller,
): CulturalIdeaListItemDTO {
  return {
    id: idea.id,
    title: idea.title,
    description: idea.description,
    eventType: idea.eventType,
    status: idea.status,
    author: optionalPersonOf(idea.authorId, people),
    createdAt: idea.createdAt.toISOString(),
    updatedAt: idea.updatedAt.toISOString(),
    backers: stats.backerIds
      .slice(0, CULTURAL_IDEA_BACKERS_SHOWN)
      .map((backerId) => personOf(backerId, people)),
    backerCount: stats.backerCount,
    isBackedByMe: stats.isBackedByMe,
    commentCount: stats.commentCount,
    linkedTaskCount: stats.linkedTaskCount,
    openLinkedTaskCount: stats.openLinkedTaskCount,
    canDelete: canDeleteCulturalItem(idea.authorId, caller),
  };
}

/** Maps one comment on an idea. */
function toCulturalIdeaComment(
  comment: CulturalIdeaComment,
  people: Map<string, CulturalStaffSummaryDTO>,
  caller: CulturalCaller,
): CulturalIdeaCommentDTO {
  return {
    id: comment.id,
    body: comment.body,
    author: optionalPersonOf(comment.authorId, people),
    createdAt: comment.createdAt.toISOString(),
    canDelete: canDeleteCulturalItem(comment.authorId, caller),
  };
}

/** Maps a whole idea. The counts come from the detail itself: every backer,
 *  every comment and every linked task. */
export function toCulturalIdea(
  idea: CulturalIdea,
  detail: CulturalIdeaDetail,
  people: Map<string, CulturalStaffSummaryDTO>,
  caller: CulturalCaller,
): CulturalIdeaDTO {
  return {
    id: idea.id,
    title: idea.title,
    description: idea.description,
    eventType: idea.eventType,
    status: idea.status,
    author: optionalPersonOf(idea.authorId, people),
    createdAt: idea.createdAt.toISOString(),
    updatedAt: idea.updatedAt.toISOString(),
    backers: detail.backerIds.map((backerId) => personOf(backerId, people)),
    backerCount: detail.backerIds.length,
    isBackedByMe: detail.backerIds.includes(caller.userId),
    commentCount: detail.comments.length,
    linkedTaskCount: detail.linkedTasks.length,
    openLinkedTaskCount: detail.linkedTasks.filter((linkedTask) =>
      isOpenTaskStatus(linkedTask.status),
    ).length,
    canDelete: canDeleteCulturalItem(idea.authorId, caller),
    comments: detail.comments.map((comment) =>
      toCulturalIdeaComment(comment, people, caller),
    ),
    linkedTasks: detail.linkedTasks,
  };
}

/** Maps one task list row. `dueOn` and `eventOn` pass through as
 *  `YYYY-MM-DD` text, and the notes stay off the row. */
export function toCulturalTaskListItem(
  task: CulturalTask,
  links: CulturalTaskLinks,
  people: Map<string, CulturalStaffSummaryDTO>,
  caller: CulturalCaller,
): CulturalTaskListItemDTO {
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    dueOn: task.dueOn,
    eventOn: task.eventOn,
    hasNotes: task.notes.trim().length > 0,
    assignees: links.assigneeIds.map((assigneeId) =>
      personOf(assigneeId, people),
    ),
    idea: links.idea ? { id: links.idea.id, title: links.idea.title } : null,
    guide: links.guide
      ? { id: links.guide.id, title: links.guide.title }
      : null,
    author: optionalPersonOf(task.authorId, people),
    createdAt: task.createdAt.toISOString(),
    updatedAt: task.updatedAt.toISOString(),
    completedAt: task.completedAt ? task.completedAt.toISOString() : null,
    canDelete: canDeleteCulturalItem(task.authorId, caller),
  };
}

/** Maps a whole task: the list row plus its notes. */
export function toCulturalTask(
  task: CulturalTask,
  links: CulturalTaskLinks,
  people: Map<string, CulturalStaffSummaryDTO>,
  caller: CulturalCaller,
): CulturalTaskDTO {
  return {
    ...toCulturalTaskListItem(task, links, people, caller),
    notes: task.notes,
  };
}

/** A guide's stored sections, an empty list when the column holds no array. */
function sectionsOf(guide: CulturalGuide): CulturalGuideSectionRecord[] {
  return Array.isArray(guide.sections) ? guide.sections : [];
}

/** A section's stored steps, an empty list when the field holds no array. */
function stepsOf(
  section: CulturalGuideSectionRecord,
): CulturalGuideSectionRecord['steps'] {
  return Array.isArray(section.steps) ? section.steps : [];
}

/** Maps one guide list row. The section and step counts are read from
 *  `sections` here, and the sections themselves stay off the row. */
export function toCulturalGuideListItem(
  guide: CulturalGuide,
  people: Map<string, CulturalStaffSummaryDTO>,
  caller: CulturalCaller,
): CulturalGuideListItemDTO {
  const sections = sectionsOf(guide);
  return {
    id: guide.id,
    title: guide.title,
    eventType: guide.eventType,
    locale: guide.locale,
    summary: guide.summary,
    sectionCount: sections.length,
    stepCount: countGuideSteps(
      sections.map((section) => ({ steps: stepsOf(section) })),
    ),
    author: optionalPersonOf(guide.authorId, people),
    updatedBy: optionalPersonOf(guide.updatedById, people),
    createdAt: guide.createdAt.toISOString(),
    updatedAt: guide.updatedAt.toISOString(),
    canDelete: canDeleteCulturalItem(guide.authorId, caller),
  };
}

/** Maps a whole guide. Each section and step is built field by field. */
export function toCulturalGuide(
  guide: CulturalGuide,
  people: Map<string, CulturalStaffSummaryDTO>,
  caller: CulturalCaller,
): CulturalGuideDTO {
  return {
    ...toCulturalGuideListItem(guide, people, caller),
    sections: sectionsOf(guide).map((section) => ({
      id: section.id,
      heading: section.heading,
      body: section.body,
      steps: stepsOf(section).map((step) => ({
        id: step.id,
        text: step.text,
        daysBefore: step.daysBefore,
      })),
    })),
    revision: guide.revision,
  };
}
