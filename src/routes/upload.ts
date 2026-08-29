import { type RequestHandler, Router } from 'express';
import { uploadDocHandler, uploadImageHandler } from '../controllers/upload.controller';
import { uploadDoc, uploadImage } from '../middleware/upload';

const router = Router();

// O cast contorna um conflito de tipos do @types/multer (que resolve o @types/express@5
// de um node_modules ancestral, diferente do @types/express@4 do backend). Em runtime é idêntico.
const handleImage = uploadImage.single('image') as unknown as RequestHandler;
const handleDoc = uploadDoc.single('file') as unknown as RequestHandler;

router.post('/image', handleImage, uploadImageHandler);
router.post('/file', handleDoc, uploadDocHandler);

export default router;
