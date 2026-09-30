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
  mail: {
    /** 'smtp' delivers, 'log' writes to the server log, anything else is off. */
    transport: string;
    from: string;
    host: string;
    port: number;
    secure: boolean;
    user: string;
    pass: string;
  };
  /**
   * Where the web app lives, used to build a password-reset link.
   *
   * Configured rather than taken from the request's Host header, and that is
   * the whole point: a reset link built from a header is one an attacker can
   * aim at their own server by sending `Host: evil.example`, and the victim
   * clicking it hands over a live token. The header is attacker-controlled
   * input; this is not.
   */
  webUrl: string;
  passwordReset: {
    /** Minutes a link stays usable. */
    ttlMinutes: number;
    /** The same, for vendor console accounts. Deliberately shorter. */
    platformTtlMinutes: number;
    /**
     * Minutes after a vendor self-service reset during which `openGrant`
     * refuses. `0` disables it.
     */
    platformGrantCooldownMinutes: number;
  };
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
  mail: {
    transport: process.env.MAIL_TRANSPORT ?? '',
    from: process.env.MAIL_FROM ?? 'no-reply@localhost',
    host: process.env.SMTP_HOST ?? '',
    port: parseInt(process.env.SMTP_PORT ?? '587', 10),
    // Explicit string comparison rather than truthiness: `SMTP_SECURE=false`
    // is a string and is therefore truthy, which would turn "off" into "on"
    // for anybody who wrote the setting out rather than leaving it blank.
    secure: (process.env.SMTP_SECURE ?? '').toLowerCase() === 'true',
    user: process.env.SMTP_USER ?? '',
    pass: process.env.SMTP_PASS ?? '',
  },
  webUrl: (process.env.WEB_URL ?? 'http://localhost:3001').replace(/\/+$/, ''),
  passwordReset: {
    /*
     * Thirty minutes. Long enough to walk to a computer and short enough that a
     * link left in a mailbox is not a standing key — which matters more here
     * than the usual argument, because a shared clinic mailbox is exactly the
     * kind of address a small practice signs up with.
     */
    ttlMinutes: parseInt(process.env.PASSWORD_RESET_TTL_MINUTES ?? '30', 10),
    /*
     * Fifteen rather than thirty. The same link, half the window, because the
     * blast radius is not the same: a hospital account reaches one hospital and
     * can be undone by its administrator or by the vendor, and this one reaches
     * every hospital on the deployment.
     */
    platformTtlMinutes: parseInt(process.env.PLATFORM_RESET_TTL_MINUTES ?? '15', 10),
    /*
     * One hour, and this is the control that makes emailed recovery defensible
     * for a vendor account rather than merely convenient.
     *
     * The realistic attack is a compromised mailbox followed immediately by a
     * break-glass grant into somebody's patient data. A password reset is rare
     * and planned; a grant minutes after one is not. So the console keeps
     * working — tenants, applications, subscriptions, modules — and reaching
     * *inside* a hospital waits an hour.
     *
     * The cost is real and lands on a real person: an engineer who has just
     * reset their password at 3am waits, or asks a colleague to open the grant.
     * Set `PLATFORM_RESET_GRANT_COOLDOWN_MINUTES=0` to switch it off if that
     * trade is wrong for your operation — it is a decision, not a law.
     */
    platformGrantCooldownMinutes: parseInt(
      process.env.PLATFORM_RESET_GRANT_COOLDOWN_MINUTES ?? '60',
      10,
    ),
  },
});
