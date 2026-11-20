import { HttpException, HttpStatus } from '@nestjs/common';

/** The event types a cultural idea or guide can carry. The order is the
 *  order of the migration CHECK in 1840600000000-AddCulturalProduction. */
export const CULTURAL_EVENT_TYPES = [
  'board_game_night',
  'quiz_night',
  'music_night',
  'film_night',
  'workshop',
  'talk',
  'party',
  'other',
] as const;
/** One of the cultural event types. */
export type CulturalEventType = (typeof CULTURAL_EVENT_TYPES)[number];

/** The statuses an idea moves through. */
export const CULTURAL_IDEA_STATUSES = [
  'new',
  'exploring',
  'planned',
  'parked',
] as const;
/** One of the idea statuses. */
export type CulturalIdeaStatus = (typeof CULTURAL_IDEA_STATUSES)[number];
/** The status a new idea starts in. */
export const DEFAULT_CULTURAL_IDEA_STATUS: CulturalIdeaStatus = 'new';

/** The statuses a task moves through. */
export const CULTURAL_TASK_STATUSES = ['todo', 'doing', 'done'] as const;
/** One of the task statuses. */
export type CulturalTaskStatus = (typeof CULTURAL_TASK_STATUSES)[number];
/** The status a new task starts in. */
export const DEFAULT_CULTURAL_TASK_STATUS: CulturalTaskStatus = 'todo';
/** The statuses the badge and the Open filter count. */
export const OPEN_CULTURAL_TASK_STATUSES = ['todo', 'doing'] as const;

/** The task list `status` filter. Absent means every status. */
export const CULTURAL_TASK_STATUS_FILTERS = [
  'open',
  'todo',
  'doing',
  'done',
] as const;
/** One of the task list status filters. */
export type CulturalTaskStatusFilter =
  (typeof CULTURAL_TASK_STATUS_FILTERS)[number];

/** The task list `assignedTo` filter. Absent means everyone. */
export const CULTURAL_ASSIGNED_TO_FILTERS = ['me', 'unassigned'] as const;
/** One of the task list assignedTo filters. */
export type CulturalAssignedToFilter =
  (typeof CULTURAL_ASSIGNED_TO_FILTERS)[number];

/** The locales a guide is written in. */
export const CULTURAL_GUIDE_LOCALES = ['en', 'pt'] as const;
/** One of the guide locales. */
export type CulturalGuideLocale = (typeof CULTURAL_GUIDE_LOCALES)[number];

/** Why CULTURAL_ASSIGNEE_NOT_STAFF refused, in check order. */
export const CULTURAL_ASSIGNEE_REFUSAL_REASONS = [
  'no_access',
  'suspended',
  'deactivated',
] as const;
/** One of the assignee refusal reasons. */
export type CulturalAssigneeRefusalReason =
  (typeof CULTURAL_ASSIGNEE_REFUSAL_REASONS)[number];

