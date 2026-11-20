import { HttpException, HttpStatus } from '@nestjs/common';
import {
  CULTURAL_ACCESS_STAFF_ROLES,
  CULTURAL_ASSIGNED_TO_FILTERS,
  CULTURAL_ASSIGNEE_NOT_STAFF_MESSAGES,
  CULTURAL_ASSIGNEE_REFUSAL_REASONS,
  CULTURAL_EVENT_TYPES,
  CULTURAL_GUIDE_LOCALES,
  CULTURAL_IDEA_STATUSES,
  CULTURAL_REFUSAL_EXTRAS,
  CULTURAL_REFUSALS,
  CULTURAL_TASK_STATUS_FILTERS,
  CULTURAL_TASK_STATUSES,
  culturalError,
  DEFAULT_CULTURAL_IDEA_STATUS,
  DEFAULT_CULTURAL_TASK_STATUS,
  isCulturalAssignedToFilter,
  isCulturalAssigneeRefusalReason,
  isCulturalEventType,
  isCulturalGuideLocale,
  isCulturalIdeaStatus,
  isCulturalStaffTierRole,
  isCulturalTaskStatus,
  isCulturalTaskStatusFilter,
  OPEN_CULTURAL_TASK_STATUSES,
  type CulturalAssigneeRefusalReason,
  type CulturalRefusalCode,
} from './cultural-production.constants';

const USER_ID = '7c1e2f4a-3b5d-4e6f-8a9b-0c1d2e3f4a5b';

/** The contract's section 5 table, in table order: code, status, message. */
const EXPECTED_REFUSALS: ReadonlyArray<
  readonly [CulturalRefusalCode, number, string]
> = [
  ['CULTURAL_IDEA_NOT_FOUND', 404, 'No idea has this id.'],
  ['CULTURAL_TASK_NOT_FOUND', 404, 'No task has this id.'],
  ['CULTURAL_GUIDE_NOT_FOUND', 404, 'No guide has this id.'],
  ['CULTURAL_COMMENT_NOT_FOUND', 404, 'No comment on this idea has this id.'],
  ['CULTURAL_TITLE_REQUIRED', 400, 'A title is required.'],
  ['CULTURAL_TITLE_TOO_LONG', 400, 'A title can be at most 160 characters.'],
  [
    'CULTURAL_DESCRIPTION_TOO_LONG',
    400,
    'An idea description can be at most 4000 characters.',
  ],
  [
    'CULTURAL_NOTES_TOO_LONG',
    400,
    'Task notes can be at most 4000 characters.',
  ],
  [
    'CULTURAL_EVENT_TYPE_INVALID',
    400,
    'The event type must be one of the listed types.',
  ],
  [
    'CULTURAL_IDEA_STATUS_INVALID',
    400,
    'The idea status must be new, exploring, planned or parked.',
  ],
  [
    'CULTURAL_TASK_STATUS_INVALID',
    400,
    'The task status must be todo, doing or done.',
  ],
  [
    'CULTURAL_ASSIGNED_TO_INVALID',
    400,
    'The assignedTo filter must be me or unassigned.',
  ],
  [
    'CULTURAL_DUE_DATE_INVALID',
    400,
    'The due date must be a real day between 2000-01-01 and 2100-12-31, or null.',
  ],
  [
    'CULTURAL_EVENT_DATE_INVALID',
    400,
    'The event date must be a real day between 2000-01-01 and 2100-12-31.',
  ],
  ['CULTURAL_LINKED_IDEA_NOT_FOUND', 400, 'The linked idea does not exist.'],
  ['CULTURAL_LINKED_GUIDE_NOT_FOUND', 400, 'The linked guide does not exist.'],
  ['CULTURAL_COMMENT_EMPTY', 400, 'A comment needs some text.'],
  [
    'CULTURAL_COMMENT_TOO_LONG',
    400,
    'A comment can be at most 2000 characters.',
  ],
  [
    'CULTURAL_COMMENT_NOT_YOURS',
    403,
    "Only the comment's author, a Moderator or an Admin can delete it.",
  ],
  [
    'CULTURAL_IDEA_NOT_YOURS',
    403,
    "Only the idea's author, a Moderator or an Admin can delete it.",
  ],
  [
    'CULTURAL_TASK_NOT_YOURS',
    403,
    "Only the task's author, a Moderator or an Admin can delete it.",
  ],
  [
    'CULTURAL_GUIDE_NOT_YOURS',
    403,
    "Only the guide's author, a Moderator or an Admin can delete it.",
  ],
  ['CULTURAL_ASSIGNEE_NOT_FOUND', 404, 'No account has this id.'],
  [
    'CULTURAL_ASSIGNEE_NOT_STAFF',
    400,
    'This person cannot be assigned a task.',
  ],
  [
    'CULTURAL_TOO_MANY_ASSIGNEES',
    409,
    'A task can have at most 10 people assigned.',
  ],
  ['CULTURAL_GUIDE_LOCALE_INVALID', 400, 'The guide locale must be en or pt.'],
  [
    'CULTURAL_GUIDE_SUMMARY_TOO_LONG',
    400,
    'A guide summary can be at most 500 characters.',
  ],
  [
    'CULTURAL_GUIDE_SECTIONS_INVALID',
    400,
    'The guide sections must be an array of sections, each with a heading, a body and an array of steps.',
  ],
  [
    'CULTURAL_GUIDE_TOO_MANY_SECTIONS',
    400,
    'A guide can have at most 30 sections.',
  ],
  ['CULTURAL_GUIDE_HEADING_REQUIRED', 400, 'Every section needs a heading.'],
  [
    'CULTURAL_GUIDE_HEADING_TOO_LONG',
    400,
    'A section heading can be at most 120 characters.',
  ],
  [
    'CULTURAL_GUIDE_BODY_TOO_LONG',
    400,
    'A section body can be at most 10000 characters.',
  ],
  [
    'CULTURAL_GUIDE_TOO_MANY_STEPS',
    400,
    'A section can have at most 40 steps, and a guide at most 100.',
  ],
  [
    'CULTURAL_GUIDE_STEP_TEXT_REQUIRED',
    400,
    'Every checklist step needs text.',
  ],
  [
    'CULTURAL_GUIDE_STEP_TEXT_TOO_LONG',
    400,
    'A checklist step can be at most 160 characters.',
  ],
  [
    'CULTURAL_GUIDE_STEP_DAYS_INVALID',
    400,
    'Days before the event must be a whole number from -60 to 365, or null.',
  ],
  [
    'CULTURAL_GUIDE_REVISION_INVALID',
    400,
    'A guide save must send the revision it started from.',
  ],
  [
    'CULTURAL_GUIDE_EDIT_CONFLICT',
    409,
    'Someone saved this guide after you opened it.',
  ],
  [
    'CULTURAL_GUIDE_HAS_NO_STEPS',
    400,
    'This guide has no checklist steps to turn into tasks.',
  ],
];

