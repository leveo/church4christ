export type IdentityDeliveryContext = {
  waitUntil(promise: Promise<unknown>): void;
};

/** Schedules both real delivery and existence-neutral no-op work identically. */
export function scheduleIdentityDelivery(
  context: IdentityDeliveryContext | null | undefined,
  deliver: () => Promise<boolean>,
): Promise<boolean> {
  const scheduled = Promise.resolve().then(deliver).catch(() => false);
  if (!context?.waitUntil) return scheduled;
  try {
    context.waitUntil(scheduled);
  } catch {
    // A closed context cannot keep background work alive, so the caller awaits
    // the same handled delivery instead of reporting a false scheduled state.
    return scheduled;
  }
  return Promise.resolve(true);
}
