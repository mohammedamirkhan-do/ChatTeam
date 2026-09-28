import { Router } from 'express';
import { z } from 'zod';
import { insertOne } from '../../database/db.js';
import { validate } from '@teamchat/validation';
import { logger } from '../../common/logger.js';

export const crashesRouter = Router();

const crashSchema = z.object({
  appVersion: z.string().max(32).optional().default(''),
  platform: z.string().max(32).optional().default(''),
  error: z.string().min(1).max(5000),
  stack: z.string().max(20000).optional(),
  context: z.record(z.unknown()).optional().default({}),
});

crashesRouter.post('/crashes', async (req, res, next) => {
  try {
    const body = validate(crashSchema, req.body);
    const row = await insertOne('crash_reports', { app_version: body.appVersion, platform: body.platform, error: body.error, stack: body.stack || null, context: body.context, created_at: new Date() });
    logger.warn({ crashId: row.id, appVersion: body.appVersion, platform: body.platform }, 'desktop crash report');
    res.status(201).json({ id: row.id, receivedAt: row.created_at });
  } catch (e) {
    next(e);
  }
});
