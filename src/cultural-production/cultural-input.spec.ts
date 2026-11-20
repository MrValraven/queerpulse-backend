import { HttpException } from '@nestjs/common';
import {
  isCulturalUuid,
  normalizeAssigneeIds,
  normalizeCommentBody,
  normalizeCulturalDay,
  normalizeCulturalText,
  normalizeCulturalTitle,
  normalizeGuideCreate,
  normalizeGuideReplace,
  normalizeIdeaCreate,
  normalizeIdeaUpdate,
  normalizeOptionalUuid,
  normalizeSearchTerm,
  normalizeTaskCreate,
  normalizeTaskFilters,
  normalizeTaskUpdate,
} from './cultural-input';

const IDEA_ID = '6f1c2a40-8b3d-4e5f-9a10-1b2c3d4e5f60';
const GUIDE_ID = '3b9d6c1e-2f4a-4c8b-9d7e-5a6b7c8d9e0f';
const USER_ID = 'cf5a6b7c-8d9e-4f0a-9b1c-4d5e6f7a8b9c';
const EMOJI = '\u{1F3B2}';

interface RefusalOutcome {
  code?: string;
  status?: number;
  userId?: string;
}

function refusalOf(run: () => unknown): RefusalOutcome {
  try {
    run();
    return {};
  } catch (error) {
    const httpError = error as HttpException;
    const body = httpError.getResponse() as { code?: string; userId?: string };
    const outcome: RefusalOutcome = {
      code: body.code,
      status: httpError.getStatus(),
    };
    if (body.userId !== undefined) outcome.userId = body.userId;
    return outcome;
  }
}

function codeOf(run: () => unknown): string | undefined {
  return refusalOf(run).code;
}

function distinctUserIds(count: number): string[] {
  return Array.from(
    { length: count },
    (_unused, userIndex) =>
      `cf5a6b7c-8d9e-4f0a-9b1c-${String(userIndex).padStart(12, '0')}`,
  );
}

const VALID_IDEA = { title: 'Board games', eventType: 'board_game_night' };
const VALID_TASK = { title: 'Book the venue' };
const VALID_GUIDE = {
  title: 'Board game night',
  eventType: 'board_game_night',
  locale: 'en',
};

describe('normalizeCulturalText', () => {
  it('removes NUL, turns CRLF and CR into LF and trims', () => {
    expect(normalizeCulturalText('  a\u0000b\r\nc\rd  ')).toBe('ab\nc\nd');
  });

  it('replaces an unpaired surrogate', () => {
    expect(normalizeCulturalText('a\uD800b')).toBe('a�b');
  });
});

describe('normalizeCulturalTitle', () => {
  it('answers CULTURAL_TITLE_REQUIRED for a missing, non-string or blank title', () => {
    for (const title of [undefined, null, 5, ['a'], '   ', '\u0000']) {
      expect(refusalOf(() => normalizeCulturalTitle(title))).toEqual({
        code: 'CULTURAL_TITLE_REQUIRED',
        status: 400,
      });
    }
  });

  it('counts title length in code points', () => {
    expect(normalizeCulturalTitle(EMOJI.repeat(160))).toBe(EMOJI.repeat(160));
    expect(refusalOf(() => normalizeCulturalTitle(EMOJI.repeat(161)))).toEqual({
      code: 'CULTURAL_TITLE_TOO_LONG',
      status: 400,
    });
  });

  it('trims before counting', () => {
    expect(normalizeCulturalTitle(`  ${'a'.repeat(160)}  `)).toBe(
      'a'.repeat(160),
    );
  });
});

