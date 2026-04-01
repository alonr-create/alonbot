import { Router, Request, Response } from 'express';

export const waManagerRouter = Router();

// Redirect /wa-manager to /wa-inbox (the unified CRM dashboard)
waManagerRouter.get('/wa-manager', (req: Request, res: Response): void => {
  const token = req.query.token as string || '';
  res.redirect(`/wa-inbox${token ? '?token=' + encodeURIComponent(token) : ''}`);
});
