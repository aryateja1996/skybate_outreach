import cookieParser from 'cookie-parser';
import cors from 'cors';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import type { AppDeps } from './routes';
import { errorHandler } from './middleware/errors';
import { registerRoutes } from './routes';

export type { AppDeps } from './routes';

export function createApp(deps: AppDeps): Express {
  const app = express();
  if (deps.config.trustProxy) app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
  app.use(cors({
    origin(origin, callback) {
      if (!origin || deps.config.corsOrigins.includes(origin)) {
        callback(null, true);
        return;
      }
      callback(null, false);
    },
    credentials: true,
  }));
  app.use(cookieParser());
  app.use(express.json({ limit: '2mb', type: ['application/json', 'text/plain', 'application/*+json'] }));
  app.use((req, _res, next) => {
    if (typeof req.body === 'string' && req.body.trim()) {
      try {
        req.body = JSON.parse(req.body) as unknown;
      } catch {
        req.body = {};
      }
    }
    next();
  });

  if (deps.config.nodeEnv !== 'test') {
    // A local HTTPS tunnel sets X-Forwarded-For. Rejecting that header would
    // turn the SNS webhook into a 500 before signature and topic checks run.
    // The header is not used for authentication. Trust it for client IP only
    // when TRUST_PROXY=true.
    const validate = { xForwardedForHeader: false as const };
    app.use('/api', rateLimit({
      windowMs: 15 * 60 * 1000,
      limit: 300,
      standardHeaders: true,
      legacyHeaders: false,
      validate,
    }));
    app.use('/api/auth/login', rateLimit({
      windowMs: 15 * 60 * 1000,
      limit: 10,
      standardHeaders: true,
      legacyHeaders: false,
      validate,
    }));
    app.use('/unsubscribe', rateLimit({
      windowMs: 15 * 60 * 1000,
      limit: 30,
      standardHeaders: true,
      legacyHeaders: false,
      validate,
    }));
  }

  registerRoutes(app, deps);
  app.use((_req: Request, res: Response) => {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Resource not found.' } });
  });
  app.use((error: unknown, req: Request, res: Response, next: NextFunction) => {
    if (error instanceof SyntaxError) {
      res.status(400).json({ error: { code: 'INVALID_JSON', message: 'Request body must be valid JSON.' } });
      return;
    }
    errorHandler(error, req, res, next);
  });
  return app;
}
