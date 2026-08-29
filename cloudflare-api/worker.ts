import { createRemoteJWKSet, jwtVerify } from "jose";
import { AwsClient } from "aws4fetch";

interface Env {
  DB: D1Database;
  GOOGLE_CLIENT_ID?: string;
  SESSION_SECRET?: string;
  OWNER_GOOGLE_EMAIL?: string;
  ALLOWED_ORIGIN?: string;
  B2_KEY_ID?: string;
  B2_APPLICATION_KEY?: string;
  B2_ENDPOINT?: string;
  B2_BUCKET_NAME?: string;
  GEOCODING_ENDPOINT?: string;
}

type SessionUser = {
  sub: string;
  email: string;
  name: string;
  picture?: string;
  isOwner: boolean;
};

type SessionPayload = Omit<SessionUser, "isOwner"> & { exp: number };

type PhotoRow = {
  id: string;
  title: string;
  category: string;
  location: string;
  captured_at: string;
  camera: string;
  lens: string;
  technical: string;
  created_at: number;
  thumbnail_key?: string;
  thumbnail_version?: string;
  thumbnail_content_type?: string;
  thumbnail_size?: number;
  width?: number;
  height?: number;
};

const googleKeys = createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs"));
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const MAX_PHOTO_BYTES = 20 * 1024 * 1024;
const MAX_THUMBNAIL_BYTES = 3 * 1024 * 1024;
const STORAGE_LIMIT_BYTES = 9 * 1024 * 1024 * 1024;
const MEDIA_LINK_LIFETIME_SECONDS = 6 * 60 * 60;
let schemaReady = false;

function allowedOrigins(env: Env) {
  return (env.ALLOWED_ORIGIN || "")
    .split(",")
    .map((origin) => origin.trim().replace(/\/$/, ""))
    .filter(Boolean);
}

function requestOriginAllowed(request: Request, env: Env) {
  const origin = request.headers.get("origin")?.replace(/\/$/, "");
  if (!origin) return false;
  const configured = allowedOrigins(env);
  return configured.length ? configured.includes(origin) : origin === new URL(request.url).origin;
}

function corsHeaders(request: Request, env: Env): Record<string, string> {
  const origin = request.headers.get("origin")?.replace(/\/$/, "");
  if (!origin || !requestOriginAllowed(request, env)) return {};
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET, POST, PATCH, DELETE, OPTIONS",
    "access-control-allow-headers": "Authorization, Content-Type, X-Lumen-Request",
    "access-control-max-age": "86400",
    vary: "Origin",
  };
}

function json(request: Request, env: Env, data: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...corsHeaders(request, env),
      ...init.headers,
    },
  });
}

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
      file_size INTEGER NOT NULL DEFAULT 0,
      object_version TEXT NOT NULL DEFAULT '',
      camera TEXT NOT NULL DEFAULT '',
      lens TEXT NOT NULL DEFAULT '',
      technical TEXT NOT NULL DEFAULT '',
      thumbnail_key TEXT NOT NULL DEFAULT '',
      thumbnail_version TEXT NOT NULL DEFAULT '',
      thumbnail_content_type TEXT NOT NULL DEFAULT '',
      thumbnail_size INTEGER NOT NULL DEFAULT 0,
      width INTEGER NOT NULL DEFAULT 0,
      height INTEGER NOT NULL DEFAULT 0,
      owner_sub TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )`),
    env.DB.prepare("CREATE INDEX IF NOT EXISTS photos_created_at_idx ON photos (created_at)"),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS geocode_cache (
      cache_key TEXT PRIMARY KEY,
      location TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )`),
  ]);
  const columns = await env.DB.prepare("PRAGMA table_info(photos)").all<{ name: string }>();
  if (!columns.results.some((column) => column.name === "file_size")) {
    await env.DB.prepare("ALTER TABLE photos ADD COLUMN file_size INTEGER NOT NULL DEFAULT 0").run();
  }
  if (!columns.results.some((column) => column.name === "object_version")) {
    await env.DB.prepare("ALTER TABLE photos ADD COLUMN object_version TEXT NOT NULL DEFAULT ''").run();
  }
  if (!columns.results.some((column) => column.name === "camera")) {
    await env.DB.prepare("ALTER TABLE photos ADD COLUMN camera TEXT NOT NULL DEFAULT ''").run();
  }
  if (!columns.results.some((column) => column.name === "lens")) {
    await env.DB.prepare("ALTER TABLE photos ADD COLUMN lens TEXT NOT NULL DEFAULT ''").run();
  }
  if (!columns.results.some((column) => column.name === "technical")) {
    await env.DB.prepare("ALTER TABLE photos ADD COLUMN technical TEXT NOT NULL DEFAULT ''").run();
  }
  if (!columns.results.some((column) => column.name === "thumbnail_key")) {
    await env.DB.prepare("ALTER TABLE photos ADD COLUMN thumbnail_key TEXT NOT NULL DEFAULT ''").run();
  }
  if (!columns.results.some((column) => column.name === "thumbnail_version")) {
    await env.DB.prepare("ALTER TABLE photos ADD COLUMN thumbnail_version TEXT NOT NULL DEFAULT ''").run();
  }
  if (!columns.results.some((column) => column.name === "thumbnail_content_type")) {
    await env.DB.prepare("ALTER TABLE photos ADD COLUMN thumbnail_content_type TEXT NOT NULL DEFAULT ''").run();
  }
  if (!columns.results.some((column) => column.name === "thumbnail_size")) {
    await env.DB.prepare("ALTER TABLE photos ADD COLUMN thumbnail_size INTEGER NOT NULL DEFAULT 0").run();
  }
  if (!columns.results.some((column) => column.name === "width")) {
    await env.DB.prepare("ALTER TABLE photos ADD COLUMN width INTEGER NOT NULL DEFAULT 0").run();
  }
  if (!columns.results.some((column) => column.name === "height")) {
    await env.DB.prepare("ALTER TABLE photos ADD COLUMN height INTEGER NOT NULL DEFAULT 0").run();
  }
  schemaReady = true;
}

