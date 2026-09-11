import { BadRequestException, ConflictException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { AdminResourcesService } from './admin-resources.service';
import { Resource } from './entities/resource.entity';
import { MAX_GUIDE_BLOCK_LENGTH } from './guide-section';

function makeResource(overrides: Partial<Resource> = {}): Resource {
  return {
    id: 'res-1',
    slug: 'accessible-lisbon',
    category: 'community',
    title: 'Accessible Lisbon',
    description: 'Step-free routes.',
    body: 'Step-free routes.',
    titlePt: null,
    descriptionPt: null,
    sections: [],
    sectionsPt: null,
    routePath: '/resources/accessible-lisbon',
    meta: null,
    externalUrl: null,
    publishedAt: null,
    lastVerifiedAt: null,
    reviewDueOn: null,
    lastReviewedOn: null,
    reviewedBy: null,
    reviewOverdueNotifiedOn: null,
    updatedBy: null,
    createdAt: new Date('2026-09-01T10:00:00.000Z'),
    updatedAt: new Date('2026-09-10T14:02:03.456Z'),
    ...overrides,
  };
}

describe('AdminResourcesService', () => {
  let service: AdminResourcesService;
  let repository: { findOne: jest.Mock; save: jest.Mock; create: jest.Mock };

  beforeEach(async () => {
    repository = {
      findOne: jest.fn(),
      save: jest.fn((value: Resource) => Promise.resolve(value)),
      create: jest.fn((value: Partial<Resource>) => value),
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AdminResourcesService,
        { provide: getRepositoryToken(Resource), useValue: repository },
      ],
    }).compile();
    service = module.get(AdminResourcesService);
  });

  describe('update: formatted blocks', () => {
    it('sanitizes html and derives text from it', async () => {
      repository.findOne.mockResolvedValue(makeResource());
      const result = await service.update(
        'res-1',
        {
          sections: [
            {
              id: 'routes',
              heading: 'Routes',
              blocks: [
                {
                  kind: 'paragraph',
                  text: 'ignored',
                  html: 'Take <strong>line 28</strong><script>alert(1)</script><br>then walk',
                },
              ],
            },
          ],
        },
        'admin-1',
      );
      expect(result.sections[0]?.blocks[0]).toEqual({
        kind: 'paragraph',
        text: 'Take line 28\nthen walk',
        html: 'Take <strong>line 28</strong><br />then walk',
      });
      expect(result.body).toContain('Take line 28');
    });

    it('drops html sent on a subheading', async () => {
      repository.findOne.mockResolvedValue(makeResource());
      const result = await service.update(
        'res-1',
        {
          sections: [
            {
              id: 'a',
              heading: 'A',
              blocks: [
                {
                  kind: 'subheading',
                  text: 'Getting there',
                  html: '<em>x</em>',
                },
              ],
            },
          ],
        },
        'admin-1',
      );
      expect(result.sections[0]?.blocks[0]).toEqual({
        kind: 'subheading',
        text: 'Getting there',
      });
    });

    it('keeps a plain block without html as it is', async () => {
      repository.findOne.mockResolvedValue(makeResource());
      const result = await service.update(
        'res-1',
        {
          sections: [
            {
              id: 'a',
              heading: 'A',
              blocks: [{ kind: 'note', text: 'Call 112' }],
            },
          ],
        },
        'admin-1',
      );
      expect(result.sections[0]?.blocks[0]).toEqual({
        kind: 'note',
        text: 'Call 112',
      });
    });

    it('rejects a block whose derived text is too long', async () => {
      repository.findOne.mockResolvedValue(makeResource());
      await expect(
        service.update(
          'res-1',
          {
            sections: [
              {
                id: 'a',
                heading: 'A',
                blocks: [
                  {
                    kind: 'paragraph',
                    text: 'x',
                    html: 'a'.repeat(MAX_GUIDE_BLOCK_LENGTH + 1),
                  },
                ],
              },
            ],
          },
          'admin-1',
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(repository.save).not.toHaveBeenCalled();
    });

    it('treats a null html as absent and keeps the text', async () => {
      repository.findOne.mockResolvedValue(makeResource());
      const result = await service.update(
        'res-1',
        {
          sections: [
            {
              id: 'a',
              heading: 'A',
              blocks: [
                {
                  kind: 'paragraph',
                  text: 'Plain',
                  html: null as unknown as string,
                },
              ],
            },
          ],
        },
        'admin-1',
      );
      expect(result.sections[0]?.blocks[0]).toEqual({
        kind: 'paragraph',
        text: 'Plain',
      });
    });

    it('rejects html that grows past the limit when sanitized', async () => {
      repository.findOne.mockResolvedValue(makeResource());
      await expect(
        service.update(
          'res-1',
          {
            sections: [
              {
                id: 'a',
                heading: 'A',
                blocks: [
                  {
                    kind: 'paragraph',
                    text: 'x',
                    html: '<br>'.repeat(1700),
                  },
                ],
              },
            ],
          },
          'admin-1',
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(repository.save).not.toHaveBeenCalled();
    });
  });

  describe('update: stale writes', () => {
    it('refuses a write made against an older updatedAt', async () => {
      repository.findOne.mockResolvedValue(makeResource());
      await expect(
        service.update(
          'res-1',
          { title: 'New', expectedUpdatedAt: '2026-09-10T14:00:00.000Z' },
          'admin-1',
        ),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(repository.save).not.toHaveBeenCalled();
    });

    it('saves when expectedUpdatedAt matches', async () => {
      repository.findOne.mockResolvedValue(makeResource());
      const result = await service.update(
        'res-1',
        { title: 'New', expectedUpdatedAt: '2026-09-10T14:02:03.456Z' },
        'admin-1',
      );
      expect(result.title).toBe('New');
    });

    it('saves when expectedUpdatedAt is absent', async () => {
      repository.findOne.mockResolvedValue(makeResource());
      const result = await service.update('res-1', { title: 'New' }, 'admin-1');
      expect(result.title).toBe('New');
    });
  });
});
