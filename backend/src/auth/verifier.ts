import { createRemoteJWKSet, decodeJwt, jwtVerify, type JWTVerifyGetKey } from "jose";

/** Identity extracted from a verified token. */
export interface AuthUser {
  uid: string;
  email: string;
  emailVerified: boolean;
  displayName: string | null;
}

export class AuthError extends Error {}

export interface TokenVerifier {
  verify(token: string): Promise<AuthUser>;
}

/** Firebase publishes ID-token signing keys in JWK format at this endpoint. */
const FIREBASE_JWKS_URL =
  "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com";

function toAuthUser(payload: Record<string, unknown>): AuthUser {
  const uid = String(payload.sub ?? "");
  if (!uid) throw new AuthError("Token has no subject");
  return {
    uid,
    email: typeof payload.email === "string" ? payload.email.toLowerCase() : "",
    emailVerified: payload.email_verified === true,
    displayName: typeof payload.name === "string" ? payload.name : null,
  };
}

/**
 * Verifies Firebase ID tokens: RS256 signature against Google's JWKS plus
 * issuer, audience, expiry and subject checks.
 */
export class FirebaseVerifier implements TokenVerifier {
  private readonly jwks: JWTVerifyGetKey;
  private readonly issuer: string;

  constructor(private readonly projectId: string, jwks?: JWTVerifyGetKey) {
    if (!projectId) throw new Error("FirebaseVerifier requires a project id");
    this.jwks = jwks ?? createRemoteJWKSet(new URL(FIREBASE_JWKS_URL));
    this.issuer = `https://securetoken.google.com/${projectId}`;
  }

  async verify(token: string): Promise<AuthUser> {
    try {
      const { payload } = await jwtVerify(token, this.jwks, {
        issuer: this.issuer,
        audience: this.projectId,
        algorithms: ["RS256"],
      });
      return toAuthUser(payload as Record<string, unknown>);
    } catch (err) {
      if (err instanceof AuthError) throw err;
      throw new AuthError(`Invalid token: ${(err as Error).message}`);
    }
  }
}

/**
 * Firebase Auth Emulator tokens are unsigned (alg "none"). Only constructed
 * when FIREBASE_AUTH_EMULATOR_HOST is set and NODE_ENV is not production.
 */
export class EmulatorVerifier implements TokenVerifier {
  constructor(private readonly projectId: string) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("EmulatorVerifier must never be used in production");
    }
  }

  async verify(token: string): Promise<AuthUser> {
    try {
      const payload = decodeJwt(token);
      if (payload.aud !== this.projectId) throw new AuthError("Wrong audience");
      if (payload.iss !== `https://securetoken.google.com/${this.projectId}`) {
        throw new AuthError("Wrong issuer");
      }
      if (typeof payload.exp !== "number" || payload.exp * 1000 < Date.now()) {
        throw new AuthError("Token expired");
      }
      return toAuthUser(payload as Record<string, unknown>);
    } catch (err) {
      if (err instanceof AuthError) throw err;
      throw new AuthError(`Invalid emulator token: ${(err as Error).message}`);
    }
  }
}

/**
 * Test/dev verifier backed by a static token map. Also used for
 * AUTH_MODE=disabled, where every request maps to one local user.
 */
export class StaticVerifier implements TokenVerifier {
  constructor(private readonly tokens: Map<string, AuthUser>) {}

  async verify(token: string): Promise<AuthUser> {
    const user = this.tokens.get(token);
    if (!user) throw new AuthError("Unknown token");
    return user;
  }
}

/** The single local identity used when AUTH_MODE=disabled. */
export const LOCAL_USER: AuthUser = {
  uid: "local",
  email: "local@localhost",
  emailVerified: true,
  displayName: "Local user",
};

export class DisabledAuthVerifier implements TokenVerifier {
  async verify(): Promise<AuthUser> {
    return LOCAL_USER;
  }
}
