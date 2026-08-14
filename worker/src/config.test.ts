import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  defaultProfilePath,
  loadWorkerConfig,
  readWorkerConfigFile,
  writeWorkerConfigFile
} from './config.js';

const stored = {
  controlPlaneUrl: 'http://stored.example',
  machineId: 'stored-machine',
  workerId: 'stored-worker',
  workerToken: 'stored-token-123456',
  profilePath: '/stored/profile',
  heartbeatMs: 20000,
  pollMs: 1000,
  inputPollMs: 1000
};

describe('worker file configuration', () => {
  it('gives environment variables precedence over file values', () => {
    expect(loadWorkerConfig({
      TALOS_CONTROL_PLANE_URL: 'http://env.example',
      TALOS_MACHINE_ID: 'env-machine',
      TALOS_WORKER_TOKEN: 'env-token-12345678'
    }, stored)).toMatchObject({
      controlPlaneUrl: 'http://env.example',
      machineId: 'env-machine',
      workerId: 'stored-worker',
      workerToken: 'env-token-12345678'
    });
  });

  it('writes validated JSON with owner-only permissions', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'talos-config-')), 'nested', 'config.json');
    const config = loadWorkerConfig({}, stored);
    writeWorkerConfigFile(config, path);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readWorkerConfigFile(path)).toEqual(config);
    expect(readFileSync(path, 'utf8')).toContain('stored-machine');
  });

  it('accepts a control-plane URL with a NyxID public-proxy path prefix', () => {
    const config = loadWorkerConfig({
      TALOS_CONTROL_PLANE_URL: 'https://nyxid.example.com/public/s/talos-worker'
    }, stored);
    expect(config.controlPlaneUrl).toBe('https://nyxid.example.com/public/s/talos-worker');
  });

  it('loads interactive polling and idle timeout configuration from the environment', () => {
    const config = loadWorkerConfig({
      TALOS_ACTION_POLL_MS: '250',
      TALOS_SESSION_IDLE_MS: '5000'
    }, stored);
    expect(config).toMatchObject({ actionPollMs: 250, sessionIdleMs: 5000 });
  });

  it('defaults interactive action polling to two seconds', () => {
    expect(loadWorkerConfig({}, stored).actionPollMs).toBe(2000);
  });

  it('defaults the profile root beneath the worker home directory', () => {
    const withoutProfile = { ...stored, profilePath: undefined };
    expect(loadWorkerConfig({}, withoutProfile).profilePath).toBe(defaultProfilePath());
  });
});
