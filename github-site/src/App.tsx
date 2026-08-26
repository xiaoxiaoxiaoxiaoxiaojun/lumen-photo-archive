import { ChangeEvent, FormEvent, useCallback, useEffect, useRef, useState } from "react";
import {
  deletePhoto as deleteCloudPhoto,
  getConfig,
  getPhotos,
  isConfigured,
  loginWithGoogle,
  logout,
  reverseGeocode,
  restoreUser,
  uploadPhoto as uploadCloudPhoto,
  type Photo,
  type SessionUser,
} from "./api";
import { extractPhotoMetadata, type PhotoMetadata } from "./photo-metadata";

const demoPhotos: Photo[] = [
  ["旷野来信", "旅途", "冰岛", "2025", "https://images.unsplash.com/photo-1500530855697-b586d89ba3ee?auto=format&fit=crop&w=1800&q=88"],
  ["夏夜之后", "日常", "京都", "2024", "https://images.unsplash.com/photo-1492684223066-81342ee5ff30?auto=format&fit=crop&w=1400&q=88"],
  ["城市切面", "城市", "首尔", "2025", "https://images.unsplash.com/photo-1518005020951-eccb494ad742?auto=format&fit=crop&w=1500&q=88"],
].map(([title, category, location, capturedAt, url], index) => ({
  id: `demo-${index}`,
  title,
  category,
  location,
  capturedAt,
  createdAt: 0,
  url,
}));

let googleScriptPromise: Promise<void> | null = null;

function loadGoogleIdentity() {
  if (window.google) return Promise.resolve();
  if (googleScriptPromise) return googleScriptPromise;
  googleScriptPromise = new Promise((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>('script[src^="https://accounts.google.com/gsi/client"]');
    if (existing) {
      existing.addEventListener("load", () => resolve(), { once: true });
      existing.addEventListener("error", () => reject(new Error("Google 登录组件加载失败。")), { once: true });
      return;
    }
    const script = document.createElement("script");
    script.src = "https://accounts.google.com/gsi/client?hl=zh_CN";
    script.async = true;
    script.defer = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Google 登录组件加载失败。"));
    document.head.appendChild(script);
  });
  return googleScriptPromise;
}

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

