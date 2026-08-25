import { FormEvent, useCallback, useEffect, useState } from "react";
import type { User } from "@supabase/supabase-js";
import { isConfigured, supabase } from "./supabase";

type PhotoRow = {
  id: string;
  storage_path: string;
  title: string;
  category: string;
  location: string;
  captured_at: string;
  created_at: string;
};

type Photo = PhotoRow & { url: string };

const demoPhotos: Photo[] = [
  ["旷野来信", "旅途", "冰岛", "2025", "https://images.unsplash.com/photo-1500530855697-b586d89ba3ee?auto=format&fit=crop&w=1800&q=88"],
  ["夏夜之后", "日常", "京都", "2024", "https://images.unsplash.com/photo-1492684223066-81342ee5ff30?auto=format&fit=crop&w=1400&q=88"],
  ["城市切面", "城市", "首尔", "2025", "https://images.unsplash.com/photo-1518005020951-eccb494ad742?auto=format&fit=crop&w=1500&q=88"],
].map(([title, category, location, captured_at, url], index) => ({
  id: `demo-${index}`,
  storage_path: "",
  title,
  category,
  location,
  captured_at,
  created_at: "",
  url,
}));

function message(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [isOwner, setIsOwner] = useState(false);
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState("");
  const [filter, setFilter] = useState("全部");
  const [selected, setSelected] = useState<Photo | null>(null);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [uploading, setUploading] = useState(false);

  const loadArchive = useCallback(async () => {
    const { data: rows, error } = await supabase.from("photos").select("*").order("created_at", { ascending: false });
    if (error) throw error;
    const signed = await Promise.all((rows as PhotoRow[]).map(async (row) => {
      const { data } = await supabase.storage.from("photos").createSignedUrl(row.storage_path, 3600);
      return { ...row, url: data?.signedUrl || "" };
    }));
    setPhotos(signed.filter((photo) => photo.url));
    const { data: owner } = await supabase.rpc("is_owner");
    setIsOwner(Boolean(owner));
  }, []);

  useEffect(() => {
    if (!isConfigured) {
      setLoading(false);
      return;
    }
    supabase.auth.getSession().then(async ({ data }) => {
      setUser(data.session?.user || null);
      if (data.session?.user) await loadArchive();
    }).catch((error) => setNotice(message(error, "无法连接云端。"))).finally(() => setLoading(false));

    const { data: listener } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user || null);
      window.setTimeout(() => {
        if (session?.user) loadArchive().catch((error) => setNotice(message(error, "无法读取相册。")));
        else {
          setPhotos([]);
          setIsOwner(false);
        }
      }, 0);
    });
    return () => listener.subscription.unsubscribe();
  }, [loadArchive]);

  useEffect(() => {
    if (!selected) return;
    const close = (event: KeyboardEvent) => event.key === "Escape" && setSelected(null);
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [selected]);

  async function signIn() {
    setNotice("");
    const redirectTo = `${window.location.origin}${import.meta.env.BASE_URL}`;
    const { error } = await supabase.auth.signInWithOAuth({ provider: "google", options: { redirectTo } });
    if (error) setNotice(error.message);
  }

  async function uploadPhoto(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!user || !isOwner) return;
    setUploading(true);
    const form = new FormData(event.currentTarget);
    const file = form.get("file") as File;
    let storagePath = "";
    try {
      if (!file || !file.type.startsWith("image/") || file.size > 20 * 1024 * 1024) throw new Error("请选择一张不超过 20MB 的图片。");
      const ext = file.name.split(".").pop()?.toLowerCase().replace(/[^a-z0-9]/g, "") || "jpg";
      storagePath = `${user.id}/${crypto.randomUUID()}.${ext}`;
      const { error: uploadError } = await supabase.storage.from("photos").upload(storagePath, file, { contentType: file.type, upsert: false });
      if (uploadError) throw uploadError;
      const { error: insertError } = await supabase.from("photos").insert({
        storage_path: storagePath,
        title: String(form.get("title") || "").trim().slice(0, 80),
        category: String(form.get("category") || "旅途"),
        location: String(form.get("location") || "").trim().slice(0, 80),
        captured_at: String(form.get("capturedAt") || "").trim().slice(0, 20),
      });
      if (insertError) throw insertError;
      await loadArchive();
      setUploadOpen(false);
      event.currentTarget.reset();
    } catch (error) {
      if (storagePath) await supabase.storage.from("photos").remove([storagePath]);
      setNotice(message(error, "上传失败，请重试。"));
    } finally {
      setUploading(false);
    }
  }

  async function deletePhoto(photo: Photo) {
    if (!window.confirm(`确定删除“${photo.title}”吗？`)) return;
    const { error } = await supabase.from("photos").delete().eq("id", photo.id);
    if (error) return setNotice(error.message);
    await supabase.storage.from("photos").remove([photo.storage_path]);
    setPhotos((current) => current.filter((item) => item.id !== photo.id));
    setSelected(null);
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
  const avatar = user?.user_metadata?.avatar_url as string | undefined;
  const displayName = (user?.user_metadata?.full_name as string | undefined) || user?.email || "访客";

  return <main>
    <header className="site-header">
      <a className="wordmark" href="#top">LU<span>•</span>MEN</a>
      <div className="header-actions">
        <span className="cloud-status"><i /> GITHUB PAGES · SECURE CLOUD</span>
        {!user ? <button className="google-button" type="button" onClick={signIn} disabled={!isConfigured}><b>G</b><span>使用 Google 登录</span></button> : <div className="account-menu"><button className="share-button" type="button" onClick={shareSite}>分享</button><button className="avatar-button" type="button" onClick={() => supabase.auth.signOut()} title="退出登录">{avatar ? <img src={avatar} alt="" referrerPolicy="no-referrer" /> : displayName.slice(0, 1)}</button></div>}
      </div>
    </header>

    {notice ? <button className="notice" type="button" onClick={() => setNotice("")}>{notice}<span>×</span></button> : null}

    <section className={`hero ${user ? "hero-signed-in" : ""}`} id="top">
      <div className="hero-copy"><p className="eyebrow">PRIVATE PHOTOGRAPHY ARCHIVE / 2026</p><h1>把光，<br />留在云端。</h1><p className="hero-intro">一个安静、私密的摄影空间。收藏旅途与日常，也把珍贵的画面分享给重要的人。</p><div className="hero-meta"><span>{photos.length || "—"} 张云端作品</span><span>原画安全存储</span><span>仅登录后可见</span></div></div>
      <div className="hero-frame"><img src={photos[0]?.url || "https://images.unsplash.com/photo-1469474968028-56623f02e42e?auto=format&fit=crop&w=1800&q=90"} alt="山谷中的晨雾与光线" />
        {!user ? <div className="login-panel"><span className="lock-mark">⌁</span><p className="login-kicker">PRIVATE ACCESS</p><h2>登录后，进入摄影档案</h2><p>使用 Google 账号登录，受邀的朋友也可以安全查看。</p><button className="google-button google-button-large" type="button" onClick={signIn} disabled={!isConfigured}><b>G</b><span>{isConfigured ? "使用 Google 登录" : "等待云端配置"}</span></button></div> : <div className="frame-caption"><span>01</span><p>{photos[0]?.title || "清晨，风从山脊经过"}<br /><small>{photos[0] ? `${photos[0].location} / ${photos[0].captured_at}` : "HOKKAIDO / 2025"}</small></p></div>}
      </div>
    </section>

    {user ? <section className="archive"><div className="archive-heading"><div><p className="eyebrow">THE ARCHIVE</p><h2>摄影档案</h2></div><div className="archive-controls"><nav className="filters">{["全部", "旅途", "城市", "日常"].map((item) => <button className={filter === item ? "active" : ""} type="button" key={item} onClick={() => setFilter(item)}>{item}</button>)}</nav>{isOwner ? <button className="upload-button" type="button" onClick={() => setUploadOpen(true)}>＋ 上传照片</button> : null}</div></div>
      {!photos.length ? <p className="demo-label">示例作品 · 主人上传第一张照片后自动替换</p> : null}<div className="photo-grid">{filtered.map((photo, index) => <article className={`photo-card photo-${index % 3}`} key={photo.id}><button className="photo-image" type="button" onClick={() => setSelected(photo)}><img src={photo.url} alt={photo.title} /><span className="photo-index">{String(index + 1).padStart(2, "0")}</span></button><div className="photo-caption"><h3>{photo.title}</h3><p>{photo.location} · {photo.captured_at}</p></div></article>)}</div></section>
      : <section className="locked-archive"><div><p className="eyebrow">THE ARCHIVE</p><h2>作品已安全收藏</h2><p>完整画质与作品信息仅对登录访客开放。</p></div><div className="locked-strip">{demoPhotos.map((photo) => <img src={photo.url} alt="" key={photo.id} />)}<span>登录后查看</span></div></section>}

    <footer><a className="wordmark footer-mark" href="#top">LU<span>•</span>MEN</a><p>PRIVATE PHOTOGRAPHY ARCHIVE<br />HOSTED ON GITHUB PAGES</p><p>© 2026 · KEEP THE LIGHT, CLOSE.</p></footer>

    {selected ? <div className="lightbox" role="dialog" aria-modal="true" onMouseDown={(event) => event.target === event.currentTarget && setSelected(null)}><button className="lightbox-close" type="button" onClick={() => setSelected(null)}>×</button><img src={selected.url} alt={selected.title} /><div className="lightbox-meta"><div><h2>{selected.title}</h2><p>{selected.category} · {selected.location} · {selected.captured_at}</p></div>{isOwner && !selected.id.startsWith("demo-") ? <button type="button" onClick={() => deletePhoto(selected)}>删除照片</button> : null}</div></div> : null}

    {uploadOpen ? <div className="modal-backdrop" role="dialog" aria-modal="true"><form className="upload-modal" onSubmit={uploadPhoto}><button className="modal-close" type="button" onClick={() => setUploadOpen(false)}>×</button><p className="eyebrow">ADD TO THE ARCHIVE</p><h2>上传一张新作品</h2><label className="file-drop"><input name="file" type="file" accept="image/jpeg,image/png,image/webp,image/avif" required /><span>选择照片</span><small>JPG、PNG、WebP 或 AVIF，最大 20MB</small></label><div className="form-grid"><label><span>作品名称</span><input name="title" maxLength={80} required /></label><label><span>拍摄地点</span><input name="location" maxLength={80} /></label><label><span>分类</span><select name="category"><option>旅途</option><option>城市</option><option>日常</option></select></label><label><span>拍摄年份</span><input name="capturedAt" maxLength={20} /></label></div><button className="submit-upload" type="submit" disabled={uploading}>{uploading ? "正在上传…" : "上传到云端"}</button></form></div> : null}
    {loading ? <div className="page-loader"><span /></div> : null}
  </main>;
}
