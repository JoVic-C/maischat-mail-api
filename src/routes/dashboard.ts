import { Router } from 'express';
import * as ctrl from '../controllers/dashboard.controller';

const router = Router();

router.get('/stats', ctrl.getStats);
router.get('/activity', ctrl.getActivity);

export default router;
