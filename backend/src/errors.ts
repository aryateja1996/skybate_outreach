export class AppError extends Error {
  readonly details?: unknown;

  constructor(
    readonly statusCode: number,
    message: string,
    readonly code: string,
    details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
    this.details = details;
  }
}

export class DuplicateEmailError extends AppError {
  constructor() {
    super(409, 'A contact with this email already exists.', 'DUPLICATE_CONTACT');
  }
}
