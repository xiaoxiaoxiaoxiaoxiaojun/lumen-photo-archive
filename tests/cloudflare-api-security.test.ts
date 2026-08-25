import assert from "node:assert/strict";
import { test } from "node:test";
import worker from "../cloudflare-api/worker.ts";

const allowedOrigin = "https://example.github.io";
const secret = "security-test-secret-with-enough-entropy";

function base64Url(value: string | ArrayBuffer) {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : new Uint8Array(value);
  return Buffer.from(bytes).toString("base64url");
}

async function session(email: string, extra: Record<string, unknown> = {}) {
  const payload = base64Url(JSON.stringify({
    sub: `google-${email}`,
    email,
    name: email.split("@")[0],
    exp: Date.now() + 60_000,
    ...extra,
  }));
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return `${payload}.${base64Url(signature)}`;
}

const env = {
  ALLOWED_ORIGIN: allowedOrigin,
  OWNER_GOOGLE_EMAIL: "owner@example.com",
  SESSION_SECRET: secret,
  GOOGLE_CLIENT_ID: "test-client.apps.googleusercontent.com",
} as never;

function apiRequest(path: string, token: string, method = "GET", origin = allowedOrigin) {
  return new Request(`https://api.example.workers.dev${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      origin,
      "x-lumen-request": "1",
    },
  });
}

test("viewer session is always read-only even if its payload contains isOwner", async () => {
  const token = await session("viewer@example.com", { isOwner: true });
  const me = await worker.fetch(apiRequest("/api/me", token), env);
  assert.equal(me.status, 200);
  assert.equal(me.headers.get("access-control-allow-origin"), allowedOrigin);
  assert.equal((await me.json() as { user: { isOwner: boolean } }).user.isOwner, false);

  const upload = await worker.fetch(apiRequest("/api/photos", token, "POST"), env);
  assert.equal(upload.status, 403);
  assert.match(await upload.text(), /只有相册主人可以上传照片/);

  const remove = await worker.fetch(apiRequest("/api/photos/photo-id", token, "DELETE"), env);
  assert.equal(remove.status, 403);
  assert.match(await remove.text(), /只有相册主人可以删除照片/);
});

test("owner permission is derived from the server-side email setting", async () => {
  const token = await session("owner@example.com", { isOwner: false });
  const response = await worker.fetch(apiRequest("/api/me", token), env);
  assert.equal(response.status, 200);
  assert.equal((await response.json() as { user: { isOwner: boolean } }).user.isOwner, true);
});

test("write requests from another origin are rejected before any storage access", async () => {
  const token = await session("owner@example.com");
  const response = await worker.fetch(apiRequest("/api/photos", token, "POST", "https://evil.example"), env);
  assert.equal(response.status, 403);
  assert.match(await response.text(), /安全检查/);
  assert.equal(response.headers.get("access-control-allow-origin"), null);
});

test("media objects require an unexpired server signature", async () => {
  const response = await worker.fetch(new Request("https://api.example.workers.dev/media/photo-id?exp=1&sig=fake"), env);
  assert.equal(response.status, 403);
});
