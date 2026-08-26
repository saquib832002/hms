import { SetMetadata } from '@nestjs/common';

export const IS_PLATFORM_ROUTE_KEY = 'isPlatformRoute';

/**
 * Marks a route as belonging to the vendor's platform API, authenticated by
 * `PlatformGuard` instead of `JwtAuthGuard`.
 *
 * WHY NOT JUST REUSE @Public()
 * ----------------------------
 * `@Public()` means "anyone may call this, signed in or not" — login, refresh,
 * health. Platform routes are the opposite: they need *stronger* credentials
 * than a hospital login, from an account no hospital holds.
 *
 * Reusing `@Public()` would work mechanically and read as a lie. The access
 * matrix asserts that exactly four routes are public, and that assertion is one
 * of the more valuable lines in the suite; folding a dozen vendor endpoints
 * into it would turn "these four are open to the world" into a sentence nobody
 * could trust. So this is its own key, with its own assertions.
 */
export const PlatformRoute = () => SetMetadata(IS_PLATFORM_ROUTE_KEY, true);
