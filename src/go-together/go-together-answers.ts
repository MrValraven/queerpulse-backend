import {
  ACTIVE_HUMOUR_PAIR_IDS,
  AGE_BRACKETS,
  AGE_PREFERENCES,
  AREA_IDS,
  CHAT_LANGUAGES,
  DRINKING_OPTIONS,
  ENERGY_ITEM_IDS,
  FriendMatchAnswers,
  HostAnswers,
  HostQuestion,
  INTEREST_TAG_IDS,
  INTENTS,
  MAX_HOST_OPTION_LENGTH,
  MAX_HOST_OPTIONS,
  MAX_HOST_PROMPT_LENGTH,
  MAX_HOST_QUESTIONS,
  MAX_INTEREST_TAGS,
  MAX_MUSIC_TAGS,
  MEET_FREQUENCIES,
  MIN_HOST_OPTIONS,
  MUSIC_TAG_IDS,
  Scale5,
  VALUE_ITEM_IDS,
} from './go-together-questionnaire.catalog';

/**
 * Validation for the jsonb payloads Go together stores. The answers live in a
 * jsonb column, so class-validator on the DTO only proves the body is an
 * object; these functions are the real gate and the only way a payload reaches
 * the database. They return every problem at once so the client can show them
 * together.
 */
export type ParseResult<T> =
  { ok: true; value: T } | { ok: false; errors: string[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isScale5(value: unknown): value is Scale5 {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= 5
  );
}

function isOneOf<T extends string>(
  options: readonly T[],
  value: unknown,
): value is T {
  return (
    typeof value === 'string' && (options as readonly string[]).includes(value)
  );
}

function parseTagList<T extends string>(
  field: string,
  options: readonly T[],
  max: number,
  value: unknown,
  errors: string[],
): T[] {
  if (!Array.isArray(value)) {
    errors.push(`${field} must be a list`);
    return [];
  }
  const unique = [...new Set(value)];
  if (unique.length > max) errors.push(`${field} allows at most ${max} picks`);
  const valid = unique.filter((item): item is T => isOneOf(options, item));
  if (valid.length !== unique.length) errors.push(`${field} has an unknown id`);
  return valid.slice(0, max);
}

export function parseFriendMatchAnswers(
  input: unknown,
): ParseResult<FriendMatchAnswers> {
  const errors: string[] = [];
  if (!isRecord(input))
    return { ok: false, errors: ['answers must be an object'] };

  const values = {} as FriendMatchAnswers['values'];
  const rawValues = isRecord(input.values) ? input.values : {};
  for (const itemId of VALUE_ITEM_IDS) {
    const answer = rawValues[itemId];
    if (isScale5(answer)) values[itemId] = answer;
    else errors.push(`values.${itemId} must be 1 to 5`);
  }

  const humour: FriendMatchAnswers['humour'] = {};
  const rawHumour = isRecord(input.humour) ? input.humour : {};
  for (const pairId of ACTIVE_HUMOUR_PAIR_IDS) {
    const pick = rawHumour[pairId];
    if (pick === 'a' || pick === 'b') humour[pairId] = pick;
    else errors.push(`humour.${pairId} must be a or b`);
  }

  const energy = {} as FriendMatchAnswers['energy'];
  const rawEnergy = isRecord(input.energy) ? input.energy : {};
  for (const itemId of ENERGY_ITEM_IDS) {
    const answer = rawEnergy[itemId];
    if (isScale5(answer)) energy[itemId] = answer;
    else errors.push(`energy.${itemId} must be 1 to 5`);
  }

  const interests = parseTagList(
    'interests',
    INTEREST_TAG_IDS,
    MAX_INTEREST_TAGS,
    input.interests,
    errors,
  );
  const music = parseTagList(
    'music',
    MUSIC_TAG_IDS,
    MAX_MUSIC_TAGS,
    input.music,
    errors,
  );
  const languages = parseTagList(
    'languages',
    CHAT_LANGUAGES,
    CHAT_LANGUAGES.length,
    input.languages,
    errors,
  );
  if (languages.length === 0)
    errors.push('languages needs at least one language');

  if (!isOneOf(INTENTS, input.intent)) errors.push('intent is invalid');
  if (!isOneOf(MEET_FREQUENCIES, input.meetFrequency))
    errors.push('meetFrequency is invalid');
  if (!isOneOf(DRINKING_OPTIONS, input.drinking))
    errors.push('drinking is invalid');
  if (!isOneOf(AGE_BRACKETS, input.ageBracket))
    errors.push('ageBracket is invalid');
  if (!isOneOf(AGE_PREFERENCES, input.agePreference))
    errors.push('agePreference is invalid');
  const area = input.area ?? null;
  if (area !== null && !isOneOf(AREA_IDS, area)) errors.push('area is invalid');

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      values,
      humour,
      interests,
      music,
      energy,
      intent: input.intent as FriendMatchAnswers['intent'],
      meetFrequency: input.meetFrequency as FriendMatchAnswers['meetFrequency'],
      languages,
      drinking: input.drinking as FriendMatchAnswers['drinking'],
      ageBracket: input.ageBracket as FriendMatchAnswers['ageBracket'],
      agePreference: input.agePreference as FriendMatchAnswers['agePreference'],
      area: area as FriendMatchAnswers['area'],
    },
  };
}

