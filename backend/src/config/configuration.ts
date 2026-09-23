export interface AppConfig {
  nodeEnv: string;
  port: number;
  jwt: {
    accessSecret: string;
    refreshSecret: string;
    accessTtl: string;
    refreshTtlDays: number;
  };
  corsOrigins: string[];
}

/*
 * There is deliberately no HOSPITAL_TIMEZONE here any more.
 *
 * It existed when the clinic day was a process-wide constant, and multi-tenancy
 * made it meaningless: two hospitals on one deployment keep different clocks,
 * so the timezone belongs to the tenant row and is resolved per request by
 * `ClinicSettingsService`. The variable survived the change, was read by
 * nothing, and stayed in `.env.example` looking load-bearing — which is worse
 * than absent, because someone deploying reads it as the setting that decides
 * what "today" means and then cannot work out why changing it does nothing.
 *
 * `Tenant.timezone` is the answer, set from Admin → Clinic Settings.
 */

export default (): AppConfig => ({
  nodeEnv: process.env.NODE_ENV ?? 'development',
  port: parseInt(process.env.PORT ?? '3000', 10),
  jwt: {
    accessSecret: process.env.JWT_ACCESS_SECRET as string,
    refreshSecret: process.env.JWT_REFRESH_SECRET as string,
    accessTtl: process.env.JWT_ACCESS_TTL ?? '15m',
    refreshTtlDays: parseInt(process.env.JWT_REFRESH_TTL_DAYS ?? '7', 10),
  },
  corsOrigins: (process.env.CORS_ORIGINS ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean),
});
