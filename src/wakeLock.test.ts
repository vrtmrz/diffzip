import { type ScreenWakeLockEvent, type ScreenWakeLockSentinel } from "octagonal-wheels/browser/wakeLock";
import { createDiffZipWakeLock, runWithDiffZipWakeLock } from "./wakeLock.ts";

declare const Deno: {
    test: (name: string, fn: () => void | Promise<void>) => void;
};

function assert(condition: unknown, message: string): asserts condition {
    if (!condition) throw new Error(message);
}

function assertEquals<T>(actual: T, expected: T, message: string): void {
    if (actual !== expected) {
        throw new Error(`${message}: expected=${String(expected)}, actual=${String(actual)}`);
    }
}

class FakeSentinel implements ScreenWakeLockSentinel {
    released = false;
    releaseCalls = 0;
    listeners = new Set<() => void>();

    addEventListener(_type: "release", listener: () => void): void {
        this.listeners.add(listener);
    }

    removeEventListener(_type: "release", listener: () => void): void {
        this.listeners.delete(listener);
    }

    async release(): Promise<void> {
        if (this.released) return;
        this.released = true;
        this.releaseCalls++;
        for (const listener of this.listeners) listener();
    }
}

Deno.test("DiffZip wake lock: protects a backup and releases after completion", async () => {
    const sentinel = new FakeSentinel();
    const events: ScreenWakeLockEvent[] = [];
    const wakeLock = createDiffZipWakeLock({
        provider: { request: async () => sentinel },
        document: null,
        onEvent: (event) => events.push(event),
    });

    const result = await runWithDiffZipWakeLock(wakeLock, "differential-backup", async () => {
        assert(wakeLock.held, "The platform wake lock should be held while the backup runs");
        return "completed";
    });

    assertEquals(result, "completed", "The backup result should be preserved");
    assertEquals(wakeLock.activeLeaseCount, 0, "The logical lease should be released");
    assertEquals(sentinel.releaseCalls, 1, "The platform wake lock should be released once");
    assert(
        events.some((event) => event.type === "lease-acquired" && event.label === "differential-backup"),
        "The diagnostic label should identify the backup operation"
    );
    await wakeLock.dispose();
});

Deno.test("DiffZip wake lock: releases when a backup exits early", async () => {
    const sentinel = new FakeSentinel();
    const wakeLock = createDiffZipWakeLock({
        provider: { request: async () => sentinel },
        document: null,
    });

    const result = await runWithDiffZipWakeLock(wakeLock, "differential-backup", () => "cancelled");

    assertEquals(result, "cancelled", "An early backup result should be preserved");
    assertEquals(wakeLock.activeLeaseCount, 0, "An early exit should release the logical lease");
    assertEquals(sentinel.releaseCalls, 1, "An early exit should release the platform wake lock");
    await wakeLock.dispose();
});

Deno.test("DiffZip wake lock: releases and preserves a backup error", async () => {
    const sentinel = new FakeSentinel();
    const wakeLock = createDiffZipWakeLock({
        provider: { request: async () => sentinel },
        document: null,
    });
    const expected = new Error("backup failed");
    let caught: unknown;

    try {
        await runWithDiffZipWakeLock(wakeLock, "selective-sync-send", () => {
            throw expected;
        });
    } catch (error) {
        caught = error;
    }

    assertEquals(caught, expected, "The original backup error should propagate");
    assertEquals(wakeLock.activeLeaseCount, 0, "An error should release the logical lease");
    assertEquals(sentinel.releaseCalls, 1, "An error should release the platform wake lock");
    await wakeLock.dispose();
});

Deno.test("DiffZip wake lock: unsupported platforms still run the backup", async () => {
    const wakeLock = createDiffZipWakeLock({ provider: null, document: null });
    let ran = false;

    await runWithDiffZipWakeLock(wakeLock, "differential-backup", () => {
        ran = true;
    });

    assert(ran, "The backup should run when the Screen Wake Lock API is unavailable");
    assertEquals(wakeLock.activeLeaseCount, 0, "The unsupported run should not leak a logical lease");
    await wakeLock.dispose();
});
