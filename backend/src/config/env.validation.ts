/**
 * Fails fast at boot rather than at the first request. A backend that starts
 * with a missing JWT secret and only falls over when someone tries to log in
 * is a worse failure than one that refuses to start.
 */
export function validateEnv(config: Record<string, unknown>): Record<string, unknown> {
  const required = ['DATABASE_URL', 'JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET'];
  const missing = required.filter((k) => !config[k]);

  if (missing.length) {
    throw new Error(
      `Missing required environment variables: ${missing.join(', ')}. ` +
        `Copy .env.example to .env and fill them in.`,
    );
  }

  const isProd = config.NODE_ENV === 'production';
  if (isProd) {
    for (const key of ['JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET']) {
      const val = String(config[key]);
      if (val.includes('dev-only')) {
        throw new Error(`${key} still holds the development placeholder. Refusing to start.`);
      }
      if (val.length < 32) {
        throw new Error(`${key} must be at least 32 characters in production.`);
      }
    }
  }

  return config;
}
