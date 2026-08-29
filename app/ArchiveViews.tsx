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

function sizeMasonryCard(image: HTMLImageElement) {
  const card = image.closest<HTMLElement>(".photo-card");
  const grid = card?.parentElement;
  if (!card || !grid) return;
  const styles = window.getComputedStyle(grid);
  const rowHeight = Number.parseFloat(styles.gridAutoRows) || 4;
  const rowGap = Number.parseFloat(styles.rowGap) || 0;
  const span = Math.ceil((card.getBoundingClientRect().height + rowGap) / (rowHeight + rowGap));
  card.style.gridRowEnd = `span ${span}`;
}

function MasonryArchive<T extends ArchivePhoto>({
  photos,
  bulkMode,
  selectedPhotoIds,
  displayCategory,
  onOpen,
  onToggle,
}: Omit<ArchiveViewsProps<T>, "mode">) {
  const gridRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let frame = 0;
    const sizeCards = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const grid = gridRef.current;
        if (!grid) return;
        grid.querySelectorAll<HTMLImageElement>(".photo-image img").forEach(sizeMasonryCard);
      });
    };
    sizeCards();
    window.addEventListener("resize", sizeCards);
    return () => {
      window.removeEventListener("resize", sizeCards);
      cancelAnimationFrame(frame);
    };
  }, [photos]);

  return (
    <div className={`photo-grid view-default ${bulkMode ? "is-selecting" : ""}`} ref={gridRef}>
      {photos.map((photo, index) => {
        const selected = selectedPhotoIds.includes(photo.id);
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
            >
              <img src={photo.url} alt={photo.title} loading={index > 2 ? "lazy" : "eager"} decoding="async" onLoad={(event) => sizeMasonryCard(event.currentTarget)} />
              {bulkMode && selectable ? <span className="selection-mark" aria-hidden="true">{selected ? "✓" : ""}</span> : null}
            </button>
            <PhotoCaption photo={photo} displayCategory={displayCategory} />
          </article>
        );
      })}
    </div>
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
  const stageRef = useRef<HTMLDivElement>(null);
  const [offset, setOffset] = useState(() => -Math.max(1, photos.length * 148));
  const [activePhoto, setActivePhoto] = useState<T | null>(null);
  const [pointer, setPointer] = useState({ x: 0, y: 0 });
  const rowHeight = 148;
  const setHeight = Math.max(1, photos.length * rowHeight);
  const repeatCount = Math.max(4, Math.ceil(14 / Math.max(1, photos.length)));
  const repeated = useMemo(() => Array.from({ length: repeatCount }, () => photos).flat(), [photos, repeatCount]);

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let frame = 0;
    let previous = performance.now();
    const tick = (time: number) => {
      const elapsed = Math.min(time - previous, 40);
      previous = time;
      setOffset((current) => {
        let next = current - elapsed * 0.036;
        while (next <= -setHeight * 2) next += setHeight;
        while (next >= 0) next -= setHeight;
        return next;
      });
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
      setOffset((current) => {
        let next = current - event.deltaY * 0.6;
        while (next <= -setHeight * 2) next += setHeight;
        while (next >= 0) next -= setHeight;
        return next;
      });
    };
    stage.addEventListener("wheel", onWheel, { passive: false });
    return () => stage.removeEventListener("wheel", onWheel);
  }, [setHeight]);

  const movePreview = (event: PointerEvent<HTMLDivElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    setPointer({ x: event.clientX - bounds.left, y: event.clientY - bounds.top });
  };

  return (
    <div className="list-stage archive-mode-enter" ref={stageRef} onPointerMove={movePreview} onPointerLeave={() => setActivePhoto(null)}>
      <div className="list-rail" style={{ "--list-offset": `${offset}px`, "--list-row-height": `${rowHeight}px` } as CSSProperties}>
        {repeated.map((photo, index) => {
          const selected = selectedPhotoIds.includes(photo.id);
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
          style={{ "--preview-x": `${pointer.x}px`, "--preview-y": `${pointer.y}px` } as CSSProperties}
          aria-hidden="true"
        >
          <img src={activePhoto.url} alt="" decoding="async" />
          {visibleMetadata(activePhoto.location) ? <span>{visibleMetadata(activePhoto.location)}</span> : null}
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
  const reduceMotion = typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const cardCount = photos.length;
  const renderBackFaces = photos.length <= 36;
  const angleStep = photos.length ? 360 / photos.length : 0;
  const radius = orbitRadius(photos.length, settings);
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
            const photo = photos[index % photos.length];
            if (!photo) return null;
            const selected = selectedPhotoIds.includes(photo.id);
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
                  <span className="orbit-face orbit-front"><img src={photo.url} alt={photo.title} loading={index < 4 ? "eager" : "lazy"} decoding="async" /><span className="orbit-meta"><strong>{photo.title}</strong><small>{frontDetails}</small></span></span>
                  {renderBackFaces ? <span className="orbit-face orbit-back" aria-hidden="true"><img src={photo.url} alt="" loading="lazy" decoding="async" /><span className="orbit-meta"><strong>{photo.title}</strong>{location ? <small>{location}</small> : null}</span></span> : null}
                  {bulkMode && selectable ? <span className="selection-mark" aria-hidden="true">{selected ? "✓" : ""}</span> : null}
                </button>
              </div>
            );
          })}
        </div>
      </div>
      <div className="orbit-mobile-grid">
        {photos.map((photo, index) => (
          <article className="photo-card" key={photo.id}>
            <button className="photo-image" type="button" onClick={() => bulkMode ? onToggle(photo) : onOpen(photo)} disabled={bulkMode && !canSelect(photo)}><img src={photo.url} alt={photo.title} loading={index > 2 ? "lazy" : "eager"} decoding="async" /></button>
            <PhotoCaption photo={photo} displayCategory={displayCategory} />
          </article>
        ))}
      </div>
    </div>
  );
}

export function ArchiveViews<T extends ArchivePhoto>(props: ArchiveViewsProps<T>) {
  const { mode, ...viewProps } = props;
  if (mode === "default") return <MasonryArchive {...viewProps} />;
  if (mode === "list") return <ListArchive {...viewProps} />;
  return <OrbitArchive key={mode} {...viewProps} mode={mode} />;
}
