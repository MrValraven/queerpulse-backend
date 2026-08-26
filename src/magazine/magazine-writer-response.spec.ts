import { MagazinePiece, PieceStage } from './entities/magazine-piece.entity';
import { MagazinePitch, PitchStatus } from './entities/magazine-pitch.entity';
import { MagazinePayment } from './entities/magazine-payment.entity';
import {
  WriterAssignmentResponse,
  toWriterAssignment,
  toWriterPayment,
  toWriterPitch,
} from './magazine-writer-response';

function makePiece(overrides: Partial<MagazinePiece> = {}): MagazinePiece {
  return {
    id: 'piece-1',
    format: 'article',
    title: 'What we owe old friends',
    section: 'Cover',
    kind: 'feature',
    stage: 'edit',
    editorId: 'editor-1',
    writerId: 'writer-1',
    byline: 'Sara Pinheiro',
    dueOn: '2026-08-04',
    issueId: 'issue-14',
    articleId: null,
    deckId: null,
    wordTarget: 2800,
    slideTarget: null,
    fresh: false,
    pitchId: null,
    orderIndex: null,
    pages: null,
    laidOut: false,
    art: 'none',
    contentsBlurb: '',
    brief: {
      angle: 'Start at the waiting list, not the diagnosis.',
      wants: [],
      avoid: '',
      wordCount: 2800,
      filedWords: 3140,
      rate: '',
      killFee: '20% of the agreed fee',
      commissionedBy: '',
      commissionedOn: '',
      art: '',
    },
    care: {
      subjects: [
        {
          name: 'A source who asked not to be named',
          named: false,
          out: null,
          consent: 'given',
          reply: '',
          note: 'Internal editor note that must never reach the writer.',
        },
      ],
      contentNotes: ['mentions grief'],
      flags: [],
      read: {
        reader: 'Dana',
        role: 'sensitivity reader',
        status: 'in progress',
        askedOn: '2026-07-01',
        dueOn: '2026-08-01',
        checks: [],
      },
    },
    createdAt: new Date('2026-07-01T10:00:00Z'),
    updatedAt: new Date('2026-07-20T10:00:00Z'),
    ...overrides,
  };
}

function makePitch(overrides: Partial<MagazinePitch> = {}): MagazinePitch {
  return {
    id: 'pitch-1',
    title: 'The last kiosk in Anjos',
    from: 'sara@example.com',
    note: 'A piece about the last kiosk.',
    tags: [],
    suggestFormat: 'article',
    status: 'waiting',
    fresh: false,
    issueId: null,
    passTemplate: null,
    passNote: null,
    submitterId: 'writer-1',
    storySubmissionId: null,
    createdAt: new Date('2026-07-12T09:00:00Z'),
    ...overrides,
  };
}

function makePayment(
  overrides: Partial<MagazinePayment> = {},
): MagazinePayment {
  return {
    id: 'payment-1',
    pieceId: 'piece-1',
    currency: 'EUR',
    feeAmount: '420.00',
    feeText: null,
    expensesAmount: null,
    expensesText: null,
    invoice: null,
    filedOn: null,
    terms: '21 days',
    dueOn: '2026-08-19',
    status: 'approved_unpaid',
    paidOn: null,
    createdAt: new Date('2026-07-02T10:00:00Z'),
    updatedAt: new Date('2026-07-20T10:00:00Z'),
    ...overrides,
  };
}

const WRITER_ASSIGNMENT_KEYS: (keyof WriterAssignmentResponse)[] = [
  'id',
  'title',
  'section',
  'due',
  'state',
  'stage',
  'words',
  'target',
  'fee',
  'pay',
  'note',
  'byline',
  'terms',
  'wants',
  'avoid',
  'rate',
  'commissionedBy',
  'commissionedOn',
];

