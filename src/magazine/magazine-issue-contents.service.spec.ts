import { NotFoundException } from '@nestjs/common';
import { MagazineIssueContentsService } from './magazine-issue-contents.service';

const NEXT_WEEK = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
const LAST_WEEK = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

function build() {
  const issues = { findOne: jest.fn() };
  const pieces = { find: jest.fn().mockResolvedValue([]) };
  const articles = { find: jest.fn().mockResolvedValue([]) };
  const decks = { find: jest.fn().mockResolvedValue([]) };
  const service = new MagazineIssueContentsService(
    issues as never,
    pieces as never,
    articles as never,
    decks as never,
  );
  return { service, issues, pieces, articles, decks };
}

function shippedIssue(
  digest: { pieceId: string; blurb: string; on: boolean }[],
) {
  return {
    id: 'issue-1',
    number: '26',
    title: 'Neighbours',
    publishedOn: '2026-01-01',
    digest,
  };
}

describe('MagazineIssueContentsService.getContents', () => {
  it('404s on an issue that has not shipped', async () => {
    const { service, issues } = build();
    issues.findOne.mockResolvedValueOnce(null);
    await expect(service.getContents('99')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('lists a curated entry whose article is already published', async () => {
    const { service, issues, pieces, articles } = build();
    issues.findOne.mockResolvedValueOnce(
      shippedIssue([{ pieceId: 'piece-1', blurb: 'A blurb', on: true }]),
    );
    pieces.find.mockResolvedValueOnce([
      {
        id: 'piece-1',
        section: 'Features',
        articleId: 'article-1',
        deckId: null,
      },
    ]);
    articles.find.mockResolvedValueOnce([
      {
        id: 'article-1',
        slug: 'city-changed',
        title: 'The city changed',
        publishedAt: LAST_WEEK,
      },
    ]);

    const contents = await service.getContents('26');

    expect(contents.entries).toEqual([
      {
        title: 'The city changed',
        blurb: 'A blurb',
        section: 'Features',
        kind: 'article',
        slug: 'city-changed',
      },
    ]);
  });

  // ENG-100 — the leak: a future-dated article inside a shipped issue printed
  // its unshipped headline here, and the link 404'd on the article read.
  it('drops an article scheduled for a later date', async () => {
    const { service, issues, pieces, articles } = build();
    issues.findOne.mockResolvedValueOnce(
      shippedIssue([{ pieceId: 'piece-1', blurb: 'A blurb', on: true }]),
    );
    pieces.find.mockResolvedValueOnce([
      {
        id: 'piece-1',
        section: 'Features',
        articleId: 'article-1',
        deckId: null,
      },
    ]);
    articles.find.mockResolvedValueOnce([
      {
        id: 'article-1',
        slug: 'next-week',
        title: 'Not out yet',
        publishedAt: NEXT_WEEK,
      },
    ]);

    const contents = await service.getContents('26');

    expect(contents.entries).toEqual([]);
  });

  it('drops a deck scheduled for a later date', async () => {
    const { service, issues, pieces, decks } = build();
    issues.findOne.mockResolvedValueOnce(
      shippedIssue([{ pieceId: 'piece-2', blurb: 'A blurb', on: true }]),
    );
    pieces.find.mockResolvedValueOnce([
      {
        id: 'piece-2',
        section: 'Features',
        articleId: null,
        deckId: 'deck-1',
      },
    ]);
    decks.find.mockResolvedValueOnce([
      {
        id: 'deck-1',
        slug: 'next-week-deck',
        title: 'Not out yet',
        publishedAt: NEXT_WEEK,
      },
    ]);

    const contents = await service.getContents('26');

    expect(contents.entries).toEqual([]);
  });

  it('lists a deck that is already published', async () => {
    const { service, issues, pieces, decks } = build();
    issues.findOne.mockResolvedValueOnce(
      shippedIssue([{ pieceId: 'piece-2', blurb: 'A blurb', on: true }]),
    );
    pieces.find.mockResolvedValueOnce([
      {
        id: 'piece-2',
        section: 'Last word',
        articleId: null,
        deckId: 'deck-1',
      },
    ]);
    decks.find.mockResolvedValueOnce([
      {
        id: 'deck-1',
        slug: 'ten-places',
        title: 'Ten places',
        publishedAt: LAST_WEEK,
      },
    ]);

    const contents = await service.getContents('26');

    expect(contents.entries).toEqual([
      {
        title: 'Ten places',
        blurb: 'A blurb',
        section: 'Last word',
        kind: 'deck',
        slug: 'ten-places',
      },
    ]);
  });

  it('drops an unpublished article', async () => {
    const { service, issues, pieces, articles } = build();
    issues.findOne.mockResolvedValueOnce(
      shippedIssue([{ pieceId: 'piece-1', blurb: 'A blurb', on: true }]),
    );
    pieces.find.mockResolvedValueOnce([
      {
        id: 'piece-1',
        section: 'Features',
        articleId: 'article-1',
        deckId: null,
      },
    ]);
    articles.find.mockResolvedValueOnce([
      {
        id: 'article-1',
        slug: 'draft',
        title: 'Still a draft',
        publishedAt: null,
      },
    ]);

    const contents = await service.getContents('26');

    expect(contents.entries).toEqual([]);
  });
});
