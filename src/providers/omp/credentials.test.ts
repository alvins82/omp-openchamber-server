import { afterEach, describe, expect, test } from "bun:test";
import {
  CredentialInputError,
  credentialInputFingerprint,
  normalizeBackendCredentials,
  resetCredentialResolver,
  resolveBackendCredentials,
  setCredentialResolver,
} from "./credentials";

afterEach(() => {
  resetCredentialResolver();
});

describe("caller-owned OMP credentials", () => {
  test("normalizes direct credentials and infers the selected provider", () => {
    expect(normalizeBackendCredentials(
      {
        apiKey: "secret",
        baseUrl: "http://127.0.0.1:8080/v1",
        headers: { "X-Team": "jarvis" },
      },
      "llama.cpp",
    )).toEqual({
      providerID: "llama.cpp",
      apiKey: "secret",
      baseUrl: "http://127.0.0.1:8080/v1",
      headers: { "X-Team": "jarvis" },
      api: undefined,
      auth: undefined,
      authHeader: undefined,
      models: undefined,
    });
  });

  test("rejects an empty credential envelope", () => {
    expect(() => normalizeBackendCredentials({}, "openai")).toThrow(CredentialInputError);
  });

  test("resolves an opaque credentialRef through the installed resolver", async () => {
    let received: { ref: string; providerID?: string; modelID?: string; cwd: string } | undefined;
    setCredentialResolver(async (credentialRef, context) => {
      received = { ref: credentialRef, providerID: context.providerID, modelID: context.modelID, cwd: context.cwd };
      return { providerID: "openai", apiKey: "resolved-secret", baseUrl: "https://api.example.test/v1" };
    });

    await expect(resolveBackendCredentials(
      { credentialRef: "cred_org_123" },
      { cwd: "/workspace", openCodeId: "ses_1", providerID: "openai", modelID: "gpt-test" },
    )).resolves.toEqual({
      providerID: "openai",
      apiKey: "resolved-secret",
      baseUrl: "https://api.example.test/v1",
      api: undefined,
      auth: undefined,
      authHeader: undefined,
      headers: undefined,
      models: undefined,
    });
    expect(received).toEqual({
      ref: "cred_org_123",
      providerID: "openai",
      modelID: "gpt-test",
      cwd: "/workspace",
    });
  });

  test("requires exactly one credential input", async () => {
    await expect(resolveBackendCredentials(undefined, { cwd: "/workspace" })).resolves.toBeUndefined();
    await expect(resolveBackendCredentials(
      { credentials: { apiKey: "secret" }, credentialRef: "cred_1" },
      { cwd: "/workspace", providerID: "openai" },
    )).rejects.toThrow("provide exactly one");
  });

  test("fingerprints credential input without exposing the secret", () => {
    const first = credentialInputFingerprint({ credentials: { providerID: "openai", apiKey: "one" } });
    const second = credentialInputFingerprint({ credentials: { apiKey: "one", providerID: "openai" } });
    const third = credentialInputFingerprint({ credentials: { providerID: "openai", apiKey: "two" } });
    const fourth = credentialInputFingerprint({
      credentials: { apiKey: "one" },
      selectedProviderID: "openai",
    });
    const fifth = credentialInputFingerprint({
      credentials: { apiKey: "one" },
      selectedProviderID: "anthropic",
    });
    expect(first).toBe(second);
    expect(first).not.toBe(third);
    expect(first).not.toContain("one");
    expect(fourth).not.toBe(fifth);
  });
});
