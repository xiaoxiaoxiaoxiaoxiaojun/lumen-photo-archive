import { createRemoteJWKSet, jwtVerify } from "jose";
import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";

interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  PHOTOS: R2Bucket;
  GOOGLE_CLIENT_ID?: string;
  SESSION_SECRET?: string;
  OWNER_GOOGLE_EMAIL?: string;
  IMAGES: {
    input(stream: ReadableStream): {
      transform(options: Record<string, unknown>): {
        output(options: { format: string; quality: number }): Promise<{ response(): Response }>;
      };
    };
  };
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

type SessionUser = {
  sub: string;
  email: string;
  name: string;
  picture?: string;
  isOwner: boolean;
};

type SessionPayload = SessionUser & { exp: number };

const googleKeys = createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs"));
const encoder = new TextEncoder();
let schemaReady = false;

const json = (data: unknown, init?: ResponseInit) => new Response(JSON.stringify(data), {
  ...init,
  headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...init?.headers },
});

async function ensureSchema(env: Env) {
  if (schemaReady) return;
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS photos (
      id TEXT PRIMARY KEY,
      object_key TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT '旅途',
      location TEXT NOT NULL DEFAULT '',
      captured_at TEXT NOT NULL DEFAULT '',
      content_type TEXT NOT NULL,
      owner_sub TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )`),
    env.DB.prepare("CREATE INDEX IF NOT EXISTS photos_created_at_idx ON photos (created_at)"),
  ]);
  schemaReady = true;
}

function bytesToBase64Url(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function base64UrlToBytes(value: string) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(normalized);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

async function importSessionKey(secret: string) {
  return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

async function createSession(user: SessionUser, secret: string) {
  const payload = bytesToBase64Url(encoder.encode(JSON.stringify({ ...user, exp: Date.now() + 7 * 24 * 60 * 60 * 1000 })));
  const signature = await crypto.subtle.sign("HMAC", await importSessionKey(secret), encoder.encode(payload));
  return `${payload}.${bytesToBase64Url(new Uint8Array(signature))}`;
}

function cookieValue(request: Request, name: string) {
  const cookies = request.headers.get("cookie") || "";
  return cookies.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${name}=`))?.slice(name.length + 1) || "";
}

async function readSession(request: Request, env: Env): Promise<SessionUser | null> {
  const token = cookieValue(request, "lumen_session");
  if (!token || !env.SESSION_SECRET) return null;
  const [payload, signature] = token.split(".");
  if (!payload || !signature) return null;
  try {
    const valid = await crypto.subtle.verify("HMAC", await importSessionKey(env.SESSION_SECRET), base64UrlToBytes(signature), encoder.encode(payload));
    if (!valid) return null;
    const parsed = JSON.parse(new TextDecoder().decode(base64UrlToBytes(payload))) as SessionPayload;
    if (!parsed.exp || parsed.exp < Date.now() || !parsed.sub) return null;
    const { exp: _exp, ...user } = parsed;
    return user;
  } catch {
    return null;
  }
}

function sameOriginWrite(request: Request) {
  const origin = request.headers.get("origin");
  return request.headers.get("x-lumen-request") && (!origin || origin === new URL(request.url).origin);
}

function sessionCookie(value: string, request: Request) {
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return `lumen_session=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800${secure}`;
}

function cleanText(value: FormDataEntryValue | null, max = 80) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function photoFromRow(row: Record<string, unknown>) {
  const id = String(row.id);
  return {
    id,
    title: String(row.title),
    category: String(row.category),
    location: String(row.location),
    capturedAt: String(row.captured_at),
    createdAt: Number(row.created_at),
    url: `/media/${encodeURIComponent(id)}`,
  };
}

