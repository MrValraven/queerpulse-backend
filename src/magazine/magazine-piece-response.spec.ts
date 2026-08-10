import {
  MagazinePiece,
  PieceCare,
  PieceStage,
} from './entities/magazine-piece.entity';
import { MagazinePieceEvent } from './entities/magazine-piece-event.entity';
import { MagazinePitch } from './entities/magazine-pitch.entity';
import { MagazinePayment } from './entities/magazine-payment.entity';
import { MagazineLetter } from './entities/magazine-letter.entity';
import { MagazineCorrection } from './entities/magazine-correction.entity';
import { MagazineArticle } from './entities/magazine-article.entity';
import { MagazineDeck } from './entities/magazine-deck.entity';
import {
  computePublishGate,
  deriveLate,
  deriveWaitingOn,
  toArchiveEntryFromArticle,
  toArchiveEntryFromDeck,
  toDeskSummary,
  toCorrectionResponse,
  toLetterResponse,
  toPaymentResponse,
  toPieceListItem,
  toPieceRecordFull,
  toPieceRecordSummary,
  toPitchResponse,
} from './magazine-piece-response';

const FIXED_NOW = new Date('2026-08-10T12:00:00Z');

function makePiece(overrides: Partial<MagazinePiece> = {}): MagazinePiece {
  return {
    id: 'piece-1',
    format: 'article',
    title: 'The Long Weekend',
    section: 'culture',
    kind: 'feature',
    stage: 'drafting',
    editorId: 'editor-1',
    writerId: 'writer-1',
    byline: 'Kai Rivera',
    dueOn: null,
    issueId: 'issue-1',
    articleId: null,
    deckId: null,
    wordTarget: 1200,
    slideTarget: null,
    fresh: false,
    pitchId: null,
    orderIndex: null,
    pages: null,
    laidOut: false,
    art: 'none',
    contentsBlurb: '',
    brief: null,
    care: null,
    createdAt: new Date('2026-08-01T10:00:00Z'),
    updatedAt: new Date('2026-08-01T10:00:00Z'),
    ...overrides,
  };
}

function makePitch(overrides: Partial<MagazinePitch> = {}): MagazinePitch {
  return {
    id: 'pitch-1',
    title: 'Trans Elders Oral History',
    from: 'jordan@example.com',
    note: 'A multi-part oral history series.',
    tags: ['history', 'elders'],
    suggestFormat: 'article',
    status: 'waiting',
    fresh: true,
    issueId: null,
    passTemplate: null,
    passNote: null,
    submitterId: null,
    createdAt: new Date('2026-08-05T09:00:00Z'),
    ...overrides,
  };
}

function makeCare(overrides: Partial<PieceCare> = {}): PieceCare {
  return {
    subjects: [],
    contentNotes: [],
    flags: [],
    read: null,
    ...overrides,
  };
}

function makePayment(
  overrides: Partial<MagazinePayment> = {},
): MagazinePayment {
  return {
    id: 'payment-1',
    pieceId: 'piece-1',
    fee: '€420',
    expenses: '€18 travel',
    invoice: 'INV-2026-084',
    filedOn: '2026-07-29',
    terms: '21 days',
    dueOn: '2026-08-19',
    status: 'approved_unpaid',
    paidOn: null,
    createdAt: new Date('2026-07-02T10:00:00Z'),
    updatedAt: new Date('2026-07-29T10:00:00Z'),
    ...overrides,
  };
}

function makeLetter(overrides: Partial<MagazineLetter> = {}): MagazineLetter {
  return {
    id: 'letter-1',
    pieceId: 'piece-1',
    who: 'Cláudia, 58',
    body: 'I read this twice.',
    runInLetters: false,
    createdAt: new Date('2026-08-08T10:00:00Z'),
    ...overrides,
  };
}

function makeCorrection(
  overrides: Partial<MagazineCorrection> = {},
): MagazineCorrection {
  return {
    id: 'correction-1',
    pieceId: 'piece-1',
    text: 'An earlier version misstated a date.',
    publishedOn: null,
    createdAt: new Date('2026-08-09T10:00:00Z'),
    ...overrides,
  };
}

function makeEvent(
  overrides: Partial<MagazinePieceEvent> = {},
): MagazinePieceEvent {
  return {
    id: 'event-1',
    pieceId: 'piece-1',
    actorId: 'editor-1',
    action: 'stage_changed',
    detail: 'commissioned -> drafting',
    createdAt: new Date('2026-08-02T09:00:00Z'),
    ...overrides,
  };
}

