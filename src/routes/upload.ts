import { Router } from 'express';
import { uploadDocHandler, uploadImageHandler } from '../controllers/upload.controller';
import { handleDocUpload, handleImageUpload } from '../middleware/upload';

const router = Router();

router.post('/image', handleImageUpload, uploadImageHandler);
router.post('/file', handleDocUpload, uploadDocHandler);

export default router;
