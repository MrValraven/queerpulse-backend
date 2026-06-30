import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { UserStatus } from '../../users/entities/user.entity';

@Injectable()
export class ActiveMemberGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const { user } = context.switchToHttp().getRequest();
    if (user?.status !== UserStatus.Active) {
      throw new ForbiddenException('Active membership required');
    }
    return true;
  }
}
