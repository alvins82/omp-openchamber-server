import { describe, expect, test } from "bun:test";
import { checkForOmpUpdate, OMP_UPDATE_CHECK_INTERVAL_MS } from "./update-check";

describe("checkForOmpUpdate", () => {
  test("reports a newer stable release", async () => {
    let requestedUrl = "";
    const result = await checkForOmpUpdate("18.1.15", async (input, init) => {
      requestedUrl = String(input);
      expect(init?.headers).toMatchObject({
        Accept: "application/vnd.github+json",
        "User-Agent": "omp-openchamber-server",
      });
      return new Response(JSON.stringify({ tag_name: "v18.2.0" }), { status: 200 });
    });

    expect(requestedUrl).toBe("https://api.github.com/repos/can1357/oh-my-pi/releases/latest");
    expect(result).toEqual({
      currentVersion: "18.1.15",
      latestVersion: "18.2.0",
      updateAvailable: true,
    });
  });

  test("does not report an equal or older release", async () => {
    const equal = await checkForOmpUpdate("18.1.15", async () =>
      new Response(JSON.stringify({ tag_name: "v18.1.15" }), { status: 200 }),
    );
    const older = await checkForOmpUpdate("18.1.15", async () =>
      new Response(JSON.stringify({ tag_name: "v18.1.14" }), { status: 200 }),
    );

    expect(equal.updateAvailable).toBe(false);
    expect(older.updateAvailable).toBe(false);
  });

  test("rejects malformed release metadata", async () => {
    await expect(
      checkForOmpUpdate("18.1.15", async () =>
        new Response(JSON.stringify({ tag_name: "latest" }), { status: 200 }),
      ),
    ).rejects.toThrow("no valid stable version");
  });
});

test("checks for updates every four hours", () => {
  expect(OMP_UPDATE_CHECK_INTERVAL_MS).toBe(4 * 60 * 60 * 1_000);
});