// Limits, in code points after trim.
/** Idea, task and guide titles, and checklist step text. */
export const CULTURAL_TITLE_MAX = 160;
/** The longest idea description. */
export const CULTURAL_IDEA_DESCRIPTION_MAX = 4000;
/** The longest idea comment. */
export const CULTURAL_COMMENT_MAX = 2000;
/** The longest task notes. */
export const CULTURAL_TASK_NOTES_MAX = 4000;
/** The longest guide summary. */
export const CULTURAL_GUIDE_SUMMARY_MAX = 500;
/** The most sections in one guide. */
export const CULTURAL_GUIDE_SECTIONS_MAX = 30;
/** The longest section heading. */
export const CULTURAL_GUIDE_HEADING_MAX = 120;
/** The longest section body. */
export const CULTURAL_GUIDE_BODY_MAX = 10000;
/** The most checklist steps in one section. */
export const CULTURAL_GUIDE_SECTION_STEPS_MAX = 40;
/** The most checklist steps across the whole guide. */
export const CULTURAL_GUIDE_STEPS_MAX = 100;
/** The smallest days-before value: 60 days after the event. */
export const CULTURAL_STEP_DAYS_MIN = -60;
/** The largest days-before value. */
export const CULTURAL_STEP_DAYS_MAX = 365;
/** The most people assigned to one task. */
export const CULTURAL_MAX_ASSIGNEES = 10;
/** The assignee summaries shown on a task list item. */
export const CULTURAL_STAFF_PREVIEW_LIMIT = 5;
/** The most rows a staff picker search returns. */
export const CULTURAL_STAFF_SEARCH_LIMIT = 20;
/** The longest picker search text. */
export const CULTURAL_SEARCH_QUERY_MAX = 100;
/** The most ideas or tasks one list read returns. */
export const CULTURAL_LIST_LIMIT = 500;
/** The backer summaries shown on an idea list item. */
export const CULTURAL_IDEA_BACKERS_SHOWN = 5;
/** The earliest day a date field accepts. */
export const CULTURAL_DATE_MIN = '2000-01-01';
/** The latest day a date field accepts. */
export const CULTURAL_DATE_MAX = '2100-12-31';
/** The calendar day of a due date and of the badge is read in this zone. */
export const CULTURAL_TIME_ZONE = 'Europe/Lisbon';

/** The staff grants that open Cultural Production below the staff tier. */
export const CULTURAL_ACCESS_STAFF_ROLES = [
  'cultural_producer',
  'music_manager_producer',
] as const;

/** One stored step of a guide's checklist. */
export interface CulturalGuideStepRecord {
  /** A uuid. */
  id: string;
  /** 1 to 160 code points, trimmed. */
  text: string;
  /** An integer from -60 to 365. 0 is the day of the event, negative is after it. */
  daysBefore: number | null;
}

/** One stored section of a guide. */
export interface CulturalGuideSectionRecord {
  /** A uuid. */
  id: string;
  /** 1 to 120 code points. */
  heading: string;
  /** 0 to 10000 code points, in the body format of contract section 8. */
  body: string;
  /** 0 to 40 steps. */
  steps: CulturalGuideStepRecord[];
}

/** Whether a value is one of the cultural event types. */
export function isCulturalEventType(
  value: unknown,
): value is CulturalEventType {
  return (CULTURAL_EVENT_TYPES as readonly unknown[]).includes(value);
}

/** Whether a value is one of the idea statuses. */
export function isCulturalIdeaStatus(
  value: unknown,
): value is CulturalIdeaStatus {
  return (CULTURAL_IDEA_STATUSES as readonly unknown[]).includes(value);
}

/** Whether a value is one of the task statuses. */
export function isCulturalTaskStatus(
  value: unknown,
): value is CulturalTaskStatus {
  return (CULTURAL_TASK_STATUSES as readonly unknown[]).includes(value);
}

/** Whether a value is one of the task list status filters. */
export function isCulturalTaskStatusFilter(
  value: unknown,
): value is CulturalTaskStatusFilter {
  return (CULTURAL_TASK_STATUS_FILTERS as readonly unknown[]).includes(value);
}

/** Whether a value is one of the task list assignedTo filters. */
export function isCulturalAssignedToFilter(
  value: unknown,
): value is CulturalAssignedToFilter {
  return (CULTURAL_ASSIGNED_TO_FILTERS as readonly unknown[]).includes(value);
}

/** Whether a value is one of the guide locales. */
export function isCulturalGuideLocale(
  value: unknown,
): value is CulturalGuideLocale {
  return (CULTURAL_GUIDE_LOCALES as readonly unknown[]).includes(value);
}

/** Whether a value is one of the assignee refusal reasons. */
export function isCulturalAssigneeRefusalReason(
  value: unknown,
): value is CulturalAssigneeRefusalReason {
  return (CULTURAL_ASSIGNEE_REFUSAL_REASONS as readonly unknown[]).includes(
    value,
  );
}