export default function App() {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [loading, setLoading] = useState(isConfigured);
  const [notice, setNotice] = useState("");
  const [googleClientId, setGoogleClientId] = useState("");
  const [filter, setFilter] = useState("全部");
  const [selected, setSelected] = useState<Photo | null>(null);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploadPreview, setUploadPreview] = useState("");
  const [uploadMetadata, setUploadMetadata] = useState<PhotoMetadata | null>(null);
  const googleHeaderRef = useRef<HTMLDivElement>(null);
  const googleCardRef = useRef<HTMLDivElement>(null);
  const analysisIdRef = useRef(0);

  const loadArchive = useCallback(async () => {
    setPhotos(await getPhotos());
  }, []);

  useEffect(() => {
    let active = true;
    async function boot() {
      if (!isConfigured) return;
      const config = await getConfig();
      if (!active) return;
      setGoogleClientId(config.googleClientId);
      const restored = await restoreUser();
      if (!active || !restored) return;
      setUser(restored);
      await loadArchive();
    }
    boot().catch((error) => active && setNotice(errorMessage(error, "无法连接云端。"))).finally(() => active && setLoading(false));
    return () => { active = false; };
  }, [loadArchive]);

  useEffect(() => {
    if (!googleClientId || user) return;
    let active = true;
    loadGoogleIdentity().then(() => {
      if (!active || !window.google) return;
      window.google.accounts.id.initialize({
        client_id: googleClientId,
        callback: async ({ credential }) => {
          setLoading(true);
          try {
            const signedInUser = await loginWithGoogle(credential);
            setUser(signedInUser);
            await loadArchive();
          } catch (error) {
            setNotice(errorMessage(error, "Google 登录失败。"));
          } finally {
            setLoading(false);
          }
        },
      });
      const common = { type: "standard", theme: "filled_black", text: "signin_with", shape: "pill", logo_alignment: "left" };
      if (googleHeaderRef.current) {
        googleHeaderRef.current.innerHTML = "";
        window.google.accounts.id.renderButton(googleHeaderRef.current, { ...common, size: "medium", width: 190 });
      }
      if (googleCardRef.current) {
        googleCardRef.current.innerHTML = "";
        window.google.accounts.id.renderButton(googleCardRef.current, { ...common, size: "large", width: 280 });
      }
    }).catch((error) => active && setNotice(errorMessage(error, "Google 登录组件加载失败。")));
    return () => { active = false; };
  }, [googleClientId, loadArchive, user]);

  useEffect(() => {
    if (!selected) return;
    const close = (event: KeyboardEvent) => event.key === "Escape" && setSelected(null);
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [selected]);

  useEffect(() => () => {
    if (uploadPreview) URL.revokeObjectURL(uploadPreview);
  }, [uploadPreview]);

  function closeUpload() {
    analysisIdRef.current += 1;
    setUploadOpen(false);
    setUploadFile(null);
    setUploadMetadata(null);
    setUploadPreview("");
    setAnalyzing(false);
  }

  async function handleFileSelected(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    if (!file) return;
    if (!file.type.startsWith("image/") || file.size > 20 * 1024 * 1024) {
      event.currentTarget.value = "";
      setNotice("请选择一张不超过 20MB 的图片。");
      return;
    }

    const analysisId = ++analysisIdRef.current;
    setUploadFile(file);
    setUploadMetadata(null);
    setAnalyzing(true);
    setUploadPreview(URL.createObjectURL(file));

    try {
      const metadata = await extractPhotoMetadata(file);
      if (metadata.latitude !== undefined && metadata.longitude !== undefined) {
        try {
          const result = await reverseGeocode(metadata.latitude, metadata.longitude);
          metadata.location = result.location;
          metadata.geocoded = Boolean(result.location);
        } catch {
          metadata.location = "地点识别暂不可用";
        }
      }
      if (analysisId === analysisIdRef.current) setUploadMetadata(metadata);
    } catch {
      if (analysisId === analysisIdRef.current) {
        setUploadMetadata({
          title: file.name.replace(/\.[^.]+$/, "") || "未命名作品",
          category: "日常",
          location: "",
          capturedAt: "",
          camera: "",
          lens: "",
          technical: "",
        });
      }
    } finally {
      if (analysisId === analysisIdRef.current) setAnalyzing(false);
    }
  }

  async function handleUpload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!user?.isOwner) return setNotice("当前账号只有查看权限。");
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const file = form.get("file");
    if (!(file instanceof File) || !file.type.startsWith("image/") || file.size > 20 * 1024 * 1024) {
      return setNotice("请选择一张不超过 20MB 的图片。");
    }
    if (!uploadMetadata || analyzing) return setNotice("照片信息仍在自动识别，请稍候。");
    form.set("title", uploadMetadata.title);
    form.set("category", uploadMetadata.category);
    form.set("location", uploadMetadata.location);
    form.set("capturedAt", uploadMetadata.capturedAt);
    form.set("camera", uploadMetadata.camera);
    form.set("lens", uploadMetadata.lens);
    form.set("technical", uploadMetadata.technical);
    setUploading(true);
    try {
      const photo = await uploadCloudPhoto(form);
      setPhotos((current) => [photo, ...current]);
      formElement.reset();
      closeUpload();
    } catch (error) {
      setNotice(errorMessage(error, "上传失败，请重试。"));
    } finally {
      setUploading(false);
    }
  }

  async function handleDelete(photo: Photo) {
    if (!user?.isOwner) return setNotice("当前账号只有查看权限。");
    if (!window.confirm(`确定删除“${photo.title}”吗？删除后无法恢复。`)) return;
    try {
      await deleteCloudPhoto(photo.id);
      setPhotos((current) => current.filter((item) => item.id !== photo.id));
      setSelected(null);
    } catch (error) {
      setNotice(errorMessage(error, "删除失败，请重试。"));
    }
  }

  function signOut() {
    logout();
    window.google?.accounts.id.disableAutoSelect();
    setUser(null);
    setPhotos([]);
    setSelected(null);
    closeUpload();
  }

  async function shareSite() {
    const data = { title: "LUMEN｜私人摄影档案", text: "来看看我的摄影作品。", url: window.location.href };
    if (navigator.share) await navigator.share(data).catch(() => undefined);
    else {
      await navigator.clipboard.writeText(window.location.href);
      setNotice("链接已复制，可以发给朋友了。");
    }
  }

  const shown = photos.length ? photos : demoPhotos;
  const filtered = filter === "全部" ? shown : shown.filter((photo) => photo.category === filter);
  const displayName = user?.name || user?.email || "访客";

  return <main>
    <header className="site-header">
      <a className="wordmark" href="#top">LU<span>•</span>MEN</a>
      <div className="header-actions">
        <span className="cloud-status"><i /> GITHUB PAGES · B2 PRIVATE CLOUD</span>
        {!user ? (googleClientId ? <div className="google-slot google-slot-header" ref={googleHeaderRef} /> : <span className="setup-pill">等待云端配置</span>) : <div className="account-menu"><span className={`access-badge ${user.isOwner ? "owner" : "viewer"}`}>{user.isOwner ? "主人模式" : "只读访客"}</span>{user.isOwner ? <button className="share-button" type="button" onClick={shareSite}>分享</button> : null}<button className="avatar-button" type="button" onClick={signOut} title="退出登录">{user.picture ? <img src={user.picture} alt="" referrerPolicy="no-referrer" /> : displayName.slice(0, 1)}</button></div>}
      </div>
    </header>

    {notice ? <button className="notice" type="button" onClick={() => setNotice("")}>{notice}<span>×</span></button> : null}

    <section className={`hero ${user ? "hero-signed-in" : ""}`} id="top">
      <div className="hero-copy"><p className="eyebrow">PRIVATE PHOTOGRAPHY ARCHIVE / 2026</p><h1>把光，<br />留在云端。</h1><p className="hero-intro">一个安静、私密的摄影空间。收藏旅途与日常，也把珍贵的画面分享给重要的人。</p></div>
      <div className="hero-frame"><img src={photos[0]?.url || "https://images.unsplash.com/photo-1469474968028-56623f02e42e?auto=format&fit=crop&w=1800&q=90"} alt="山谷中的晨雾与光线" />
        {!user ? <div className="login-panel"><span className="lock-mark">⌁</span><p className="login-kicker">PRIVATE ACCESS</p><h2>登录后，进入摄影档案</h2><p>使用 Google 账号登录。朋友只能浏览，上传和删除只属于相册主人。</p>{googleClientId ? <div className="google-slot google-slot-card" ref={googleCardRef} /> : <div className="auth-placeholder">{isConfigured ? "等待 Google 登录配置" : "等待云端 API 配置"}</div>}</div> : <div className="frame-caption"><span>01</span><p>{photos[0]?.title || "清晨，风从山脊经过"}<br /><small>{photos[0] ? `${photos[0].location || "地点未知"} / ${photos[0].capturedAt || "时间未知"}` : "HOKKAIDO / 2025"}</small></p></div>}
      </div>
    </section>

    {user ? <section className="archive"><div className="archive-heading"><div><p className="eyebrow">THE ARCHIVE</p><h2>摄影档案</h2></div><div className="archive-controls"><nav className="filters">{["全部", "旅途", "城市", "日常"].map((item) => <button className={filter === item ? "active" : ""} type="button" key={item} onClick={() => setFilter(item)}>{item}</button>)}</nav>{user.isOwner ? <button className="upload-button" type="button" onClick={() => setUploadOpen(true)}>＋ 上传照片</button> : <span className="readonly-note">只读模式 · 无上传与删除权限</span>}</div></div>
      {!photos.length ? <p className="demo-label">示例作品 · 主人上传第一张照片后自动替换</p> : null}<div className="photo-grid">{filtered.map((photo, index) => <article className={`photo-card photo-${index % 3}`} key={photo.id}><button className="photo-image" type="button" onClick={() => setSelected(photo)}><img src={photo.url} alt={photo.title} /><span className="photo-index">{String(index + 1).padStart(2, "0")}</span></button><div className="photo-caption"><h3>{photo.title}</h3><p>{photo.location || "地点未知"} · {photo.capturedAt || "时间未知"}</p></div></article>)}</div></section>
      : <section className="locked-archive"><div><p className="eyebrow">THE ARCHIVE</p><h2>作品已安全收藏</h2><p>完整画质与作品信息仅对 Google 登录访客开放。</p></div><div className="locked-strip">{demoPhotos.map((photo) => <img src={photo.url} alt="" key={photo.id} />)}<span>登录后查看</span></div></section>}

    <footer><a className="wordmark footer-mark" href="#top">LU<span>•</span>MEN</a><p>PRIVATE PHOTOGRAPHY ARCHIVE<br />GITHUB PAGES + BACKBLAZE B2</p><p><span className="legal-links"><a href="privacy.html">隐私政策</a> · <a href="terms.html">服务条款</a></span><br />© 2026 · KEEP THE LIGHT, CLOSE.</p></footer>

    {selected ? <div className="lightbox" role="dialog" aria-modal="true"><button className="lightbox-close" type="button" onClick={() => setSelected(null)}>×</button><img src={selected.url} alt={selected.title} /><div className="lightbox-meta"><div><h2>{selected.title}</h2><p>{selected.category} · {selected.location || "地点未知"} · {selected.capturedAt || "时间未知"}</p>{selected.camera || selected.lens || selected.technical ? <p className="camera-data">{[selected.camera, selected.lens, selected.technical].filter(Boolean).join(" · ")}</p> : null}</div>{user?.isOwner && !selected.id.startsWith("demo-") ? <button type="button" onClick={() => handleDelete(selected)}>删除照片</button> : null}</div></div> : null}

    {uploadOpen && user?.isOwner ? <div className="modal-backdrop" role="dialog" aria-modal="true"><form className="upload-modal" onSubmit={handleUpload}><button className="modal-close" type="button" onClick={closeUpload}>×</button><p className="eyebrow">ADD TO THE ARCHIVE</p><h2>上传一张新作品</h2><label className={`file-drop ${uploadPreview ? "has-preview" : ""}`}>{uploadPreview ? <img src={uploadPreview} alt="待上传照片预览" /> : null}<input name="file" type="file" accept="image/jpeg,image/png,image/webp,image/avif" onChange={handleFileSelected} required /><span>{uploadPreview ? "更换照片" : "选择照片"}</span><small>{uploadFile ? `${uploadFile.name} · ${(uploadFile.size / 1024 / 1024).toFixed(1)}MB` : "JPG、PNG、WebP 或 AVIF，最大 20MB"}</small></label><section className="metadata-panel" aria-live="polite">{!uploadFile ? <div className="metadata-empty"><strong>选择后自动识别</strong><p>拍摄时间、GPS 地点、相机型号和拍摄参数会自动读取，无需手动填写。</p></div> : analyzing ? <div className="metadata-loading"><i /><div><strong>正在分析照片</strong><p>读取原始拍摄信息与地点名称…</p></div></div> : uploadMetadata ? <><div className="metadata-heading"><span>自动识别完成</span><b>无需填写</b></div><dl><div><dt>作品名称</dt><dd>{uploadMetadata.title}</dd></div><div><dt>拍摄时间</dt><dd>{uploadMetadata.capturedAt || "照片未记录"}</dd></div><div><dt>地点名称</dt><dd>{uploadMetadata.location || "照片没有 GPS 信息"}</dd></div><div><dt>分类</dt><dd>{uploadMetadata.category}</dd></div><div><dt>相机</dt><dd>{uploadMetadata.camera || "照片未记录"}</dd></div><div><dt>拍摄参数</dt><dd>{uploadMetadata.technical || "照片未记录"}</dd></div></dl>{uploadMetadata.geocoded ? <p className="map-credit">地点名称由 <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">© OpenStreetMap contributors</a> 提供</p> : null}</> : null}</section><button className="submit-upload" type="submit" disabled={uploading || analyzing || !uploadMetadata}>{uploading ? "正在上传…" : analyzing ? "正在识别…" : "上传到云端"}</button></form></div> : null}
    {loading ? <div className="page-loader"><span /></div> : null}
  </main>;
}