function b2Settings(env: Env) {
  const accessKeyId = (env.B2_KEY_ID || "").trim();
  const secretAccessKey = (env.B2_APPLICATION_KEY || "").trim();
  const bucket = (env.B2_BUCKET_NAME || "").trim();
  const rawEndpoint = (env.B2_ENDPOINT || "").trim().replace(/\/$/, "");
  if (!accessKeyId || !secretAccessKey || !bucket || !rawEndpoint) throw new Error("B2 storage is not configured");
  const endpoint = rawEndpoint.startsWith("https://") ? rawEndpoint : `https://${rawEndpoint}`;
  const regionMatch = new URL(endpoint).hostname.match(/^s3\.([^.]+)\.backblazeb2\.com$/);
  if (!regionMatch) throw new Error("B2 endpoint is invalid");
  return {
    bucket,
    endpoint,
    client: new AwsClient({ accessKeyId, secretAccessKey, region: regionMatch[1], service: "s3" }),
  };
}

function b2ObjectUrl(env: Env, objectKey: string, versionId?: string) {
  const { bucket, endpoint } = b2Settings(env);
  const encodedKey = objectKey.split("/").map(encodeURIComponent).join("/");
  const url = new URL(`${endpoint}/${encodeURIComponent(bucket)}/${encodedKey}`);
  if (versionId) url.searchParams.set("versionId", versionId);
  return url.toString();
}

async function b2Put(env: Env, objectKey: string, file: File) {
  const { client } = b2Settings(env);
  const response = await client.fetch(b2ObjectUrl(env, objectKey), {
    method: "PUT",
    headers: { "content-type": file.type },
    body: file.stream(),
  });
  if (!response.ok) throw new Error(`B2 upload failed (${response.status})`);
  const versionId = response.headers.get("x-amz-version-id") || "";
  if (!versionId) throw new Error("B2 did not return an object version");
  return versionId;
}

async function b2Delete(env: Env, objectKey: string, versionId: string) {
  if (!versionId) throw new Error("B2 object version is missing");
  const { client } = b2Settings(env);
  const response = await client.fetch(b2ObjectUrl(env, objectKey, versionId), { method: "DELETE" });
  if (!response.ok && response.status !== 404) throw new Error(`B2 delete failed (${response.status})`);
}

async function b2Get(env: Env, objectKey: string) {
  const { client } = b2Settings(env);
  return client.fetch(b2ObjectUrl(env, objectKey), { method: "GET" });
}

type StoredPhotoObjects = {
  object_key: string;
  object_version: string;
  thumbnail_key?: string;
  thumbnail_version?: string;
};