/** Whether a role is in the staff tier: `moderator` or `admin`. */
export function isCulturalStaffTierRole(role: string): boolean {
  return role === 'moderator' || role === 'admin';
}

/** Every refusal code of the Cultural Production routes, in contract table order. */
export type CulturalRefusalCode =
  | 'CULTURAL_IDEA_NOT_FOUND'
  | 'CULTURAL_TASK_NOT_FOUND'
  | 'CULTURAL_GUIDE_NOT_FOUND'
  | 'CULTURAL_COMMENT_NOT_FOUND'
  | 'CULTURAL_TITLE_REQUIRED'
  | 'CULTURAL_TITLE_TOO_LONG'
  | 'CULTURAL_DESCRIPTION_TOO_LONG'
  | 'CULTURAL_NOTES_TOO_LONG'
  | 'CULTURAL_EVENT_TYPE_INVALID'
  | 'CULTURAL_IDEA_STATUS_INVALID'
  | 'CULTURAL_TASK_STATUS_INVALID'
  | 'CULTURAL_ASSIGNED_TO_INVALID'
  | 'CULTURAL_DUE_DATE_INVALID'
  | 'CULTURAL_EVENT_DATE_INVALID'
  | 'CULTURAL_LINKED_IDEA_NOT_FOUND'
  | 'CULTURAL_LINKED_GUIDE_NOT_FOUND'
  | 'CULTURAL_COMMENT_EMPTY'
  | 'CULTURAL_COMMENT_TOO_LONG'
  | 'CULTURAL_COMMENT_NOT_YOURS'
  | 'CULTURAL_IDEA_NOT_YOURS'
  | 'CULTURAL_TASK_NOT_YOURS'
  | 'CULTURAL_GUIDE_NOT_YOURS'
  | 'CULTURAL_ASSIGNEE_NOT_FOUND'
  | 'CULTURAL_ASSIGNEE_NOT_STAFF'
  | 'CULTURAL_TOO_MANY_ASSIGNEES'
  | 'CULTURAL_GUIDE_LOCALE_INVALID'
  | 'CULTURAL_GUIDE_SUMMARY_TOO_LONG'
  | 'CULTURAL_GUIDE_SECTIONS_INVALID'
  | 'CULTURAL_GUIDE_TOO_MANY_SECTIONS'
  | 'CULTURAL_GUIDE_HEADING_REQUIRED'
  | 'CULTURAL_GUIDE_HEADING_TOO_LONG'
  | 'CULTURAL_GUIDE_BODY_TOO_LONG'
  | 'CULTURAL_GUIDE_TOO_MANY_STEPS'
  | 'CULTURAL_GUIDE_STEP_TEXT_REQUIRED'
  | 'CULTURAL_GUIDE_STEP_TEXT_TOO_LONG'
  | 'CULTURAL_GUIDE_STEP_DAYS_INVALID'
  | 'CULTURAL_GUIDE_REVISION_INVALID'
  | 'CULTURAL_GUIDE_EDIT_CONFLICT'
  | 'CULTURAL_GUIDE_HAS_NO_STEPS';

/** The status and the fixed sentence of every refusal code. */
export const CULTURAL_REFUSALS: Record<
  CulturalRefusalCode,
  { status: HttpStatus; message: string }
