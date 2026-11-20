import { HttpException } from '@nestjs/common';
import { isUUID } from 'class-validator';
import {
  countGuideSteps,
  dueOnForStep,
  normalizeCulturalGuideSections,
} from './cultural-guide-sections';

const SECTION_ID = '6f1c2a40-8b3d-4e5f-9a10-1b2c3d4e5f60';
const STEP_ID = '3b9d6c1e-2f4a-4c8b-9d7e-5a6b7c8d9e0f';
const EMOJI = '\u{1F3B2}';

interface RefusalOutcome {
  code?: string;
  status?: number;
  sectionIndex?: number;
  stepIndex?: number;
}

function refusalOf(value: unknown): RefusalOutcome {
  try {
    normalizeCulturalGuideSections(value);
    return {};
  } catch (error) {
    const httpError = error as HttpException;
    const body = httpError.getResponse() as RefusalOutcome;
    const outcome: RefusalOutcome = {
      code: body.code,
      status: httpError.getStatus(),
    };
    if (body.sectionIndex !== undefined) {
      outcome.sectionIndex = body.sectionIndex;
    }
    if (body.stepIndex !== undefined) outcome.stepIndex = body.stepIndex;
    return outcome;
  }
}

function sectionWith(fields: Record<string, unknown>): Record<string, unknown> {
  return { heading: 'Before', body: '', steps: [], ...fields };
}

function stepsOf(count: number): Record<string, unknown>[] {
  return Array.from({ length: count }, (_unused, stepIndex) => ({
    text: `Step ${stepIndex}`,
    daysBefore: null,
  }));
}