async function deleteStoredPhoto(env: Env, row: StoredPhotoObjects) {
  await b2Delete(env, row.object_key, row.object_version);
  if (row.thumbnail_key && row.thumbnail_version) {
    // The original is the source of truth. A stale thumbnail is safe to clean up
    // later, while failing the whole deletion after removing it can leave a
    // temporarily broken gallery card.
    await b2Delete(env, row.thumbnail_key, row.thumbnail_version).catch(() => undefined);
  }
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

async function importSigningKey(secret: string) {
  return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

async function signValue(value: string, secret: string) {
  const signature = await crypto.subtle.sign("HMAC", await importSigningKey(secret), encoder.encode(value));
  return bytesToBase64Url(new Uint8Array(signature));
}

async function createSession(user: SessionUser, secret: string) {
  const payload = bytesToBase64Url(encoder.encode(JSON.stringify({
    sub: user.sub,
    email: user.email,
    name: user.name,
    picture: user.picture,
    exp: Date.now() + 7 * 24 * 60 * 60 * 1000,
  })));
  return `${payload}.${await signValue(payload, secret)}`;
}

function bearerToken(request: Request) {
  const authorization = request.headers.get("authorization") || "";
  return authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
}

async function readSession(request: Request, env: Env): Promise<SessionUser | null> {
  const token = bearerToken(request);
  if (!token || !env.SESSION_SECRET) return null;
  const [payload, signature] = token.split(".");
  if (!payload || !signature) return null;
  try {
    const valid = await crypto.subtle.verify(
      "HMAC",
      await importSigningKey(env.SESSION_SECRET),
      base64UrlToBytes(signature),
      encoder.encode(payload),
    );
    if (!valid) return null;
    const parsed = JSON.parse(decoder.decode(base64UrlToBytes(payload))) as SessionPayload;
    if (!parsed.exp || parsed.exp < Date.now() || !parsed.sub || !parsed.email) return null;
    const ownerEmail = (env.OWNER_GOOGLE_EMAIL || "").trim().toLowerCase();
    return {
      sub: parsed.sub,
      email: parsed.email,
      name: parsed.name,
      picture: parsed.picture,
      isOwner: Boolean(ownerEmail && parsed.email.toLowerCase() === ownerEmail),
    };
  } catch {
    return null;
  }
}

function secureWriteRequest(request: Request, env: Env) {
  return request.headers.get("x-lumen-request") === "1" && requestOriginAllowed(request, env);
}

function cleanText(value: unknown, max = 80) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function cleanDimension(value: unknown) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 20_000 ? parsed : 0;
}

function validThumbnail(value: FormDataEntryValue | null): value is File {
  return value instanceof File
    && ["image/webp", "image/jpeg"].includes(value.type)
    && value.size > 0
    && value.size <= MAX_THUMBNAIL_BYTES;
}

type MediaVariant = "original" | "thumbnail";

async function mediaUrl(request: Request, env: Env, id: string, variant: MediaVariant = "original") {
  if (!env.SESSION_SECRET) throw new Error("SESSION_SECRET is missing");
  const now = Math.floor(Date.now() / 1000);
  const exp = (Math.floor(now / MEDIA_LINK_LIFETIME_SECONDS) + 2) * MEDIA_LINK_LIFETIME_SECONDS;
  const sig = await signValue(`${id}.${variant}.${exp}`, env.SESSION_SECRET);
  const url = new URL(`/media/${encodeURIComponent(id)}`, request.url);
  if (variant === "thumbnail") url.searchParams.set("variant", variant);
  url.searchParams.set("exp", String(exp));
  url.searchParams.set("sig", sig);
  return url.toString();
}

async function photoFromRow(request: Request, env: Env, row: PhotoRow) {
  const originalUrl = await mediaUrl(request, env, row.id);
  const hasThumbnail = Boolean(row.thumbnail_key);
  return {
    id: row.id,
    title: row.title,
    category: row.category,
    location: row.location,
    capturedAt: row.captured_at,
    camera: row.camera,
    lens: row.lens,
    technical: row.technical,
    createdAt: row.created_at,
    url: originalUrl,
    thumbnailUrl: hasThumbnail ? await mediaUrl(request, env, row.id, "thumbnail") : originalUrl,
    hasThumbnail,
    width: Number(row.width || 0),
    height: Number(row.height || 0),
  };
}

async function geocodeCacheKey(latitude: number, longitude: number) {
  const approximateCoordinates = `${latitude.toFixed(3)},${longitude.toFixed(3)}`;
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(approximateCoordinates));
  return bytesToBase64Url(new Uint8Array(digest));
}

