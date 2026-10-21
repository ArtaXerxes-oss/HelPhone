import type { Request, Response, NextFunction, ErrorRequestHandler } from 'express'

/**
 * Typed application error — thrown by route handlers when they want to
 * surface a specific HTTP status code and user-facing message.
 */
export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
  ) {
    super(message)
    this.name = 'AppError'
  }
}

/**
 * 404 handler — must be mounted after all real routes.
 * Delegates to the error handler below so the response format is uniform.
 */
export function notFoundHandler(req: Request, _res: Response, next: NextFunction): void {
  next(new AppError(404, `Route not found: ${req.method} ${req.originalUrl}`))
}

/**
 * Global error handler — the final middleware in the stack.
 *
 * Distinguishes between operational errors (AppError) that are safe to
 * describe to the caller and unexpected errors that get a generic 500.
 * Stack traces are only logged in non-production environments.
 */
export const globalErrorHandler: ErrorRequestHandler = (
  err: unknown,
  _req: Request,
  res: Response,
  // `next` must be present even if unused — Express identifies error
  // handlers by arity (four parameters).
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _next: NextFunction,
) => {
  if (err instanceof AppError) {
    res.status(err.statusCode).json({ success: false, error: err.message })
    return
  }

  // Unexpected error — log full details server-side, return minimal info
  const message =
    err instanceof Error ? err.message : 'An unexpected error occurred'

  if (process.env.NODE_ENV !== 'production') {
    console.error('[error]', err)
  } else {
    console.error('[error]', message)
  }

  res.status(500).json({ success: false, error: 'Internal server error' })
}
