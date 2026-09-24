import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { EmailTemplate } from './entities/email-template.entity';
import { EmailTemplatesService } from './email-templates.service';

const ENGLISH = {
  subject: 'Welcome',
  mode: 'blocks',
  blocks: [{ id: 'p-1', type: 'paragraph', text: 'Hi {name}' }],
  html: null,
};

function makeRow(overrides: Partial<EmailTemplate> = {}): EmailTemplate {
  return {
    id: 'template-1',
    label: 'Welcome: invite approved',
    purpose: 'invite_approved',
    locales: { en: { ...ENGLISH, mode: 'blocks' } } as EmailTemplate['locales'],
    sortOrder: 0,
    isActive: true,
    createdByUserId: null,
    updatedByUserId: null,
    createdAt: new Date('2026-09-24T10:00:00Z'),
    updatedAt: new Date('2026-09-24T10:00:00Z'),
    ...overrides,
  };
}

describe('EmailTemplatesService', () => {
  let service: EmailTemplatesService;
  let templates: {
    find: jest.Mock;
    findOne: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
    delete: jest.Mock;
  };

  beforeEach(async () => {
    templates = {
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn(),
      create: jest.fn((input: Partial<EmailTemplate>) => ({
        ...makeRow(),
        ...input,
      })),
      save: jest.fn((row: EmailTemplate) => Promise.resolve(row)),
      delete: jest.fn(),
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EmailTemplatesService,
        { provide: getRepositoryToken(EmailTemplate), useValue: templates },
      ],
    }).compile();
    service = module.get(EmailTemplatesService);
  });

  it('creates a template with trimmed label, validated locales and its author', async () => {
    const created = await service.create(
      {
        label: '  Welcome  ',
        purpose: 'invite_approved',
        locales: { en: { ...ENGLISH, subject: '  Welcome  ' } },
      },
      'admin-1',
    );
    expect(templates.create).toHaveBeenCalledWith(
      expect.objectContaining({
        label: 'Welcome',
        createdByUserId: 'admin-1',
        updatedByUserId: 'admin-1',
      }),
    );
    expect(created.locales.en.subject).toBe('Welcome');
  });

  it('refuses a create whose content uses an unknown placeholder', async () => {
    await expect(
      service.create(
        {
          label: 'General note',
          purpose: 'general',
          locales: { en: ENGLISH },
        },
        'admin-1',
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(templates.save).not.toHaveBeenCalled();
  });

  it('re-checks stored content when only the purpose changes', async () => {
    templates.findOne.mockResolvedValue(makeRow());
    const attempt = service.update(
      'template-1',
      { purpose: 'general' },
      'admin-2',
    );
    await expect(attempt).rejects.toBeInstanceOf(BadRequestException);
    await attempt.catch((error: BadRequestException) => {
      const body = error.getResponse() as { message: string[] };
      expect(body.message[0]).toContain(
        'en: {name} is not a placeholder for general',
      );
    });
  });

  it('records who updated a template', async () => {
    templates.findOne.mockResolvedValue(makeRow());
    await service.update('template-1', { isActive: false }, 'admin-2');
    expect(templates.save).toHaveBeenCalledWith(
      expect.objectContaining({ isActive: false, updatedByUserId: 'admin-2' }),
    );
  });

  it('404s an update to a missing template', async () => {
    templates.findOne.mockResolvedValue(null);
    await expect(
      service.update('missing', { label: 'Anything' }, 'admin-2'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('turns a label collision into a 409', async () => {
    templates.save.mockRejectedValue({
      code: '23505',
      constraint: 'UQ_email_templates_label',
    });
    await expect(
      service.create(
        {
          label: 'Taken',
          purpose: 'invite_approved',
          locales: { en: ENGLISH },
        },
        'admin-1',
      ),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('lists only active templates for a purpose, in display order', async () => {
    templates.find.mockResolvedValue([makeRow()]);
    const rows = await service.listActive('invite_approved');
    expect(templates.find).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { isActive: true, purpose: 'invite_approved' },
        order: { sortOrder: 'ASC', label: 'ASC' },
      }),
    );
    expect(rows[0]).not.toHaveProperty('createdByUserId');
  });

  it('404s a delete of a missing template', async () => {
    templates.delete.mockResolvedValue({ affected: 0 });
    await expect(service.remove('missing')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
