import { resolvePostLoginRedirect, safeRedirectPath } from './safe-redirect';

describe('safeRedirectPath', () => {
  it('accepts simple internal paths', () => {
    expect(safeRedirectPath('/feed')).toBe('/feed');
    expect(safeRedirectPath('/auth/welcome')).toBe('/auth/welcome');
    expect(safeRedirectPath('/events/123?tab=going')).toBe(
      '/events/123?tab=going',
    );
    expect(safeRedirectPath('/')).toBe('/');
  });

  it('rejects absent or non-string values', () => {
    expect(safeRedirectPath(undefined)).toBeNull();
    expect(safeRedirectPath(null)).toBeNull();
    expect(safeRedirectPath('')).toBeNull();
    expect(safeRedirectPath(42)).toBeNull();
    expect(safeRedirectPath({})).toBeNull();
  });

  it('rejects absolute URLs with a scheme', () => {
    expect(safeRedirectPath('https://evil.com')).toBeNull();
    expect(safeRedirectPath('http://evil.com/feed')).toBeNull();
    expect(safeRedirectPath('javascript:alert(1)')).toBeNull();
    expect(safeRedirectPath('data:text/html,<script>')).toBeNull();
  });

  it('rejects protocol-relative and backslash tricks', () => {
    expect(safeRedirectPath('//evil.com')).toBeNull();
    expect(safeRedirectPath('/\\evil.com')).toBeNull();
    expect(safeRedirectPath('/\\/evil.com')).toBeNull();
    expect(safeRedirectPath('/foo\\bar')).toBeNull();
  });

  it('rejects values that do not start with a single slash', () => {
    expect(safeRedirectPath('feed')).toBeNull();
    expect(safeRedirectPath('  /feed')).toBeNull();
  });

  it('rejects embedded schemes and control characters', () => {
    expect(safeRedirectPath('/redirect/https://evil.com')).toBeNull();
    expect(safeRedirectPath('/feed\nSet-Cookie: x=y')).toBeNull();
    expect(safeRedirectPath('/feed\tx')).toBeNull();
  });
});

describe('resolvePostLoginRedirect', () => {
  const FRONTEND = 'http://localhost:5173';

  it('appends a safe path to the frontend origin', () => {
    expect(resolvePostLoginRedirect('/feed', FRONTEND)).toBe(
      'http://localhost:5173/feed',
    );
  });

  it('falls back to the default landing page when redirect is absent', () => {
    expect(resolvePostLoginRedirect(undefined, FRONTEND)).toBe(FRONTEND);
  });

  it('falls back to the default landing page for an open-redirect attempt', () => {
    expect(resolvePostLoginRedirect('https://evil.com', FRONTEND)).toBe(
      FRONTEND,
    );
    expect(resolvePostLoginRedirect('//evil.com', FRONTEND)).toBe(FRONTEND);
  });

  it('never emits a cross-origin URL', () => {
    const out = resolvePostLoginRedirect('/feed', FRONTEND);
    expect(new URL(out).origin).toBe(new URL(FRONTEND).origin);
  });
});