const EXPECTED_REASON_MESSAGES: Record<CulturalAssigneeRefusalReason, string> =
  {
    no_access:
      'This person does not have Cultural Production access, so they cannot be assigned a task.',
    suspended: 'This account is suspended, so it cannot be assigned a task.',
    deactivated:
      'This account is deactivated, so it cannot be assigned a task.',
  };

function bodyOf(error: HttpException): Record<string, unknown> {
  return error.getResponse() as Record<string, unknown>;
}

describe('cultural refusal table', () => {
  it('has 39 codes in contract table order', () => {
    expect(EXPECTED_REFUSALS).toHaveLength(39);
    expect(Object.keys(CULTURAL_REFUSALS)).toEqual(
      EXPECTED_REFUSALS.map(([code]) => code),
    );
    expect(Object.keys(CULTURAL_REFUSAL_EXTRAS)).toEqual(
      EXPECTED_REFUSALS.map(([code]) => code),
    );
  });

  it.each(EXPECTED_REFUSALS)(
    'pins the status and message of %s',
    (code, status, message) => {
      expect(CULTURAL_REFUSALS[code]).toEqual({ status, message });
      const error = culturalError(code);
      expect(error).toBeInstanceOf(HttpException);
      expect(error.getStatus()).toBe(status);
      expect(bodyOf(error)).toEqual({ statusCode: status, message, code });
    },
  );
});