> = {
  CULTURAL_IDEA_NOT_FOUND: {
    status: HttpStatus.NOT_FOUND,
    message: 'No idea has this id.',
  },
  CULTURAL_TASK_NOT_FOUND: {
    status: HttpStatus.NOT_FOUND,
    message: 'No task has this id.',
  },
  CULTURAL_GUIDE_NOT_FOUND: {
    status: HttpStatus.NOT_FOUND,
    message: 'No guide has this id.',
  },
  CULTURAL_COMMENT_NOT_FOUND: {
    status: HttpStatus.NOT_FOUND,
    message: 'No comment on this idea has this id.',
  },
  CULTURAL_TITLE_REQUIRED: {
    status: HttpStatus.BAD_REQUEST,
    message: 'A title is required.',
  },
  CULTURAL_TITLE_TOO_LONG: {
    status: HttpStatus.BAD_REQUEST,
    message: 'A title can be at most 160 characters.',
  },
  CULTURAL_DESCRIPTION_TOO_LONG: {
    status: HttpStatus.BAD_REQUEST,
    message: 'An idea description can be at most 4000 characters.',
  },
  CULTURAL_NOTES_TOO_LONG: {
    status: HttpStatus.BAD_REQUEST,
    message: 'Task notes can be at most 4000 characters.',
  },
  CULTURAL_EVENT_TYPE_INVALID: {
    status: HttpStatus.BAD_REQUEST,
    message: 'The event type must be one of the listed types.',
  },
  CULTURAL_IDEA_STATUS_INVALID: {
    status: HttpStatus.BAD_REQUEST,
    message: 'The idea status must be new, exploring, planned or parked.',
  },
  CULTURAL_TASK_STATUS_INVALID: {
    status: HttpStatus.BAD_REQUEST,
    message: 'The task status must be todo, doing or done.',
  },
  CULTURAL_ASSIGNED_TO_INVALID: {
    status: HttpStatus.BAD_REQUEST,
    message: 'The assignedTo filter must be me or unassigned.',
  },
  CULTURAL_DUE_DATE_INVALID: {
    status: HttpStatus.BAD_REQUEST,
    message:
      'The due date must be a real day between 2000-01-01 and 2100-12-31, or null.',
  },
  CULTURAL_EVENT_DATE_INVALID: {
    status: HttpStatus.BAD_REQUEST,
    message:
      'The event date must be a real day between 2000-01-01 and 2100-12-31.',
  },
  CULTURAL_LINKED_IDEA_NOT_FOUND: {
    status: HttpStatus.BAD_REQUEST,
    message: 'The linked idea does not exist.',
  },
  CULTURAL_LINKED_GUIDE_NOT_FOUND: {
    status: HttpStatus.BAD_REQUEST,
    message: 'The linked guide does not exist.',
  },
  CULTURAL_COMMENT_EMPTY: {
    status: HttpStatus.BAD_REQUEST,
    message: 'A comment needs some text.',
  },
  CULTURAL_COMMENT_TOO_LONG: {
    status: HttpStatus.BAD_REQUEST,
    message: 'A comment can be at most 2000 characters.',
  },
  CULTURAL_COMMENT_NOT_YOURS: {
    status: HttpStatus.FORBIDDEN,
    message:
      "Only the comment's author, a Moderator or an Admin can delete it.",
  },
  CULTURAL_IDEA_NOT_YOURS: {
    status: HttpStatus.FORBIDDEN,
    message: "Only the idea's author, a Moderator or an Admin can delete it.",
  },
  CULTURAL_TASK_NOT_YOURS: {
    status: HttpStatus.FORBIDDEN,
    message: "Only the task's author, a Moderator or an Admin can delete it.",
  },
  CULTURAL_GUIDE_NOT_YOURS: {
    status: HttpStatus.FORBIDDEN,
    message: "Only the guide's author, a Moderator or an Admin can delete it.",
  },
  CULTURAL_ASSIGNEE_NOT_FOUND: {
    status: HttpStatus.NOT_FOUND,
    message: 'No account has this id.',
  },
  CULTURAL_ASSIGNEE_NOT_STAFF: {
    status: HttpStatus.BAD_REQUEST,
    message: 'This person cannot be assigned a task.',
  },
  CULTURAL_TOO_MANY_ASSIGNEES: {
    status: HttpStatus.CONFLICT,
    message: 'A task can have at most 10 people assigned.',
  },
  CULTURAL_GUIDE_LOCALE_INVALID: {
    status: HttpStatus.BAD_REQUEST,
    message: 'The guide locale must be en or pt.',
  },
  CULTURAL_GUIDE_SUMMARY_TOO_LONG: {
    status: HttpStatus.BAD_REQUEST,
    message: 'A guide summary can be at most 500 characters.',
  },
  CULTURAL_GUIDE_SECTIONS_INVALID: {
    status: HttpStatus.BAD_REQUEST,
    message:
      'The guide sections must be an array of sections, each with a heading, a body and an array of steps.',
  },
  CULTURAL_GUIDE_TOO_MANY_SECTIONS: {
    status: HttpStatus.BAD_REQUEST,
    message: 'A guide can have at most 30 sections.',
  },
  CULTURAL_GUIDE_HEADING_REQUIRED: {
    status: HttpStatus.BAD_REQUEST,
    message: 'Every section needs a heading.',
  },
  CULTURAL_GUIDE_HEADING_TOO_LONG: {
    status: HttpStatus.BAD_REQUEST,
    message: 'A section heading can be at most 120 characters.',
  },
  CULTURAL_GUIDE_BODY_TOO_LONG: {
    status: HttpStatus.BAD_REQUEST,
    message: 'A section body can be at most 10000 characters.',
  },
  CULTURAL_GUIDE_TOO_MANY_STEPS: {
    status: HttpStatus.BAD_REQUEST,
    message: 'A section can have at most 40 steps, and a guide at most 100.',
  },
  CULTURAL_GUIDE_STEP_TEXT_REQUIRED: {
    status: HttpStatus.BAD_REQUEST,
    message: 'Every checklist step needs text.',
  },
  CULTURAL_GUIDE_STEP_TEXT_TOO_LONG: {
    status: HttpStatus.BAD_REQUEST,
    message: 'A checklist step can be at most 160 characters.',
  },
  CULTURAL_GUIDE_STEP_DAYS_INVALID: {
    status: HttpStatus.BAD_REQUEST,
    message:
      'Days before the event must be a whole number from -60 to 365, or null.',
  },
  CULTURAL_GUIDE_REVISION_INVALID: {
    status: HttpStatus.BAD_REQUEST,
    message: 'A guide save must send the revision it started from.',
  },
  CULTURAL_GUIDE_EDIT_CONFLICT: {
    status: HttpStatus.CONFLICT,
    message: 'Someone saved this guide after you opened it.',
  },
  CULTURAL_GUIDE_HAS_NO_STEPS: {
    status: HttpStatus.BAD_REQUEST,
    message: 'This guide has no checklist steps to turn into tasks.',
  },
};