/** Host questions come from the host; ids are generated server side (`q1`,
 *  `q2`, options `o1`..`o4`) so a client can never collide two ids. */
export function parseHostQuestions(
  input: unknown,
): ParseResult<HostQuestion[]> {
  if (!Array.isArray(input))
    return { ok: false, errors: ['hostQuestions must be a list'] };
  const errors: string[] = [];
  if (input.length > MAX_HOST_QUESTIONS)
    errors.push(`at most ${MAX_HOST_QUESTIONS} questions`);
  const questions: HostQuestion[] = [];
  input.slice(0, MAX_HOST_QUESTIONS).forEach((raw, questionIndex) => {
    const prompt =
      isRecord(raw) && typeof raw.prompt === 'string' ? raw.prompt.trim() : '';
    const rawOptions =
      isRecord(raw) && Array.isArray(raw.options) ? raw.options : [];
    if (prompt.length === 0 || prompt.length > MAX_HOST_PROMPT_LENGTH) {
      errors.push(
        `question ${questionIndex + 1} prompt must be 1 to ${MAX_HOST_PROMPT_LENGTH} characters`,
      );
    }
    if (
      rawOptions.length < MIN_HOST_OPTIONS ||
      rawOptions.length > MAX_HOST_OPTIONS
    ) {
      errors.push(
        `question ${questionIndex + 1} needs ${MIN_HOST_OPTIONS} to ${MAX_HOST_OPTIONS} options`,
      );
    }
    const options = rawOptions
      .slice(0, MAX_HOST_OPTIONS)
      .map((option, optionIndex) => {
        const label = typeof option === 'string' ? option.trim() : '';
        if (label.length === 0 || label.length > MAX_HOST_OPTION_LENGTH) {
          errors.push(
            `question ${questionIndex + 1} option ${optionIndex + 1} must be 1 to ${MAX_HOST_OPTION_LENGTH} characters`,
          );
        }
        return { id: `o${optionIndex + 1}`, label };
      });
    questions.push({ id: `q${questionIndex + 1}`, prompt, options });
  });
  return errors.length > 0
    ? { ok: false, errors }
    : { ok: true, value: questions };
}

/** Every host question must be answered with one of its option ids. */
export function parseHostAnswers(
  questions: HostQuestion[],
  input: unknown,
): ParseResult<HostAnswers> {
  const raw = isRecord(input) ? input : {};
  const errors: string[] = [];
  const answers: HostAnswers = {};
  for (const question of questions) {
    const optionId = raw[question.id];
    if (
      typeof optionId === 'string' &&
      question.options.some((option) => option.id === optionId)
    ) {
      answers[question.id] = optionId;
    } else {
      errors.push(`host question ${question.id} needs an answer`);
    }
  }
  return errors.length > 0
    ? { ok: false, errors }
    : { ok: true, value: answers };
}
