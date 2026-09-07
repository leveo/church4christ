import { env } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import {
  IDENTITY_DEVICE_COOKIE,
  resolveIdentityDeviceCookie,
} from '../src/lib/identityDeviceCookie';
import { scheduleIdentityDelivery } from '../src/lib/identityDelivery';

const authEnv = env as unknown as { IDENTITY_VERIFICATION_SECRET?: string };

describe('server-authenticated identity device cookie', () => {
  it('mints a versioned signed random device and accepts only that exact cookie', async () => {
    const minted = await resolveIdentityDeviceCookie(authEnv, null);
    expect(IDENTITY_DEVICE_COOKIE).toBe('c4c_identity_device');
    expect(minted.replaced).toBe(true);
    expect(minted.deviceId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(minted.cookieValue).toMatch(/^v1\.[0-9a-f-]{36}\.[0-9a-f]{64}$/u);

    await expect(resolveIdentityDeviceCookie(authEnv, minted.cookieValue)).resolves.toEqual({
      deviceId: minted.deviceId,
      cookieValue: minted.cookieValue,
      replaced: false,
    });
  });

  it.each([
    'attacker-chosen-device',
    `v1.11111111-1111-4111-8111-111111111111.${'0'.repeat(64)}`,
    `v2.11111111-1111-4111-8111-111111111111.${'0'.repeat(64)}`,
    'x'.repeat(4096),
  ])('replaces forged, malformed, or oversized input without using it as the bucket id', async (forged) => {
    const result = await resolveIdentityDeviceCookie(authEnv, forged);
    expect(result.replaced).toBe(true);
    expect(result.deviceId).not.toBe('11111111-1111-4111-8111-111111111111');
    expect(result.cookieValue).not.toBe(forged);
  });

  it('fails closed when the verification secret is unavailable and logs no signature', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(resolveIdentityDeviceCookie({}, null)).rejects.toThrow(/verification.*unavailable/i);
    expect(log).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    log.mockRestore();
    error.mockRestore();
  });
});

describe('non-blocking existence-neutral identity delivery', () => {
  it('awaits delivery when the execution context has no waitUntil', async () => {
    let release!: () => void;
    let resolved = false;
    const slow = new Promise<void>((resolve) => { release = resolve; });
    const delivery = scheduleIdentityDelivery(undefined, async () => { await slow; return true; })
      .then(() => { resolved = true; });
    await Promise.resolve();
    expect(resolved).toBe(false);
    release();
    await delivery;
    expect(resolved).toBe(true);
  });

  it('awaits delivery when waitUntil rejects registration synchronously', async () => {
    let release!: () => void; let resolved = false;
    const slow = new Promise<void>((resolve) => { release = resolve; });
    const delivery = scheduleIdentityDelivery({ waitUntil() { throw new Error('closed'); } }, async () => {
      await slow; return true;
    }).then(() => { resolved = true; });
    await Promise.resolve();
    expect(resolved).toBe(false);
    release();
    await delivery;
    expect(resolved).toBe(true);
  });

  it('hands a slow known-owner delivery to waitUntil without awaiting it', async () => {
    let release!: () => void;
    const slow = new Promise<void>((resolve) => { release = resolve; });
    const waitUntil = vi.fn<(promise: Promise<unknown>) => void>();
    const deliver = vi.fn(async () => { await slow; return true; });

    const registered = scheduleIdentityDelivery({ waitUntil }, deliver);
    expect(waitUntil).toHaveBeenCalledTimes(1);
    expect(deliver).not.toHaveBeenCalled();
    await expect(registered).resolves.toBe(true);
    await Promise.resolve();
    expect(deliver).toHaveBeenCalledTimes(1);
    release();
    await waitUntil.mock.calls[0][0];
  });

  it('schedules the unknown-owner no-op through the same category', async () => {
    const waitUntil = vi.fn<(promise: Promise<unknown>) => void>();
    await expect(scheduleIdentityDelivery({ waitUntil }, async () => false)).resolves.toBe(true);
    expect(waitUntil).toHaveBeenCalledTimes(1);
    await expect(waitUntil.mock.calls[0][0]).resolves.toBe(false);
  });
});