describe('normalizeIdeaCreate', () => {
  it('defaults the description to empty and the status to new', () => {
    expect(normalizeIdeaCreate(VALID_IDEA)).toEqual({
      title: 'Board games',
      description: '',
      eventType: 'board_game_night',
      status: 'new',
    });
  });

  it('reads a null description as empty', () => {
    expect(
      normalizeIdeaCreate({ ...VALID_IDEA, description: null }).description,
    ).toBe('');
  });

  it('refuses a non-string or long description', () => {
    expect(
      codeOf(() => normalizeIdeaCreate({ ...VALID_IDEA, description: 5 })),
    ).toBe('CULTURAL_DESCRIPTION_TOO_LONG');
    expect(
      codeOf(() =>
        normalizeIdeaCreate({ ...VALID_IDEA, description: 'a'.repeat(4001) }),
      ),
    ).toBe('CULTURAL_DESCRIPTION_TOO_LONG');
    expect(
      normalizeIdeaCreate({ ...VALID_IDEA, description: 'a'.repeat(4000) })
        .description,
    ).toHaveLength(4000);
  });

  it('keeps inner line breaks in the description', () => {
    expect(
      normalizeIdeaCreate({ ...VALID_IDEA, description: 'one\r\n\r\ntwo' })
        .description,
    ).toBe('one\n\ntwo');
  });

  it('requires a listed event type', () => {
    for (const eventType of [undefined, null, 'karaoke', 5]) {
      expect(
        codeOf(() => normalizeIdeaCreate({ ...VALID_IDEA, eventType })),
      ).toBe('CULTURAL_EVENT_TYPE_INVALID');
    }
  });

  it('refuses an unknown or null idea status', () => {
    for (const status of [null, 'done', 'NEW']) {
      expect(codeOf(() => normalizeIdeaCreate({ ...VALID_IDEA, status }))).toBe(
        'CULTURAL_IDEA_STATUS_INVALID',
      );
    }
    expect(
      normalizeIdeaCreate({ ...VALID_IDEA, status: 'planned' }).status,
    ).toBe('planned');
  });

  it('checks the create idea fields in the contract order', () => {
    expect(
      codeOf(() =>
        normalizeIdeaCreate({
          title: '',
          description: 5,
          eventType: 'x',
          status: 'x',
        }),
      ),
    ).toBe('CULTURAL_TITLE_REQUIRED');
    expect(
      codeOf(() =>
        normalizeIdeaCreate({
          title: 'a',
          description: 5,
          eventType: 'x',
          status: 'x',
        }),
      ),
    ).toBe('CULTURAL_DESCRIPTION_TOO_LONG');
    expect(
      codeOf(() =>
        normalizeIdeaCreate({ title: 'a', eventType: 'x', status: 'x' }),
      ),
    ).toBe('CULTURAL_EVENT_TYPE_INVALID');
    expect(
      codeOf(() =>
        normalizeIdeaCreate({ title: 'a', eventType: 'talk', status: 'x' }),
      ),
    ).toBe('CULTURAL_IDEA_STATUS_INVALID');
  });
});

describe('normalizeIdeaUpdate', () => {
  it('answers no change for a body with no known field', () => {
    expect(normalizeIdeaUpdate({})).toEqual({});
  });

  it('keeps only the present fields', () => {
    expect(normalizeIdeaUpdate({ status: 'parked' })).toEqual({
      status: 'parked',
    });
    expect(normalizeIdeaUpdate({ description: null })).toEqual({
      description: '',
    });
  });

  it('refuses a null title, event type or status', () => {
    expect(codeOf(() => normalizeIdeaUpdate({ title: null }))).toBe(
      'CULTURAL_TITLE_REQUIRED',
    );
    expect(codeOf(() => normalizeIdeaUpdate({ eventType: null }))).toBe(
      'CULTURAL_EVENT_TYPE_INVALID',
    );
    expect(codeOf(() => normalizeIdeaUpdate({ status: null }))).toBe(
      'CULTURAL_IDEA_STATUS_INVALID',
    );
  });

  it('checks the update idea fields in the create order', () => {
    expect(codeOf(() => normalizeIdeaUpdate({ status: 'x', title: '' }))).toBe(
      'CULTURAL_TITLE_REQUIRED',
    );
    expect(
      codeOf(() => normalizeIdeaUpdate({ status: 'x', eventType: 'x' })),
    ).toBe('CULTURAL_EVENT_TYPE_INVALID');
  });
});

describe('normalizeCommentBody', () => {
  it('answers CULTURAL_COMMENT_EMPTY for a missing, non-string or blank body', () => {
    for (const body of [undefined, null, 5, '  \r\n ']) {
      expect(codeOf(() => normalizeCommentBody(body))).toBe(
        'CULTURAL_COMMENT_EMPTY',
      );
    }
  });

  it('answers CULTURAL_COMMENT_TOO_LONG past 2000 code points', () => {
    expect(normalizeCommentBody(EMOJI.repeat(2000))).toBe(EMOJI.repeat(2000));
    expect(codeOf(() => normalizeCommentBody(EMOJI.repeat(2001)))).toBe(
      'CULTURAL_COMMENT_TOO_LONG',
    );
  });

  it('trims and keeps inner line breaks', () => {
    expect(normalizeCommentBody('  one\r\ntwo  ')).toBe('one\ntwo');
  });
});

