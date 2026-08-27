"use client";

import { FormEvent, useCallback, useEffect, useRef, useState } from "react";

type GoogleCredentialResponse = { credential: string };

declare global {
  interface Window {
    google?: {
      accounts: {
        id: {
          initialize(options: { client_id: string; callback: (response: GoogleCredentialResponse) => void }): void;
          renderButton(element: HTMLElement, options: Record<string, string | number>): void;
          disableAutoSelect(): void;
        };
      };
    };
  }
}

type User = {
  sub: string;
  email: string;
  name: string;
  picture?: string;
  isOwner: boolean;
};

type Photo = {
  id: string;
  title: string;
  category: string;
  location: string;
  capturedAt: string;
  url: string;
  createdAt: number;
};

const demoPhotos: Photo[] = [
  { id: "demo-1", title: "旷野来信", category: "摄影", location: "冰岛", capturedAt: "2025", url: "https://images.unsplash.com/photo-1500530855697-b586d89ba3ee?auto=format&fit=crop&w=1800&q=88", createdAt: 3 },
  { id: "demo-2", title: "夏夜之后", category: "个人", location: "京都", capturedAt: "2024", url: "https://images.unsplash.com/photo-1492684223066-81342ee5ff30?auto=format&fit=crop&w=1400&q=88", createdAt: 2 },
  { id: "demo-3", title: "林间来客", category: "动物", location: "北海道", capturedAt: "2025", url: "https://images.unsplash.com/photo-1474511320723-9a56873867b5?auto=format&fit=crop&w=1500&q=88", createdAt: 1 },
];

const categoryTabs = ["全部", "摄影", "动物", "个人"] as const;

function displayCategory(category: string) {
  if (category === "动物" || category === "个人") return category;
  return "摄影";
}

async function readJson<T>(response: Response): Promise<T> {
  const data = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(data.error || "请求失败，请稍后再试。");
  return data;
}

