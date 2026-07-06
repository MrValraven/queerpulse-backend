import { PartialType } from '@nestjs/mapped-types';
import { CreateCommunityDto } from './create-community.dto';

// `handle` is inherited (optional) so a stray value in the payload doesn't
// trip `forbidNonWhitelisted`, but `CommunitiesService.update`'s
// `UpdateCommunityInput` type omits it entirely and never reads it —
// slugs never change post-creation (spec: "handle ignored on patch").
export class UpdateCommunityDto extends PartialType(CreateCommunityDto) {}