describe('normalizeTaskCreate', () => {
  it('fills the defaults', () => {
    expect(normalizeTaskCreate(VALID_TASK)).toEqual({
      title: 'Book the venue',
      notes: '',
      status: 'todo',
      dueOn: null,
      ideaId: null,
      guideId: null,
      assigneeIds: [],
    });
  });

  it('reads null notes as empty and refuses long ones', () => {
    expect(normalizeTaskCreate({ ...VALID_TASK, notes: null }).notes).toBe('');
    expect(
      codeOf(() =>
        normalizeTaskCreate({ ...VALID_TASK, notes: 'a'.repeat(4001) }),
      ),
    ).toBe('CULTURAL_NOTES_TOO_LONG');
    expect(codeOf(() => normalizeTaskCreate({ ...VALID_TASK, notes: 7 }))).toBe(
      'CULTURAL_NOTES_TOO_LONG',
    );
  });

  it('refuses an unknown or null task status', () => {
    for (const status of [null, 'open', 'new']) {
      expect(codeOf(() => normalizeTaskCreate({ ...VALID_TASK, status }))).toBe(
        'CULTURAL_TASK_STATUS_INVALID',
      );
    }
    expect(normalizeTaskCreate({ ...VALID_TASK, status: 'done' }).status).toBe(
      'done',
    );
  });

  it('refuses 2026-02-30 as a due date', () => {
    expect(
      refusalOf(() =>
        normalizeTaskCreate({ ...VALID_TASK, dueOn: '2026-02-30' }),
      ),
    ).toEqual({ code: 'CULTURAL_DUE_DATE_INVALID', status: 400 });
  });

  it('accepts null to clear a due date', () => {
    expect(
      normalizeTaskCreate({ ...VALID_TASK, dueOn: null }).dueOn,
    ).toBeNull();
    expect(normalizeTaskUpdate({ dueOn: null })).toEqual({ dueOn: null });
  });

  it('keeps a real due date inside the range', () => {
    expect(
      normalizeTaskCreate({ ...VALID_TASK, dueOn: '2026-12-12' }).dueOn,
    ).toBe('2026-12-12');
  });

  it('lowercases the linked ids and reads null as no link', () => {
    const task = normalizeTaskCreate({
      ...VALID_TASK,
      ideaId: IDEA_ID.toUpperCase(),
      guideId: GUIDE_ID.toUpperCase(),
    });
    expect(task.ideaId).toBe(IDEA_ID);
    expect(task.guideId).toBe(GUIDE_ID);
    const unlinked = normalizeTaskCreate({
      ...VALID_TASK,
      ideaId: null,
      guideId: null,
    });
    expect(unlinked.ideaId).toBeNull();
    expect(unlinked.guideId).toBeNull();
  });

  it('answers 400 for a malformed linked idea or guide id', () => {
    expect(
      refusalOf(() => normalizeTaskCreate({ ...VALID_TASK, ideaId: 'x' })),
    ).toEqual({ code: 'CULTURAL_LINKED_IDEA_NOT_FOUND', status: 400 });
    expect(
      refusalOf(() => normalizeTaskCreate({ ...VALID_TASK, guideId: 5 })),
    ).toEqual({ code: 'CULTURAL_LINKED_GUIDE_NOT_FOUND', status: 400 });
  });

  it('checks the create task fields in the contract order', () => {
    const failingEverything = {
      title: '',
      notes: 5,
      status: 'x',
      dueOn: 'x',
      ideaId: 'x',
      guideId: 'x',
      assigneeIds: 'x',
    };
    expect(codeOf(() => normalizeTaskCreate(failingEverything))).toBe(
      'CULTURAL_TITLE_REQUIRED',
    );
    const expectedOrder: [string, string][] = [
      ['title', 'CULTURAL_NOTES_TOO_LONG'],
      ['notes', 'CULTURAL_TASK_STATUS_INVALID'],
      ['status', 'CULTURAL_DUE_DATE_INVALID'],
      ['dueOn', 'CULTURAL_LINKED_IDEA_NOT_FOUND'],
      ['ideaId', 'CULTURAL_LINKED_GUIDE_NOT_FOUND'],
      ['guideId', 'CULTURAL_ASSIGNEE_NOT_FOUND'],
    ];
    const fixedBody: Record<string, unknown> = { ...failingEverything };
    const validValues: Record<string, unknown> = {
      title: 'a',
      notes: '',
      status: 'todo',
      dueOn: null,
      ideaId: null,
      guideId: null,
    };
    for (const [fixedField, expectedCode] of expectedOrder) {
      fixedBody[fixedField] = validValues[fixedField];
      expect(codeOf(() => normalizeTaskCreate(fixedBody))).toBe(expectedCode);
    }
  });
});