/** What CULTURAL_ASSIGNEE_NOT_STAFF says for each reason an assignee is refused. */
export const CULTURAL_ASSIGNEE_NOT_STAFF_MESSAGES: Record<
  CulturalAssigneeRefusalReason,
  string
> = {
  no_access:
    'This person does not have Cultural Production access, so they cannot be assigned a task.',
  suspended: 'This account is suspended, so it cannot be assigned a task.',
  deactivated: 'This account is deactivated, so it cannot be assigned a task.',
};

/** The extra body fields a refusal can carry. */
export type CulturalRefusalExtra =
  'reason' | 'userId' | 'sectionIndex' | 'stepIndex' | 'revision';

/** The extra body fields each code carries. `culturalError` copies only these
 *  and only when the matching option is defined. */
export const CULTURAL_REFUSAL_EXTRAS: Record<
  CulturalRefusalCode,
  readonly CulturalRefusalExtra[]
> = {
  CULTURAL_IDEA_NOT_FOUND: [],
  CULTURAL_TASK_NOT_FOUND: [],
  CULTURAL_GUIDE_NOT_FOUND: [],
  CULTURAL_COMMENT_NOT_FOUND: [],
  CULTURAL_TITLE_REQUIRED: [],
  CULTURAL_TITLE_TOO_LONG: [],
  CULTURAL_DESCRIPTION_TOO_LONG: [],
  CULTURAL_NOTES_TOO_LONG: [],
  CULTURAL_EVENT_TYPE_INVALID: [],
  CULTURAL_IDEA_STATUS_INVALID: [],
  CULTURAL_TASK_STATUS_INVALID: [],
  CULTURAL_ASSIGNED_TO_INVALID: [],
  CULTURAL_DUE_DATE_INVALID: [],
  CULTURAL_EVENT_DATE_INVALID: [],
  CULTURAL_LINKED_IDEA_NOT_FOUND: [],
  CULTURAL_LINKED_GUIDE_NOT_FOUND: [],
  CULTURAL_COMMENT_EMPTY: [],
  CULTURAL_COMMENT_TOO_LONG: [],
  CULTURAL_COMMENT_NOT_YOURS: [],
  CULTURAL_IDEA_NOT_YOURS: [],
  CULTURAL_TASK_NOT_YOURS: [],
  CULTURAL_GUIDE_NOT_YOURS: [],
  CULTURAL_ASSIGNEE_NOT_FOUND: ['userId'],
  CULTURAL_ASSIGNEE_NOT_STAFF: ['reason', 'userId'],
  CULTURAL_TOO_MANY_ASSIGNEES: [],
  CULTURAL_GUIDE_LOCALE_INVALID: [],
  CULTURAL_GUIDE_SUMMARY_TOO_LONG: [],
  CULTURAL_GUIDE_SECTIONS_INVALID: ['sectionIndex', 'stepIndex'],
  CULTURAL_GUIDE_TOO_MANY_SECTIONS: [],
  CULTURAL_GUIDE_HEADING_REQUIRED: ['sectionIndex'],
  CULTURAL_GUIDE_HEADING_TOO_LONG: ['sectionIndex'],
  CULTURAL_GUIDE_BODY_TOO_LONG: ['sectionIndex'],
  CULTURAL_GUIDE_TOO_MANY_STEPS: ['sectionIndex'],
  CULTURAL_GUIDE_STEP_TEXT_REQUIRED: ['sectionIndex', 'stepIndex'],
  CULTURAL_GUIDE_STEP_TEXT_TOO_LONG: ['sectionIndex', 'stepIndex'],
  CULTURAL_GUIDE_STEP_DAYS_INVALID: ['sectionIndex', 'stepIndex'],
  CULTURAL_GUIDE_REVISION_INVALID: [],
  CULTURAL_GUIDE_EDIT_CONFLICT: ['revision'],
  CULTURAL_GUIDE_HAS_NO_STEPS: [],
};

