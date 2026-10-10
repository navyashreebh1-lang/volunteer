export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export const badRequest = (message: string, details?: unknown) => new HttpError(400, 'VALIDATION_ERROR', message, details);
export const unauthorized = (message = 'Authentication required') => new HttpError(401, 'UNAUTHENTICATED', message);
export const forbidden = (message = 'You are not allowed to do this', code = 'FORBIDDEN') => new HttpError(403, code, message);
export const notFound = (message = 'Not found') => new HttpError(404, 'NOT_FOUND', message);
export const conflict = (message: string, code = 'CONFLICT', details?: unknown) => new HttpError(409, code, message, details);
export const unprocessable = (message: string, code: string, details?: unknown) => new HttpError(422, code, message, details);