describe('deriveLate', () => {
  it('is true when dueOn is strictly before today and the stage is not ready', () => {
    const piece = makePiece({ dueOn: '2026-08-01', stage: 'drafting' });
    expect(deriveLate(piece, FIXED_NOW)).toBe(true);
  });

  it('is false when dueOn is past due but the stage is ready', () => {
    const piece = makePiece({ dueOn: '2026-08-01', stage: 'ready' });
    expect(deriveLate(piece, FIXED_NOW)).toBe(false);
  });

  it('is false when dueOn is in the future', () => {
    const piece = makePiece({ dueOn: '2026-12-25', stage: 'drafting' });
    expect(deriveLate(piece, FIXED_NOW)).toBe(false);
  });

  it('is false when dueOn is null', () => {
    const piece = makePiece({ dueOn: null, stage: 'drafting' });
    expect(deriveLate(piece, FIXED_NOW)).toBe(false);
  });

  it('is false when dueOn is an unparseable date', () => {
    const piece = makePiece({ dueOn: 'not-a-date', stage: 'drafting' });
    expect(deriveLate(piece, FIXED_NOW)).toBe(false);
  });

  it('is false when dueOn is today (not strictly before)', () => {
    const piece = makePiece({ dueOn: '2026-08-10', stage: 'drafting' });
    expect(deriveLate(piece, FIXED_NOW)).toBe(false);
  });
});

describe('deriveWaitingOn', () => {
  const expectedByStage: Record<PieceStage, 'writer' | 'you' | 'nobody'> = {
    commissioned: 'writer',
    drafting: 'writer',
    in_review: 'you',
    edit: 'you',
    sensitivity_read: 'you',
    layout: 'you',
    ready: 'nobody',
  };

  for (const [stage, expected] of Object.entries(expectedByStage)) {
    it(`maps stage "${stage}" (writer assigned) to "${expected}"`, () => {
      expect(
        deriveWaitingOn(
          makePiece({ stage: stage as PieceStage, writerId: 'writer-1' }),
        ),
      ).toBe(expected);
    });
  }

  it('is "you" for commissioned with no writer assigned yet (editor owes the assignment)', () => {
    expect(
      deriveWaitingOn(makePiece({ stage: 'commissioned', writerId: null })),
    ).toBe('you');
  });

  it('is "you" for drafting with no writer assigned (should not happen, but stays editor-owed)', () => {
    expect(
      deriveWaitingOn(makePiece({ stage: 'drafting', writerId: null })),
    ).toBe('you');
  });

  it('is "writer" for commissioned once a writer is assigned', () => {
    expect(
      deriveWaitingOn(
        makePiece({ stage: 'commissioned', writerId: 'writer-1' }),
      ),
    ).toBe('writer');
  });
});

describe('toPieceListItem', () => {
  it('maps every response field from the entity', () => {
    const piece = makePiece({ dueOn: '2026-08-01', stage: 'drafting' });

    expect(toPieceListItem(piece)).toEqual({
      id: 'piece-1',
      format: 'article',
      title: 'The Long Weekend',
      section: 'culture',
      kind: 'feature',
      byline: 'Kai Rivera',
      editorId: 'editor-1',
      writerId: 'writer-1',
      stage: 'drafting',
      due: '2026-08-01',
      late: deriveLate(piece),
      waitingOn: 'writer',
      words: 1200,
      slides: null,
      fresh: false,
      issueId: 'issue-1',
      articleId: null,
      deckId: null,
      art: 'none',
      contentsBlurb: '',
    });
  });

  it('maps a non-default art state through', () => {
    const piece = makePiece({ art: 'in' });

    expect(toPieceListItem(piece).art).toBe('in');
  });

  it('round-trips a non-default contentsBlurb through', () => {
    const piece = makePiece({ contentsBlurb: 'A quiet, devastating read.' });

    expect(toPieceListItem(piece).contentsBlurb).toBe(
      'A quiet, devastating read.',
    );
  });

  it('never leaks internal columns (brief, care, orderIndex, pages, laidOut, pitchId)', () => {
    const piece = makePiece({
      brief: {
        angle: 'secret angle',
        wants: [],
        avoid: '',
        wordCount: null,
        filedWords: null,
        rate: '',
        killFee: '',
        commissionedBy: '',
        commissionedOn: '',
        art: '',
      },
      care: {
        subjects: [],
        contentNotes: ['internal note'],
        flags: [],
        read: null,
      },
      orderIndex: 3,
      pages: 'A1-A4',
      laidOut: true,
      pitchId: 'pitch-9',
    });

    const listItem = toPieceListItem(piece);

    expect(listItem).not.toHaveProperty('brief');
    expect(listItem).not.toHaveProperty('care');
    expect(listItem).not.toHaveProperty('orderIndex');
    expect(listItem).not.toHaveProperty('pages');
    expect(listItem).not.toHaveProperty('laidOut');
    expect(listItem).not.toHaveProperty('pitchId');
  });
});