describe('normalizeTaskUpdate', () => {
  it('answers no change for an empty body', () => {
    expect(normalizeTaskUpdate({})).toEqual({});
  });

  it('reads null as a clear for notes, due date, idea and guide', () => {
    expect(
      normalizeTaskUpdate({
        notes: null,
        dueOn: null,
        ideaId: null,
        guideId: null,
      }),
    ).toEqual({ notes: '', dueOn: null, ideaId: null, guideId: null });
  });

  it('refuses a null title or status', () => {
    expect(codeOf(() => normalizeTaskUpdate({ title: null }))).toBe(
      'CULTURAL_TITLE_REQUIRED',
    );
    expect(codeOf(() => normalizeTaskUpdate({ status: null }))).toBe(
      'CULTURAL_TASK_STATUS_INVALID',
    );
  });

  it('checks the update task fields in the create order', () => {
    expect(
      codeOf(() => normalizeTaskUpdate({ guideId: 'x', dueOn: 'x' })),
    ).toBe('CULTURAL_DUE_DATE_INVALID');
    expect(
      codeOf(() => normalizeTaskUpdate({ guideId: 'x', ideaId: 'x' })),
    ).toBe('CULTURAL_LINKED_IDEA_NOT_FOUND');
  });
});

describe('normalizeAssigneeIds', () => {
  it('reads an absent list as empty', () => {
    expect(normalizeAssigneeIds(undefined)).toEqual([]);
    expect(normalizeAssigneeIds([])).toEqual([]);
  });

  it('lowercases and dedupes assignee ids', () => {
    expect(
      normalizeAssigneeIds([USER_ID.toUpperCase(), USER_ID, IDEA_ID]),
    ).toEqual([USER_ID, IDEA_ID]);
  });

  it('answers 400 CULTURAL_ASSIGNEE_NOT_FOUND for a non-array', () => {
    for (const value of [null, USER_ID, { id: USER_ID }, 5]) {
      expect(refusalOf(() => normalizeAssigneeIds(value))).toEqual({
        code: 'CULTURAL_ASSIGNEE_NOT_FOUND',
        status: 400,
      });
    }
  });

  it('answers 400 CULTURAL_ASSIGNEE_NOT_FOUND for an item that is no uuid, with no userId', () => {
    expect(refusalOf(() => normalizeAssigneeIds([USER_ID, 'nope']))).toEqual({
      code: 'CULTURAL_ASSIGNEE_NOT_FOUND',
      status: 400,
    });
    expect(refusalOf(() => normalizeAssigneeIds([USER_ID, 5]))).toEqual({
      code: 'CULTURAL_ASSIGNEE_NOT_FOUND',
      status: 400,
    });
  });

  it('answers 400 CULTURAL_TOO_MANY_ASSIGNEES for eleven distinct ids', () => {
    expect(normalizeAssigneeIds(distinctUserIds(10))).toHaveLength(10);
    expect(refusalOf(() => normalizeAssigneeIds(distinctUserIds(11)))).toEqual({
      code: 'CULTURAL_TOO_MANY_ASSIGNEES',
      status: 400,
    });
  });

  it('counts eleven ids that collapse to ten as ten', () => {
    const ids = [...distinctUserIds(10), distinctUserIds(1)[0]];
    expect(normalizeAssigneeIds(ids)).toHaveLength(10);
  });

  it('checks the item shapes before the count', () => {
    expect(
      codeOf(() => normalizeAssigneeIds([...distinctUserIds(11), 'x'])),
    ).toBe('CULTURAL_ASSIGNEE_NOT_FOUND');
  });
});

