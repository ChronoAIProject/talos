import { createPublicKey, type KeyObject } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify, type RemoteJWKSet } from 'jose';
import {
  testingAuthenticatedTransportContextSchema,
  type TestingAuthenticatedTransportContext
} from '@talos/testing-protocol';

export interface ResolvedIdentity {
  userId: string;
  groups: readonly string[];
  permissions: readonly string[];
  authenticatedTransport?: TestingAuthenticatedTransportContext;
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
    const groups = parseAttribute(attributes, 'groups');
    const permissions = parseAttribute(attributes, 'permissions');
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
    if (options.jwksUrl !== undefined && !['http:', 'https:'].includes(new URL(options.jwksUrl).protocol)) throw new Error('NyxID JWKS URL must use http or https');
    this.key = options.publicKey === undefined
      ? createRemoteJWKSet(new URL(options.jwksUrl as string))
      : createPublicKey(options.publicKey);
    this.options = options;
  }

  public async resolve(token: string): Promise<ResolvedIdentity | undefined> {
    try {
      const verified = await jwtVerify(token, this.key, {
        algorithms: ['RS256'],
        issuer: this.options.issuer,
        audience: this.options.audience,
        maxTokenAge: '60s'
      });
      const subject = typeof verified.payload.sub === 'string' ? verified.payload.sub : undefined;
      if (subject === undefined) return undefined;
      const issuedAt = verified.payload.iat;
      const expiresAt = verified.payload.exp;
      if (typeof issuedAt !== 'number' || typeof expiresAt !== 'number' || issuedAt > Math.floor(Date.now() / 1000) + 60) return undefined;
      const authenticatedTransport = verified.payload.nyxid_transport === undefined
        ? undefined
        : testingAuthenticatedTransportContextSchema.parse(verified.payload.nyxid_transport);
      if (authenticatedTransport !== undefined && authenticatedTransport.subject !== subject) return undefined;
      return {
        userId: subject,
        groups: stringArray(verified.payload.groups),
        permissions: stringArray(verified.payload.permissions),
        ...(authenticatedTransport === undefined ? {} : { authenticatedTransport })
      };
    } catch {
      return undefined;
    }
  }
}

const stringArray = (value: unknown): readonly string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

const parseAttribute = (attributes: readonly string[], name: string): readonly string[] => {
  const attribute = attributes.find((value) => value.startsWith(`${name}=`) || value.startsWith(`${name}:`));
  if (attribute === undefined) return [];
  const separator = attribute.indexOf('=') >= 0 ? '=' : ':';
  return attribute.slice(attribute.indexOf(separator) + 1).split(',').filter(Boolean);
};
