import { generateKeyPair } from 'node:crypto';
import { createServer } from 'node:http';
import { promisify } from 'node:util';
import { afterAll, describe, expect, it } from 'vitest';
import { SignJWT, exportJWK, exportSPKI } from 'jose';
import { DevIdentityResolver, JwtIdentityResolver } from './identity.js';

const generate = promisify(generateKeyPair);
const keysPromise = generate('rsa', { modulusLength: 2048 });
const issuer = 'https://nyxid.example';
const audience = 'talos-service';

const token = async (overrides: Record<string, unknown> = {}): Promise<string> => {
  const { privateKey } = await keysPromise;
  return new SignJWT({ groups: ['eng'], permissions: ['tasks:submit'], ...overrides })
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
    .setSubject('alice')
    .setIssuer(issuer)
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(privateKey);
};

describe('identity resolvers', () => {
  afterAll(async () => { await keysPromise; });

  it('parses the development identity syntax', () => {
    const resolver = new DevIdentityResolver();
    expect(resolver.resolve('user:alice')).toEqual({ userId: 'alice', groups: [], permissions: [] });
    expect(resolver.resolve('user:alice;groups=eng,ops;permissions=tasks:submit')).toEqual({ userId: 'alice', groups: ['eng', 'ops'], permissions: ['tasks:submit'] });
    expect(resolver.resolve('user:alice;groups:eng,ops')).toMatchObject({ userId: 'alice', groups: ['eng', 'ops'] });
    expect(resolver.resolve('bad')).toBeUndefined();
  });

  it('verifies valid JWTs and defaults missing groups', async () => {
    const { publicKey } = await keysPromise;
    const publicKeyPem = await exportSPKI(publicKey);
    const resolver = new JwtIdentityResolver({ publicKey: publicKeyPem, issuer, audience });
    expect(await resolver.resolve(await token())).toMatchObject({ userId: 'alice', groups: ['eng'], permissions: ['tasks:submit'] });
    const noGroups = await new SignJWT({}).setProtectedHeader({ alg: 'RS256' }).setSubject('bob').setIssuer(issuer).setAudience(audience).setIssuedAt().setExpirationTime('1h').sign((await keysPromise).privateKey);
    expect(await resolver.resolve(noGroups)).toMatchObject({ userId: 'bob', groups: [] });
  });

  it('rejects wrong signature, expiry, issuer, audience, and future iat', async () => {
    const { publicKey } = await keysPromise;
    const resolver = new JwtIdentityResolver({ publicKey: await exportSPKI(publicKey), issuer, audience });
    const { privateKey: otherKey } = await generate('rsa', { modulusLength: 2048 });
    const wrongSignature = await new SignJWT({}).setProtectedHeader({ alg: 'RS256' }).setSubject('alice').setIssuer(issuer).setAudience(audience).setIssuedAt().setExpirationTime('1h').sign(otherKey);
    expect(await resolver.resolve(wrongSignature)).toBeUndefined();
    expect(await resolver.resolve(await token({}))).toBeDefined();
    const expired = await new SignJWT({}).setProtectedHeader({ alg: 'RS256' }).setSubject('alice').setIssuer(issuer).setAudience(audience).setIssuedAt(Math.floor(Date.now() / 1000) - 7200).setExpirationTime(Math.floor(Date.now() / 1000) - 3600).sign((await keysPromise).privateKey);
    expect(await resolver.resolve(expired)).toBeUndefined();
    const wrongAudience = await token();
    const wrongIssuer = await token();
    expect(await new JwtIdentityResolver({ publicKey: await exportSPKI(publicKey), issuer, audience: 'other' }).resolve(wrongAudience)).toBeUndefined();
    expect(await new JwtIdentityResolver({ publicKey: await exportSPKI(publicKey), issuer: 'other', audience }).resolve(wrongIssuer)).toBeUndefined();
    const future = await new SignJWT({}).setProtectedHeader({ alg: 'RS256' }).setSubject('alice').setIssuer(issuer).setAudience(audience).setIssuedAt(Math.floor(Date.now() / 1000) + 120).setExpirationTime(Math.floor(Date.now() / 1000) + 3600).sign((await keysPromise).privateKey);
    expect(await resolver.resolve(future)).toBeUndefined();
  });

  it('loads a keyed JWKS and selects the matching kid', async () => {
    const { publicKey, privateKey } = await keysPromise;
    const jwk = await exportJWK(publicKey);
    const jwksServer = createServer((_request, response) => {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ keys: [{ ...jwk, kid: 'test-key', alg: 'RS256', use: 'sig' }] }));
    });
    await new Promise<void>((resolve) => jwksServer.listen(0, '127.0.0.1', resolve));
    const address = jwksServer.address();
    if (address === null || typeof address === 'string') throw new Error('JWKS server did not bind');
    const resolver = new JwtIdentityResolver({ jwksUrl: `http://127.0.0.1:${address.port}/jwks`, issuer, audience });
    const signed = await new SignJWT({ groups: ['ops'] }).setProtectedHeader({ alg: 'RS256', kid: 'test-key' }).setSubject('alice').setIssuer(issuer).setAudience(audience).setIssuedAt().setExpirationTime('1m').sign(privateKey);
    await expect(resolver.resolve(signed)).resolves.toMatchObject({ userId: 'alice', groups: ['ops'] });
    await new Promise<void>((resolve, reject) => jwksServer.close((error) => error === undefined ? resolve() : reject(error)));
  });
});
