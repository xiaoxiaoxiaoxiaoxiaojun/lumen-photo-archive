"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, PointerEvent } from "react";

export const archiveViewModes = [
  { id: "default", label: "默认" },
  { id: "list", label: "列表" },
  { id: "gallery", label: "画廊" },
  { id: "spiral", label: "螺旋" },
] as const;

export type ArchiveViewMode = typeof archiveViewModes[number]["id"];

export type ArchivePhoto = {
  id: string;
  title: string;
  category: string;
  location: string;
  capturedAt: string;
  url: string;
  thumbnailUrl?: string;
  width?: number;
  height?: number;
};

type ArchiveViewsProps<T extends ArchivePhoto> = {
  photos: T[];
  mode: ArchiveViewMode;
  bulkMode: boolean;
  selectedPhotoIds: string[];
  displayCategory: (category: string) => string;
  onOpen: (photo: T) => void;
  onToggle: (photo: T) => void;
};

function canSelect(photo: ArchivePhoto) {
  return !photo.id.startsWith("demo-");
}

function visibleMetadata(value: string) {
  const normalized = value.trim();
  if (!normalized || /^(?:未知|地点未知|时间未知|unknown(?:\s+(?:location|time|date))?|n\/a|null|undefined)$/i.test(normalized)) return "";
  return normalized;
}

function cardImage(photo: ArchivePhoto) {
  return photo.thumbnailUrl || photo.url;
}

function imageDimensions(photo: ArchivePhoto) {
  return photo.width && photo.height ? { width: photo.width, height: photo.height } : {};
}

function useProgressivePhotos<T extends ArchivePhoto>(photos: T[], initialCount = 30, batchSize = 30) {
  const sentinelRef = useRef<HTMLDivElement>(null);
  const photoKey = photos.map((photo) => photo.id).join("|");
  const [progress, setProgress] = useState(() => ({ key: photoKey, count: Math.min(initialCount, photos.length) }));
  const visibleCount = progress.key === photoKey ? Math.min(progress.count, photos.length) : Math.min(initialCount, photos.length);

  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel || visibleCount >= photos.length) return;
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) {
        setProgress((current) => ({
          key: photoKey,
          count: Math.min((current.key === photoKey ? current.count : initialCount) + batchSize, photos.length),
        }));
      }
    }, { rootMargin: "800px 0px" });
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [batchSize, initialCount, photoKey, photos.length, visibleCount]);

  return { visiblePhotos: photos.slice(0, visibleCount), hasMore: visibleCount < photos.length, sentinelRef };
}

function masonryColumnCount() {
  if (typeof window === "undefined") return 4;
  if (window.innerWidth <= 620) return 1;
  if (window.innerWidth <= 900) return 2;
  if (window.innerWidth <= 1280) return 4;
  return 5;
}

function useMasonryColumnCount() {
  const [columnCount, setColumnCount] = useState(4);

  useEffect(() => {
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => setColumnCount(masonryColumnCount()));
    };
    update();
    window.addEventListener("resize", update, { passive: true });
    return () => {
      window.removeEventListener("resize", update);
      cancelAnimationFrame(frame);
    };
  }, []);

  return columnCount;
}

