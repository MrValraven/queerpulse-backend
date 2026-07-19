import { Test, TestingModule } from '@nestjs/testing';
import { ProfilesService } from '../profiles/profiles.service';
import { SavedService } from '../saved/saved.service';
import { SocialService } from '../social/social.service';
import { BootstrapService } from './bootstrap.service';

describe('BootstrapService', () => {
  let service: BootstrapService;
  let profiles: { getMine: jest.Mock };
  let saved: { list: jest.Mock };
  let social: { listBlocks: jest.Mock; listMutes: jest.Mock };

  const emptyPage = { items: [], total: 0, page: 1, pageSize: 20 };

  beforeEach(async () => {
    profiles = { getMine: jest.fn().mockResolvedValue({ slug: 'me', limited: false }) };
    saved = { list: jest.fn().mockResolvedValue(emptyPage) };
    social = {
      listBlocks: jest.fn().mockResolvedValue(emptyPage),
      listMutes: jest.fn().mockResolvedValue(emptyPage),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BootstrapService,
        { provide: ProfilesService, useValue: profiles },
        { provide: SavedService, useValue: saved },
        { provide: SocialService, useValue: social },
      ],
    }).compile();

    service = module.get(BootstrapService);
  });

  it('returns all four slices keyed by name', async () => {
    const res = await service.getForUser('u1');
    expect(res).toEqual({
      profile: { slug: 'me', limited: false },
      saved: emptyPage,
      blocks: emptyPage,
      mutes: emptyPage,
    });
  });

  it('asks each service for the caller only, page 1', async () => {
    await service.getForUser('u1');
    expect(profiles.getMine).toHaveBeenCalledWith('u1');
    expect(saved.list).toHaveBeenCalledWith('u1', {});
    expect(social.listBlocks).toHaveBeenCalledWith('u1');
    expect(social.listMutes).toHaveBeenCalledWith('u1');
  });

  it('fetches the four slices concurrently, not serially', async () => {
    let running = 0;
    let peak = 0;
    const slow = () => {
      running += 1;
      peak = Math.max(peak, running);
      return new Promise((resolve) =>
        setTimeout(() => {
          running -= 1;
          resolve(emptyPage);
        }, 5),
      );
    };
    profiles.getMine.mockImplementation(slow);
    saved.list.mockImplementation(slow);
    social.listBlocks.mockImplementation(slow);
    social.listMutes.mockImplementation(slow);

    await service.getForUser('u1');
    expect(peak).toBe(4);
  });
});
