import { Types } from 'mongoose';
import { UserDocument } from '../models/User';

declare global {
  namespace Express {
    interface Request {
      /** Preenchido pelo requireAuth. */
      user?: UserDocument;
      apiKeyUsed?: string;
      apiKeyId?: Types.ObjectId;
    }
  }
}
