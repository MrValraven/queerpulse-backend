import { computeBatchFlags, isDisposableEmail } from './join-request-flags';

describe('isDisposableEmail', () => {
  it('flags a known disposable domain', () => {
    expect(isDisposableEmail('foo@mailinator.com')).toBe(true);
  });

  it('is case-insensitive on the domain', () => {
    expect(isDisposableEmail('foo@MAILINATOR.COM')).toBe(true);
  });

  it('does not flag a real-looking domain', () => {
    expect(isDisposableEmail('sam@example.com')).toBe(false);
  });

  it('does not flag a malformed address', () => {
    expect(isDisposableEmail('not-an-email')).toBe(false);
  });
});

describe('computeBatchFlags', () => {
  const row = (
    overrides: Partial<{
      id: string;
      email: string;
      message: string;
      source: string | null;
      createdAt: Date;
    }> = {},
  ) => ({
    id: 'r1',
    email: 'sam@example.com',
    message: 'let me in',
    source: null,
    createdAt: new Date(),
    ...overrides,
  });

  it('flags duplicate messages shared by more than one request in the batch', () => {
    const batch = [
      row({ id: 'a', message: 'Please let me in!' }),
      row({ id: 'b', message: '  please   let me in!  ' }),
      row({ id: 'c', message: 'A totally different message' }),
    ];
    const flags = computeBatchFlags(batch);
    expect(flags.get('a')).toContain('duplicate_message');
    expect(flags.get('b')).toContain('duplicate_message');
    expect(flags.get('c')).not.toContain('duplicate_message');
  });

  it('flags a source burst once the recent-window threshold is exceeded', () => {
    const now = new Date();
    const batch = Array.from({ length: 6 }, (_, index) =>
      row({ id: `s${index}`, source: 'homepage_hero', createdAt: now }),
    );
    const flags = computeBatchFlags(batch);
    expect(flags.get('s5')).toContain('source_burst');
  });

  it('does not flag a source burst outside the recent window', () => {
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    const batch = Array.from({ length: 6 }, (_, index) =>
      row({ id: `s${index}`, source: 'homepage_hero', createdAt: old }),
    );
    const flags = computeBatchFlags(batch);
    for (const request of batch) {
      expect(flags.get(request.id)).not.toContain('source_burst');
    }
  });

  it('flags a disposable email', () => {
    const batch = [row({ id: 'd', email: 'x@guerrillamail.com' })];
    const flags = computeBatchFlags(batch);
    expect(flags.get('d')).toContain('disposable_email');
  });
});