describe('toPitchResponse', () => {
  it('maps every pitch field and omits internal-only columns', () => {
    const pitch = makePitch();

    const response = toPitchResponse(pitch);

    expect(response).toEqual({
      id: 'pitch-1',
      title: 'Trans Elders Oral History',
      from: 'jordan@example.com',
      note: 'A multi-part oral history series.',
      tags: ['history', 'elders'],
      suggestFormat: 'article',
      status: 'waiting',
      fresh: true,
    });
    expect(response).not.toHaveProperty('passTemplate');
    expect(response).not.toHaveProperty('passNote');
  });
});

describe('toPieceRecordSummary', () => {
  it('extends the list item with brief, care, and mapped audit events', () => {
    const piece = makePiece({
      brief: {
        angle: 'the angle',
        wants: ['quotes'],
        avoid: 'jargon',
        wordCount: 1000,
        filedWords: null,
        rate: '$1/word',
        killFee: '25%',
        commissionedBy: 'editor-1',
        commissionedOn: '2026-08-01',
        art: 'commission a photographer',
      },
      care: {
        subjects: [],
        contentNotes: [],
        flags: [],
        read: null,
      },
    });
    const events = [
      makeEvent({ id: 'event-1', createdAt: new Date('2026-08-02T09:00:00Z') }),
      makeEvent({
        id: 'event-2',
        actorId: null,
        action: 'auto_reminder',
        detail: null,
        createdAt: new Date('2026-08-03T09:00:00Z'),
      }),
    ];

    const record = toPieceRecordSummary(piece, events);

    expect(record).toMatchObject(toPieceListItem(piece));
    expect(record.brief).toEqual(piece.brief);
    expect(record.care).toEqual(piece.care);
    expect(record.audit).toEqual([
      {
        actorId: 'editor-1',
        action: 'stage_changed',
        detail: 'commissioned -> drafting',
        createdAt: '2026-08-02T09:00:00.000Z',
      },
      {
        actorId: null,
        action: 'auto_reminder',
        detail: null,
        createdAt: '2026-08-03T09:00:00.000Z',
      },
    ]);
  });
});

describe('toDeskSummary', () => {
  it('aggregates stage counts, editor load against cap, and activity', () => {
    const pieces = [
      makePiece({ id: 'piece-1', stage: 'drafting', editorId: 'editor-1' }),
      makePiece({ id: 'piece-2', stage: 'drafting', editorId: 'editor-1' }),
      makePiece({ id: 'piece-3', stage: 'ready', editorId: 'editor-2' }),
    ];
    const events = [makeEvent({ id: 'event-1' })];
    const editors = [
      { id: 'editor-1', cap: 5 },
      { id: 'editor-2', cap: 3 },
      { id: 'editor-3', cap: 4 },
    ];

    const summary = toDeskSummary(pieces, events, editors);

    expect(summary.stageLoad).toEqual(
      expect.arrayContaining([
        { stage: 'drafting', count: 2 },
        { stage: 'ready', count: 1 },
      ]),
    );
    expect(summary.editorLoad).toEqual([
      { editorId: 'editor-1', count: 2, cap: 5 },
      { editorId: 'editor-2', count: 1, cap: 3 },
      { editorId: 'editor-3', count: 0, cap: 4 },
    ]);
    expect(summary.activity).toEqual([
      {
        actorId: 'editor-1',
        action: 'stage_changed',
        detail: 'commissioned -> drafting',
        createdAt: '2026-08-02T09:00:00.000Z',
      },
    ]);
  });
});