function MasonryArchive<T extends ArchivePhoto>({
  photos,
  bulkMode,
  selectedPhotoIds,
  displayCategory,
  onOpen,
  onToggle,
}: Omit<ArchiveViewsProps<T>, "mode">) {
  const selectedIds = useMemo(() => new Set(selectedPhotoIds), [selectedPhotoIds]);
  const { visiblePhotos, hasMore, sentinelRef } = useProgressivePhotos(photos);
  const columnCount = useMasonryColumnCount();
  const columns = useMemo(() => {
    const nextColumns = Array.from({ length: columnCount }, () => [] as Array<{ photo: T; index: number }>);
    const heights = Array.from({ length: columnCount }, () => 0);
    visiblePhotos.forEach((photo, index) => {
      const shortestColumn = heights.indexOf(Math.min(...heights));
      nextColumns[shortestColumn].push({ photo, index });
      const estimatedImageHeight = photo.width && photo.height
        ? photo.height / photo.width
        : [1.28, 0.78, 1.04][index % 3];
      heights[shortestColumn] += estimatedImageHeight + 0.22;
    });
    return nextColumns;
  }, [columnCount, visiblePhotos]);

  return (
    <>
      <div
        className={`photo-grid view-default ${bulkMode ? "is-selecting" : ""}`}
        style={{ "--masonry-columns": columnCount } as CSSProperties}
      >
        {columns.map((column, columnIndex) => (
          <div className="photo-column" key={`column-${columnIndex}`}>
            {column.map(({ photo, index }) => {
              const selected = selectedIds.has(photo.id);
              const selectable = canSelect(photo);
              return (
                <article className={`photo-card photo-${index % 3} ${selected ? "is-selected" : ""}`} key={photo.id}>
                  <button
                    className="photo-image"
                    type="button"
                    onClick={() => bulkMode ? onToggle(photo) : onOpen(photo)}
                    disabled={bulkMode && !selectable}
                    aria-label={bulkMode ? `${selected ? "取消选择" : "选择"} ${photo.title}` : `查看 ${photo.title}`}
                    aria-pressed={bulkMode ? selected : undefined}
                    style={photo.width && photo.height ? { aspectRatio: `${photo.width} / ${photo.height}` } : undefined}
                  >
                    <img
                      src={cardImage(photo)}
                      alt={photo.title}
                      loading={index > 3 ? "lazy" : "eager"}
                      fetchPriority={index < 2 ? "high" : "auto"}
                      decoding="async"
                      {...imageDimensions(photo)}
                    />
                    {bulkMode && selectable ? <span className="selection-mark" aria-hidden="true">{selected ? "✓" : ""}</span> : null}
                  </button>
                  <PhotoCaption photo={photo} displayCategory={displayCategory} />
                </article>
              );
            })}
          </div>
        ))}
      </div>
      {hasMore ? <div className="archive-load-more" ref={sentinelRef} aria-label="继续加载照片"><span /></div> : null}
    </>
  );
}

function PhotoCaption<T extends ArchivePhoto>({ photo, displayCategory }: { photo: T; displayCategory: (category: string) => string }) {
  const location = visibleMetadata(photo.location);
  const capturedAt = visibleMetadata(photo.capturedAt);
  const details = [location, capturedAt].filter(Boolean).join(" · ");

  return (
    <div className="photo-caption">
      <h3>{photo.title}</h3>
      <p><span>{displayCategory(photo.category)}</span>{details ? <span>{details}</span> : null}</p>
    </div>
  );
}

