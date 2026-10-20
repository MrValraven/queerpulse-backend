import type { EntityManager } from 'typeorm';
import * as launchedFeatures from '../launchedFeatures';
import {
  EARLY_ACCESS_KEYS_FOR_USER_SQL,
  USERS_WITH_EARLY_ACCESS_SQL,
  VIEWER_HAS_EARLY_ACCESS_SQL,
  canViewerUseFeature,
  earlyAccessFeaturesForUser,
  usersWithFeatureAccess,
} from './early-access-reads';

function buildFakeManager(rows: unknown[]) {
  const query = jest.fn().mockResolvedValue(rows);
  return { manager: { query } as unknown as EntityManager, query };
}

function stubRegistry(options: {
  isLaunched: boolean;
  isEarlyAccess: boolean;
}): void {
  jest
    .spyOn(launchedFeatures, 'isFeatureLaunched')
    .mockReturnValue(options.isLaunched);
  jest
    .spyOn(launchedFeatures, 'isEarlyAccessFeature')
    .mockReturnValue(options.isEarlyAccess);
}

describe('early access reads', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('canViewerUseFeature', () => {
    it('lets everyone in once the feature is launched, with no query', async () => {
      stubRegistry({ isLaunched: true, isEarlyAccess: true });
      const { manager, query } = buildFakeManager([{ exists: false }]);
      await expect(
        canViewerUseFeature(manager, 'quizshow', null),
      ).resolves.toBe(true);
      expect(query).not.toHaveBeenCalled();
    });

    it('keeps an unlaunched feature without early access closed, with no query', async () => {
      stubRegistry({ isLaunched: false, isEarlyAccess: false });
      const { manager, query } = buildFakeManager([{ exists: true }]);
      await expect(
        canViewerUseFeature(manager, 'cinema', 'viewer-1'),
      ).resolves.toBe(false);
      expect(query).not.toHaveBeenCalled();
    });

    it('keeps an anonymous viewer out of an early-access feature, with no query', async () => {
      stubRegistry({ isLaunched: false, isEarlyAccess: true });
      const { manager, query } = buildFakeManager([{ exists: true }]);
      await expect(
        canViewerUseFeature(manager, 'quizshow', null),
      ).resolves.toBe(false);
      expect(query).not.toHaveBeenCalled();
    });

    it('asks for the grant by viewer and feature key', async () => {
      stubRegistry({ isLaunched: false, isEarlyAccess: true });
      const { manager, query } = buildFakeManager([{ exists: true }]);
      await expect(
        canViewerUseFeature(manager, 'quizshow', 'viewer-1'),
      ).resolves.toBe(true);
      expect(query).toHaveBeenCalledWith(VIEWER_HAS_EARLY_ACCESS_SQL, [
        'viewer-1',
        'quizshow',
      ]);
    });

    it('answers false when the viewer holds no grant', async () => {
      stubRegistry({ isLaunched: false, isEarlyAccess: true });
      const { manager } = buildFakeManager([{ exists: false }]);
      await expect(
        canViewerUseFeature(manager, 'quizshow', 'viewer-1'),
      ).resolves.toBe(false);
    });
  });

  describe('usersWithFeatureAccess', () => {
    it('returns every member once the feature is launched, with no query', async () => {
      stubRegistry({ isLaunched: true, isEarlyAccess: true });
      const { manager, query } = buildFakeManager([]);
      await expect(
        usersWithFeatureAccess(manager, 'quizshow', ['user-1', 'user-2']),
      ).resolves.toEqual(['user-1', 'user-2']);
      expect(query).not.toHaveBeenCalled();
    });

    it('returns nobody for an unlaunched feature without early access', async () => {
      stubRegistry({ isLaunched: false, isEarlyAccess: false });
      const { manager, query } = buildFakeManager([{ user_id: 'user-1' }]);
      await expect(
        usersWithFeatureAccess(manager, 'cinema', ['user-1']),
      ).resolves.toEqual([]);
      expect(query).not.toHaveBeenCalled();
    });

    it('runs no query for an empty list', async () => {
      stubRegistry({ isLaunched: false, isEarlyAccess: true });
      const { manager, query } = buildFakeManager([]);
      await expect(
        usersWithFeatureAccess(manager, 'quizshow', []),
      ).resolves.toEqual([]);
      expect(query).not.toHaveBeenCalled();
    });

    it('keeps the grant holders in input order', async () => {
      stubRegistry({ isLaunched: false, isEarlyAccess: true });
      const { manager, query } = buildFakeManager([
        { user_id: 'user-3' },
        { user_id: 'user-1' },
      ]);
      await expect(
        usersWithFeatureAccess(manager, 'quizshow', [
          'user-1',
          'user-2',
          'user-3',
        ]),
      ).resolves.toEqual(['user-1', 'user-3']);
      expect(query).toHaveBeenCalledWith(USERS_WITH_EARLY_ACCESS_SQL, [
        ['user-1', 'user-2', 'user-3'],
        'quizshow',
      ]);
    });
  });

  describe('earlyAccessFeaturesForUser', () => {
    it('lists granted early-access keys in registry order and skips the rest', async () => {
      jest
        .spyOn(launchedFeatures, 'isEarlyAccessFeature')
        .mockImplementation(
          (featureKey) => featureKey === 'studio' || featureKey === 'quizshow',
        );
      const { manager, query } = buildFakeManager([
        { feature_key: 'quizshow' },
        { feature_key: 'retired-feature' },
        { feature_key: 'cinema' },
        { feature_key: 'studio' },
      ]);
      await expect(
        earlyAccessFeaturesForUser(manager, 'user-1'),
      ).resolves.toEqual(['studio', 'quizshow']);
      expect(query).toHaveBeenCalledWith(EARLY_ACCESS_KEYS_FOR_USER_SQL, [
        'user-1',
      ]);
    });

    it('returns an empty list for a member with no grants', async () => {
      const { manager } = buildFakeManager([]);
      await expect(
        earlyAccessFeaturesForUser(manager, 'user-1'),
      ).resolves.toEqual([]);
    });
  });
});
