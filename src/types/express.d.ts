import { Types } from 'mongoose';
import { UserDocument } from '../models/User';

declare global {
  namespace Express {
    interface Request {
      user?: UserDocument; // populado pelo requireAuth (JWT)
      apiKeyUsed?: string; // populado pelo apiKeyAuth (Fase E)
      apiKeyId?: Types.ObjectId;
    }
  }
}