function ListArchive<T extends ArchivePhoto>({
  photos,
  bulkMode,
  selectedPhotoIds,
  displayCategory,
  onOpen,
  onToggle,
}: Omit<ArchiveViewsProps<T>, "mode">) {
  const pageSize = 40;
  const [pageIndex, setPageIndex] = useState(0);
  const pageCount = Math.max(1, Math.ceil(photos.length / pageSize));
  const safePageIndex = Math.min(pageIndex, pageCount - 1);
  const pagePhotos = useMemo(
    () => photos.slice(safePageIndex * pageSize, (safePageIndex + 1) * pageSize),
    [photos, safePageIndex],
  );
  const stageRef = useRef<HTMLDivElement>(null);
  const railRef = useRef<HTMLDivElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const offsetRef = useRef(-Math.max(1, pagePhotos.length * 148));
  const [activePhoto, setActivePhoto] = useState<T | null>(null);
  const rowHeight = 148;
  const setHeight = Math.max(1, pagePhotos.length * rowHeight);
  const repeatCount = Math.max(2, Math.ceil(14 / Math.max(1, pagePhotos.length)));
  const repeated = useMemo(() => Array.from({ length: repeatCount }, () => pagePhotos).flat(), [pagePhotos, repeatCount]);
  const selectedIds = useMemo(() => new Set(selectedPhotoIds), [selectedPhotoIds]);

  useEffect(() => {
    offsetRef.current = -setHeight;
    if (railRef.current) railRef.current.style.transform = `translate3d(0, ${offsetRef.current}px, 0)`;
  }, [setHeight]);

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let frame = 0;
    let previous = performance.now();
    const tick = (time: number) => {
      const elapsed = Math.min(time - previous, 40);
      previous = time;
      let next = offsetRef.current - elapsed * 0.036;
      while (next <= -setHeight * 2) next += setHeight;
      while (next >= 0) next -= setHeight;
      offsetRef.current = next;
      if (railRef.current) railRef.current.style.transform = `translate3d(0, ${next}px, 0)`;
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [setHeight]);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      let next = offsetRef.current - event.deltaY * 0.6;
      while (next <= -setHeight * 2) next += setHeight;
      while (next >= 0) next -= setHeight;
      offsetRef.current = next;
      if (railRef.current) railRef.current.style.transform = `translate3d(0, ${next}px, 0)`;
    };
    stage.addEventListener("wheel", onWheel, { passive: false });
    return () => stage.removeEventListener("wheel", onWheel);
  }, [setHeight]);

  const movePreview = (event: PointerEvent<HTMLDivElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    const preview = previewRef.current;
    if (!preview) return;
    preview.style.setProperty("--preview-x", `${event.clientX - bounds.left}px`);
    preview.style.setProperty("--preview-y", `${event.clientY - bounds.top}px`);
  };

  return (
    <div className="list-view archive-mode-enter">
      <div className="list-stage" ref={stageRef} onPointerMove={movePreview} onPointerLeave={() => setActivePhoto(null)}>
        <div className="list-rail" ref={railRef} style={{ "--list-row-height": `${rowHeight}px`, transform: `translate3d(0, ${-setHeight}px, 0)` } as CSSProperties}>
          {repeated.map((photo, index) => {
            const selected = selectedIds.has(photo.id);
            const selectable = canSelect(photo);
            const capturedAt = visibleMetadata(photo.capturedAt);
            return (
              <button
                className={`list-project ${activePhoto?.id === photo.id ? "is-active" : ""} ${selected ? "is-selected" : ""}`}
                type="button"
                key={`${photo.id}-${index}`}
                onPointerEnter={() => setActivePhoto(photo)}
                onFocus={() => setActivePhoto(photo)}
                onBlur={() => setActivePhoto(null)}
                onClick={() => bulkMode ? onToggle(photo) : onOpen(photo)}
                disabled={bulkMode && !selectable}
                aria-label={bulkMode ? `${selected ? "取消选择" : "选择"} ${photo.title}` : `查看 ${photo.title}`}
              >
                <span className="list-category">{displayCategory(photo.category)}</span>
                <strong>{photo.title}</strong>
                {capturedAt ? <span className="list-year">{capturedAt}</span> : <span aria-hidden="true" />}
                {bulkMode && selectable ? <span className="selection-mark" aria-hidden="true">{selected ? "✓" : ""}</span> : null}
              </button>
            );
          })}
        </div>
        {activePhoto ? (
          <div
            className="list-cursor-preview"
            ref={previewRef}
            style={{ "--preview-x": "0px", "--preview-y": "0px" } as CSSProperties}
            aria-hidden="true"
          >
            <img src={cardImage(activePhoto)} alt="" decoding="async" {...imageDimensions(activePhoto)} />
            {visibleMetadata(activePhoto.location) ? <span>{visibleMetadata(activePhoto.location)}</span> : null}
          </div>
        ) : null}
      </div>
      {pageCount > 1 ? (
        <div className="orbit-pagination" aria-label="列表分组">
          <button type="button" onClick={() => setPageIndex((safePageIndex - 1 + pageCount) % pageCount)}>上一组</button>
          <span>{safePageIndex + 1} / {pageCount}</span>
          <button type="button" onClick={() => setPageIndex((safePageIndex + 1) % pageCount)}>下一组</button>
        </div>
      ) : null}
    </div>
  );
}

type OrbitMode = "gallery" | "spiral";

const orbitSettings = {
  gallery: { itemWidth: 200, itemHeight: 300, minRadius: 380, maxRadius: 1400, cardGap: 96, perspective: 760, tiltX: 0, tiltZ: 0 },
  spiral: { itemWidth: 180, itemHeight: 270, minRadius: 340, maxRadius: 900, cardGap: 84, perspective: 680, tiltX: 0, tiltZ: 0 },
} as const;

