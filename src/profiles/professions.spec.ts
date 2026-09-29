import {
  DISCIPLINE_BY_PROFESSION,
  LISTED_DISCIPLINE_IDS,
  LISTED_PROFESSION_IDS,
  PROFESSIONS_BY_DISCIPLINE,
  UNLISTED_DISCIPLINE_IDS,
  listedDisciplines,
  listedProfessions,
  reconcileDisciplineProfession,
  withoutUnlistedWork,
} from './professions';

describe('games discipline', () => {
  it('lists game masters and fandom work', () => {
    expect(PROFESSIONS_BY_DISCIPLINE.games).toEqual(
      expect.arrayContaining(['gameMaster', 'cosplayer', 'streamer']),
    );
    expect(PROFESSIONS_BY_DISCIPLINE.editorial).toContain('podcaster');
    expect(PROFESSIONS_BY_DISCIPLINE.performance).toContain('voiceActor');
  });
});

describe('business disciplines', () => {
  it('lists marketing, operations, people, finance and sales work', () => {
    expect(PROFESSIONS_BY_DISCIPLINE.marketing).toContain('socialMediaManager');
    expect(PROFESSIONS_BY_DISCIPLINE.operations).toContain('projectManager');
    expect(PROFESSIONS_BY_DISCIPLINE.people).toEqual(
      expect.arrayContaining(['recruiter', 'deiLead']),
    );
    expect(PROFESSIONS_BY_DISCIPLINE.finance).toContain('accountant');
    expect(PROFESSIONS_BY_DISCIPLINE.sales).toContain('customerSuccessManager');
  });
});

const NEW_DISCIPLINE_IDS = [
  'fashion',
  'engineering',
  'ownBusiness',
  'nightlife',
  'publicSector',
  'hospitality',
  'farming',
  'animals',
  'sport',
  'adultWork',
  'lifeStage',
];

const ADULT_WORK_PROFESSION_IDS = [
  'sexWorker',
  'adultContentCreator',
  'camPerformer',
  'exoticDancer',
  'professionalDominant',
  'adultFilmPerformer',
];

describe('Section B: new disciplines', () => {
  it('adds every new discipline from the taxonomy', () => {
    for (const disciplineId of NEW_DISCIPLINE_IDS) {
      expect(PROFESSIONS_BY_DISCIPLINE).toHaveProperty(disciplineId);
      expect(PROFESSIONS_BY_DISCIPLINE[disciplineId]!.length).toBeGreaterThan(
        0,
      );
    }
  });

  it('lifeStage contains student', () => {
    expect(PROFESSIONS_BY_DISCIPLINE.lifeStage).toContain('student');
  });

  it('adultWork contains sexWorker', () => {
    expect(PROFESSIONS_BY_DISCIPLINE.adultWork).toContain('sexWorker');
  });

  it('no profession id appears in two disciplines', () => {
    const seen = new Set<string>();
    for (const professions of Object.values(PROFESSIONS_BY_DISCIPLINE)) {
      for (const professionId of professions) {
        expect(seen.has(professionId)).toBe(false);
        seen.add(professionId);
      }
    }
  });
});

describe('unlisted work (adultWork is selectable but stays unfindable)', () => {
  it('LISTED_DISCIPLINE_IDS excludes adultWork', () => {
    expect(LISTED_DISCIPLINE_IDS).not.toContain('adultWork');
    expect(UNLISTED_DISCIPLINE_IDS).toEqual(['adultWork']);
  });

  it('LISTED_PROFESSION_IDS excludes all six adult professions', () => {
    for (const professionId of ADULT_WORK_PROFESSION_IDS) {
      expect(LISTED_PROFESSION_IDS).not.toContain(professionId);
      expect(DISCIPLINE_BY_PROFESSION[professionId]).toBe('adultWork');
    }
  });

  it('listedProfessions drops the unlisted id and keeps the listed one', () => {
    expect(listedProfessions(['sexWorker', 'nurse'])).toEqual(['nurse']);
  });

  it('listedDisciplines drops adultWork and keeps a listed discipline', () => {
    expect(listedDisciplines(['adultWork', 'healthcare'])).toEqual([
      'healthcare',
    ]);
  });

  it('withoutUnlistedWork strips both the discipline and profession arrays', () => {
    expect(
      withoutUnlistedWork({
        discipline: ['adultWork', 'healthcare'],
        profession: ['sexWorker', 'nurse'],
      }),
    ).toEqual({
      discipline: ['healthcare'],
      profession: ['nurse'],
    });
  });

  it('reconcileDisciplineProfession still accepts adultWork/sexWorker, so saving keeps working', () => {
    expect(reconcileDisciplineProfession([], ['sexWorker'])).toEqual({
      disciplines: ['adultWork'],
      professions: ['sexWorker'],
    });
  });
});