describe('normalizeTaskFilters', () => {
  it('reads absent or blank filters as none', () => {
    expect(normalizeTaskFilters({})).toEqual({
      assignedTo: null,
      status: null,
    });
    expect(normalizeTaskFilters({ assignedTo: '  ', status: '' })).toEqual({
      assignedTo: null,
      status: null,
    });
  });

  it('accepts me and unassigned', () => {
    expect(normalizeTaskFilters({ assignedTo: ' me ' }).assignedTo).toBe('me');
    expect(normalizeTaskFilters({ assignedTo: 'unassigned' }).assignedTo).toBe(
      'unassigned',
    );
  });

  it('refuses an assignedTo array', () => {
    expect(
      refusalOf(() => normalizeTaskFilters({ assignedTo: ['me', 'me'] })),
    ).toEqual({ code: 'CULTURAL_ASSIGNED_TO_INVALID', status: 400 });
    expect(codeOf(() => normalizeTaskFilters({ assignedTo: 'ME' }))).toBe(
      'CULTURAL_ASSIGNED_TO_INVALID',
    );
  });

  it('accepts open as a status filter', () => {
    expect(normalizeTaskFilters({ status: 'open' }).status).toBe('open');
    for (const status of ['todo', 'doing', 'done']) {
      expect(normalizeTaskFilters({ status }).status).toBe(status);
    }
  });

  it('refuses an unknown or repeated status filter', () => {
    for (const status of ['closed', ['open']]) {
      expect(codeOf(() => normalizeTaskFilters({ status }))).toBe(
        'CULTURAL_TASK_STATUS_INVALID',
      );
    }
  });

  it('checks assignedTo before status', () => {
    expect(
      codeOf(() => normalizeTaskFilters({ assignedTo: 'x', status: 'x' })),
    ).toBe('CULTURAL_ASSIGNED_TO_INVALID');
  });
});

describe('normalizeCulturalDay', () => {
  it('refuses null for a required event day', () => {
    expect(
      codeOf(() =>
        normalizeCulturalDay(null, 'CULTURAL_EVENT_DATE_INVALID', {
          isNullable: false,
        }),
      ),
    ).toBe('CULTURAL_EVENT_DATE_INVALID');
    expect(
      codeOf(() =>
        normalizeCulturalDay(undefined, 'CULTURAL_EVENT_DATE_INVALID', {
          isNullable: false,
        }),
      ),
    ).toBe('CULTURAL_EVENT_DATE_INVALID');
  });

  it('keeps the range bounds and refuses the days outside them', () => {
    const options = { isNullable: false };
    expect(
      normalizeCulturalDay(
        '2000-01-01',
        'CULTURAL_EVENT_DATE_INVALID',
        options,
      ),
    ).toBe('2000-01-01');
    expect(
      normalizeCulturalDay(
        '2100-12-31',
        'CULTURAL_EVENT_DATE_INVALID',
        options,
      ),
    ).toBe('2100-12-31');
    for (const day of ['1999-12-31', '2101-01-01', '2026-2-3', 20261212]) {
      expect(
        codeOf(() =>
          normalizeCulturalDay(day, 'CULTURAL_EVENT_DATE_INVALID', options),
        ),
      ).toBe('CULTURAL_EVENT_DATE_INVALID');
    }
  });
});

describe('normalizeOptionalUuid and isCulturalUuid', () => {
  it('answers undefined when absent, null for null and the lowercased id', () => {
    expect(
      normalizeOptionalUuid(undefined, 'CULTURAL_LINKED_IDEA_NOT_FOUND'),
    ).toBeUndefined();
    expect(
      normalizeOptionalUuid(null, 'CULTURAL_LINKED_IDEA_NOT_FOUND'),
    ).toBeNull();
    expect(
      normalizeOptionalUuid(
        IDEA_ID.toUpperCase(),
        'CULTURAL_LINKED_IDEA_NOT_FOUND',
      ),
    ).toBe(IDEA_ID);
  });

  it('tells a uuid string from anything else', () => {
    expect(isCulturalUuid(USER_ID)).toBe(true);
    expect(isCulturalUuid(USER_ID.toUpperCase())).toBe(true);
    for (const value of ['', 'x', 5, null, undefined, [USER_ID]]) {
      expect(isCulturalUuid(value)).toBe(false);
    }
  });
});

