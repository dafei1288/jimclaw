import { Request, Response, NextFunction } from 'express';

/**
 * 自定义错误类
 */
export class AppError extends Error {
  constructor(
    public statusCode: number,
    public message: string,
    public isOperational = true
  ) {
    super(message);
    Object.setPrototypeOf(this, AppError.prototype);
    Error.captureStackTrace(this, this.constructor);
  }
}

/**
 * 错误处理中间件
 * 统一处理所有错误并返回标准化响应
 */
export function errorHandler(
  err: Error | AppError,
  req: Request,
  res: Response,
  next: NextFunction
): void {
  // 记录错误日志
  console.error('[错误]', {
    message: err.message,
    stack: err.stack,
    path: req.path,
    method: req.method,
    timestamp: new Date().toISOString()
  });

  // 处理自定义应用错误
  if (err instanceof AppError) {
    res.status(err.statusCode).json({
      error: err.message,
      timestamp: new Date().toISOString(),
      ...(process.env.NODE_ENV !== 'production' && { stack: err.stack })
    });
    return;
  }

  // 处理未知错误
  const statusCode = 500;
  const message = process.env.NODE_ENV === 'production'
    ? '内部服务器错误'
    : err.message || '未知错误';

  res.status(statusCode).json({
    error: message,
    timestamp: new Date().toISOString(),
    ...(process.env.NODE_ENV !== 'production' && {
      stack: err.stack,
      details: '未知错误类型'
    })
  });
}

/**
 * 异步路由包装器
 * 自动捕获异步路由中的错误并传递给错误处理中间件
 */
export function asyncHandler<T>(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<T>
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

/**
 * 404 处理器
 * 用于未匹配的路由
 */
export function notFoundHandler(req: Request, res: Response): void {
  res.status(404).json({
    error: 'Not Found',
    message: `路径 ${req.method} ${req.path} 不存在`,
    timestamp: new Date().toISOString()
  });
}
