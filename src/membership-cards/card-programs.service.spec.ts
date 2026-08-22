import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { CardProgramsService } from './card-programs.service';
import { CardSkin, CommunityCard } from './entities/community-card.entity';

const dto = {
  isEnabled: true,
  skin: CardSkin.Jade,
  accentToken: 'jade',
  cardName: 'Sócie',
  validityMonths: 12,
  allowsPublicBadge: true,
};

function makeService(overrides: Record<string, unknown> = {}) {
  const programs = {
    findOne: jest.fn().mockResolvedValue(null),
    create: jest.fn((row: Partial<CommunityCard>) => row),
    save: jest.fn((row: Partial<CommunityCard>) =>
      Promise.resolve({ id: 'prog-1', ...row }),
    ),
  };
  const communities = {
    findOne: jest.fn().mockResolvedValue({
      id: 'com-1',
      slug: 'azores-queer',
      name: 'Azores Queer',
      archivedAt: null,
    }),
  };
  const membership = {
    assertOwnerOrModBySlug: jest.fn().mockResolvedValue('com-1'),
  };
  const serials = { prefixFor: jest.fn().mockReturnValue('AQ') };
  const governance = { log: jest.fn().mockResolvedValue(undefined) };
  const service = new CardProgramsService(
    programs as never,
    communities as never,
    membership as never,
    serials as never,
    governance as never,
  );
  Object.assign(service, overrides);
  return { service, programs, communities, membership, serials, governance };
}

describe('CardProgramsService.upsert', () => {
  it('creates a programme and freezes its serial prefix from the name', async () => {
    const { service, programs, serials } = makeService();
    const saved = await service.upsert('azores-queer', 'user-1', dto);
    expect(serials.prefixFor).toHaveBeenCalledWith('Azores Queer');
    expect(programs.save).toHaveBeenCalled();
    expect(saved.serialPrefix).toBe('AQ');
  });

  it('does not re-derive the prefix when updating an existing programme', async () => {
    const { service, programs, serials } = makeService();
    programs.findOne.mockResolvedValue({
      id: 'prog-1',
      serialPrefix: 'OLD',
    });
    const saved = await service.upsert('azores-queer', 'user-1', dto);
    expect(serials.prefixFor).not.toHaveBeenCalled();
    expect(saved.serialPrefix).toBe('OLD');
  });

  it('rejects a caller who is not an owner or mod', async () => {
    const { service, membership } = makeService();
    membership.assertOwnerOrModBySlug.mockRejectedValue(
      new ForbiddenException(),
    );
    await expect(service.upsert('azores-queer', 'user-2', dto)).rejects.toThrow(
      ForbiddenException,
    );
  });

  it('refuses to run a programme for an archived community', async () => {
    const { service, communities } = makeService();
    communities.findOne.mockResolvedValue({
      id: 'com-1',
      slug: 'azores-queer',
      name: 'Azores Queer',
      archivedAt: new Date('2026-08-01T00:00:00Z'),
    });
    await expect(service.upsert('azores-queer', 'user-1', dto)).rejects.toThrow(
      NotFoundException,
    );
  });

  it('records a governance log entry for the change', async () => {
    const { service, governance } = makeService();
    await service.upsert('azores-queer', 'user-1', dto);
    expect(governance.log).toHaveBeenCalledWith(
      expect.objectContaining({
        communityId: 'com-1',
        action: 'card_program_enabled',
      }),
    );
  });

  it('records a disable entry when the programme is turned off', async () => {
    const { service, governance } = makeService();
    await service.upsert('azores-queer', 'user-1', {
      ...dto,
      isEnabled: false,
    });
    expect(governance.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'card_program_disabled' }),
    );
  });

  it('leaves an existing crest untouched when the payload omits it', async () => {
    const { service, programs } = makeService();
    programs.findOne.mockResolvedValue({
      id: 'prog-1',
      serialPrefix: 'AQ',
      crestMediaKey: 'uploads/existing-crest.png',
    });
    // `dto` carries no `crestMediaKey` field at all.
    const saved = await service.upsert('azores-queer', 'user-1', dto);
    expect(saved.crestMediaKey).toBe('uploads/existing-crest.png');
  });

  it('clears the crest when the payload explicitly sends null', async () => {
    const { service, programs } = makeService();
    programs.findOne.mockResolvedValue({
      id: 'prog-1',
      serialPrefix: 'AQ',
      crestMediaKey: 'uploads/existing-crest.png',
    });
    const saved = await service.upsert('azores-queer', 'user-1', {
      ...dto,
      crestMediaKey: null,
    });
    expect(saved.crestMediaKey).toBeNull();
  });

  it('sets a newly provided crest', async () => {
    const { service, programs } = makeService();
    programs.findOne.mockResolvedValue({
      id: 'prog-1',
      serialPrefix: 'AQ',
      crestMediaKey: null,
    });
    const saved = await service.upsert('azores-queer', 'user-1', {
      ...dto,
      crestMediaKey: 'uploads/new-crest.png',
    });
    expect(saved.crestMediaKey).toBe('uploads/new-crest.png');
  });
});
