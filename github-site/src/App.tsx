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
  ["旷野来信", "摄影", "冰岛", "2025", "https://images.unsplash.com/photo-1500530855697-b586d89ba3ee?auto=format&fit=crop&w=1800&q=88"],
  ["夏夜之后", "个人", "京都", "2024", "https://images.unsplash.com/photo-1492684223066-81342ee5ff30?auto=format&fit=crop&w=1400&q=88"],
  ["林间来客", "动物", "北海道", "2025", "https://images.unsplash.com/photo-1474511320723-9a56873867b5?auto=format&fit=crop&w=1500&q=88"],
].map(([title, category, location, capturedAt, url], index) => ({
  id: `demo-${index}`,
  title,
  category,
  location,
  capturedAt,
  createdAt: 0,
  url,
}));

const categoryTabs = ["全部", "摄影", "动物", "个人"] as const;
const viewModes = [
  { id: "default", label: "默认" },
  { id: "list", label: "列表" },
  { id: "gallery", label: "画廊" },
  { id: "loop", label: "环形" },
  { id: "spiral", label: "螺旋" },
] as const;

type ViewMode = typeof viewModes[number]["id"];

type UploadItem = {
  id: string;
  file: File;
  preview: string;
  metadata: PhotoMetadata | null;
  status: "analyzing" | "ready" | "uploading" | "error";
  error?: string;
};

function displayCategory(category: string) {
  if (category === "动物" || category === "个人") return category;
  return "摄影";
}

