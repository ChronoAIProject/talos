import { createPublicKey, type KeyObject } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify, type RemoteJWKSet } from 'jose';

export interface ResolvedIdentity {
  userId: string;
  groups: readonly string[];
  permissions: readonly string[];
}

export interface IdentityResolver {
  resolve(token: string): Promise<ResolvedIdentity | undefined> | ResolvedIdentity | undefined;
}

export class DevIdentityResolver implements IdentityResolver {
  public resolve(token: string): ResolvedIdentity | undefined {
    if (!token.startsWith('user:')) return undefined;
    const [userPart = '', ...attributes] = token.split(';');
    const userId = userPart.slice(5);
    if (userId.length === 0) return undefined;
    const groups = attributes.find((value) => value.startsWith('groups='))?.slice(7).split(',').filter(Boolean) ?? [];
    const permissions = attributes.find((value) => value.startsWith('permissions='))?.slice(12).split(',').filter(Boolean) ?? [];
    return { userId, groups, permissions };
  }
}

export interface JwtIdentityResolverOptions {
  publicKey?: string;
  jwksUrl?: string;
  issuer: string;
  audience: string;
}

export class JwtIdentityResolver implements IdentityResolver {
  private readonly key: KeyObject | RemoteJWKSet;
  private readonly options: JwtIdentityResolverOptions;

  public constructor(options: JwtIdentityResolverOptions) {
    if ((options.publicKey === undefined) === (options.jwksUrl === undefined)) throw new Error('configure exactly one NyxID JWT public key or JWKS URL');
    this.key = options.publicKey === undefined
      ? createRemoteJWKSet(new URL(options.jwksUrl as string))
      : createPublicKey(options.publicKey);
    this.options = options;
  }

  public async resolve(token: string): Promise<ResolvedIdentity | undefined> {
    try {
      const verified = await jwtVerify(token, this.key, { algorithms: ['RS256'], issuer: this.options.issuer, audience: this.options.audience });
      const subject = typeof verified.payload.sub === 'string' ? verified.payload.sub : undefined;
      if (subject === undefined) return undefined;
      return {
        userId: subject,
        groups: stringArray(verified.payload.groups),
        permissions: stringArray(verified.payload.permissions)
      };
    } catch {
      return undefined;
    }
  }
}

const stringArray = (value: unknown): readonly string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
