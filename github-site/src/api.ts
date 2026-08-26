export type SessionUser = {
  sub: string;
  email: string;
  name: string;
  picture?: string;
  isOwner: boolean;
};

export type Photo = {
  id: string;
  title: string;
  category: string;
  location: string;
  capturedAt: string;
  camera?: string;
  lens?: string;
  technical?: string;
  createdAt: number;
  url: string;
};

type ApiError = { error?: string };

const apiBase = (import.meta.env.VITE_API_BASE_URL || "").replace(/\/$/, "");
const tokenKey = "lumen-session";

export const isConfigured = Boolean(apiBase);

function token() {
  return window.sessionStorage.getItem(tokenKey) || "";
}

async function request<T>(path: string, init: RequestInit = {}) {
  if (!apiBase) throw new Error("云端 API 地址尚未配置。");
  const headers = new Headers(init.headers);
  const session = token();
  if (session) headers.set("authorization", `Bearer ${session}`);
  if (init.method && init.method !== "GET") headers.set("x-lumen-request", "1");
  const response = await fetch(`${apiBase}${path}`, { ...init, headers });
  let data: T & ApiError;
  try {
    data = await response.json() as T & ApiError;
  } catch {
    throw new Error("云端返回了无法识别的响应。");
  }
  if (!response.ok) {
    if (response.status === 401) window.sessionStorage.removeItem(tokenKey);
    throw new Error(data.error || `云端请求失败（${response.status}）。`);
  }
  return data;
}

export async function getConfig() {
  return request<{ googleClientId: string; maxPhotoBytes: number; storageLimitBytes: number }>("/api/config");
}

export async function restoreUser() {
  if (!token()) return null;
  const data = await request<{ user: SessionUser | null }>("/api/me");
  if (!data.user) window.sessionStorage.removeItem(tokenKey);
  return data.user;
}

export async function loginWithGoogle(credential: string) {
  const data = await request<{ user: SessionUser; token: string }>("/api/auth/google", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ credential }),
  });
  window.sessionStorage.setItem(tokenKey, data.token);
  return data.user;
}

export function logout() {
  window.sessionStorage.removeItem(tokenKey);
}

export async function getPhotos() {
  return (await request<{ photos: Photo[] }>("/api/photos")).photos;
}

export async function uploadPhoto(form: FormData) {
  return (await request<{ photo: Photo }>("/api/photos", { method: "POST", body: form })).photo;
}

export async function reverseGeocode(latitude: number, longitude: number) {
  const query = new URLSearchParams({
    latitude: String(Number(latitude.toFixed(3))),
    longitude: String(Number(longitude.toFixed(3))),
  });
  return request<{ location: string; attribution: string }>(`/api/geocode?${query}`);
}

export async function deletePhoto(id: string) {
  await request<{ ok: true }>(`/api/photos/${encodeURIComponent(id)}`, { method: "DELETE" });
}
