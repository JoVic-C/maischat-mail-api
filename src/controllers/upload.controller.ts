import type { Request, Response } from 'express';

export const uploadImageHandler = (req: Request, res: Response): void => {
  if (!req.file) {
    res.status(400).json({ error: 'Nenhuma imagem enviada.' });
    return;
  }

  const base = process.env.PUBLIC_API_URL || 'http://localhost:3000';
  res.json({ url: `${base}/uploads/${req.file.filename}` });
};

export const uploadDocHandler = (req: Request, res: Response): void => {
  if (!req.file) {
    res.status(400).json({ error: 'Nenhum arquivo enviado.' });
    return;
  }
  res.json({
    filename: req.file.originalname,
    storedName: req.file.filename,
    size: req.file.size,
  });
};
