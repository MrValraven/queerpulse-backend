import { decodeOAuthState, encodeOAuthState } from './oauth-state';

describe('oauth-state codec', () => {
  describe('encodeOAuthState', () => {
    it('returns undefined when there is nothing to carry', () => {
      expect(encodeOAuthState({})).toBeUndefined();
      expect(encodeOAuthState({ invite: '', redirect: '' })).toBeUndefined();
    });

    it('round-trips an invite-only payload', () => {
      const encoded = encodeOAuthState({ invite: 'CODE123' });
      expect(typeof encoded).toBe('string');
      expect(decodeOAuthState(encoded)).toEqual({ invite: 'CODE123' });
    });

    it('round-trips a redirect-only payload', () => {
      const encoded = encodeOAuthState({ redirect: '/feed' });
      expect(decodeOAuthState(encoded)).toEqual({ redirect: '/feed' });
    });

    it('round-trips both invite and redirect', () => {
      const encoded = encodeOAuthState({ invite: 'CODE', redirect: '/auth/welcome' });
      expect(decodeOAuthState(encoded)).toEqual({
        invite: 'CODE',
        redirect: '/auth/welcome',
      });
    });

    it('produces a single opaque token (no raw path leakage)', () => {
      const encoded = encodeOAuthState({ redirect: '/feed' })!;
      expect(encoded).not.toContain('/');
      expect(encoded).not.toContain('=');
    });
  });

  describe('decodeOAuthState', () => {
    it('returns an empty object for absent state', () => {
      expect(decodeOAuthState(undefined)).toEqual({});
      expect(decodeOAuthState(null)).toEqual({});
      expect(decodeOAuthState('')).toEqual({});
    });

    it('treats a legacy bare invite code as { invite }', () => {
      // Pre-existing behavior: `state` used to be the raw invite string.
      expect(decodeOAuthState('GOODCODE')).toEqual({ invite: 'GOODCODE' });
      expect(decodeOAuthState('EXPIRED')).toEqual({ invite: 'EXPIRED' });
    });

    it('ignores non-string fields in a decoded payload', () => {
      const encoded = Buffer.from(
        JSON.stringify({ invite: 123, redirect: ['/feed'] }),
        'utf8',
      ).toString('base64url');
      expect(decodeOAuthState(encoded)).toEqual({});
    });
  });
});
