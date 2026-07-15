import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { reefSetupWizard } from "./setup.js";

const temporaryDirs: string[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(
    temporaryDirs.splice(0).map(async (dir) => await fs.rm(dir, { recursive: true, force: true })),
  );
});

describe("reefSetupWizard", () => {
  it("declares the persistence boundary before writing identity keys", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-reef-setup-"));
    temporaryDirs.push(stateDir);
    const persistenceBlocked = new Error("stop before persistence");
    const events: string[] = [];
    const text = vi.fn(async ({ message }: { message: string }) => {
      events.push(message);
      const answers: Record<string, string> = {
        "Reef relay URL": "https://reef.example",
        Email: "alice@example.com",
        "Existing setup session (optional)": "setup-session",
        "Handle (without @)": "alice",
        "Local Reef state directory": stateDir,
        "Pinned guard model snapshot": "claude-sonnet-4-6",
        "Guard API key environment variable name": "ANTHROPIC_API_KEY",
        "Guard policy version": "reef-v1",
      };
      return answers[message] ?? "";
    });
    const select = vi.fn(async ({ message }: { message: string }) => {
      events.push(message);
      return message === "Guard provider" ? "anthropic" : "code-only";
    });
    const note = vi.fn(async () => undefined);

    await expect(
      reefSetupWizard.configureInteractive({
        cfg: {} as OpenClawConfig,
        prompter: {
          note,
          text,
          select,
        },
        options: {
          beforePersistentEffect: vi.fn(async () => {
            events.push("persistent boundary");
            throw persistenceBlocked;
          }),
        },
      }),
    ).rejects.toBe(persistenceBlocked);

    await expect(fs.stat(path.join(stateDir, "keys.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(events).toContain("Guard policy version");
    expect(events.indexOf("Guard policy version")).toBeLessThan(
      events.indexOf("persistent boundary"),
    );
    expect(events.at(-1)).toBe("persistent boundary");
    expect(note).not.toHaveBeenCalled();
  });

  it("crosses the persistence boundary before starting magic-link authentication", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-reef-auth-"));
    temporaryDirs.push(stateDir);
    const events: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = new URL(input instanceof Request ? input.url : input.toString());
        events.push(`fetch ${url.pathname}`);
        const body =
          url.pathname === "/v1/auth/start"
            ? { status: "sent", magicLink: "https://reef.example/welcome" }
            : url.pathname === "/v1/auth/complete"
              ? { session: "setup-session", expires: 1 }
              : { handle: "alice", key_epoch: 1 };
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    );
    const text = vi.fn(async ({ message }: { message: string }) => {
      events.push(message);
      const answers: Record<string, string> = {
        "Reef relay URL": "https://reef.example",
        Email: "alice@example.com",
        "Existing setup session (optional)": "",
        "Handle (without @)": "alice",
        "Local Reef state directory": stateDir,
        "Magic-link token": "token",
        "Pinned guard model snapshot": "claude-sonnet-4-6",
        "Guard API key environment variable name": "ANTHROPIC_API_KEY",
        "Guard policy version": "reef-v1",
      };
      return answers[message] ?? "";
    });
    let fingerprintObservedAfterPersistence = false;

    await reefSetupWizard.configureInteractive({
      cfg: {} as OpenClawConfig,
      prompter: {
        note: vi.fn(async (message: string, title?: string) => {
          events.push(`note ${message}`);
          if (title === "Reef safety fingerprint — share out of band") {
            await expect(fs.stat(path.join(stateDir, "keys.json"))).resolves.toBeDefined();
            fingerprintObservedAfterPersistence = true;
          }
        }),
        text,
        select: vi.fn(async ({ message }: { message: string }) => {
          events.push(message);
          return message === "Guard provider" ? "anthropic" : "code-only";
        }),
      },
      options: {
        beforePersistentEffect: vi.fn(async () => {
          events.push("persistent boundary");
        }),
      },
    });

    expect(events.indexOf("persistent boundary")).toBeLessThan(
      events.indexOf("fetch /v1/auth/start"),
    );
    expect(events.indexOf("persistent boundary")).toBeLessThan(events.indexOf("Magic-link token"));
    expect(events.filter((event) => event === "persistent boundary")).toHaveLength(3);
    expect(fingerprintObservedAfterPersistence).toBe(true);
    expect(
      events.lastIndexOf("persistent boundary", events.indexOf("fetch /v1/auth/complete")),
    ).toBeGreaterThan(events.indexOf("Magic-link token"));
    expect(events.lastIndexOf("persistent boundary")).toBeGreaterThan(
      events.indexOf("Guard policy version"),
    );
    expect(events.indexOf("Guard policy version")).toBeLessThan(
      events.indexOf("fetch /v1/auth/complete"),
    );
    expect(events.slice(events.indexOf("fetch /v1/auth/complete") + 1)).toEqual([
      "fetch /v1/handles",
    ]);
  });
});