type OrbitSettings = (typeof orbitSettings)[OrbitMode];

function orbitRadius(photoCount: number, settings: OrbitSettings) {
  const radiusForGap = Math.max(1, photoCount) * (settings.itemWidth + settings.cardGap) / (Math.PI * 2);
  return Math.min(settings.maxRadius, Math.max(settings.minRadius, radiusForGap));
}

function orbitTransform(
  index: number,
  cardCount: number,
  angleStep: number,
  radius: number,
  mode: OrbitMode,
) {
  const reverseIndex = index === 0 ? 0 : cardCount - index;
  const theta = angleStep * reverseIndex;
  const radians = theta * Math.PI / 180;
  const x = Math.cos(radians) * radius;
  const z = Math.sin(radians) * radius;
  const rotateY = -theta + 90 + (mode === "spiral" ? Math.sin(radians) * 6 : 0);
  return `translate(-50%, -50%) translate3d(${x.toFixed(3)}px, 0, ${z.toFixed(3)}px) rotateY(${rotateY.toFixed(3)}deg)`;
}

function orbitSceneTransform(angle: number, settings: OrbitSettings) {
  return `rotateX(${settings.tiltX}deg) rotateZ(${settings.tiltZ}deg) rotateY(${angle.toFixed(3)}deg)`;
}

