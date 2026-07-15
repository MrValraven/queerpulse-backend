import { BadRequestException } from '@nestjs/common';
import { SavedKind } from './entities/saved-item.entity';
import { parseSavedRef, toSavedId } from './saved-ref.util';

describe('saved-ref.util', () => {
  describe('parseSavedRef', () => {
    it('splits a well-formed composite id on the first colon', () => {
      expect(parseSavedRef('article:my-slug')).toEqual({
        subjectType: SavedKind.Article,
        subjectId: 'my-slug',
      });
    });

    it('only splits on the FIRST colon — a slug may contain further colons', () => {
      expect(parseSavedRef('event:2026-07-15:evening')).toEqual({
        subjectType: SavedKind.Event,
        subjectId: '2026-07-15:evening',
      });
    });

    it('rejects an id with no colon', () => {
      expect(() => parseSavedRef('article')).toThrow(BadRequestException);
    });

    it('rejects an id with an empty subjectId', () => {
      expect(() => parseSavedRef('article:')).toThrow(BadRequestException);
    });

    it('rejects an id with an empty kind prefix', () => {
      expect(() => parseSavedRef(':some-slug')).toThrow(BadRequestException);
    });

    it('rejects an unknown kind', () => {
      expect(() => parseSavedRef('recipe:banana-bread')).toThrow(
        BadRequestException,
      );
    });
  });

  describe('toSavedId', () => {
    it('reconstructs the composite id from a subject', () => {
      expect(toSavedId(SavedKind.Job, 'senior-eng')).toBe('job:senior-eng');
    });
  });
});