describe('culturalError', () => {
  it.each(CULTURAL_ASSIGNEE_REFUSAL_REASONS)(
    'names the reason on CULTURAL_ASSIGNEE_NOT_STAFF for %s',
    (reason) => {
      const error = culturalError('CULTURAL_ASSIGNEE_NOT_STAFF', {
        reason,
        userId: USER_ID,
      });
      expect(bodyOf(error)).toEqual({
        statusCode: 400,
        message: EXPECTED_REASON_MESSAGES[reason],
        code: 'CULTURAL_ASSIGNEE_NOT_STAFF',
        reason,
        userId: USER_ID,
      });
      expect(CULTURAL_ASSIGNEE_NOT_STAFF_MESSAGES[reason]).toBe(
        EXPECTED_REASON_MESSAGES[reason],
      );
    },
  );

  it('keeps the table message with no reason', () => {
    const error = culturalError('CULTURAL_ASSIGNEE_NOT_STAFF', {
      userId: USER_ID,
    });
    expect(bodyOf(error)).toEqual({
      statusCode: 400,
      message: 'This person cannot be assigned a task.',
      code: 'CULTURAL_ASSIGNEE_NOT_STAFF',
      userId: USER_ID,
    });
  });

  it('keeps the table message when the reason is not a known reason', () => {
    const error = culturalError('CULTURAL_ASSIGNEE_NOT_STAFF', {
      reason: 'unknown' as CulturalAssigneeRefusalReason,
    });
    expect(bodyOf(error).message).toBe(
      'This person cannot be assigned a task.',
    );
  });

  it('does not let a reason change the message of another code', () => {
    const error = culturalError('CULTURAL_ASSIGNEE_NOT_FOUND', {
      reason: 'suspended',
      userId: USER_ID,
    });
    expect(bodyOf(error)).toEqual({
      statusCode: 404,
      message: 'No account has this id.',
      code: 'CULTURAL_ASSIGNEE_NOT_FOUND',
      userId: USER_ID,
    });
  });

  it('copies only the extras listed for the code', () => {
    const error = culturalError('CULTURAL_TITLE_REQUIRED', {
      sectionIndex: 2,
      stepIndex: 1,
      revision: 4,
      userId: USER_ID,
      reason: 'suspended',
    });
    expect(bodyOf(error)).toEqual({
      statusCode: 400,
      message: 'A title is required.',
      code: 'CULTURAL_TITLE_REQUIRED',
    });
  });

  it('copies the section and step index where the code lists them', () => {
    const error = culturalError('CULTURAL_GUIDE_STEP_TEXT_REQUIRED', {
      sectionIndex: 0,
      stepIndex: 3,
      revision: 9,
    });
    expect(bodyOf(error)).toEqual({
      statusCode: 400,
      message: 'Every checklist step needs text.',
      code: 'CULTURAL_GUIDE_STEP_TEXT_REQUIRED',
      sectionIndex: 0,
      stepIndex: 3,
    });
  });

  it('leaves an extra off the body when its option is undefined', () => {
    const error = culturalError('CULTURAL_GUIDE_SECTIONS_INVALID', {
      sectionIndex: 1,
    });
    expect(bodyOf(error)).not.toHaveProperty('stepIndex');
    expect(bodyOf(error)).toHaveProperty('sectionIndex', 1);
  });

  it('carries the revision on CULTURAL_GUIDE_EDIT_CONFLICT', () => {
    const error = culturalError('CULTURAL_GUIDE_EDIT_CONFLICT', {
      revision: 7,
    });
    expect(error.getStatus()).toBe(409);
    expect(bodyOf(error)).toEqual({
      statusCode: 409,
      message: 'Someone saved this guide after you opened it.',
      code: 'CULTURAL_GUIDE_EDIT_CONFLICT',
      revision: 7,
    });
  });

  it('lets status override the table status', () => {
    const error = culturalError('CULTURAL_ASSIGNEE_NOT_FOUND', {
      status: HttpStatus.BAD_REQUEST,
      userId: USER_ID,
    });
    expect(error.getStatus()).toBe(400);
    expect(bodyOf(error)).toEqual({
      statusCode: 400,
      message: 'No account has this id.',
      code: 'CULTURAL_ASSIGNEE_NOT_FOUND',
      userId: USER_ID,
    });
  });

  it('lets status override the table status of CULTURAL_TOO_MANY_ASSIGNEES', () => {
    const error = culturalError('CULTURAL_TOO_MANY_ASSIGNEES', {
      status: HttpStatus.BAD_REQUEST,
    });
    expect(error.getStatus()).toBe(400);
    expect(bodyOf(error).statusCode).toBe(400);
  });
});

