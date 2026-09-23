import { IdentityKind } from '../identities/entities/identity.entity';
import { buildAuthorSummary } from './author-summary';

describe('buildAuthorSummary', () => {
  it('shows the business as the author and hides the human by default', () => {
    const summary = buildAuthorSummary({
      identity: { id: 'identity-1', kind: IdentityKind.Listing },
      identityDisplayName: 'Cafe Lisboa',
      identityHandle: 'cafe-lisboa',
      identityAvatarUrl: 'https://example.test/cafe.png',
      staffFirstName: null,
    });
    expect(summary.displayName).toBe('Cafe Lisboa');
    expect(summary.handle).toBe('cafe-lisboa');
    expect(summary.staffFirstName).toBeUndefined();
  });

  it('carries the staff first name when attribution allows it', () => {
    const summary = buildAuthorSummary({
      identity: { id: 'identity-1', kind: IdentityKind.Listing },
      identityDisplayName: 'Cafe Lisboa',
      identityHandle: 'cafe-lisboa',
      identityAvatarUrl: null,
      staffFirstName: 'Tiago',
    });
    expect(summary.displayName).toBe('Cafe Lisboa');
    expect(summary.staffFirstName).toBe('Tiago');
  });

  it('never leaks the staff member into the handle', () => {
    const summary = buildAuthorSummary({
      identity: { id: 'identity-1', kind: IdentityKind.Listing },
      identityDisplayName: 'Cafe Lisboa',
      identityHandle: 'cafe-lisboa',
      identityAvatarUrl: null,
      staffFirstName: 'Tiago',
    });
    expect(summary.handle).toBe('cafe-lisboa');
  });
});
