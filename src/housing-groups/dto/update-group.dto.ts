import { PartialType } from '@nestjs/mapped-types';
import { CreateHousingGroupDto } from './create-group.dto';

export class UpdateGroupDto extends PartialType(CreateHousingGroupDto) {}