describe('cultural lists', () => {
  it('lists the event types in the migration CHECK order', () => {
    expect([...CULTURAL_EVENT_TYPES]).toEqual([
      'board_game_night',
      'quiz_night',
      'music_night',
      'film_night',
      'workshop',
      'talk',
      'party',
      'other',
    ]);
  });

  it('lists the statuses, filters, locales, reasons and grants', () => {
    expect([...CULTURAL_IDEA_STATUSES]).toEqual([
      'new',
      'exploring',
      'planned',
      'parked',
    ]);
    expect(DEFAULT_CULTURAL_IDEA_STATUS).toBe('new');
    expect([...CULTURAL_TASK_STATUSES]).toEqual(['todo', 'doing', 'done']);
    expect(DEFAULT_CULTURAL_TASK_STATUS).toBe('todo');
    expect([...OPEN_CULTURAL_TASK_STATUSES]).toEqual(['todo', 'doing']);
    expect([...CULTURAL_TASK_STATUS_FILTERS]).toEqual([
      'open',
      'todo',
      'doing',
      'done',
    ]);
    expect([...CULTURAL_ASSIGNED_TO_FILTERS]).toEqual(['me', 'unassigned']);
    expect([...CULTURAL_GUIDE_LOCALES]).toEqual(['en', 'pt']);
    expect([...CULTURAL_ASSIGNEE_REFUSAL_REASONS]).toEqual([
      'no_access',
      'suspended',
      'deactivated',
    ]);
    expect([...CULTURAL_ACCESS_STAFF_ROLES]).toEqual([
      'cultural_producer',
      'music_manager_producer',
    ]);
  });
});

describe('cultural guards', () => {
  const guardCases: ReadonlyArray<
    readonly [string, (value: unknown) => boolean, readonly string[], string]
  > = [
    [
      'isCulturalEventType',
      isCulturalEventType,
      CULTURAL_EVENT_TYPES,
      'board_game',
    ],
    [
      'isCulturalIdeaStatus',
      isCulturalIdeaStatus,
      CULTURAL_IDEA_STATUSES,
      'newer',
    ],
    [
      'isCulturalTaskStatus',
      isCulturalTaskStatus,
      CULTURAL_TASK_STATUSES,
      'open',
    ],
    [
      'isCulturalTaskStatusFilter',
      isCulturalTaskStatusFilter,
      CULTURAL_TASK_STATUS_FILTERS,
      'opened',
    ],
    [
      'isCulturalAssignedToFilter',
      isCulturalAssignedToFilter,
      CULTURAL_ASSIGNED_TO_FILTERS,
      'mine',
    ],
    [
      'isCulturalGuideLocale',
      isCulturalGuideLocale,
      CULTURAL_GUIDE_LOCALES,
      'pt-PT',
    ],
    [
      'isCulturalAssigneeRefusalReason',
      isCulturalAssigneeRefusalReason,
      CULTURAL_ASSIGNEE_REFUSAL_REASONS,
      'noaccess',
    ],
  ];

  it.each(guardCases)('%s accepts every listed value', (_name, guard, list) => {
    for (const value of list) {
      expect(guard(value)).toBe(true);
    }
  });

  it.each(guardCases)(
    '%s refuses an empty string, null, an array and a near miss',
    (_name, guard, list, nearMiss) => {
      expect(guard('')).toBe(false);
      expect(guard(null)).toBe(false);
      expect(guard(undefined)).toBe(false);
      expect(guard([list[0]])).toBe(false);
      expect(guard(nearMiss)).toBe(false);
      expect(guard(`${list[0]} `)).toBe(false);
      for (const value of list) {
        expect(guard(value.toUpperCase())).toBe(false);
      }
    },
  );
});

describe('isCulturalStaffTierRole', () => {
  it('accepts moderator and admin', () => {
    expect(isCulturalStaffTierRole('moderator')).toBe(true);
    expect(isCulturalStaffTierRole('admin')).toBe(true);
  });

  it('refuses member, the two grants, an empty string and a near miss', () => {
    expect(isCulturalStaffTierRole('member')).toBe(false);
    expect(isCulturalStaffTierRole('cultural_producer')).toBe(false);
    expect(isCulturalStaffTierRole('music_manager_producer')).toBe(false);
    expect(isCulturalStaffTierRole('')).toBe(false);
    expect(isCulturalStaffTierRole('Admin')).toBe(false);
    expect(isCulturalStaffTierRole('admins')).toBe(false);
  });
});
