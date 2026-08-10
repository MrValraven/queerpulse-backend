import { MagazineArticleVersion } from './entities/magazine-article-version.entity';
import {
  toArticleVersionDetail,
  toArticleVersionSummary,
  UNRESOLVED_VERSION_AUTHOR_LABEL,
} from './magazine-article-version-response';

function makeVersion(
  overrides: Partial<MagazineArticleVersion> = {},
): MagazineArticleVersion {
  return {
    id: 'version-1',
    articleId: 'article-1',
    label: 'Manual save',
    authorId: 'user-1',
    blocks: [{ id: 'b1', kind: 'paragraph', html: 'Hello.' }],
    createdAt: new Date('2026-08-10T09:00:00Z'),
    ...overrides,
  };
}

describe('toArticleVersionSummary', () => {
  it('omits blocks entirely from the summary shape', () => {
    const version = makeVersion();

    const summary = toArticleVersionSummary(
      version,
      new Map([['user-1', 'Ana Silva']]),
    );

    expect(summary).toEqual({
      id: 'version-1',
      label: 'Manual save',
      author: 'Ana Silva',
      createdAt: '2026-08-10T09:00:00.000Z',
    });
    expect(summary).not.toHaveProperty('blocks');
  });

  it("resolves the author's name from the passed map, never the raw id or an email", () => {
    const version = makeVersion({ authorId: 'user-42' });

    const summary = toArticleVersionSummary(
      version,
      new Map([['user-42', 'Kai Duarte']]),
    );

    expect(summary.author).toBe('Kai Duarte');
    expect(summary.author).not.toContain('user-42');
    expect(summary.author).not.toContain('@');
  });

  it('falls back to a neutral label when the author id is missing from the map', () => {
    const version = makeVersion({ authorId: 'ghost-1' });

    const summary = toArticleVersionSummary(version, new Map());

    expect(summary.author).toBe(UNRESOLVED_VERSION_AUTHOR_LABEL);
    expect(summary.author).not.toContain('ghost-1');
  });

  it('falls back to a neutral label for a system/auto-snapshot with no authorId', () => {
    const version = makeVersion({ authorId: null });

    const summary = toArticleVersionSummary(version, new Map());

    expect(summary.author).toBe(UNRESOLVED_VERSION_AUTHOR_LABEL);
  });
});

describe('toArticleVersionDetail', () => {
  it('includes the full blocks snapshot alongside the resolved author', () => {
    const version = makeVersion();

    const detail = toArticleVersionDetail(
      version,
      new Map([['user-1', 'Ana Silva']]),
    );

    expect(detail).toEqual({
      id: 'version-1',
      label: 'Manual save',
      author: 'Ana Silva',
      createdAt: '2026-08-10T09:00:00.000Z',
      blocks: [{ id: 'b1', kind: 'paragraph', html: 'Hello.' }],
    });
  });

  it('never leaks a raw author id or email in place of the resolved name', () => {
    const version = makeVersion({ authorId: 'user-42' });

    const detail = toArticleVersionDetail(
      version,
      new Map([['user-42', 'Kai Duarte']]),
    );

    expect(detail.author).toBe('Kai Duarte');
    expect(detail.author).not.toContain('user-42');
    expect(detail.author).not.toContain('@');
  });
});
