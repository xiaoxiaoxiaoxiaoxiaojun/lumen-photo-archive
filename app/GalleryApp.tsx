"use client";

import { ChangeEvent, FormEvent, useCallback, useEffect, useRef, useState } from "react";

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
const viewModes = [
  { id: "default", label: "默认" },
  { id: "list", label: "列表" },
  { id: "gallery", label: "画廊" },
  { id: "loop", label: "环形" },
  { id: "spiral", label: "螺旋" },
] as const;

type ViewMode = typeof viewModes[number]["id"];

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
  const [viewMode, setViewMode] = useState<ViewMode>("default");
  const [selected, setSelected] = useState<Photo | null>(null);
  const [editingPhoto, setEditingPhoto] = useState<Photo | null>(null);
  const [savingEdit, setSavingEdit] = useState(false);
  const [bulkMode, setBulkMode] = useState(false);
  const [selectedPhotoIds, setSelectedPhotoIds] = useState<string[]>([]);
  const [deletingBatch, setDeletingBatch] = useState(false);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadFiles, setUploadFiles] = useState<File[]>([]);
  const [uploadProgress, setUploadProgress] = useState({ current: 0, total: 0 });
  const headerGoogleRef = useRef<HTMLDivElement>(null);
  const cardGoogleRef = useRef<HTMLDivElement>(null);

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
    setSelected(null);
    setEditingPhoto(null);
    setBulkMode(false);
    setSelectedPhotoIds([]);
  }

  function selectUploadFiles(event: ChangeEvent<HTMLInputElement>) {
    const selectedFiles = Array.from(event.currentTarget.files || []);
    event.currentTarget.value = "";
    const allowedTypes = new Set(["image/jpeg", "image/png", "image/webp", "image/avif"]);
    const existing = new Set(uploadFiles.map((file) => `${file.name}:${file.size}:${file.lastModified}`));
    const validFiles = selectedFiles.filter((file) => allowedTypes.has(file.type) && file.size <= 20 * 1024 * 1024)
      .filter((file) => !existing.has(`${file.name}:${file.size}:${file.lastModified}`));
    const invalidCount = selectedFiles.filter((file) => !allowedTypes.has(file.type) || file.size > 20 * 1024 * 1024).length;
    setUploadFiles((current) => [...current, ...validFiles]);
    if (!validFiles.length && selectedFiles.length) {
      setNotice(invalidCount ? "请选择 JPG、PNG、WebP 或 AVIF 图片，且每张不超过 20MB。" : "这些照片已经在待上传列表中。");
    } else if (invalidCount) {
      setNotice(`已加入 ${validFiles.length} 张照片，另有 ${invalidCount} 张格式或大小不符合要求。`);
    }
  }

  function removeUploadFile(fileToRemove: File) {
    if (uploading) return;
    setUploadFiles((current) => current.filter((file) => file !== fileToRemove));
  }

  function closeUpload() {
    if (uploading) return;
    setUploadOpen(false);
    setUploadFiles([]);
    setUploadProgress({ current: 0, total: 0 });
  }

  async function uploadPhotos(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!uploadFiles.length) return setNotice("请先选择要上传的照片。");
    const formElement = event.currentTarget;
    const sharedForm = new FormData(formElement);
    const sharedTitle = String(sharedForm.get("title") || "").trim();
    setUploading(true);
    setNotice("");
    setUploadProgress({ current: 0, total: uploadFiles.length });
    let successCount = 0;
    let failureCount = 0;

    for (const [index, file] of uploadFiles.entries()) {
      setUploadProgress({ current: index + 1, total: uploadFiles.length });
      const form = new FormData();
      form.set("file", file);
      const fallbackTitle = file.name.replace(/\.[^.]+$/, "") || "未命名作品";
      form.set("title", sharedTitle ? (uploadFiles.length > 1 ? `${sharedTitle} ${index + 1}` : sharedTitle) : fallbackTitle);
      for (const field of ["location", "category", "capturedAt"]) form.set(field, String(sharedForm.get(field) || ""));
      try {
        const result = await readJson<{ photo: Photo }>(await fetch("/api/photos", {
          method: "POST",
          headers: { "x-lumen-request": "upload" },
          body: form,
        }));
        successCount += 1;
        setPhotos((current) => [result.photo, ...current]);
        setUploadFiles((current) => current.filter((currentFile) => currentFile !== file));
      } catch {
        failureCount += 1;
      }
    }

    setUploading(false);
    setUploadProgress({ current: 0, total: 0 });
    if (!failureCount) {
      setUploadOpen(false);
      setUploadFiles([]);
      formElement.reset();
      setNotice(`已成功上传 ${successCount} 张照片。`);
    } else {
      setNotice(`已上传 ${successCount} 张，${failureCount} 张失败，可直接重试。`);
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
      setSelectedPhotoIds((current) => current.filter((id) => id !== photo.id));
      setSelected(null);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "删除失败，请重试。");
    }
  }

  async function editPhoto(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!user?.isOwner || !editingPhoto) return setNotice("当前账号只有查看权限。");
    const form = new FormData(event.currentTarget);
    setSavingEdit(true);
    try {
      const result = await readJson<{ photo: Photo }>(await fetch(`/api/photos/${encodeURIComponent(editingPhoto.id)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json", "x-lumen-request": "edit" },
        body: JSON.stringify({
          title: String(form.get("title") || ""),
          category: String(form.get("category") || "摄影"),
          location: String(form.get("location") || ""),
          capturedAt: String(form.get("capturedAt") || ""),
        }),
      }));
      setPhotos((current) => current.map((photo) => photo.id === result.photo.id ? result.photo : photo));
      setSelected((current) => current?.id === result.photo.id ? result.photo : current);
      setEditingPhoto(null);
      setNotice("照片信息已更新。");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "编辑失败，请重试。");
    } finally {
      setSavingEdit(false);
    }
  }

  function toggleBulkMode() {
    setBulkMode((current) => !current);
    setSelectedPhotoIds([]);
    setSelected(null);
  }

  function togglePhotoSelection(photo: Photo) {
    if (photo.id.startsWith("demo-")) return;
    setSelectedPhotoIds((current) => current.includes(photo.id)
      ? current.filter((id) => id !== photo.id)
      : [...current, photo.id]);
  }

  function toggleAllVisible(visiblePhotos: Photo[]) {
    const ids = visiblePhotos.filter((photo) => !photo.id.startsWith("demo-")).map((photo) => photo.id);
    const allSelected = ids.length > 0 && ids.every((id) => selectedPhotoIds.includes(id));
    setSelectedPhotoIds((current) => allSelected
      ? current.filter((id) => !ids.includes(id))
      : [...new Set([...current, ...ids])]);
  }

  async function batchDeletePhotos() {
    if (!user?.isOwner) return setNotice("当前账号只有查看权限。");
    if (!selectedPhotoIds.length) return setNotice("请先选择要删除的照片。");
    if (!window.confirm(`确定删除选中的 ${selectedPhotoIds.length} 张照片吗？删除后无法恢复。`)) return;
    setDeletingBatch(true);
    try {
      const result = await readJson<{ deletedIds: string[]; failed: Array<{ id: string; error: string }> }>(await fetch("/api/photos/batch-delete", {
        method: "POST",
        headers: { "content-type": "application/json", "x-lumen-request": "batch-delete" },
        body: JSON.stringify({ ids: selectedPhotoIds }),
      }));
      const deleted = new Set(result.deletedIds);
      setPhotos((current) => current.filter((photo) => !deleted.has(photo.id)));
      setSelected((current) => current && deleted.has(current.id) ? null : current);
      setSelectedPhotoIds((current) => current.filter((id) => !deleted.has(id)));
      if (result.failed.length) {
        setNotice(`已删除 ${result.deletedIds.length} 张，${result.failed.length} 张失败，可直接重试。`);
      } else {
        setBulkMode(false);
        setNotice(`已删除 ${result.deletedIds.length} 张照片。`);
      }
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "批量删除失败，请重试。");
    } finally {
      setDeletingBatch(false);
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
  const manageablePhotos = filteredPhotos.filter((photo) => !photo.id.startsWith("demo-"));
  const allVisibleSelected = manageablePhotos.length > 0 && manageablePhotos.every((photo) => selectedPhotoIds.includes(photo.id));

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
          <h1>让光，替我们记住</h1>
          <p className="hero-intro">一个安静、私密的摄影空间。收藏旅途与日常，也把珍贵的画面分享给重要的人</p>
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
        <section className="archive" id="archive" aria-labelledby="archive-title">
          <div className="archive-heading">
            <div className="archive-title"><p className="eyebrow">THE ARCHIVE</p><h2 id="archive-title">摄影档案</h2></div>
            <div className="archive-controls">
              <nav className="view-switcher" aria-label="照片展示形式">
                {viewModes.map((mode) => (
                  <button className={viewMode === mode.id ? "active" : ""} type="button" key={mode.id} aria-pressed={viewMode === mode.id} onClick={() => setViewMode(mode.id)}>
                    <span aria-hidden="true" />{mode.label}
                  </button>
                ))}
              </nav>
              <div className="archive-actions">
                <nav className="filters" aria-label="作品分类">
                  {categoryTabs.map((item) => <button className={filter === item ? "active" : ""} type="button" key={item} onClick={() => setFilter(item)}>{item}</button>)}
                </nav>
                {user.isOwner ? <div className="owner-actions"><button className={`manage-button ${bulkMode ? "active" : ""}`} type="button" onClick={toggleBulkMode} disabled={!photos.length}>{bulkMode ? "退出批量" : "批量管理"}</button><button className="upload-button" type="button" onClick={() => setUploadOpen(true)} disabled={bulkMode}>＋ 上传照片</button></div> : null}
              </div>
            </div>
          </div>

          {bulkMode ? <div className="bulk-toolbar" role="toolbar" aria-label="批量管理照片"><strong>已选择 {selectedPhotoIds.length} 张</strong><div><button type="button" onClick={() => toggleAllVisible(manageablePhotos)} disabled={!manageablePhotos.length}>{allVisibleSelected ? "取消全选" : "全选当前"}</button><button className="bulk-delete-button" type="button" onClick={batchDeletePhotos} disabled={!selectedPhotoIds.length || deletingBatch}>{deletingBatch ? "正在删除…" : "删除选中"}</button></div></div> : null}
          <div className={`photo-grid view-${viewMode} ${bulkMode ? "is-selecting" : ""}`}>
            {filteredPhotos.map((photo, index) => (
              <article className={`photo-card photo-${index % 3} ${selectedPhotoIds.includes(photo.id) ? "is-selected" : ""}`} key={photo.id}>
                <button className="photo-image" type="button" onClick={() => bulkMode ? togglePhotoSelection(photo) : setSelected(photo)} disabled={bulkMode && photo.id.startsWith("demo-")} aria-label={bulkMode ? `${selectedPhotoIds.includes(photo.id) ? "取消选择" : "选择"} ${photo.title}` : `查看 ${photo.title}`} aria-pressed={bulkMode ? selectedPhotoIds.includes(photo.id) : undefined}>
                  <img src={photo.url} alt={photo.title} loading={index > 2 ? "lazy" : "eager"} onLoad={(event) => sizeMasonryCard(event.currentTarget)} />
                  {bulkMode && !photo.id.startsWith("demo-") ? <span className="selection-mark" aria-hidden="true">{selectedPhotoIds.includes(photo.id) ? "✓" : ""}</span> : null}
                </button>
                <div className="photo-caption"><h3>{photo.title}</h3><p><span>{displayCategory(photo.category)}</span><span>{photo.location || "地点未知"} · {photo.capturedAt || "时间未知"}</span></p></div>
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
          <div className="lightbox-meta"><div><h2>{selected.title}</h2><p>{displayCategory(selected.category)} · {selected.location} · {selected.capturedAt}</p></div>{user?.isOwner && !selected.id.startsWith("demo-") ? <div className="lightbox-actions"><button type="button" onClick={() => setEditingPhoto(selected)}>编辑信息</button><button className="danger" type="button" onClick={() => deletePhoto(selected)}>删除照片</button></div> : null}</div>
        </div>
      ) : null}

      {editingPhoto && user?.isOwner ? (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="edit-photo-title">
          <form className="upload-modal edit-photo-modal" onSubmit={editPhoto}>
            <button className="modal-close" type="button" onClick={() => setEditingPhoto(null)} disabled={savingEdit} aria-label="关闭">×</button>
            <p className="eyebrow">EDIT THE MEMORY</p><h2 id="edit-photo-title">编辑照片信息</h2>
            <div className="edit-photo-preview"><img src={editingPhoto.url} alt="" /><div><strong>{editingPhoto.title}</strong><small>照片原图不会被修改</small></div></div>
            <div className="form-grid edit-form-grid">
              <label><span>作品名称</span><input name="title" maxLength={80} defaultValue={editingPhoto.title} required /></label>
              <label><span>拍摄地点</span><input name="location" maxLength={80} defaultValue={editingPhoto.location} /></label>
              <label><span>分类</span><select name="category" defaultValue={displayCategory(editingPhoto.category)}><option>摄影</option><option>动物</option><option>个人</option></select></label>
              <label><span>拍摄时间</span><input name="capturedAt" maxLength={20} defaultValue={editingPhoto.capturedAt} /></label>
            </div>
            <button className="submit-upload" type="submit" disabled={savingEdit}>{savingEdit ? "正在保存…" : "保存修改"}</button>
          </form>
        </div>
      ) : null}

      {uploadOpen ? (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="upload-title">
          <form className="upload-modal" onSubmit={uploadPhotos}>
            <button className="modal-close" type="button" onClick={closeUpload} disabled={uploading} aria-label="关闭">×</button>
            <p className="eyebrow">ADD TO THE ARCHIVE</p><h2 id="upload-title">批量上传照片</h2>
            <label className="file-drop"><input type="file" accept="image/jpeg,image/png,image/webp,image/avif" onChange={selectUploadFiles} disabled={uploading} multiple /><span>{uploadFiles.length ? "继续添加照片" : "选择多张照片"}</span><small>{uploadFiles.length ? `已选择 ${uploadFiles.length} 张` : "支持一次多选；JPG、PNG、WebP 或 AVIF，每张最大 20MB"}</small></label>
            {uploadFiles.length ? <div className="simple-upload-list">{uploadFiles.map((file, index) => <div key={`${file.name}:${file.size}:${file.lastModified}`}><span>{String(index + 1).padStart(2, "0")}</span><strong>{file.name}</strong><small>{(file.size / 1024 / 1024).toFixed(1)}MB</small><button type="button" onClick={() => removeUploadFile(file)} disabled={uploading} aria-label={`移除 ${file.name}`}>×</button></div>)}</div> : null}
            <div className="form-grid">
              <label><span>作品名称（可选）</span><input name="title" maxLength={72} placeholder="留空则使用文件名，多张会自动编号" /></label>
              <label><span>拍摄地点</span><input name="location" maxLength={80} placeholder="例如：北海道" /></label>
              <label><span>分类</span><select name="category" defaultValue="摄影"><option>摄影</option><option>动物</option><option>个人</option></select></label>
              <label><span>拍摄年份</span><input name="capturedAt" maxLength={20} placeholder="2026" /></label>
            </div>
            <button className="submit-upload" type="submit" disabled={uploading || !uploadFiles.length}>{uploading ? `正在上传 ${uploadProgress.current}/${uploadProgress.total}` : `上传 ${uploadFiles.length} 张到云端`}</button>
          </form>
        </div>
      ) : null}

      {loading ? <div className="page-loader" aria-label="正在载入"><span /></div> : null}
    </main>
  );
}
