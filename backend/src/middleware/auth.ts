import type { NextFunction, Request, Response } from 'express';
import type { AppConfig } from '../config';
import { safeEqual } from '../domain/tokens';
import { AppError } from '../errors';
import type { Store } from '../store';
import type { User } from '../types';

export interface RequestContext {
  user: User;
  csrfToken: string;
}

export function getContext(res: Response): RequestContext {
  const context = res.locals.auth as RequestContext | undefined;
  if (!context) throw new AppError(401, 'Sign in required.', 'UNAUTHENTICATED');
  return context;
}

export function requireUser(store: Store) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const sid = req.cookies?.sid;
      if (!sid || typeof sid !== 'string') throw new AppError(401, 'Sign in required.', 'UNAUTHENTICATED');
      const session = await store.findSession(sid);
      if (!session || session.expiresAt.getTime() < Date.now()) {
        if (session) await store.deleteSession(session.id);
        throw new AppError(401, 'Sign in required.', 'UNAUTHENTICATED');
      }
      const user = await store.findUserById(session.userId);
      if (!user) throw new AppError(401, 'Sign in required.', 'UNAUTHENTICATED');
      res.locals.auth = { user, csrfToken: session.csrfToken } satisfies RequestContext;
      next();
    } catch (error) {
      next(error);
    }
  };
}

export function requireAdmin(_req: Request, res: Response, next: NextFunction): void {
  try {
    const context = getContext(res);
    if (context.user.role !== 'admin') {
      next(new AppError(403, 'Administrator access is required.', 'FORBIDDEN'));
      return;
    }
    next();
  } catch (error) {
    next(error);
  }
}

export function requireCsrf(_req: Request, res: Response, next: NextFunction): void {
  const context = getContext(res);
  const provided = _req.get('x-csrf-token') ?? '';
  if (!safeEqual(provided, context.csrfToken)) {
    next(new AppError(403, 'CSRF token is missing or invalid.', 'CSRF_FAILED'));
    return;
  }
  next();
}

export function cookieOptions(config: AppConfig) {
  return {
    sameSite: config.cookieSameSite,
    secure: config.cookieSecure,
    path: '/',
    maxAge: config.sessionTtlHours * 60 * 60 * 1000,
  } as const;
}