function placeName(data: unknown) {
  if (!data || typeof data !== "object") return "";
  const result = data as { name?: unknown; display_name?: unknown; address?: Record<string, unknown> };
  const address = result.address || {};
  const value = (key: string) => typeof address[key] === "string" ? String(address[key]).trim() : "";
  const locality = value("city") || value("town") || value("village") || value("municipality") || value("county");
  const region = value("state") || value("region");
  const country = value("country");
  const parts = [...new Set([locality, region, country].filter(Boolean))];
  if (parts.length) return parts.slice(0, 3).join(" · ").slice(0, 80);
  if (typeof result.name === "string" && result.name.trim()) return result.name.trim().slice(0, 80);
  if (typeof result.display_name === "string") return result.display_name.split(",").slice(0, 3).join(" · ").trim().slice(0, 80);
  return "";
}

async function reverseLocation(env: Env, latitude: number, longitude: number) {
  const roundedLatitude = Number(latitude.toFixed(3));
  const roundedLongitude = Number(longitude.toFixed(3));
  const cacheKey = await geocodeCacheKey(roundedLatitude, roundedLongitude);
  const cached = await env.DB.prepare("SELECT location FROM geocode_cache WHERE cache_key = ?")
    .bind(cacheKey).first<{ location: string }>();
  if (cached?.location) return cached.location;

  const endpoint = (env.GEOCODING_ENDPOINT || "https://nominatim.openstreetmap.org/reverse").trim();
  const url = new URL(endpoint);
  if (url.protocol !== "https:") throw new Error("Geocoding endpoint must use HTTPS");
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("lat", String(roundedLatitude));
  url.searchParams.set("lon", String(roundedLongitude));
  url.searchParams.set("zoom", "10");
  url.searchParams.set("addressdetails", "1");
  url.searchParams.set("accept-language", "zh-CN");
  const response = await fetch(url, {
    headers: {
      accept: "application/json",
      "user-agent": "LUMEN-Photo-Archive/1.0 (+https://xiaoxiaoxiaoxiaoxiaojun.github.io/lumen-photo-archive/)",
      referer: "https://xiaoxiaoxiaoxiaoxiaojun.github.io/lumen-photo-archive/",
    },
  });
  if (!response.ok) throw new Error(`Geocoding failed (${response.status})`);
  const location = placeName(await response.json());
  if (!location) return "";
  await env.DB.prepare(
    `INSERT INTO geocode_cache (cache_key, location, created_at) VALUES (?, ?, ?)
     ON CONFLICT(cache_key) DO UPDATE SET location = excluded.location, created_at = excluded.created_at`,
  ).bind(cacheKey, location, Date.now()).run();
  return location;
}

async function verifyMediaSignature(url: URL, env: Env, id: string, variant: MediaVariant) {
  if (!env.SESSION_SECRET) return false;
  const exp = Number(url.searchParams.get("exp"));
  const signature = url.searchParams.get("sig") || "";
  if (!Number.isInteger(exp) || exp <= Math.floor(Date.now() / 1000) || !signature) return false;
  try {
    const key = await importSigningKey(env.SESSION_SECRET);
    const valid = await crypto.subtle.verify(
      "HMAC",
      key,
      base64UrlToBytes(signature),
      encoder.encode(`${id}.${variant}.${exp}`),
    );
    if (valid || variant !== "original") return valid;
    return crypto.subtle.verify("HMAC", key, base64UrlToBytes(signature), encoder.encode(`${id}.${exp}`));
  } catch {
    return false;
  }
}

