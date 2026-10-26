import {
  dropEmailCodeRequestBody,
  isEmailCodeRequestUrl,
} from './email-code-request-log';

describe('isEmailCodeRequestUrl', () => {
  it('matches every email code route', () => {
    expect(isEmailCodeRequestUrl('/auth/email-code/request')).toBe(true);
    expect(isEmailCodeRequestUrl('/auth/email-code/verify')).toBe(true);
    expect(isEmailCodeRequestUrl('/auth/email-code/reauth/request')).toBe(true);
    expect(
      isEmailCodeRequestUrl(
        'https://api.queerpulse.com/auth/email-code/reauth/verify?x=1',
      ),
    ).toBe(true);
    expect(isEmailCodeRequestUrl('/v1/auth/email-code/verify')).toBe(true);
  });

  it('leaves other routes alone', () => {
    expect(isEmailCodeRequestUrl('/auth/refresh')).toBe(false);
    expect(isEmailCodeRequestUrl('/auth/email-codes')).toBe(false);
    expect(isEmailCodeRequestUrl('/v1/auth/me')).toBe(false);
    expect(isEmailCodeRequestUrl(undefined)).toBe(false);
    expect(isEmailCodeRequestUrl('')).toBe(false);
  });
});

describe('dropEmailCodeRequestBody', () => {
  it('removes the body of an email code route', () => {
    const request = {
      url: '/auth/email-code/verify',
      data: { email: 'a@b.c', code: '123456' },
    };
    dropEmailCodeRequestBody(request);
    expect('data' in request).toBe(false);
  });

  it('keeps the body of every other route', () => {
    const request = { url: '/auth/refresh', data: { token: 'x' } };
    dropEmailCodeRequestBody(request);
    expect(request.data).toEqual({ token: 'x' });
  });

  it('accepts an absent request', () => {
    expect(() => dropEmailCodeRequestBody(undefined)).not.toThrow();
  });
});