describe('computePublishGate', () => {
  it('returns a single "not started" blocker when care is null', () => {
    expect(computePublishGate(null)).toEqual([
      { label: 'Care record not started', done: false },
    ]);
  });

  it('is all done when every subject has consented, the read is complete, and content notes are written', () => {
    const care = makeCare({
      subjects: [
        {
          name: 'Teresa M.',
          named: true,
          out: true,
          consent: 'given',
          reply: 'sent',
          note: '',
        },
        {
          name: 'Rui S.',
          named: false,
          out: false,
          consent: 'given',
          reply: 'n/a',
          note: '',
        },
      ],
      contentNotes: ['Illness and hospital settings'],
      read: {
        reader: 'Ana Duarte',
        role: 'Community sensitivity reader',
        status: 'complete',
        askedOn: '2026-08-03',
        dueOn: '2026-08-09',
        checks: [
          { label: 'Nobody is outed by detail', done: true },
          { label: 'Pseudonyms hold across the whole piece', done: true },
        ],
      },
    });

    const gate = computePublishGate(care);

    expect(gate.length).toBeGreaterThan(0);
    expect(gate.every((item) => item.done)).toBe(true);
    expect(gate.some((item) => !item.done)).toBe(false);
  });

  it('treats a pseudonym subject as settled consent, not an open blocker', () => {
    const care = makeCare({
      subjects: [
        {
          name: 'Rui S.',
          named: false,
          out: false,
          consent: 'pseudonym',
          reply: 'n/a',
          note: '',
        },
      ],
      contentNotes: ['note'],
      read: {
        reader: 'Ana Duarte',
        role: 'Community sensitivity reader',
        status: 'complete',
        askedOn: '2026-08-03',
        dueOn: '2026-08-09',
        checks: [{ label: 'check', done: true }],
      },
    });

    const gate = computePublishGate(care);

    expect(gate).toEqual(
      expect.arrayContaining([{ label: 'Consent — Rui S.', done: true }]),
    );
    expect(gate.some((item) => !item.done)).toBe(false);
  });

  it('raises an open blocker naming a subject whose consent is still pending', () => {
    const care = makeCare({
      subjects: [
        {
          name: 'Dra. Câmara',
          named: true,
          out: null,
          consent: 'pending',
          reply: 'waiting',
          note: '',
        },
      ],
      contentNotes: ['note'],
      read: {
        reader: 'Ana Duarte',
        role: 'Community sensitivity reader',
        status: 'complete',
        askedOn: '2026-08-03',
        dueOn: '2026-08-09',
        checks: [{ label: 'check', done: true }],
      },
    });

    const gate = computePublishGate(care);

    expect(gate).toEqual(
      expect.arrayContaining([{ label: 'Consent — Dra. Câmara', done: false }]),
    );
    expect(gate.some((item) => !item.done)).toBe(true);
  });

  it('flags "Sensitivity read not started" as an open blocker when read is null', () => {
    const care = makeCare({ read: null });

    const gate = computePublishGate(care);

    expect(gate).toEqual(
      expect.arrayContaining([
        { label: 'Sensitivity read not started', done: false },
      ]),
    );
  });

  it('raises an open blocker per incomplete sensitivity-read check', () => {
    const care = makeCare({
      read: {
        reader: 'Ana Duarte',
        role: 'Community sensitivity reader',
        status: 'in progress',
        askedOn: '2026-08-03',
        dueOn: '2026-08-09',
        checks: [
          { label: 'Language matches the subjects own words', done: false },
          {
            label: 'Second reader for the health-provider mention',
            done: false,
          },
        ],
      },
    });

    const gate = computePublishGate(care);

    expect(gate).toEqual(
      expect.arrayContaining([
        {
          label: 'Sensitivity read: Language matches the subjects own words',
          done: false,
        },
        {
          label:
            'Sensitivity read: Second reader for the health-provider mention',
          done: false,
        },
      ]),
    );
  });

  it('marks content notes as an open blocker when none are written', () => {
    const care = makeCare({ contentNotes: [] });

    const gate = computePublishGate(care);

    expect(gate).toEqual(
      expect.arrayContaining([{ label: 'Content notes written', done: false }]),
    );
  });
});

describe('toPaymentResponse', () => {
  it('maps every payment field', () => {
    const payment = makePayment();

    expect(toPaymentResponse(payment)).toEqual({
      fee: '€420',
      expenses: '€18 travel',
      invoice: 'INV-2026-084',
      filedOn: '2026-07-29',
      terms: '21 days',
      dueOn: '2026-08-19',
      status: 'approved_unpaid',
      paidOn: null,
    });
  });
});