async function handleApi(request: Request, env: Env) {
  const url = new URL(request.url);
  const path = url.pathname;

  if (request.method === "OPTIONS" && (path.startsWith("/api/") || path === "/api")) {
    if (!requestOriginAllowed(request, env)) return new Response(null, { status: 403 });
    return new Response(null, { status: 204, headers: corsHeaders(request, env) });
  }

  if (path === "/api/config" && request.method === "GET") {
    return json(request, env, {
      googleClientId: env.GOOGLE_CLIENT_ID || "",
      maxPhotoBytes: MAX_PHOTO_BYTES,
      storageLimitBytes: STORAGE_LIMIT_BYTES,
    });
  }

  if (path === "/api/auth/google" && request.method === "POST") {
    if (!secureWriteRequest(request, env)) return json(request, env, { error: "登录请求未通过安全检查。" }, { status: 403 });
    if (!env.GOOGLE_CLIENT_ID || !env.SESSION_SECRET) {
      return json(request, env, { error: "Google 登录尚未配置完成。" }, { status: 503 });
    }
    try {
      const body = await request.json() as { credential?: string };
      if (!body.credential) return json(request, env, { error: "没有收到 Google 登录凭证。" }, { status: 400 });
      const { payload } = await jwtVerify(body.credential, googleKeys, {
        audience: env.GOOGLE_CLIENT_ID,
        issuer: ["https://accounts.google.com", "accounts.google.com"],
      });
      if (!payload.sub || !payload.email || payload.email_verified !== true) {
        return json(request, env, { error: "无法验证这个 Google 账号。" }, { status: 401 });
      }
      const email = String(payload.email).toLowerCase();
      const ownerEmail = (env.OWNER_GOOGLE_EMAIL || "").trim().toLowerCase();
      const user: SessionUser = {
        sub: String(payload.sub),
        email,
        name: String(payload.name || email.split("@")[0]),
        picture: payload.picture ? String(payload.picture) : undefined,
        isOwner: Boolean(ownerEmail && email === ownerEmail),
      };
      return json(request, env, { user, token: await createSession(user, env.SESSION_SECRET) });
    } catch {
      return json(request, env, { error: "Google 登录验证失败，请重新登录。" }, { status: 401 });
    }
  }

  if (path === "/api/me" && request.method === "GET") {
    return json(request, env, { user: await readSession(request, env) });
  }

  if (path === "/api/geocode" && request.method === "GET") {
    if (!requestOriginAllowed(request, env)) return json(request, env, { error: "地点识别请求未通过安全检查。" }, { status: 403 });
    const user = await readSession(request, env);
    if (!user?.isOwner) return json(request, env, { error: "只有相册主人可以识别照片地点。" }, { status: 403 });
    const latitude = Number(url.searchParams.get("latitude"));
    const longitude = Number(url.searchParams.get("longitude"));
    if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90 || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
      return json(request, env, { error: "照片中的 GPS 信息无效。" }, { status: 400 });
    }
    await ensureSchema(env);
    try {
      return json(request, env, {
        location: await reverseLocation(env, latitude, longitude),
        attribution: "© OpenStreetMap contributors",
      });
    } catch {
      return json(request, env, { error: "地点名称暂时无法识别。" }, { status: 502 });
    }
  }

  if (path === "/api/photos" && request.method === "GET") {
    if (!env.SESSION_SECRET) return json(request, env, { error: "云端尚未配置完成。" }, { status: 503 });
    await ensureSchema(env);
    const result = await env.DB.prepare(
      `SELECT id, title, category, location, captured_at, camera, lens, technical, created_at,
              thumbnail_key, thumbnail_version, thumbnail_content_type, thumbnail_size, width, height
       FROM photos ORDER BY created_at DESC`,
    ).all<PhotoRow>();
    const photos = await Promise.all(result.results.map((row) => photoFromRow(request, env, row)));
    return json(request, env, { photos });
  }

  if (path === "/api/photos" && request.method === "POST") {
    if (!secureWriteRequest(request, env)) return json(request, env, { error: "上传请求未通过安全检查。" }, { status: 403 });
    const user = await readSession(request, env);
    if (!user?.isOwner) return json(request, env, { error: "只有相册主人可以上传照片。" }, { status: 403 });
    await ensureSchema(env);
    const form = await request.formData();
    const file = form.get("file");
    const thumbnail = form.get("thumbnail");
    if (!(file instanceof File) || !file.type.startsWith("image/")) {
      return json(request, env, { error: "请选择一张有效的图片。" }, { status: 400 });
    }
    if (file.size > MAX_PHOTO_BYTES) return json(request, env, { error: "照片不能超过 20MB。" }, { status: 413 });
    const allowedTypes = new Set(["image/jpeg", "image/png", "image/webp", "image/avif"]);
    if (!allowedTypes.has(file.type)) {
      return json(request, env, { error: "目前支持 JPG、PNG、WebP 和 AVIF。" }, { status: 415 });
    }
    if (thumbnail !== null && !validThumbnail(thumbnail)) {
      return json(request, env, { error: "照片缩略图无效，请重新选择照片。" }, { status: 400 });
    }
    const thumbnailSize = thumbnail instanceof File ? thumbnail.size : 0;
    const usage = await env.DB.prepare("SELECT COALESCE(SUM(file_size + thumbnail_size), 0) AS bytes FROM photos").first<{ bytes: number }>();
    if (Number(usage?.bytes || 0) + file.size + thumbnailSize > STORAGE_LIMIT_BYTES) {
      return json(request, env, { error: "云端照片已接近 9GB 安全上限，请先删除部分作品。" }, { status: 507 });
    }
    const title = cleanText(form.get("title"));
    if (!title) return json(request, env, { error: "请填写作品名称。" }, { status: 400 });
    const category = cleanText(form.get("category"), 20) || "旅途";
    const location = cleanText(form.get("location"));
    const capturedAt = cleanText(form.get("capturedAt"), 20);
    const camera = cleanText(form.get("camera"), 120);
    const lens = cleanText(form.get("lens"), 120);
    const technical = cleanText(form.get("technical"), 120);
    const id = crypto.randomUUID();
    const extension = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/avif": "avif" }[file.type] || "img";
    const objectKey = `photos/${id}.${extension}`;
    const thumbnailKey = thumbnail instanceof File ? `thumbnails/${id}.${thumbnail.type === "image/jpeg" ? "jpg" : "webp"}` : "";
    const width = cleanDimension(form.get("width"));
    const height = cleanDimension(form.get("height"));
    const createdAt = Date.now();
    let objectVersion = "";
    let thumbnailVersion = "";
    try {
      objectVersion = await b2Put(env, objectKey, file);
      if (thumbnail instanceof File) thumbnailVersion = await b2Put(env, thumbnailKey, thumbnail);
    } catch {
      if (objectVersion) await b2Delete(env, objectKey, objectVersion).catch(() => undefined);
      return json(request, env, { error: "照片云端暂时无法上传，请稍后重试。" }, { status: 502 });
    }
    try {
      await env.DB.prepare(
        `INSERT INTO photos
          (id, object_key, object_version, title, category, location, captured_at, camera, lens, technical,
           content_type, file_size, thumbnail_key, thumbnail_version, thumbnail_content_type, thumbnail_size,
           width, height, owner_sub, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        id, objectKey, objectVersion, title, category, location, capturedAt, camera, lens, technical,
        file.type, file.size, thumbnailKey, thumbnailVersion, thumbnail instanceof File ? thumbnail.type : "", thumbnailSize,
        width, height, user.sub, createdAt,
      ).run();
    } catch (error) {
      if (thumbnailVersion) await b2Delete(env, thumbnailKey, thumbnailVersion).catch(() => undefined);
      await b2Delete(env, objectKey, objectVersion);
      throw error;
    }
    const photo = await photoFromRow(request, env, {
      id, title, category, location, captured_at: capturedAt, camera, lens, technical, created_at: createdAt,
      thumbnail_key: thumbnailKey, thumbnail_version: thumbnailVersion,
      thumbnail_content_type: thumbnail instanceof File ? thumbnail.type : "", thumbnail_size: thumbnailSize,
      width, height,
    });
    return json(request, env, { photo }, { status: 201 });
  }

  const thumbnailMatch = path.match(/^\/api\/photos\/([^/]+)\/thumbnail$/);
  if (thumbnailMatch && request.method === "POST") {
    if (!secureWriteRequest(request, env)) return json(request, env, { error: "缩略图请求未通过安全检查。" }, { status: 403 });
    const user = await readSession(request, env);
    if (!user?.isOwner) return json(request, env, { error: "只有相册主人可以优化照片。" }, { status: 403 });
    await ensureSchema(env);
    const id = decodeURIComponent(thumbnailMatch[1]);
    const form = await request.formData();
    const thumbnail = form.get("thumbnail");
    if (!validThumbnail(thumbnail)) return json(request, env, { error: "照片缩略图无效。" }, { status: 400 });
    const width = cleanDimension(form.get("width"));
    const height = cleanDimension(form.get("height"));
    if (!width || !height) return json(request, env, { error: "照片尺寸无效。" }, { status: 400 });
    const existing = await env.DB.prepare(
      `SELECT id, title, category, location, captured_at, camera, lens, technical, created_at,
              thumbnail_key, thumbnail_version, thumbnail_content_type, thumbnail_size, width, height
       FROM photos WHERE id = ?`,
    ).bind(id).first<PhotoRow>();
    if (!existing) return json(request, env, { error: "没有找到这张照片。" }, { status: 404 });

    const thumbnailKey = `thumbnails/${id}.${thumbnail.type === "image/jpeg" ? "jpg" : "webp"}`;
    let thumbnailVersion = "";
    try {
      thumbnailVersion = await b2Put(env, thumbnailKey, thumbnail);
      await env.DB.prepare(
        `UPDATE photos
         SET thumbnail_key = ?, thumbnail_version = ?, thumbnail_content_type = ?, thumbnail_size = ?, width = ?, height = ?
         WHERE id = ?`,
      ).bind(thumbnailKey, thumbnailVersion, thumbnail.type, thumbnail.size, width, height, id).run();
    } catch {
      if (thumbnailVersion) await b2Delete(env, thumbnailKey, thumbnailVersion).catch(() => undefined);
      return json(request, env, { error: "缩略图暂时无法保存，请稍后重试。" }, { status: 502 });
    }
    if (existing.thumbnail_key && existing.thumbnail_version && existing.thumbnail_version !== thumbnailVersion) {
      await b2Delete(env, existing.thumbnail_key, existing.thumbnail_version).catch(() => undefined);
    }
    const photo = await photoFromRow(request, env, {
      ...existing,
      thumbnail_key: thumbnailKey,
      thumbnail_version: thumbnailVersion,
      thumbnail_content_type: thumbnail.type,
      thumbnail_size: thumbnail.size,
      width,
      height,
    });
    return json(request, env, { photo });
  }

  if (path === "/api/photos/batch-delete" && request.method === "POST") {
    if (!secureWriteRequest(request, env)) return json(request, env, { error: "批量删除请求未通过安全检查。" }, { status: 403 });
    const user = await readSession(request, env);
    if (!user?.isOwner) return json(request, env, { error: "只有相册主人可以批量删除照片。" }, { status: 403 });
    const body = await request.json().catch(() => null) as { ids?: unknown } | null;
    const ids = Array.isArray(body?.ids)
      ? [...new Set(body.ids.filter((id): id is string => typeof id === "string" && Boolean(id.trim())).map((id) => id.trim()))].slice(0, 100)
      : [];
    if (!ids.length) return json(request, env, { error: "请选择要删除的照片。" }, { status: 400 });
    await ensureSchema(env);
    const deletedIds: string[] = [];
    const failed: Array<{ id: string; error: string }> = [];
    for (let offset = 0; offset < ids.length; offset += 5) {
      const results = await Promise.all(ids.slice(offset, offset + 5).map(async (id) => {
        const row = await env.DB.prepare("SELECT object_key, object_version, thumbnail_key, thumbnail_version FROM photos WHERE id = ?")
          .bind(id).first<StoredPhotoObjects>();
        if (!row) return { id, error: "没有找到这张照片。" };
        try {
          await deleteStoredPhoto(env, row);
          await env.DB.prepare("DELETE FROM photos WHERE id = ?").bind(id).run();
          return { id };
        } catch {
          return { id, error: "云端暂时无法删除。" };
        }
      }));
      for (const result of results) {
        if (result.error) failed.push({ id: result.id, error: result.error });
        else deletedIds.push(result.id);
      }
    }
    return json(request, env, { deletedIds, failed });
  }

  if (path.startsWith("/api/photos/") && request.method === "PATCH") {
    if (!secureWriteRequest(request, env)) return json(request, env, { error: "编辑请求未通过安全检查。" }, { status: 403 });
    const user = await readSession(request, env);
    if (!user?.isOwner) return json(request, env, { error: "只有相册主人可以编辑照片。" }, { status: 403 });
    const id = decodeURIComponent(path.slice("/api/photos/".length));
    if (!id || id === "batch-delete") return json(request, env, { error: "照片编号无效。" }, { status: 400 });
    const body = await request.json().catch(() => null) as Record<string, unknown> | null;
    if (!body) return json(request, env, { error: "没有收到可编辑的信息。" }, { status: 400 });
    const title = cleanText(body.title);
    if (!title) return json(request, env, { error: "请填写作品名称。" }, { status: 400 });
    const category = cleanText(body.category, 20);
    if (!["摄影", "动物", "个人"].includes(category)) return json(request, env, { error: "请选择有效的作品分类。" }, { status: 400 });
    const location = cleanText(body.location);
    const capturedAt = cleanText(body.capturedAt, 20);
    const camera = cleanText(body.camera, 120);
    const lens = cleanText(body.lens, 120);
    const technical = cleanText(body.technical, 120);
    await ensureSchema(env);
    const existing = await env.DB.prepare(
      `SELECT id, created_at, thumbnail_key, thumbnail_version, thumbnail_content_type, thumbnail_size, width, height
       FROM photos WHERE id = ?`,
    ).bind(id).first<PhotoRow>();
    if (!existing) return json(request, env, { error: "没有找到这张照片。" }, { status: 404 });
    await env.DB.prepare(
      `UPDATE photos
       SET title = ?, category = ?, location = ?, captured_at = ?, camera = ?, lens = ?, technical = ?
       WHERE id = ?`,
    ).bind(title, category, location, capturedAt, camera, lens, technical, id).run();
    const photo = await photoFromRow(request, env, {
      id,
      title,
      category,
      location,
      captured_at: capturedAt,
      camera,
      lens,
      technical,
      created_at: existing.created_at,
      thumbnail_key: existing.thumbnail_key,
      thumbnail_version: existing.thumbnail_version,
      thumbnail_content_type: existing.thumbnail_content_type,
      thumbnail_size: existing.thumbnail_size,
      width: existing.width,
      height: existing.height,
    });
    return json(request, env, { photo });
  }

  if (path.startsWith("/api/photos/") && request.method === "DELETE") {
    if (!secureWriteRequest(request, env)) return json(request, env, { error: "删除请求未通过安全检查。" }, { status: 403 });
    const user = await readSession(request, env);
    if (!user?.isOwner) return json(request, env, { error: "只有相册主人可以删除照片。" }, { status: 403 });
    await ensureSchema(env);
    const id = decodeURIComponent(path.slice("/api/photos/".length));
    const row = await env.DB.prepare("SELECT object_key, object_version, thumbnail_key, thumbnail_version FROM photos WHERE id = ?")
      .bind(id).first<StoredPhotoObjects>();
    if (!row) return json(request, env, { error: "没有找到这张照片。" }, { status: 404 });
    try {
      await deleteStoredPhoto(env, row);
    } catch {
      return json(request, env, { error: "照片云端暂时无法删除，请稍后重试。" }, { status: 502 });
    }
    await env.DB.prepare("DELETE FROM photos WHERE id = ?").bind(id).run();
    return json(request, env, { ok: true });
  }

  return null;
}

async function handleMedia(request: Request, env: Env) {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/media/") || request.method !== "GET") return null;
  const id = decodeURIComponent(url.pathname.slice("/media/".length));
  const variant: MediaVariant = url.searchParams.get("variant") === "thumbnail" ? "thumbnail" : "original";
  if (!id || !(await verifyMediaSignature(url, env, id, variant))) return new Response("Forbidden", { status: 403 });
  await ensureSchema(env);
  const row = await env.DB.prepare(
    "SELECT object_key, content_type, thumbnail_key, thumbnail_content_type FROM photos WHERE id = ?",
  ).bind(id).first<{ object_key: string; content_type: string; thumbnail_key: string; thumbnail_content_type: string }>();
  if (!row) return new Response("Not found", { status: 404 });
  const useThumbnail = variant === "thumbnail" && Boolean(row.thumbnail_key);
  const object = await b2Get(env, useThumbnail ? row.thumbnail_key : row.object_key);
  if (!object.ok || !object.body) return new Response("Not found", { status: object.status === 404 ? 404 : 502 });
  return new Response(object.body, {
    headers: {
      "content-type": useThumbnail ? row.thumbnail_content_type : row.content_type,
      "cache-control": `public, max-age=${MEDIA_LINK_LIFETIME_SECONDS}, immutable`,
      ...corsHeaders(request, env),
      "x-content-type-options": "nosniff",
    },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const apiResponse = await handleApi(request, env);
    if (apiResponse) return apiResponse;
    const mediaResponse = await handleMedia(request, env);
    if (mediaResponse) return mediaResponse;
    return new Response("LUMEN API", { status: 404 });
  },
};
