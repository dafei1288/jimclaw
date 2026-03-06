/**
 * 类型定义
 */

/**
 * 标准 API 响应
 */
export interface ApiResponse<T = any> {
  success: boolean;
  data?: T;
  error?: string;
  timestamp: string;
}

/**
 * 分页参数
 */
export interface PaginationParams {
  page: number;
  limit: number;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
}

/**
 * 分页响应
 */
export interface PaginatedResponse<T> {
  items: T[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

/**
 * 用户输入验证架构
 */
export interface CreateUserInput {
  name: string;
  email: string;
  password: string;
}

export interface UpdateUserInput {
  name?: string;
  email?: string;
}

export interface UserResponse {
  id: string;
  name: string;
  email: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * HTTP 错误响应
 */
export interface ErrorResponse {
  error: string;
  message?: string;
  timestamp: string;
  stack?: string;
}

/**
 * 健康检查响应
 */
export interface HealthCheckResponse {
  status: 'healthy' | 'unhealthy';
  timestamp: string;
  uptime: number;
  environment: string;
  version?: string;
}

/**
 * 服务状态
 */
export enum ServiceStatus {
  HEALTHY = 'healthy',
  UNHEALTHY = 'unhealthy',
  DEGRADED = 'degraded'
}

/**
 * 环境变量
 */
export interface EnvConfig {
  NODE_ENV: 'development' | 'production' | 'test';
  PORT: string;
  CORS_ORIGIN?: string;
  DATABASE_URL?: string;
  JWT_SECRET?: string;
  LOG_LEVEL?: string;
}

/**
 * 获取环境变量（带类型安全）
 */
export function getEnv(): EnvConfig {
  return {
    NODE_ENV: (process.env.NODE_ENV as any) || 'development',
    PORT: process.env.PORT || '3000',
    CORS_ORIGIN: process.env.CORS_ORIGIN,
    DATABASE_URL: process.env.DATABASE_URL,
    JWT_SECRET: process.env.JWT_SECRET,
    LOG_LEVEL: process.env.LOG_LEVEL || 'info'
  };
}

/**
 * 验证环境变量
 */
export function validateEnv(): { valid: boolean; missing: string[] } {
  const required: (keyof EnvConfig)[] = ['NODE_ENV', 'PORT'];
  const missing: string[] = [];

  for (const key of required) {
    if (!process.env[key]) {
      missing.push(key);
    }
  }

  return {
    valid: missing.length === 0,
    missing
  };
}