export default function GalleryApp() {
  const [user, setUser] = useState<User | null>(null);
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [clientId, setClientId] = useState("");
  const [authReady, setAuthReady] = useState(false);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState("");
  const [filter, setFilter] = useState("全部");
  const [selected, setSelected] = useState<Photo | null>(null);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [uploading, setUploading] = useState(false);
  const headerGoogleRef = useRef<HTMLDivElement>(null);
  const cardGoogleRef = useRef<HTMLDivElement>(null);

  const loadPhotos = useCallback(async () => {
    const result = await readJson<{ photos: Photo[] }>(await fetch("/api/photos"));
    setPhotos(result.photos);
  }, []);

  const completeGoogleLogin = useCallback(async (response: GoogleCredentialResponse) => {
    try {
      setNotice("");
      const result = await readJson<{ user: User }>(await fetch("/api/auth/google", {
        method: "POST",
        headers: { "content-type": "application/json", "x-lumen-request": "google-login" },
        body: JSON.stringify({ credential: response.credential }),
      }));
      setUser(result.user);
      await loadPhotos();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "登录失败，请重试。");
    }
  }, [loadPhotos]);

  useEffect(() => {
    Promise.all([
      fetch("/api/config").then((response) => readJson<{ googleClientId: string }>(response)),
      fetch("/api/me").then((response) => readJson<{ user: User | null }>(response)),
    ]).then(async ([config, session]) => {
      setClientId(config.googleClientId);
      setUser(session.user);
      if (session.user) await loadPhotos();
    }).catch(() => setNotice("暂时无法连接云端，请刷新重试。"))
      .finally(() => setLoading(false));
  }, [loadPhotos]);

  useEffect(() => {
    if (!clientId || user) return;
    const renderGoogleButtons = () => {
      if (!window.google || !headerGoogleRef.current || !cardGoogleRef.current) return;
      window.google.accounts.id.initialize({ client_id: clientId, callback: completeGoogleLogin });
      const common = { type: "standard", theme: "filled_black", shape: "pill", text: "signin_with", locale: "zh_CN" };
      headerGoogleRef.current.replaceChildren();
      cardGoogleRef.current.replaceChildren();
      window.google.accounts.id.renderButton(headerGoogleRef.current, { ...common, size: "medium", width: 190 });
      window.google.accounts.id.renderButton(cardGoogleRef.current, { ...common, size: "large", width: 280 });
      setAuthReady(true);
    };

    const existing = document.querySelector<HTMLScriptElement>('script[data-lumen-google="true"]');
    if (existing) {
      if (window.google) renderGoogleButtons();
      else existing.addEventListener("load", renderGoogleButtons, { once: true });
      return;
    }

    const script = document.createElement("script");
    script.src = "https://accounts.google.com/gsi/client?hl=zh_CN";
    script.async = true;
    script.dataset.lumenGoogle = "true";
    script.addEventListener("load", renderGoogleButtons, { once: true });
    document.head.appendChild(script);
  }, [clientId, completeGoogleLogin, user]);

  useEffect(() => {
    if (!selected) return;
    const close = (event: KeyboardEvent) => event.key === "Escape" && setSelected(null);
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [selected]);

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST", headers: { "x-lumen-request": "logout" } });
    window.google?.accounts.id.disableAutoSelect();
    setUser(null);
    setPhotos([]);
    setAuthReady(false);
  }

  async function uploadPhoto(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setUploading(true);
    setNotice("");
    try {
      const result = await readJson<{ photo: Photo }>(await fetch("/api/photos", {
        method: "POST",
        headers: { "x-lumen-request": "upload" },
        body: new FormData(event.currentTarget),
      }));
      setPhotos((current) => [result.photo, ...current]);
      setUploadOpen(false);
      event.currentTarget.reset();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "上传失败，请重试。");
    } finally {
      setUploading(false);
    }
  }

  async function deletePhoto(photo: Photo) {
    if (!window.confirm(`确定删除“${photo.title}”吗？`)) return;
    try {
      await readJson(await fetch(`/api/photos/${encodeURIComponent(photo.id)}`, {
        method: "DELETE",
        headers: { "x-lumen-request": "delete" },
      }));
      setPhotos((current) => current.filter((item) => item.id !== photo.id));
      setSelected(null);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "删除失败，请重试。");
    }
  }

  async function shareSite() {
    const shareData = { title: "LUMEN｜私人摄影档案", text: "来看看我的摄影作品。", url: window.location.href };
    if (navigator.share) await navigator.share(shareData).catch(() => undefined);
    else {
      await navigator.clipboard.writeText(window.location.href);
      setNotice("网站链接已复制，可以发给朋友了。");
    }
  }

  const displayPhotos = photos.length ? photos : demoPhotos;
  const filteredPhotos = filter === "全部" ? displayPhotos : displayPhotos.filter((photo) => displayCategory(photo.category) === filter);

  return (
    <main>
      <header className="site-header">
        <a className="wordmark" href="#top" aria-label="LU XIN 首页">LU<span>•</span>XIN</a>
        <div className="header-actions">
          <span className="cloud-status"><i /> 云端摄影档案</span>
          {!user && clientId ? <div className="google-slot google-slot-header" ref={headerGoogleRef} aria-label="Google 登录" /> : null}
          {!user && !clientId ? <span className="setup-pill">等待连接 Google</span> : null}
          {user ? (
            <div className="account-menu">
              <button className="share-button" type="button" onClick={shareSite}>分享</button>
              <button className="avatar-button" type="button" onClick={logout} title="退出登录">
                {user.picture ? <img src={user.picture} alt="" referrerPolicy="no-referrer" /> : user.name.slice(0, 1)}
              </button>
            </div>
          ) : null}
        </div>
      </header>

      {notice ? <button className="notice" type="button" onClick={() => setNotice("")}>{notice}<span>×</span></button> : null}

      <section className={`hero ${user ? "hero-signed-in" : ""}`} id="top">
        <div className="hero-copy">
          <p className="eyebrow">PRIVATE PHOTOGRAPHY ARCHIVE / 2026</p>
          <h1>让光，替我们记住。</h1>
          <p className="hero-intro">一个安静、私密的摄影空间。收藏旅途与日常，也把珍贵的画面分享给重要的人。</p>
          <div className="hero-meta">
            <span>{photos.length || "—"} 张云端作品</span><span>原画安全存储</span><span>仅登录后可见</span>
          </div>
        </div>

        <div className="hero-frame" aria-label="精选摄影作品">
          <img src={photos[0]?.url || "https://images.unsplash.com/photo-1469474968028-56623f02e42e?auto=format&fit=crop&w=1800&q=90"} alt="山谷中的晨雾与光线" />
          <div className="frame-caption"><p>{photos[0]?.title || "清晨，风从山脊经过"}<br /><small>{photos[0] ? `${photos[0].location} / ${photos[0].capturedAt}` : "HOKKAIDO / 2025"}</small></p></div>
          {!user ? (
            <div className="login-panel">
              <span className="lock-mark" aria-hidden="true">⌁</span>
              <p className="login-kicker">PRIVATE ACCESS</p>
              <h2>登录后，进入摄影档案</h2>
              <p>使用 Google 账号登录，受邀的朋友也可以安全查看。</p>
              {clientId ? <div className="google-slot google-slot-card" ref={cardGoogleRef} aria-label="使用 Google 登录" /> : <div className="auth-placeholder">Google 登录尚待最后连接</div>}
              {clientId && !authReady ? <small>正在载入安全登录…</small> : null}
            </div>
          ) : null}
        </div>
      </section>

      {user ? (
        <section className="archive" aria-labelledby="archive-title">
          <div className="archive-heading">
            <div><p className="eyebrow">THE ARCHIVE</p><h2 id="archive-title">摄影档案</h2></div>
            <div className="archive-controls">
              <nav className="filters" aria-label="作品分类">
                {categoryTabs.map((item) => <button className={filter === item ? "active" : ""} type="button" key={item} onClick={() => setFilter(item)}>{item}</button>)}
              </nav>
              {user.isOwner ? <button className="upload-button" type="button" onClick={() => setUploadOpen(true)}>＋ 上传照片</button> : null}
            </div>
          </div>

          <div className="photo-grid">
            {filteredPhotos.map((photo, index) => (
              <article className={`photo-card photo-${index % 3}`} key={photo.id}>
                <button className="photo-image" type="button" onClick={() => setSelected(photo)} aria-label={`查看 ${photo.title}`}>
                  <img src={photo.url} alt={photo.title} loading={index > 2 ? "lazy" : "eager"} />
                </button>
                <div className="photo-caption"><h3>{photo.title}</h3><p>{photo.location} · {photo.capturedAt}</p></div>
              </article>
            ))}
          </div>
          {!filteredPhotos.length ? <div className="empty-state">这个分类里还没有照片。</div> : null}
        </section>
      ) : (
        <section className="locked-archive" aria-label="受保护的摄影档案">
          <div><p className="eyebrow">THE ARCHIVE</p><h2>作品已安全收藏</h2><p>完整画质与作品信息仅对登录访客开放。</p></div>
          <div className="locked-strip" aria-hidden="true">{demoPhotos.map((photo) => <img src={photo.url} alt="" key={photo.id} />)}<span>登录后查看</span></div>
        </section>
      )}

      <footer><p><span className="legal-links"><a href="privacy.html">隐私政策</a> · <a href="terms.html">服务条款</a></span><br />© 2026 · KEEP THE LIGHT, CLOSE.</p></footer>

      {selected ? (
        <div className="lightbox" role="dialog" aria-modal="true" aria-label={selected.title}>
          <button className="lightbox-close" type="button" onClick={() => setSelected(null)} aria-label="关闭">×</button>
          <img src={selected.url} alt={selected.title} />
          <div className="lightbox-meta"><div><h2>{selected.title}</h2><p>{displayCategory(selected.category)} · {selected.location} · {selected.capturedAt}</p></div>{user?.isOwner && !selected.id.startsWith("demo-") ? <button type="button" onClick={() => deletePhoto(selected)}>删除照片</button> : null}</div>
        </div>
      ) : null}

      {uploadOpen ? (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="upload-title">
          <form className="upload-modal" onSubmit={uploadPhoto}>
            <button className="modal-close" type="button" onClick={() => setUploadOpen(false)} aria-label="关闭">×</button>
            <p className="eyebrow">ADD TO THE ARCHIVE</p><h2 id="upload-title">上传一张新作品</h2>
            <label className="file-drop"><input name="file" type="file" accept="image/jpeg,image/png,image/webp,image/avif" required /><span>选择照片</span><small>JPG、PNG、WebP 或 AVIF，最大 20MB</small></label>
            <div className="form-grid">
              <label><span>作品名称</span><input name="title" maxLength={80} placeholder="例如：清晨的风" required /></label>
              <label><span>拍摄地点</span><input name="location" maxLength={80} placeholder="例如：北海道" /></label>
              <label><span>分类</span><select name="category" defaultValue="摄影"><option>摄影</option><option>动物</option><option>个人</option></select></label>
              <label><span>拍摄年份</span><input name="capturedAt" maxLength={20} placeholder="2026" /></label>
            </div>
            <button className="submit-upload" type="submit" disabled={uploading}>{uploading ? "正在安全上传…" : "上传到云端"}</button>
          </form>
        </div>
      ) : null}

      {loading ? <div className="page-loader" aria-label="正在载入"><span /></div> : null}
    </main>
  );
}