/** What a caller may hand `culturalError`. `status` overrides the table's status. */
export interface CulturalErrorOptions {
  status?: HttpStatus;
  reason?: CulturalAssigneeRefusalReason;
  userId?: string;
  /** Zero based. */
  sectionIndex?: number;
  /** Zero based. */
  stepIndex?: number;
  /** The guide's current revision. */
  revision?: number;
}

/** The one way the Cultural Production routes refuse a request:
 *  `{ statusCode, message, code }` plus each extra listed for the code in
 *  `CULTURAL_REFUSAL_EXTRAS` whose option is defined. CULTURAL_ASSIGNEE_NOT_STAFF
 *  swaps in the message that names its `reason` when one is given. The message
 *  is always a fixed sentence from the tables above. */
export function culturalError(
  code: CulturalRefusalCode,
  options?: CulturalErrorOptions,
): HttpException {
  const status = options?.status ?? CULTURAL_REFUSALS[code].status;
  const reason = options?.reason;
  const message =
    code === 'CULTURAL_ASSIGNEE_NOT_STAFF' &&
    isCulturalAssigneeRefusalReason(reason)
      ? CULTURAL_ASSIGNEE_NOT_STAFF_MESSAGES[reason]
      : CULTURAL_REFUSALS[code].message;
  const body: Record<string, unknown> = { statusCode: status, message, code };
  for (const extra of CULTURAL_REFUSAL_EXTRAS[code]) {
    const value = options?.[extra];
    if (value !== undefined) {
      body[extra] = value;
    }
  }
  return new HttpException(body, status);
}