describe('normalizeSearchTerm', () => {
  it('reads a blank or repeated q as no search and cuts a long one', () => {
    expect(normalizeSearchTerm(['a', 'b'])).toBe('');
    expect(normalizeSearchTerm('   ')).toBe('');
    expect(normalizeSearchTerm('a'.repeat(150))).toHaveLength(100);
  });
});

describe('normalizeGuideCreate', () => {
  it('defaults the summary to empty and the sections to none', () => {
    expect(normalizeGuideCreate(VALID_GUIDE)).toEqual({
      title: 'Board game night',
      eventType: 'board_game_night',
      locale: 'en',
      summary: '',
      sections: [],
    });
  });

  it('requires an en or pt locale', () => {
    for (const locale of [undefined, null, 'fr', 'EN']) {
      expect(
        codeOf(() => normalizeGuideCreate({ ...VALID_GUIDE, locale })),
      ).toBe('CULTURAL_GUIDE_LOCALE_INVALID');
    }
  });

  it('reads a null summary as empty and refuses a long one', () => {
    expect(
      normalizeGuideCreate({ ...VALID_GUIDE, summary: null }).summary,
    ).toBe('');
    expect(
      codeOf(() =>
        normalizeGuideCreate({ ...VALID_GUIDE, summary: 'a'.repeat(501) }),
      ),
    ).toBe('CULTURAL_GUIDE_SUMMARY_TOO_LONG');
  });

  it('checks the create guide fields in the contract order', () => {
    const failingEverything = {
      title: '',
      eventType: 'x',
      locale: 'x',
      summary: 5,
      sections: 'x',
    };
    expect(codeOf(() => normalizeGuideCreate(failingEverything))).toBe(
      'CULTURAL_TITLE_REQUIRED',
    );
    expect(
      codeOf(() => normalizeGuideCreate({ ...failingEverything, title: 'a' })),
    ).toBe('CULTURAL_EVENT_TYPE_INVALID');
    expect(
      codeOf(() =>
        normalizeGuideCreate({
          ...failingEverything,
          title: 'a',
          eventType: 'talk',
        }),
      ),
    ).toBe('CULTURAL_GUIDE_LOCALE_INVALID');
    expect(
      codeOf(() =>
        normalizeGuideCreate({
          ...failingEverything,
          title: 'a',
          eventType: 'talk',
          locale: 'pt',
        }),
      ),
    ).toBe('CULTURAL_GUIDE_SUMMARY_TOO_LONG');
    expect(
      codeOf(() => normalizeGuideCreate({ ...VALID_GUIDE, sections: 'x' })),
    ).toBe('CULTURAL_GUIDE_SECTIONS_INVALID');
  });
});

describe('normalizeGuideReplace', () => {
  const VALID_REPLACE = { ...VALID_GUIDE, revision: 3, sections: [] };

  it('answers the revision with the normalized guide', () => {
    expect(normalizeGuideReplace(VALID_REPLACE)).toEqual({
      revision: 3,
      title: 'Board game night',
      eventType: 'board_game_night',
      locale: 'en',
      summary: '',
      sections: [],
    });
  });

  it('refuses a revision that is no integer of at least 1', () => {
    for (const revision of [undefined, null, 0, -1, 1.5, '3', 2 ** 31]) {
      expect(
        codeOf(() => normalizeGuideReplace({ ...VALID_REPLACE, revision })),
      ).toBe('CULTURAL_GUIDE_REVISION_INVALID');
    }
  });

  it('checks the revision before the title', () => {
    expect(
      codeOf(() =>
        normalizeGuideReplace({ ...VALID_REPLACE, revision: 0, title: '' }),
      ),
    ).toBe('CULTURAL_GUIDE_REVISION_INVALID');
  });

  it('requires the sections', () => {
    const withoutSections = { ...VALID_GUIDE, revision: 3 };
    expect(codeOf(() => normalizeGuideReplace(withoutSections))).toBe(
      'CULTURAL_GUIDE_SECTIONS_INVALID',
    );
  });
});
