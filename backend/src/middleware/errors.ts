import type { NextFunction, Request, Response } from 'express';
import { AppError } from '../errors';
import { logError } from '../logger';

export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    fn(req, res, next).catch(next);
  };
}

export function errorHandler(error: unknown, _req: Request, res: Response, next: NextFunction): void {
  if (res.headersSent) {
    next(error);
    return;
  }
  const fileError = error as { code?: string };
  if (fileError?.code === 'LIMIT_FILE_SIZE') {
    res.status(413).json({
      error: { code: 'FILE_TOO_LARGE', message: 'The upload exceeds the configured size limit.' },
    });
    return;
  }
  if (error instanceof AppError) {
    res.status(error.statusCode).json({
      error: {
        code: error.code,
        message: error.message,
        ...(error.details === undefined ? {} : { details: error.details }),
      },
    });
    return;
  }
  logError('Unhandled request error.', { name: error instanceof Error ? error.name : 'Error' });
  res.status(500).json({
    error: { code: 'INTERNAL_ERROR', message: 'The request could not be completed.' },
  });
}
