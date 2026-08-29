export interface ValidationFieldError {
  field?: string;
  message: string;
}

export abstract class AppError extends Error {
  public abstract readonly statusCode: number;
  public readonly code?: string;
  public readonly details?: unknown;

  constructor(message: string, code?: string, details?: unknown) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    this.details = details;
    Error.captureStackTrace?.(this, this.constructor);
  }
}

export class BadRequestError extends AppError {
  public readonly statusCode = 400;
}

export class UnauthorizedError extends AppError {
  public readonly statusCode = 401;
}

export class ForbiddenError extends AppError {
  public readonly statusCode = 403;
}

export class NotFoundError extends AppError {
  public readonly statusCode = 404;
}

export class ConflictError extends AppError {
  public readonly statusCode = 409;
}

export class ValidationError extends AppError {
  public readonly statusCode = 400;
  public readonly errors: ValidationFieldError[];

  constructor(errors: ValidationFieldError[], message = 'Dados inválidos.') {
    super(message);
    this.errors = errors;
  }
}

export class InternalServerError extends AppError {
  public readonly statusCode = 500;
}
