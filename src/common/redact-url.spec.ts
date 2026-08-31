import {
  REDACTED_QUERY_VALUE,
  redactSensitiveQueryParameters,
  redactSensitiveQueryString,
} from './redact-url';

describe('redactSensitiveQueryParameters', () => {
  it('redacts the invite code on the path-only request target Node hands the logger', () => {
    expect(redactSensitiveQueryParameters('/auth/google?invite=abc123')).toBe(
      `/auth/google?invite=${REDACTED_QUERY_VALUE}`,
    );
  });

  it('leaves a URL with no query string untouched', () => {
    expect(redactSensitiveQueryParameters('/auth/google')).toBe('/auth/google');
    expect(redactSensitiveQueryParameters('/events/123')).toBe('/events/123');
  });

  it('leaves an empty query string untouched', () => {
    expect(redactSensitiveQueryParameters('/events?')).toBe('/events?');
  });

  it('keeps non-sensitive parameters readable alongside a redacted one', () => {
    expect(
      redactSensitiveQueryParameters(
        '/auth/google?redirect=/events&invite=abc123&ageAttested=1',
      ),
    ).toBe(
      `/auth/google?redirect=/events&invite=${REDACTED_QUERY_VALUE}&ageAttested=1`,
    );
  });

  it('leaves a query made entirely of non-sensitive parameters byte for byte', () => {
    const url = '/members?page=2&q=drag%20brunch&sort=recent';
    expect(redactSensitiveQueryParameters(url)).toBe(url);
  });

  it('redacts every occurrence of a repeated sensitive parameter', () => {
    expect(
      redactSensitiveQueryParameters('/x?token=one&page=1&token=two'),
    ).toBe(
      `/x?token=${REDACTED_QUERY_VALUE}&page=1&token=${REDACTED_QUERY_VALUE}`,
    );
  });

  it('redacts more than one distinct sensitive parameter in the same query', () => {
    expect(
      redactSensitiveQueryParameters(
        '/auth/google/callback?state=eyJpbnZpdGUiOiJhYmMifQ&code=4/0Aeaa&scope=email+profile',
      ),
    ).toBe(
      `/auth/google/callback?state=${REDACTED_QUERY_VALUE}&code=${REDACTED_QUERY_VALUE}&scope=email+profile`,
    );
  });

  it('matches parameter names case-insensitively', () => {
    expect(redactSensitiveQueryParameters('/x?Invite=abc')).toBe(
      `/x?Invite=${REDACTED_QUERY_VALUE}`,
    );
    expect(redactSensitiveQueryParameters('/x?TOKEN=abc')).toBe(
      `/x?TOKEN=${REDACTED_QUERY_VALUE}`,
    );
    expect(
      redactSensitiveQueryParameters('/upload?X-Amz-Signature=deadbeef'),
    ).toBe(`/upload?X-Amz-Signature=${REDACTED_QUERY_VALUE}`);
  });

  it('preserves the parameter name spelling it was given', () => {
    expect(redactSensitiveQueryParameters('/x?ToKeN=abc')).toBe(
      `/x?ToKeN=${REDACTED_QUERY_VALUE}`,
    );
  });

  it('redacts an absolute URL as readily as a path-only one', () => {
    expect(
      redactSensitiveQueryParameters(
        'https://api.queerpulse.example/auth/google?invite=abc&redirect=/x',
      ),
    ).toBe(
      `https://api.queerpulse.example/auth/google?invite=${REDACTED_QUERY_VALUE}&redirect=/x`,
    );
  });

  it('gives a valueless sensitive parameter the placeholder too', () => {
    expect(redactSensitiveQueryParameters('/x?token&page=1')).toBe(
      `/x?token=${REDACTED_QUERY_VALUE}&page=1`,
    );
  });

  it('redacts an empty sensitive value so the shape of the log line stays uniform', () => {
    expect(redactSensitiveQueryParameters('/x?invite=')).toBe(
      `/x?invite=${REDACTED_QUERY_VALUE}`,
    );
  });

  it('does not let a value containing "=" survive past the first separator', () => {
    expect(redactSensitiveQueryParameters('/x?state=aa=bb=cc')).toBe(
      `/x?state=${REDACTED_QUERY_VALUE}`,
    );
  });

  it('keeps a fragment out of the last parameter value', () => {
    expect(
      redactSensitiveQueryParameters('https://x.example/p?token=abc#section'),
    ).toBe(`https://x.example/p?token=${REDACTED_QUERY_VALUE}#section`);
  });

  it('does not throw on a malformed percent escape in a parameter name', () => {
    expect(redactSensitiveQueryParameters('/x?%zz=1&invite=abc')).toBe(
      `/x?%zz=1&invite=${REDACTED_QUERY_VALUE}`,
    );
  });

  it('matches a percent-encoded sensitive parameter name', () => {
    expect(redactSensitiveQueryParameters('/x?inv%69te=abc')).toBe(
      `/x?inv%69te=${REDACTED_QUERY_VALUE}`,
    );
  });

  it('passes an undefined request target through', () => {
    expect(redactSensitiveQueryParameters(undefined)).toBeUndefined();
  });
});

describe('redactSensitiveQueryString', () => {
  it('redacts a bare query string with no leading question mark', () => {
    expect(redactSensitiveQueryString('invite=abc&page=2')).toBe(
      `invite=${REDACTED_QUERY_VALUE}&page=2`,
    );
  });

  it('returns an empty query string unchanged', () => {
    expect(redactSensitiveQueryString('')).toBe('');
  });
});