describe('toWriterAssignment', () => {
  it('never leaks care, audit, subjects, or other internal editor-only data', () => {
    const piece = makePiece();
    const payment = makePayment();

    const result = toWriterAssignment(piece, payment);

    expect(Object.keys(result).sort()).toEqual(
      [...WRITER_ASSIGNMENT_KEYS].sort(),
    );
    expect(result).not.toHaveProperty('care');
    expect(result).not.toHaveProperty('audit');
    expect(result).not.toHaveProperty('subjects');
    expect(result).not.toHaveProperty('editorId');
    expect(result).not.toHaveProperty('writerId');
    expect(JSON.stringify(result)).not.toContain('Internal editor note');
  });

  it('maps id/title/section/due/stage/byline straight through', () => {
    const piece = makePiece();

    const result = toWriterAssignment(piece, null);

    expect(result.id).toBe(piece.id);
    expect(result.title).toBe(piece.title);
    expect(result.section).toBe(piece.section);
    expect(result.due).toBe(piece.dueOn);
    expect(result.stage).toBe(piece.stage);
    expect(result.byline).toBe(piece.byline);
  });

  it.each<[PieceStage, string]>([
    ['commissioned', 'Commissioned'],
    ['drafting', 'Drafting'],
    ['in_review', 'In review'],
    ['edit', 'With your editor'],
    ['sensitivity_read', 'Sensitivity read'],
    ['layout', 'In layout'],
    ['ready', 'Ready'],
  ])('derives state "%s" -> "%s" from stage', (stage, expectedState) => {
    const result = toWriterAssignment(makePiece({ stage }), null);

    expect(result.state).toBe(expectedState);
  });

  it('maps words/target from brief.filedWords/brief.wordCount', () => {
    const result = toWriterAssignment(makePiece(), null);

    expect(result.words).toBe(3140);
    expect(result.target).toBe(2800);
  });

  it('falls back to null words/target and empty note when brief is null', () => {
    const result = toWriterAssignment(makePiece({ brief: null }), null);

    expect(result.words).toBeNull();
    expect(result.target).toBeNull();
    expect(result.note).toBe('');
  });

  it('maps note from brief.angle, never from care', () => {
    const result = toWriterAssignment(makePiece(), null);

    expect(result.note).toBe('Start at the waiting list, not the diagnosis.');
  });

  it('maps fee/pay from the payment when present', () => {
    const result = toWriterAssignment(makePiece(), makePayment());

    expect(result.fee).toBe('€420.00');
    expect(result.pay).toBe('approved_unpaid');
  });

  it('falls back to an empty fee and "agreed" pay when there is no payment yet', () => {
    const result = toWriterAssignment(makePiece(), null);

    expect(result.fee).toBe('');
    expect(result.pay).toBe('agreed');
  });

  it('maps terms.killFee from brief.killFee, with static rights/edits terms', () => {
    const result = toWriterAssignment(makePiece(), null);

    expect(result.terms).toEqual({
      killFee: '20% of the agreed fee',
      rights: 'first publication, you keep the rest',
      edits: 'you see them before they ship',
    });
  });

  it('falls back to an empty killFee when brief is null, without leaking anything else', () => {
    const result = toWriterAssignment(makePiece({ brief: null }), null);

    expect(result.terms.killFee).toBe('');
    expect(JSON.stringify(result.terms)).not.toContain('Internal editor note');
  });
});

describe('toWriterPitch', () => {
  it('maps id/title/sent straight through', () => {
    const pitch = makePitch();

    const result = toWriterPitch(pitch);

    expect(result.id).toBe(pitch.id);
    expect(result.title).toBe(pitch.title);
    expect(result.sent).toBe(pitch.createdAt.toISOString());
  });

  it('tone "hold" and a held-for-consideration state for a maybe pitch', () => {
    const result = toWriterPitch(makePitch({ status: 'maybe' }));

    expect(result.tone).toBe('hold');
    expect(result.state).toBe('Held for consideration');
  });

  it('tone "no" and a state including the passNote for a passed pitch', () => {
    const result = toWriterPitch(
      makePitch({
        status: 'passed',
        passNote: 'Not now, please pitch again in issue 16.',
      }),
    );

    expect(result.tone).toBe('no');
    expect(result.state).toBe(
      'Passed — Not now, please pitch again in issue 16.',
    );
  });

  it('falls back to a plain "Passed" state when there is no passNote', () => {
    const result = toWriterPitch(
      makePitch({ status: 'passed', passNote: null }),
    );

    expect(result.state).toBe('Passed');
  });

  it.each<PitchStatus>(['waiting', 'commissioned'])(
    'tone "live" for status "%s"',
    (status) => {
      const result = toWriterPitch(makePitch({ status }));

      expect(result.tone).toBe('live');
    },
  );
});

describe('toWriterPayment', () => {
  it('maps title/issue/fee from the piece and payment', () => {
    const piece = makePiece();
    const payment = makePayment();

    const result = toWriterPayment(piece, payment);

    expect(result.title).toBe(piece.title);
    expect(result.issue).toBe(piece.issueId);
    expect(result.fee).toBe('€420.00');
  });

  it('reports "Not yet agreed" when there is no payment row', () => {
    const result = toWriterPayment(makePiece(), null);

    expect(result.state).toBe('Not yet agreed');
    expect(result.fee).toBe('');
  });

  it('reports paid state with the paid date', () => {
    const result = toWriterPayment(
      makePiece(),
      makePayment({ status: 'paid', paidOn: '2026-06-14' }),
    );

    expect(result.state).toBe('Paid 2026-06-14');
  });

  it('reports approved-unpaid state with the due date', () => {
    const result = toWriterPayment(
      makePiece(),
      makePayment({ status: 'approved_unpaid', dueOn: '2026-08-19' }),
    );

    expect(result.state).toBe('Approved, unpaid — due 2026-08-19');
  });

  it('reports agreed state with the due date', () => {
    const result = toWriterPayment(
      makePiece(),
      makePayment({ status: 'agreed', dueOn: '2026-08-19' }),
    );

    expect(result.state).toBe('Agreed — due 2026-08-19');
  });
});