describe('normalizeCulturalGuideSections', () => {
  it('rule 1: answers CULTURAL_GUIDE_SECTIONS_INVALID with no index for a value that is no array', () => {
    for (const value of [undefined, null, 'x', {}, 5]) {
      expect(refusalOf(value)).toEqual({
        code: 'CULTURAL_GUIDE_SECTIONS_INVALID',
        status: 400,
      });
    }
  });

  it('rule 2: answers CULTURAL_GUIDE_TOO_MANY_SECTIONS past 30 sections', () => {
    const thirty = Array.from({ length: 30 }, () => sectionWith({}));
    expect(normalizeCulturalGuideSections(thirty)).toHaveLength(30);
    expect(refusalOf([...thirty, sectionWith({})])).toEqual({
      code: 'CULTURAL_GUIDE_TOO_MANY_SECTIONS',
      status: 400,
    });
  });

  it('rule 2 runs before any section check', () => {
    const broken = Array.from({ length: 31 }, () => 'x');
    expect(refusalOf(broken).code).toBe('CULTURAL_GUIDE_TOO_MANY_SECTIONS');
  });

  it('rule 3: answers CULTURAL_GUIDE_SECTIONS_INVALID with sectionIndex for a section that is no plain object', () => {
    for (const section of [null, 'x', ['a'], 5]) {
      expect(refusalOf([sectionWith({}), section])).toEqual({
        code: 'CULTURAL_GUIDE_SECTIONS_INVALID',
        status: 400,
        sectionIndex: 1,
      });
    }
  });

  it('rule 3: answers CULTURAL_GUIDE_HEADING_REQUIRED with sectionIndex for a missing or blank heading', () => {
    for (const heading of [undefined, null, 5, '   ']) {
      expect(refusalOf([sectionWith({}), sectionWith({ heading })])).toEqual({
        code: 'CULTURAL_GUIDE_HEADING_REQUIRED',
        status: 400,
        sectionIndex: 1,
      });
    }
  });

  it('rule 3: answers CULTURAL_GUIDE_HEADING_TOO_LONG with sectionIndex past 120 code points', () => {
    const [kept] = normalizeCulturalGuideSections([
      sectionWith({ heading: EMOJI.repeat(120) }),
    ]);
    expect(kept?.heading).toBe(EMOJI.repeat(120));
    expect(refusalOf([sectionWith({ heading: EMOJI.repeat(121) })])).toEqual({
      code: 'CULTURAL_GUIDE_HEADING_TOO_LONG',
      status: 400,
      sectionIndex: 0,
    });
  });

  it('rule 3: reads an absent or null body as empty', () => {
    const sections = normalizeCulturalGuideSections([
      { heading: 'One' },
      { heading: 'Two', body: null },
    ]);
    expect(sections.map((section) => section.body)).toEqual(['', '']);
  });

  it('rule 3: trims the body and keeps inner blank lines', () => {
    const [section] = normalizeCulturalGuideSections([
      sectionWith({ body: 'One\r\n\r\n- two\r- three  \n\n' }),
    ]);
    expect(section?.body).toBe('One\n\n- two\n- three');
  });

  it('rule 3: answers CULTURAL_GUIDE_BODY_TOO_LONG with sectionIndex for a non-string or long body', () => {
    expect(refusalOf([sectionWith({ body: 5 })])).toEqual({
      code: 'CULTURAL_GUIDE_BODY_TOO_LONG',
      status: 400,
      sectionIndex: 0,
    });
    const [kept] = normalizeCulturalGuideSections([
      sectionWith({ body: 'a'.repeat(10000) }),
    ]);
    expect(kept?.body).toHaveLength(10000);
    expect(
      refusalOf([sectionWith({}), sectionWith({ body: 'a'.repeat(10001) })]),
    ).toEqual({
      code: 'CULTURAL_GUIDE_BODY_TOO_LONG',
      status: 400,
      sectionIndex: 1,
    });
  });

  it('rule 3: reads absent or null steps as none', () => {
    const sections = normalizeCulturalGuideSections([
      { heading: 'One' },
      { heading: 'Two', steps: null },
    ]);
    expect(sections.map((section) => section.steps)).toEqual([[], []]);
  });

  it('rule 3: answers CULTURAL_GUIDE_SECTIONS_INVALID with sectionIndex for steps that are no array', () => {
    expect(refusalOf([sectionWith({}), sectionWith({ steps: 'x' })])).toEqual({
      code: 'CULTURAL_GUIDE_SECTIONS_INVALID',
      status: 400,
      sectionIndex: 1,
    });
  });

  it('rule 3: answers CULTURAL_GUIDE_TOO_MANY_STEPS with sectionIndex past 40 steps in a section', () => {
    const [kept] = normalizeCulturalGuideSections([
      sectionWith({ steps: stepsOf(40) }),
    ]);
    expect(kept?.steps).toHaveLength(40);
    expect(
      refusalOf([sectionWith({}), sectionWith({ steps: stepsOf(41) })]),
    ).toEqual({
      code: 'CULTURAL_GUIDE_TOO_MANY_STEPS',
      status: 400,
      sectionIndex: 1,
    });
  });

  it('rule 3: answers CULTURAL_GUIDE_SECTIONS_INVALID with both indexes for a step that is no plain object', () => {
    for (const step of [null, 'x', [], 5]) {
      expect(
        refusalOf([
          sectionWith({}),
          sectionWith({ steps: [...stepsOf(2), step] }),
        ]),
      ).toEqual({
        code: 'CULTURAL_GUIDE_SECTIONS_INVALID',
        status: 400,
        sectionIndex: 1,
        stepIndex: 2,
      });
    }
  });

  it('rule 3: answers CULTURAL_GUIDE_STEP_TEXT_REQUIRED with both indexes for missing or blank text', () => {
    for (const text of [undefined, null, 5, '  ']) {
      expect(
        refusalOf([sectionWith({ steps: [...stepsOf(1), { text }] })]),
      ).toEqual({
        code: 'CULTURAL_GUIDE_STEP_TEXT_REQUIRED',
        status: 400,
        sectionIndex: 0,
        stepIndex: 1,
      });
    }
  });

  it('rule 3: answers CULTURAL_GUIDE_STEP_TEXT_TOO_LONG with both indexes past 160 code points', () => {
    const [kept] = normalizeCulturalGuideSections([
      sectionWith({ steps: [{ text: EMOJI.repeat(160) }] }),
    ]);
    expect(kept?.steps[0]?.text).toBe(EMOJI.repeat(160));
    expect(
      refusalOf([
        sectionWith({}),
        sectionWith({ steps: [{ text: EMOJI.repeat(161) }] }),
      ]),
    ).toEqual({
      code: 'CULTURAL_GUIDE_STEP_TEXT_TOO_LONG',
      status: 400,
      sectionIndex: 1,
      stepIndex: 0,
    });
  });

  it('rule 3: reads absent or null daysBefore as null and keeps an integer from -60 to 365', () => {
    const [section] = normalizeCulturalGuideSections([
      sectionWith({
        steps: [
          { text: 'a' },
          { text: 'b', daysBefore: null },
          { text: 'c', daysBefore: -60 },
          { text: 'd', daysBefore: 0 },
          { text: 'e', daysBefore: 365 },
        ],
      }),
    ]);
    expect(section?.steps.map((step) => step.daysBefore)).toEqual([
      null,
      null,
      -60,
      0,
      365,
    ]);
  });

  it('rule 3: answers CULTURAL_GUIDE_STEP_DAYS_INVALID with both indexes outside the range or for a non-integer', () => {
    for (const daysBefore of [-61, 366, 1.5, '3', Number.NaN, Infinity]) {
      expect(
        refusalOf([
          sectionWith({ steps: [...stepsOf(3), { text: 'x', daysBefore }] }),
        ]),
      ).toEqual({
        code: 'CULTURAL_GUIDE_STEP_DAYS_INVALID',
        status: 400,
        sectionIndex: 0,
        stepIndex: 3,
      });
    }
  });

  it('rule 3 checks a section in the order shape, heading, body, steps', () => {
    expect(refusalOf([{ heading: '', body: 5, steps: 'x' }]).code).toBe(
      'CULTURAL_GUIDE_HEADING_REQUIRED',
    );
    expect(refusalOf([{ heading: 'a', body: 5, steps: 'x' }]).code).toBe(
      'CULTURAL_GUIDE_BODY_TOO_LONG',
    );
    expect(
      refusalOf([{ heading: 'a', steps: [{ text: '', daysBefore: 999 }] }])
        .code,
    ).toBe('CULTURAL_GUIDE_STEP_TEXT_REQUIRED');
  });

  it('rule 4: counts 100 steps across sections and refuses the 101st without an index', () => {
    const hundred = [
      sectionWith({ steps: stepsOf(40) }),
      sectionWith({ steps: stepsOf(40) }),
      sectionWith({ steps: stepsOf(20) }),
    ];
    expect(countGuideSteps(normalizeCulturalGuideSections(hundred))).toBe(100);
    expect(refusalOf([...hundred, sectionWith({ steps: stepsOf(1) })])).toEqual(
      {
        code: 'CULTURAL_GUIDE_TOO_MANY_STEPS',
        status: 400,
      },
    );
  });

  it('rule 4 runs after every section check', () => {
    const tooMany = [
      sectionWith({ steps: stepsOf(40) }),
      sectionWith({ steps: stepsOf(40) }),
      sectionWith({ steps: stepsOf(40) }),
      sectionWith({ heading: '' }),
    ];
    expect(refusalOf(tooMany)).toEqual({
      code: 'CULTURAL_GUIDE_HEADING_REQUIRED',
      status: 400,
      sectionIndex: 3,
    });
  });

  it('keeps a unique uuid id and replaces a duplicate', () => {
    const sections = normalizeCulturalGuideSections([
      sectionWith({
        id: SECTION_ID.toUpperCase(),
        steps: [
          { id: STEP_ID, text: 'a' },
          { id: STEP_ID, text: 'b' },
          { id: SECTION_ID, text: 'c' },
        ],
      }),
      sectionWith({ id: SECTION_ID }),
    ]);
    const [first, second] = sections;
    expect(first?.id).toBe(SECTION_ID);
    expect(first?.steps[0]?.id).toBe(STEP_ID);
    const replacedIds = [first?.steps[1]?.id, first?.steps[2]?.id, second?.id];
    for (const replacedId of replacedIds) {
      expect(isUUID(replacedId)).toBe(true);
      expect([SECTION_ID, STEP_ID]).not.toContain(replacedId);
    }
    expect(new Set(replacedIds).size).toBe(3);
  });

  it('gives a fresh uuid to an id that is missing or no uuid', () => {
    const [section] = normalizeCulturalGuideSections([
      sectionWith({
        id: 'intro',
        steps: [{ id: 7, text: 'a' }, { text: 'b' }],
      }),
    ]);
    expect(isUUID(section?.id)).toBe(true);
    expect(section?.steps.every((step) => isUUID(step.id))).toBe(true);
  });

  it('drops unknown keys', () => {
    const [section] = normalizeCulturalGuideSections([
      {
        id: SECTION_ID,
        heading: 'Before',
        body: 'Text',
        color: 'red',
        steps: [{ id: STEP_ID, text: 'Book', daysBefore: 7, isDone: true }],
      },
    ]);
    expect(section).toEqual({
      id: SECTION_ID,
      heading: 'Before',
      body: 'Text',
      steps: [{ id: STEP_ID, text: 'Book', daysBefore: 7 }],
    });
  });

  it('keeps the section and step order', () => {
    const sections = normalizeCulturalGuideSections([
      sectionWith({ heading: 'B', steps: [{ text: '2' }, { text: '1' }] }),
      sectionWith({ heading: 'A' }),
    ]);
    expect(sections.map((section) => section.heading)).toEqual(['B', 'A']);
    expect(sections[0]?.steps.map((step) => step.text)).toEqual(['2', '1']);
  });
});

describe('countGuideSteps', () => {
  it('sums the steps of every section', () => {
    expect(countGuideSteps([])).toBe(0);
    expect(
      countGuideSteps([
        { steps: [] },
        { steps: [{ id: STEP_ID, text: 'a', daysBefore: null }] },
      ]),
    ).toBe(1);
  });
});

describe('dueOnForStep', () => {
  it.each<[string, number | null, string | null]>([
    ['2026-12-12', 42, '2026-10-31'],
    ['2026-12-12', 0, '2026-12-12'],
    ['2026-12-12', -1, '2026-12-13'],
    ['2027-03-01', 1, '2027-02-28'],
    ['2028-03-01', 1, '2028-02-29'],
    ['2026-03-29', 1, '2026-03-28'],
    ['2026-10-25', -1, '2026-10-26'],
    ['2026-12-12', null, null],
    ['2030-01-01', null, null],
  ])(
    'answers %s minus %p days as %p',
    (eventOn: string, daysBefore: number | null, expected: string | null) => {
      expect(dueOnForStep(eventOn, daysBefore)).toBe(expected);
    },
  );
});
