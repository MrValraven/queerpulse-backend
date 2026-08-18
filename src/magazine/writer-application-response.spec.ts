import {
  toAdminWriterApplicationDTO,
  toWriterApplicationDTO,
} from './writer-application-response';
import {
  MagazineWriterApplication,
  WriterApplicationStatus,
} from './entities/magazine-writer-application.entity';
import type { MemberRef } from '../common/member-ref';

function makeApplication(
  overrides: Partial<MagazineWriterApplication> = {},
): MagazineWriterApplication {
  const application = new MagazineWriterApplication();
  application.id = 'app-1';
  application.userId = 'user-1';
  application.pitchNote = 'I want to write about queer archives.';
  application.sampleText = 'Sample paragraph.';
  application.sampleLink = null;
  application.status = WriterApplicationStatus.Pending;
  application.reviewedBy = null;
  application.reviewNote = null;
  application.createdAt = new Date('2026-08-01T00:00:00.000Z');
  application.reviewedAt = null;
  return Object.assign(application, overrides);
}

const memberRef: MemberRef = {
  slug: 'jamie',
  firstName: 'Jamie',
  lastName: 'Ortiz',
  pronouns: 'they/them',
  avatarUrl: null,
};

describe('writer-application-response', () => {
  it('maps an application to a WriterApplicationDTO', () => {
    const dto = toWriterApplicationDTO(makeApplication());
    expect(dto).toEqual({
      id: 'app-1',
      pitchNote: 'I want to write about queer archives.',
      sampleText: 'Sample paragraph.',
      sampleLink: null,
      status: 'pending',
      reviewNote: null,
      createdAt: '2026-08-01T00:00:00.000Z',
      reviewedAt: null,
    });
  });

  it('maps an application + member ref to an AdminWriterApplicationDTO', () => {
    const dto = toAdminWriterApplicationDTO(makeApplication(), memberRef);
    expect(dto.applicant).toEqual({
      slug: 'jamie',
      name: 'Jamie Ortiz',
      avatarUrl: null,
    });
    expect(dto.id).toBe('app-1');
  });

  it('leaves applicant null when there is no member ref', () => {
    const dto = toAdminWriterApplicationDTO(makeApplication(), null);
    expect(dto.applicant).toBeNull();
  });
});