function OrbitArchive<T extends ArchivePhoto>({
  photos,
  mode,
  bulkMode,
  selectedPhotoIds,
  displayCategory,
  onOpen,
  onToggle,
}: Omit<ArchiveViewsProps<T>, "mode"> & { mode: OrbitMode }) {
  const stageRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<HTMLDivElement>(null);
  const targetAngle = useRef(90);
  const currentAngle = useRef(90);
  const direction = useRef(1);
  const lastTime = useRef(0);
  const stageVisible = useRef(true);
  const settings = orbitSettings[mode];
  const [orbitPage, setOrbitPage] = useState(0);
  const orbitPageSize = 72;
  const orbitPageCount = Math.max(1, Math.ceil(photos.length / orbitPageSize));
  const safeOrbitPage = Math.min(orbitPage, orbitPageCount - 1);
  const orbitPhotos = photos.slice(safeOrbitPage * orbitPageSize, (safeOrbitPage + 1) * orbitPageSize);
  const selectedIds = useMemo(() => new Set(selectedPhotoIds), [selectedPhotoIds]);
  const { visiblePhotos: mobilePhotos, hasMore: mobileHasMore, sentinelRef: mobileSentinelRef } = useProgressivePhotos(photos, 24, 24);
  const reduceMotion = typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const cardCount = orbitPhotos.length;
  const renderBackFaces = orbitPhotos.length <= 36;
  const angleStep = orbitPhotos.length ? 360 / orbitPhotos.length : 0;
  const radius = orbitRadius(orbitPhotos.length, settings);
  const perspective = Math.max(settings.perspective, radius * 1.85);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const visibilityObserver = new IntersectionObserver(([entry]) => {
      stageVisible.current = entry.isIntersecting;
    }, { rootMargin: "160px" });
    visibilityObserver.observe(stage);
    return () => {
      visibilityObserver.disconnect();
    };
  }, []);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const delta = event.deltaY * 0.2;
      if (delta) direction.current = delta > 0 ? 1 : -1;
      targetAngle.current += delta;
    };
    stage.addEventListener("wheel", onWheel, { passive: false });
    return () => stage.removeEventListener("wheel", onWheel);
  }, []);

  useEffect(() => {
    let frame = 0;
    const tick = (time: number) => {
      const elapsed = lastTime.current ? Math.min((time - lastTime.current) / 1000, 0.05) : 0;
      lastTime.current = time;
      if (!reduceMotion) targetAngle.current += direction.current * 0.03 * 360 * elapsed;
      const easing = 1 - Math.pow(1 - 0.2, Math.max(1, elapsed * 60));
      currentAngle.current += (targetAngle.current - currentAngle.current) * easing;
      if (stageVisible.current && !document.hidden) {
        const scene = sceneRef.current;
        if (scene) scene.style.transform = orbitSceneTransform(currentAngle.current, settings);
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
      lastTime.current = 0;
    };
  }, [reduceMotion, settings]);

  return (
    <div className="orbit-view archive-mode-enter">
      <div
        className={`orbit-stage orbit-${mode}`}
        ref={stageRef}
        style={{ "--orbit-perspective": `${perspective}px` } as CSSProperties}
        role="region"
        aria-label={`${mode === "gallery" ? "画廊" : "螺旋"}展示，可使用滚轮浏览`}
      >
        <div className="orbit-scene" ref={sceneRef} style={{ transform: orbitSceneTransform(90, settings) }}>
          {Array.from({ length: cardCount }, (_, index) => {
            const photo = orbitPhotos[index];
            if (!photo) return null;
            const selected = selectedIds.has(photo.id);
            const selectable = canSelect(photo);
            const location = visibleMetadata(photo.location);
            const capturedAt = visibleMetadata(photo.capturedAt);
            const frontDetails = [displayCategory(photo.category), capturedAt].filter(Boolean).join(" · ");
            return (
              <div
                className={`orbit-card ${selected ? "is-selected" : ""}`}
                style={{ width: settings.itemWidth, height: settings.itemHeight, transform: orbitTransform(index, cardCount, angleStep, radius, mode) } as CSSProperties}
                key={`${photo.id}-${index}`}
              >
                <button
                  className="orbit-card-shell"
                  type="button"
                  onClick={() => bulkMode ? onToggle(photo) : onOpen(photo)}
                  disabled={bulkMode && !selectable}
                  aria-label={bulkMode ? `${selected ? "取消选择" : "选择"} ${photo.title}` : `查看 ${photo.title}`}
                >
                  <span className="orbit-face orbit-front"><img src={cardImage(photo)} alt={photo.title} loading={index < 4 ? "eager" : "lazy"} decoding="async" {...imageDimensions(photo)} /><span className="orbit-meta"><strong>{photo.title}</strong><small>{frontDetails}</small></span></span>
                  {renderBackFaces ? <span className="orbit-face orbit-back" aria-hidden="true"><img src={cardImage(photo)} alt="" loading="lazy" decoding="async" {...imageDimensions(photo)} /><span className="orbit-meta"><strong>{photo.title}</strong>{location ? <small>{location}</small> : null}</span></span> : null}
                  {bulkMode && selectable ? <span className="selection-mark" aria-hidden="true">{selected ? "✓" : ""}</span> : null}
                </button>
              </div>
            );
          })}
        </div>
      </div>
      {orbitPageCount > 1 ? (
        <div className="orbit-pagination" aria-label="3D 照片分组">
          <button type="button" onClick={() => setOrbitPage((safeOrbitPage - 1 + orbitPageCount) % orbitPageCount)}>上一组</button>
          <span>{safeOrbitPage + 1} / {orbitPageCount}</span>
          <button type="button" onClick={() => setOrbitPage((safeOrbitPage + 1) % orbitPageCount)}>下一组</button>
        </div>
      ) : null}
      <div className="orbit-mobile-grid">
        {mobilePhotos.map((photo, index) => (
          <article className="photo-card" key={photo.id}>
            <button className="photo-image" type="button" onClick={() => bulkMode ? onToggle(photo) : onOpen(photo)} disabled={bulkMode && !canSelect(photo)} style={photo.width && photo.height ? { aspectRatio: `${photo.width} / ${photo.height}` } : undefined}><img src={cardImage(photo)} alt={photo.title} loading={index > 2 ? "lazy" : "eager"} decoding="async" {...imageDimensions(photo)} /></button>
            <PhotoCaption photo={photo} displayCategory={displayCategory} />
          </article>
        ))}
      </div>
      {mobileHasMore ? <div className="archive-load-more archive-load-more-mobile" ref={mobileSentinelRef} aria-label="继续加载照片"><span /></div> : null}
    </div>
  );
}

export function ArchiveViews<T extends ArchivePhoto>(props: ArchiveViewsProps<T>) {
  const { mode, ...viewProps } = props;
  if (mode === "default") return <MasonryArchive {...viewProps} />;
  if (mode === "list") return <ListArchive {...viewProps} />;
  return <OrbitArchive key={mode} {...viewProps} mode={mode} />;
}