async function api(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  const path = url.pathname;

  if (path === "/api/config" && request.method === "GET") {
    return json({ googleClientId: env.GOOGLE_CLIENT_ID || "" });
  }

  if (path === "/api/me" && request.method === "GET") {
    return json({ user: await readSession(request, env) });
  }

  if (path === "/api/auth/google" && request.method === "POST") {
    if (!sameOriginWrite(request)) return json({ error: "登录请求未通过安全检查。" }, { status: 403 });
    if (!env.GOOGLE_CLIENT_ID || !env.SESSION_SECRET) return json({ error: "Google 登录尚未配置完成。" }, { status: 503 });
    try {
      const body = await request.json() as { credential?: string };
      if (!body.credential) return json({ error: "没有收到 Google 登录凭证。" }, { status: 400 });
      const { payload } = await jwtVerify(body.credential, googleKeys, {
        audience: env.GOOGLE_CLIENT_ID,
        issuer: ["https://accounts.google.com", "accounts.google.com"],
      });
      if (!payload.sub || !payload.email || payload.email_verified !== true) return json({ error: "无法验证这个 Google 账号。" }, { status: 401 });
      const email = String(payload.email).toLowerCase();
      const ownerEmail = (env.OWNER_GOOGLE_EMAIL || "").trim().toLowerCase();
      const user: SessionUser = {
        sub: payload.sub,
        email,
        name: String(payload.name || email.split("@")[0]),
        picture: payload.picture ? String(payload.picture) : undefined,
        isOwner: Boolean(ownerEmail && email === ownerEmail),
      };
      const token = await createSession(user, env.SESSION_SECRET);
      return json({ user }, { headers: { "set-cookie": sessionCookie(token, request) } });
    } catch {
      return json({ error: "Google 登录验证失败，请重新登录。" }, { status: 401 });
    }
  }

  if (path === "/api/auth/logout" && request.method === "POST") {
    if (!sameOriginWrite(request)) return json({ error: "退出请求未通过安全检查。" }, { status: 403 });
    return json({ ok: true }, { headers: { "set-cookie": sessionCookie("", request).replace("Max-Age=604800", "Max-Age=0") } });
  }

  if (path === "/api/photos" && request.method === "GET") {
    const user = await readSession(request, env);
    if (!user) return json({ error: "请先使用 Google 登录。" }, { status: 401 });
    await ensureSchema(env);
    const result = await env.DB.prepare("SELECT id, title, category, location, captured_at, created_at FROM photos ORDER BY created_at DESC").all<Record<string, unknown>>();
    return json({ photos: result.results.map(photoFromRow) });
  }

  if (path === "/api/photos" && request.method === "POST") {
    if (!sameOriginWrite(request)) return json({ error: "上传请求未通过安全检查。" }, { status: 403 });
    const user = await readSession(request, env);
    if (!user?.isOwner) return json({ error: "只有相册主人可以上传照片。" }, { status: 403 });
    await ensureSchema(env);
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File) || !file.type.startsWith("image/")) return json({ error: "请选择一张有效的图片。" }, { status: 400 });
    if (file.size > 20 * 1024 * 1024) return json({ error: "照片不能超过 20MB。" }, { status: 413 });
    const allowed = new Set(["image/jpeg", "image/png", "image/webp", "image/avif"]);
    if (!allowed.has(file.type)) return json({ error: "目前支持 JPG、PNG、WebP 和 AVIF。" }, { status: 415 });
    const title = cleanText(form.get("title"));
    if (!title) return json({ error: "请填写作品名称。" }, { status: 400 });
    const category = cleanText(form.get("category"), 20) || "旅途";
    const location = cleanText(form.get("location"));
    const capturedAt = cleanText(form.get("capturedAt"), 20);
    const id = crypto.randomUUID();
    const extension = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/avif": "avif" }[file.type] || "img";
    const objectKey = `photos/${id}.${extension}`;
    const createdAt = Date.now();
    await env.PHOTOS.put(objectKey, file.stream(), { httpMetadata: { contentType: file.type }, customMetadata: { ownerSub: user.sub } });
    try {
      await env.DB.prepare("INSERT INTO photos (id, object_key, title, category, location, captured_at, content_type, owner_sub, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .bind(id, objectKey, title, category, location, capturedAt, file.type, user.sub, createdAt).run();
    } catch (error) {
      await env.PHOTOS.delete(objectKey);
      throw error;
    }
    return json({ photo: { id, title, category, location, capturedAt, createdAt, url: `/media/${encodeURIComponent(id)}` } }, { status: 201 });
  }

  if (path.startsWith("/api/photos/") && request.method === "DELETE") {
    if (!sameOriginWrite(request)) return json({ error: "删除请求未通过安全检查。" }, { status: 403 });
    const user = await readSession(request, env);
    if (!user?.isOwner) return json({ error: "只有相册主人可以删除照片。" }, { status: 403 });
    await ensureSchema(env);
    const id = decodeURIComponent(path.slice("/api/photos/".length));
    const row = await env.DB.prepare("SELECT object_key FROM photos WHERE id = ?").bind(id).first<{ object_key: string }>();
    if (!row) return json({ error: "没有找到这张照片。" }, { status: 404 });
    await env.DB.prepare("DELETE FROM photos WHERE id = ?").bind(id).run();
    await env.PHOTOS.delete(row.object_key);
    return json({ ok: true });
  }

  if (path.startsWith("/media/") && request.method === "GET") {
    const user = await readSession(request, env);
    if (!user) return new Response("Unauthorized", { status: 401 });
    await ensureSchema(env);
    const id = decodeURIComponent(path.slice("/media/".length));
    const row = await env.DB.prepare("SELECT object_key, content_type FROM photos WHERE id = ?").bind(id).first<{ object_key: string; content_type: string }>();
    if (!row) return new Response("Not found", { status: 404 });
    const object = await env.PHOTOS.get(row.object_key);
    if (!object) return new Response("Not found", { status: 404 });
    return new Response(object.body, {
      headers: {
        "content-type": row.content_type,
        "cache-control": "private, max-age=3600",
        "x-content-type-options": "nosniff",
      },
    });
  }

  return null;
}

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const apiResponse = await api(request, env);
    if (apiResponse) return apiResponse;

    const url = new URL(request.url);
    if (url.pathname === "/_vinext/image") {
      const allowedWidths = [...DEFAULT_DEVICE_SIZES, ...DEFAULT_IMAGE_SIZES];
      return handleImageOptimization(request, {
        fetchAsset: (path) => env.ASSETS.fetch(new Request(new URL(path, request.url))),
        transformImage: async (body, { width, format, quality }) => {
          const result = await env.IMAGES.input(body).transform(width > 0 ? { width } : {}).output({ format, quality });
          return result.response();
        },
      }, allowedWidths);
    }

    return handler.fetch(request, env, ctx);
  },
};

export default worker;