function sizeMasonryCard(image: HTMLImageElement) {
  const card = image.closest<HTMLElement>(".photo-card");
  const grid = card?.parentElement;
  if (!card || !grid) return;
  if (!grid.classList.contains("view-default")) {
    card.style.gridRowEnd = "";
    return;
  }
  const styles = window.getComputedStyle(grid);
  const rowHeight = Number.parseFloat(styles.gridAutoRows) || 4;
  const rowGap = Number.parseFloat(styles.rowGap) || 0;
  const span = Math.ceil((card.getBoundingClientRect().height + rowGap) / (rowHeight + rowGap));
  card.style.gridRowEnd = `span ${span}`;
}

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
  const [viewMode, setViewMode] = useState<ViewMode>("default");
  const [selected, setSelected] = useState<Photo | null>(null);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadItems, setUploadItems] = useState<UploadItem[]>([]);
  const [uploadProgress, setUploadProgress] = useState({ current: 0, total: 0 });
  const googleCardRef = useRef<HTMLDivElement>(null);
  const analysisIdRef = useRef(0);
  const uploadItemsRef = useRef<UploadItem[]>([]);

  useEffect(() => {
    let frame = 0;
    const resizeCards = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        document.querySelectorAll<HTMLImageElement>(".photo-grid .photo-image img").forEach(sizeMasonryCard);
      });
    };
    window.addEventListener("resize", resizeCards);
    return () => {
      window.removeEventListener("resize", resizeCards);
      cancelAnimationFrame(frame);
    };
  }, []);

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      document.querySelectorAll<HTMLImageElement>(".photo-grid .photo-image img").forEach(sizeMasonryCard);
    });
    return () => cancelAnimationFrame(frame);
  }, [filter, photos, viewMode]);
  const [manageMode] = useState(() => new URLSearchParams(window.location.search).get("manage") === "1");
  const [heroMotionEnabled] = useState(() => !window.matchMedia("(prefers-reduced-motion: reduce)").matches);

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
      await loadArchive();
      const restored = await restoreUser().catch(() => null);
      if (!active) return;
      if (restored?.isOwner) setUser(restored);
      else if (restored) logout();
    }
    boot().catch((error) => active && setNotice(errorMessage(error, "无法连接云端。"))).finally(() => active && setLoading(false));
    return () => { active = false; };
  }, [loadArchive]);

  useEffect(() => {
    if (!manageMode || !googleClientId || user) return;
    let active = true;
    loadGoogleIdentity().then(() => {
      if (!active || !window.google) return;
      window.google.accounts.id.initialize({
        client_id: googleClientId,
        callback: async ({ credential }) => {
          setLoading(true);
          try {
            const signedInUser = await loginWithGoogle(credential);
            if (!signedInUser.isOwner) {
              logout();
              setNotice("这个 Google 账号不是相册主人，无法进入管理模式。");
              return;
            }
            setUser(signedInUser);
          } catch (error) {
            setNotice(errorMessage(error, "Google 登录失败。"));
          } finally {
            setLoading(false);
          }
        },
      });
      const common = { type: "standard", theme: "filled_black", text: "signin_with", shape: "pill", logo_alignment: "left" };
      if (googleCardRef.current) {
        googleCardRef.current.innerHTML = "";
        window.google.accounts.id.renderButton(googleCardRef.current, { ...common, size: "large", width: 280 });
      }
    }).catch((error) => active && setNotice(errorMessage(error, "Google 登录组件加载失败。")));
    return () => { active = false; };
  }, [googleClientId, manageMode, user]);

  useEffect(() => {
    if (!selected) return;
    const close = (event: KeyboardEvent) => event.key === "Escape" && setSelected(null);
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [selected]);

  useEffect(() => {
    uploadItemsRef.current = uploadItems;
  }, [uploadItems]);

  useEffect(() => () => {
    uploadItemsRef.current.forEach((item) => URL.revokeObjectURL(item.preview));
  }, []);

  function closeUpload() {
    if (uploading) return;
    analysisIdRef.current += 1;
    uploadItems.forEach((item) => URL.revokeObjectURL(item.preview));
    setUploadOpen(false);
    setUploadItems([]);
    setUploadProgress({ current: 0, total: 0 });
  }

  async function analyzeUploadItem(item: UploadItem, analysisId: number) {
    let metadata: PhotoMetadata;
    try {
      metadata = await extractPhotoMetadata(item.file);
      if (metadata.latitude !== undefined && metadata.longitude !== undefined) {
        try {
          const result = await reverseGeocode(metadata.latitude, metadata.longitude);
          metadata.location = result.location;
          metadata.geocoded = Boolean(result.location);
        } catch {
          metadata.location = "地点识别暂不可用";
        }
      }
    } catch {
      metadata = {
        title: item.file.name.replace(/\.[^.]+$/, "") || "未命名作品",
        category: "摄影",
        location: "",
        capturedAt: "",
        camera: "",
        lens: "",
        technical: "",
      };
    }
    if (analysisId !== analysisIdRef.current) return;
    setUploadItems((current) => current.map((currentItem) => (
      currentItem.id === item.id ? { ...currentItem, metadata, status: "ready" } : currentItem
    )));
  }

  async function analyzeUploadItems(items: UploadItem[], analysisId: number) {
    for (const item of items) {
      if (analysisId !== analysisIdRef.current) break;
      await analyzeUploadItem(item, analysisId);
    }
  }

  function handleFilesSelected(event: ChangeEvent<HTMLInputElement>) {
    const selectedFiles = Array.from(event.currentTarget.files || []);
    event.currentTarget.value = "";
    if (!selectedFiles.length) return;

    const allowedTypes = new Set(["image/jpeg", "image/png", "image/webp", "image/avif"]);
    const existingFiles = new Set(uploadItems.map((item) => `${item.file.name}:${item.file.size}:${item.file.lastModified}`));
    const validFiles = selectedFiles.filter((file) => allowedTypes.has(file.type) && file.size <= 20 * 1024 * 1024)
      .filter((file) => !existingFiles.has(`${file.name}:${file.size}:${file.lastModified}`));
    const invalidCount = selectedFiles.filter((file) => !allowedTypes.has(file.type) || file.size > 20 * 1024 * 1024).length;
    const duplicateCount = selectedFiles.length - validFiles.length - invalidCount;

    if (!validFiles.length) {
      setNotice(invalidCount ? "请选择 JPG、PNG、WebP 或 AVIF 图片，且每张不超过 20MB。" : "这些照片已经在待上传列表中。");
      return;
    }

    const analysisId = analysisIdRef.current;
    const newItems: UploadItem[] = validFiles.map((file) => ({
      id: crypto.randomUUID(),
      file,
      preview: URL.createObjectURL(file),
      metadata: null,
      status: "analyzing",
    }));
    setUploadItems((current) => [...current, ...newItems]);
    void analyzeUploadItems(newItems, analysisId);

    if (invalidCount || duplicateCount) {
      const notes = [
        invalidCount ? `${invalidCount} 张格式或大小不符合要求` : "",
        duplicateCount ? `${duplicateCount} 张已在列表中` : "",
      ].filter(Boolean).join("，");
      setNotice(`已加入 ${validFiles.length} 张照片；${notes}。`);
    }
  }

  function removeUploadItem(id: string) {
    if (uploading) return;
    setUploadItems((current) => {
      const removed = current.find((item) => item.id === id);
      if (removed) URL.revokeObjectURL(removed.preview);
      return current.filter((item) => item.id !== id);
    });
  }

  async function handleUpload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!user?.isOwner) return setNotice("当前账号只有查看权限。");
    if (!uploadItems.length) return setNotice("请先选择要上传的照片。");
    if (uploadItems.some((item) => item.status === "analyzing")) return setNotice("照片信息仍在自动识别，请稍候。");
    const pendingItems = uploadItems.filter((item) => item.metadata && item.status !== "uploading");
    if (!pendingItems.length) return;

    setUploading(true);
    setUploadProgress({ current: 0, total: pendingItems.length });
    let successCount = 0;
    let failureCount = 0;

    for (const [index, item] of pendingItems.entries()) {
      const metadata = item.metadata;
      if (!metadata) continue;
      setUploadProgress({ current: index + 1, total: pendingItems.length });
      setUploadItems((current) => current.map((currentItem) => (
        currentItem.id === item.id ? { ...currentItem, status: "uploading", error: undefined } : currentItem
      )));
      const form = new FormData();
      form.set("file", item.file);
      form.set("title", metadata.title);
      form.set("category", metadata.category);
      form.set("location", metadata.location);
      form.set("capturedAt", metadata.capturedAt);
      form.set("camera", metadata.camera);
      form.set("lens", metadata.lens);
      form.set("technical", metadata.technical);

      try {
        const photo = await uploadCloudPhoto(form);
        successCount += 1;
        setPhotos((current) => [photo, ...current]);
        setUploadItems((current) => current.filter((currentItem) => currentItem.id !== item.id));
        URL.revokeObjectURL(item.preview);
      } catch (error) {
        failureCount += 1;
        setUploadItems((current) => current.map((currentItem) => (
          currentItem.id === item.id
            ? { ...currentItem, status: "error", error: errorMessage(error, "上传失败，请重试。") }
            : currentItem
        )));
      }
    }

    setUploading(false);
    setUploadProgress({ current: 0, total: 0 });
    if (!failureCount) {
      closeUpload();
      setNotice(`已成功上传 ${successCount} 张照片。`);
    } else {
      setNotice(`已上传 ${successCount} 张，${failureCount} 张失败，可在列表中重试。`);
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
    setSelected(null);
    closeUpload();
  }

  async function shareSite() {
    const publicUrl = `${window.location.origin}${window.location.pathname}`;
    const data = { title: "LUMEN｜私人摄影档案", text: "来看看我的摄影作品。", url: publicUrl };
    if (navigator.share) await navigator.share(data).catch(() => undefined);
    else {
      await navigator.clipboard.writeText(publicUrl);
      setNotice("链接已复制，可以发给朋友了。");
    }
  }

  const shown = photos.length ? photos : demoPhotos;
  const filtered = filter === "全部" ? shown : shown.filter((photo) => displayCategory(photo.category) === filter);
  const displayName = user?.name || user?.email || "访客";
  const analyzingCount = uploadItems.filter((item) => item.status === "analyzing").length;
  const failedUploadCount = uploadItems.filter((item) => item.status === "error").length;

  return <main>
    <header className="site-header">
      <a className="wordmark" href="#top">LU<span>•</span>XIN</a>
      <div className="header-actions">
        <span className="cloud-status"><i /> GITHUB PAGES · B2 PRIVATE CLOUD</span>
        {user?.isOwner ? <div className="account-menu"><span className="access-badge owner">主人模式</span><button className="share-button" type="button" onClick={shareSite}>分享</button><button className="avatar-button" type="button" onClick={signOut} title="退出管理模式">{user.picture ? <img src={user.picture} alt="" referrerPolicy="no-referrer" /> : displayName.slice(0, 1)}</button></div> : null}
      </div>
    </header>

    {notice ? <button className="notice" type="button" onClick={() => setNotice("")}>{notice}<span>×</span></button> : null}

    <section className="hero hero-signed-in" id="top">
      <div className="hero-copy"><p className="eyebrow">PRIVATE PHOTOGRAPHY ARCHIVE / 2026</p><h1>让光，替我们记住</h1><p className="hero-intro">一个安静、私密的摄影空间。收藏旅途与日常，也把珍贵的画面分享给重要的人</p></div>
      <div className="hero-frame">
        <video
          className="hero-video"
          autoPlay={heroMotionEnabled}
          muted
          loop
          playsInline
          preload="metadata"
          poster={`${import.meta.env.BASE_URL}media/lumen-hero-poster.jpg`}
          aria-label="光影中的人物剪影"
        >
          <source src={`${import.meta.env.BASE_URL}media/lumen-hero-clean.mp4`} type="video/mp4" />
          你的浏览器暂不支持视频播放。
        </video>
        <div className="frame-caption"><p>光流过，记忆留下<br /><small>A MEMORY IN MOTION / 2026</small></p></div>
      </div>
    </section>

    <section className="archive" id="archive">
      <div className="archive-heading">
        <div className="archive-title"><p className="eyebrow">THE ARCHIVE</p><h2>摄影档案</h2></div>
        <div className="archive-controls">
          <nav className="view-switcher" aria-label="照片展示形式">
            {viewModes.map((mode) => (
              <button className={viewMode === mode.id ? "active" : ""} type="button" key={mode.id} aria-pressed={viewMode === mode.id} onClick={() => setViewMode(mode.id)}>
                <span aria-hidden="true" />{mode.label}
              </button>
            ))}
          </nav>
          <div className="archive-actions">
            <nav className="filters" aria-label="作品分类">{categoryTabs.map((item) => <button className={filter === item ? "active" : ""} type="button" key={item} onClick={() => setFilter(item)}>{item}</button>)}</nav>
            {user?.isOwner ? <button className="upload-button" type="button" onClick={() => setUploadOpen(true)}>＋ 上传照片</button> : null}
          </div>
        </div>
      </div>
      <div className={`photo-grid view-${viewMode}`}>{filtered.map((photo, index) => <article className={`photo-card photo-${index % 3}`} key={photo.id}><button className="photo-image" type="button" onClick={() => setSelected(photo)} aria-label={`查看 ${photo.title}`}><img src={photo.url} alt={photo.title} loading={index > 2 ? "lazy" : "eager"} onLoad={(event) => sizeMasonryCard(event.currentTarget)} /></button><div className="photo-caption"><h3>{photo.title}</h3><p><span>{displayCategory(photo.category)}</span><span>{photo.location || "地点未知"} · {photo.capturedAt || "时间未知"}</span></p></div></article>)}</div>
      {!filtered.length ? <div className="empty-state">这个分类里还没有照片。</div> : null}
    </section>

    <footer><p><span className="legal-links"><a href="privacy.html">隐私政策</a> · <a href="terms.html">服务条款</a></span><br />© 2026 · KEEP THE LIGHT, CLOSE.</p></footer>

    {selected ? <div className="lightbox" role="dialog" aria-modal="true"><button className="lightbox-close" type="button" onClick={() => setSelected(null)}>×</button><img src={selected.url} alt={selected.title} /><div className="lightbox-meta"><div><h2>{selected.title}</h2><p>{displayCategory(selected.category)} · {selected.location || "地点未知"} · {selected.capturedAt || "时间未知"}</p>{selected.camera || selected.lens || selected.technical ? <p className="camera-data">{[selected.camera, selected.lens, selected.technical].filter(Boolean).join(" · ")}</p> : null}</div>{user?.isOwner && !selected.id.startsWith("demo-") ? <button type="button" onClick={() => handleDelete(selected)}>删除照片</button> : null}</div></div> : null}

    {uploadOpen && user?.isOwner ? (
      <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="batch-upload-title">
        <form className="upload-modal batch-upload-modal" onSubmit={handleUpload}>
          <button className="modal-close" type="button" onClick={closeUpload} disabled={uploading} aria-label="关闭">×</button>
          <p className="eyebrow">ADD TO THE ARCHIVE</p>
          <h2 id="batch-upload-title">批量上传照片</h2>
          <label className="file-drop batch-file-drop">
            <input
              type="file"
              accept="image/jpeg,image/png,image/webp,image/avif"
              onChange={handleFilesSelected}
              disabled={uploading || analyzingCount > 0}
              multiple
            />
            <span>{uploadItems.length ? "继续添加照片" : "选择多张照片"}</span>
            <small>{uploadItems.length ? `已选择 ${uploadItems.length} 张，可继续添加` : "支持一次多选；JPG、PNG、WebP 或 AVIF，每张最大 20MB"}</small>
          </label>

          <section className={`upload-queue ${uploadItems.length ? "" : "is-empty"}`} aria-live="polite">
            {!uploadItems.length ? (
              <div className="metadata-empty">
                <strong>选择后逐张自动识别</strong>
                <p>拍摄时间、GPS 地点、相机型号和拍摄参数会自动读取，无需手动填写。</p>
              </div>
            ) : uploadItems.map((item, index) => (
              <article className={`upload-item is-${item.status}`} key={item.id}>
                <img src={item.preview} alt="" />
                <div className="upload-item-copy">
                  <div className="upload-item-heading">
                    <span>{String(index + 1).padStart(2, "0")}</span>
                    <strong>{item.metadata?.title || item.file.name}</strong>
                  </div>
                  {item.status === "analyzing" ? <p>正在读取拍摄信息与地点名称…</p> : null}
                  {item.status === "uploading" ? <p>正在安全上传到私有云端…</p> : null}
                  {item.status === "error" ? <p className="upload-item-error">{item.error}</p> : null}
                  {item.status === "ready" && item.metadata ? (
                    <p>{[item.metadata.capturedAt || "时间未知", item.metadata.location || "地点未知", item.metadata.camera].filter(Boolean).join(" · ")}</p>
                  ) : null}
                  <small>{(item.file.size / 1024 / 1024).toFixed(1)}MB · {item.metadata?.category || "正在识别"}</small>
                </div>
                <button type="button" onClick={() => removeUploadItem(item.id)} disabled={uploading} aria-label={`移除 ${item.file.name}`}>×</button>
              </article>
            ))}
          </section>

          {uploadItems.length ? (
            <div className="upload-summary">
              <span>{analyzingCount ? `${analyzingCount} 张正在识别` : `${uploadItems.length} 张等待上传`}</span>
              <span>将按顺序逐张上传</span>
            </div>
          ) : null}
          <button className="submit-upload" type="submit" disabled={uploading || analyzingCount > 0 || !uploadItems.length}>
            {uploading
              ? `正在上传 ${uploadProgress.current}/${uploadProgress.total}`
              : analyzingCount
                ? `正在识别 ${analyzingCount} 张照片…`
                : failedUploadCount
                  ? `重试失败的 ${failedUploadCount} 张`
                  : `上传 ${uploadItems.length} 张到云端`}
          </button>
        </form>
      </div>
    ) : null}
    {manageMode && !user ? <div className="modal-backdrop owner-gate" role="dialog" aria-modal="true" aria-labelledby="owner-gate-title"><div className="owner-gate-card"><a className="owner-gate-close" href="./" aria-label="返回公开相册">×</a><p className="eyebrow">OWNER ACCESS</p><h2 id="owner-gate-title">主人管理</h2><p>使用主人 Google 账号验证后，才会显示上传和删除功能。</p>{googleClientId ? <div className="google-slot google-slot-card" ref={googleCardRef} /> : <div className="auth-placeholder">等待管理登录配置</div>}<a className="owner-gate-back" href="./">返回公开相册</a></div></div> : null}
    {loading ? <div className="page-loader"><span /></div> : null}
  </main>;
}
