import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomInt } from 'node:crypto';
import { Repository } from 'typeorm';
import { MembershipCard } from './entities/membership-card.entity';

// Crockford base32 minus the characters people misread aloud at a door: no
// I, L, O, or U — already excluded from this literal. 32 symbols over 5
// positions is about 33.5 million serials per prefix, which is far past
// enumeration by a rate-limited endpoint.
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const SUFFIX_LENGTH = 5;
const MAX_ATTEMPTS = 8;
const FALLBACK_PREFIX = 'QPC';

@Injectable()
export class CardSerialService {
  constructor(
    @InjectRepository(MembershipCard)
    private readonly cards: Repository<MembershipCard>,
  ) {}

  /**
   * The stable three-letter prefix for a community, derived once at programme
   * creation and frozen on the programme row thereafter. Renaming a community
   * must never reissue anyone's serial.
   */
  prefixFor(communityName: string): string {
    const words = communityName
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^A-Za-z ]/g, ' ')
      .split(' ')
      .filter(Boolean);

    if (words.length === 0) return FALLBACK_PREFIX;
    if (words.length >= 3) {
      return words
        .slice(0, 3)
        .map((word) => word[0]!.toUpperCase())
        .join('');
    }
    if (words.length === 2) {
      return words.map((word) => word[0]!.toUpperCase()).join('');
    }
    return words[0]!.slice(0, 3).toUpperCase();
  }

  /**
   * A platform-unique serial. Random rather than sequential because Phase 2
   * accepts a hand-typed serial as the scanner fallback, which makes an
   * enumerable serial an authentication weakness.
   */
  async generate(prefix: string): Promise<string> {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      const suffix = Array.from(
        { length: SUFFIX_LENGTH },
        () => ALPHABET[randomInt(ALPHABET.length)]!,
      ).join('');
      const serial = `${prefix}-${suffix}`;
      const clash = await this.cards.findOne({ where: { serial } });
      if (!clash) return serial;
    }
    throw new InternalServerErrorException(
      'Could not allocate a unique card serial',
    );
  }
}