describe('toLetterResponse', () => {
  it('maps every letter field and serializes createdAt', () => {
    const letter = makeLetter();

    expect(toLetterResponse(letter)).toEqual({
      id: 'letter-1',
      who: 'Cláudia, 58',
      body: 'I read this twice.',
      runInLetters: false,
      createdAt: '2026-08-08T10:00:00.000Z',
    });
  });
});

describe('toCorrectionResponse', () => {
  it('maps every correction field and serializes createdAt', () => {
    const correction = makeCorrection();

    expect(toCorrectionResponse(correction)).toEqual({
      id: 'correction-1',
      text: 'An earlier version misstated a date.',
      publishedOn: null,
      createdAt: '2026-08-09T10:00:00.000Z',
    });
  });
});

describe('toPieceRecordFull', () => {
  it('extends the record summary with payment:null, letters, corrections, and the publish gate', () => {
    const piece = makePiece({
      care: makeCare({ contentNotes: [], read: null }),
    });
    const events = [makeEvent()];
    const letters = [makeLetter()];
    const corrections = [makeCorrection()];

    const record = toPieceRecordFull(piece, events, null, letters, corrections);

    expect(record).toMatchObject(toPieceRecordSummary(piece, events));
    expect(record.payment).toBeNull();
    expect(record.letters).toEqual([toLetterResponse(letters[0]!)]);
    expect(record.corrections).toEqual([toCorrectionResponse(corrections[0]!)]);
    expect(record.publishGate).toEqual(computePublishGate(piece.care));
  });

  it('maps a present payment row', () => {
    const piece = makePiece({ care: makeCare() });
    const payment = makePayment();

    const record = toPieceRecordFull(piece, [], payment, [], []);

    expect(record.payment).toEqual(toPaymentResponse(payment));
  });
});

function makeArticle(
  overrides: Partial<MagazineArticle> = {},
): MagazineArticle {
  return {
    id: 'article-1',
    slug: 'on-chosen-family',
    title: 'On chosen family',
    dek: '',
    body: '',
    standfirst: '',
    kicker: '',
    section: 'Features',
    contentNotes: [],
    blocks: [],
    authorId: 'author-1',
    issueId: 'issue-1',
    tags: ['family', 'belonging'],
    readMinutes: 4,
    publishedAt: new Date('2026-08-01T00:00:00.000Z'),
    createdAt: new Date('2026-07-01T00:00:00.000Z'),
    updatedAt: new Date('2026-07-01T00:00:00.000Z'),
    ...overrides,
  };
}

function makeDeck(overrides: Partial<MagazineDeck> = {}): MagazineDeck {
  return {
    id: 'deck-1',
    slug: 'nightlife-map',
    title: 'Nightlife, mapped',
    kicker: '',
    section: 'Culture',
    byline: 'Sofia Andrade',
    role: null,
    authorBio: '',
    cover: '',
    coverDesc: '',
    readTime: '',
    tags: ['nightlife'],
    related: [],
    slides: [],
    publishedAt: new Date('2026-07-15T00:00:00.000Z'),
    createdAt: new Date('2026-07-01T00:00:00.000Z'),
    updatedAt: new Date('2026-07-01T00:00:00.000Z'),
    ...overrides,
  };
}

describe('toArchiveEntryFromArticle', () => {
  it('maps title/tags from the article and the resolved author name + issue number', () => {
    const article = makeArticle();

    const entry = toArchiveEntryFromArticle(article, 'Kai Rivera', '05');

    expect(entry).toEqual({
      title: 'On chosen family',
      issue: '05',
      by: 'Kai Rivera',
      tags: ['family', 'belonging'],
    });
  });

  it('passes a null issue number through for a web-only article', () => {
    const article = makeArticle({ issueId: null });

    const entry = toArchiveEntryFromArticle(article, 'Kai Rivera', null);

    expect(entry.issue).toBeNull();
  });
});

describe('toArchiveEntryFromDeck', () => {
  it('maps title/byline/tags from the deck, always with a null issue', () => {
    const deck = makeDeck();

    expect(toArchiveEntryFromDeck(deck)).toEqual({
      title: 'Nightlife, mapped',
      issue: null,
      by: 'Sofia Andrade',
      tags: ['nightlife'],
    });
  });
});
