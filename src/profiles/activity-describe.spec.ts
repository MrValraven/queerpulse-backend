import { dedupeActivity, describeActivity } from './activity-describe';
import {
  Activity,
  ActivityKind,
  ActivitySubjectKind,
} from './entities/activity.entity';

const row = (fields: Partial<Activity>): Activity => ({
  id: 'row-id',
  userId: 'member-1',
  kind: ActivityKind.Post,
  title: '',
  sub: null,
  toLink: null,
  subjectKind: null,
  subjectId: null,
  occurredAt: new Date('2026-10-20T00:00:00.000Z'),
  ...fields,
});

describe('describeActivity', () => {
  it.each([
    [
      ActivityKind.Event,
      ActivitySubjectKind.Event,
      "RSVP'd to Poetry Night",
      'rsvp',
      'Poetry Night',
    ],
    [
      ActivityKind.Post,
      ActivitySubjectKind.ForumThread,
      'Started a thread: Finding a GP',
      'thread',
      'Finding a GP',
    ],
    [
      ActivityKind.Post,
      ActivitySubjectKind.Community,
      'Posted in Trans Joy',
      'communityPost',
      'Trans Joy',
    ],
    [
      ActivityKind.Community,
      ActivitySubjectKind.Community,
      'Joined Trans Joy',
      'join',
      'Trans Joy',
    ],
    [
      ActivityKind.Persona,
      ActivitySubjectKind.Persona,
      'Published a persona: Personal trainer- Level 2',
      'persona',
      'Personal trainer- Level 2',
    ],
  ])(
    'reads a %s row titled %p',
    (kind, subjectKind, title, action, subject) => {
      expect(describeActivity({ kind, subjectKind, title })).toEqual({
        action,
        subject,
      });
    },
  );

  it('trims whitespace around the subject', () => {
    expect(
      describeActivity({
        kind: ActivityKind.Community,
        subjectKind: ActivitySubjectKind.Community,
        title: 'Joined   Trans Joy  ',
      }),
    ).toEqual({ action: 'join', subject: 'Trans Joy' });
  });

  it.each([
    // Right prefix, wrong kind.
    [ActivityKind.Event, ActivitySubjectKind.Community, 'Joined Trans Joy'],
    // A post variant is told apart by its subject kind.
    [ActivityKind.Post, ActivitySubjectKind.ForumThread, 'Posted in Trans Joy'],
    [ActivityKind.Post, null, 'Started a thread: Finding a GP'],
    // A legacy or reworded title.
    [ActivityKind.Event, ActivitySubjectKind.Event, "RSVP'd"],
    [ActivityKind.Event, ActivitySubjectKind.Event, "rsvp'd to Poetry Night"],
    // The prefix with nothing after it.
    [
      ActivityKind.Persona,
      ActivitySubjectKind.Persona,
      'Published a persona:  ',
    ],
    // A kind the listener never writes.
    [ActivityKind.Music, null, 'Joined Trans Joy'],
  ])(
    'falls back to nulls for a %s row titled %p',
    (kind, subjectKind, title) => {
      expect(describeActivity({ kind, subjectKind, title })).toEqual({
        action: null,
        subject: null,
      });
    },
  );
});

describe('dedupeActivity', () => {
  it('keeps only the newest row per persona, event and join subject', () => {
    const rows = [
      row({
        id: 'persona-new',
        kind: ActivityKind.Persona,
        subjectKind: ActivitySubjectKind.Persona,
        subjectId: 'persona-1',
      }),
      row({
        id: 'rsvp-new',
        kind: ActivityKind.Event,
        subjectKind: ActivitySubjectKind.Event,
        subjectId: 'poetry-night',
      }),
      row({
        id: 'persona-old',
        kind: ActivityKind.Persona,
        subjectKind: ActivitySubjectKind.Persona,
        subjectId: 'persona-1',
      }),
      row({
        id: 'join-new',
        kind: ActivityKind.Community,
        subjectKind: ActivitySubjectKind.Community,
        subjectId: 'trans-joy',
      }),
      row({
        id: 'rsvp-old',
        kind: ActivityKind.Event,
        subjectKind: ActivitySubjectKind.Event,
        subjectId: 'poetry-night',
      }),
      row({
        id: 'join-old',
        kind: ActivityKind.Community,
        subjectKind: ActivitySubjectKind.Community,
        subjectId: 'trans-joy',
      }),
      row({
        id: 'persona-other',
        kind: ActivityKind.Persona,
        subjectKind: ActivitySubjectKind.Persona,
        subjectId: 'persona-2',
      }),
    ];

    expect(dedupeActivity(rows).map((kept) => kept.id)).toEqual([
      'persona-new',
      'rsvp-new',
      'join-new',
      'persona-other',
    ]);
  });

  it('never collapses posts, even in the same community', () => {
    const rows = [
      row({
        id: 'post-2',
        kind: ActivityKind.Post,
        subjectKind: ActivitySubjectKind.Community,
        subjectId: 'trans-joy',
      }),
      row({
        id: 'join',
        kind: ActivityKind.Community,
        subjectKind: ActivitySubjectKind.Community,
        subjectId: 'trans-joy',
      }),
      row({
        id: 'post-1',
        kind: ActivityKind.Post,
        subjectKind: ActivitySubjectKind.Community,
        subjectId: 'trans-joy',
      }),
    ];

    expect(dedupeActivity(rows).map((kept) => kept.id)).toEqual([
      'post-2',
      'join',
      'post-1',
    ]);
  });

  it('keeps every row with no subject id', () => {
    const rows = [
      row({ id: 'legacy-1', kind: ActivityKind.Event }),
      row({ id: 'legacy-2', kind: ActivityKind.Event }),
    ];

    expect(dedupeActivity(rows).map((kept) => kept.id)).toEqual([
      'legacy-1',
      'legacy-2',
    ]);
  });
});
