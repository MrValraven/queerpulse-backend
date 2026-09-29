import { BadRequestException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { In } from 'typeorm';
import { EventMatchEntry } from './entities/event-match-entry.entity';
import { FriendMatchProfile } from './entities/friend-match-profile.entity';
import { GoTogetherProfileService } from './go-together-profile.service';
import { QUESTIONNAIRE_VERSION } from './go-together-questionnaire.catalog';

const validAnswers = {
  values: {
    community: 4,
    creativity: 4,
    family: 3,
    fun: 5,
    career: 2,
    spirituality: 1,
  },
  humour: { h1: 'a', h2: 'b', h3: 'a', h4: 'b' },
  interests: ['boardGames'],
  music: ['fado'],
  energy: { talker: 3, nightShape: 2, planner: 4 },
  intent: 'both',
  meetFrequency: 'monthly',
  languages: ['pt'],
  drinking: 'eitherWay',
  ageBracket: '25-34',
  agePreference: 'any',
  area: null,
};

describe('GoTogetherProfileService', () => {
  let service: GoTogetherProfileService;
  let profiles: {
    findOne: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
    delete: jest.Mock;
    update: jest.Mock;
  };
  let entries: { find: jest.Mock; update: jest.Mock };

  beforeEach(async () => {
    profiles = {
      findOne: jest.fn().mockResolvedValue(null),
      create: jest.fn((row: Partial<FriendMatchProfile>) => ({ ...row })),
      save: jest.fn((row: FriendMatchProfile) =>
        Promise.resolve({
          ...row,
          updatedAt: new Date('2026-09-28T10:00:00Z'),
        }),
      ),
      delete: jest.fn().mockResolvedValue({ affected: 1 }),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    entries = {
      find: jest.fn().mockResolvedValue([]),
      update: jest.fn().mockResolvedValue({ affected: 0 }),
    };
    const moduleRef = await Test.createTestingModule({
      providers: [
        GoTogetherProfileService,
        { provide: getRepositoryToken(FriendMatchProfile), useValue: profiles },
        { provide: getRepositoryToken(EventMatchEntry), useValue: entries },
      ],
    }).compile();
    service = moduleRef.get(GoTogetherProfileService);
  });

  it('refuses to save without explicit consent', async () => {
    await expect(
      service.upsertMine('user-1', { answers: validAnswers, consent: false }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(profiles.save).not.toHaveBeenCalled();
  });

  it('returns every validation error at once', async () => {
    await expect(
      service.upsertMine('user-1', {
        answers: { ...validAnswers, intent: 'x', languages: [] },
        consent: true,
      }),
    ).rejects.toMatchObject({
      response: {
        code: 'GO_TOGETHER_INVALID_ANSWERS',
        errors: expect.arrayContaining(['intent is invalid']),
      },
    });
  });

  it('records consent on first save and keeps it on later saves', async () => {
    const created = await service.upsertMine('user-1', {
      answers: validAnswers,
      consent: true,
    });
    expect(created.consentedAt).not.toBeNull();
    expect(created.questionnaireVersion).toBe(QUESTIONNAIRE_VERSION);

    const originalConsent = new Date('2026-01-01T00:00:00Z');
    profiles.findOne.mockResolvedValueOnce({
      userId: 'user-1',
      consentedAt: originalConsent,
      answers: validAnswers,
      questionnaireVersion: 1,
    });
    const updated = await service.upsertMine('user-1', {
      answers: validAnswers,
      consent: true,
    });
    expect(updated.consentedAt).toBe(originalConsent.toISOString());
  });

  it('withdraws waiting and unmatched entries with their lens, frees pair partners and deletes the answers on delete', async () => {
    entries.find.mockResolvedValueOnce([
      {
        id: 'entry-1',
        eventId: 'event-1',
        userId: 'user-1',
        status: 'waiting',
        pairStatus: 'accepted',
        pairPartnerId: 'user-2',
        lens: 'queerPoc',
      },
      {
        id: 'entry-2',
        eventId: 'event-2',
        userId: 'user-1',
        status: 'unmatched',
        pairStatus: 'none',
        pairPartnerId: null,
        lens: 'queerPoc',
      },
    ]);
    await service.deleteMine('user-1');
    expect(entries.find).toHaveBeenCalledWith({
      where: { userId: 'user-1', status: In(['waiting', 'unmatched']) },
    });
    expect(entries.update).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: 'event-1', userId: 'user-2' }),
      { pairStatus: 'none', pairPartnerId: null },
    );
    expect(entries.update).toHaveBeenCalledWith(
      {
        userId: 'user-1',
        id: In(['entry-1', 'entry-2']),
        status: In(['waiting', 'unmatched']),
      },
      {
        status: 'withdrawn',
        pairStatus: 'none',
        pairPartnerId: null,
        mergeOfferGroupId: null,
        lens: null,
        lensConsentedAt: null,
      },
    );
    expect(profiles.delete).toHaveBeenCalledWith({ userId: 'user-1' });
  });

  it('stamps the last use without moving the last-edit time', async () => {
    await service.touchUsed('user-1');
    const [criteria, patch] = profiles.update.mock.calls[0] as [
      unknown,
      { lastUsedAt: Date; updatedAt: () => string },
    ];
    expect(criteria).toEqual({ userId: 'user-1' });
    expect(patch.lastUsedAt).toBeInstanceOf(Date);
    expect(patch.updatedAt()).toBe('"updated_at"');
  });

  it('suggests a refresh six months after the last edit', async () => {
    profiles.findOne.mockResolvedValueOnce({
      userId: 'user-1',
      answers: validAnswers,
      questionnaireVersion: QUESTIONNAIRE_VERSION,
      consentedAt: new Date('2025-01-01T00:00:00Z'),
      updatedAt: new Date('2025-01-01T00:00:00Z'),
    });
    const response = await service.getMine('user-1');
    expect(response.refreshSuggested).toBe(true);
    expect(response.needsRefresh).toBe(false);
  });
});
