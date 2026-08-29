const THUMBNAIL_MAX_EDGE = 1280;
const THUMBNAIL_QUALITY = 0.8;

export type OptimizedThumbnail = {
  file: File;
  width: number;
  height: number;
};

type DrawableImage = ImageBitmap | HTMLImageElement;

async function decodeWithImageElement(file: Blob) {
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.decoding = "async";
    image.src = url;
    await image.decode();
    return image;
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function decodeImage(file: Blob): Promise<DrawableImage> {
  if ("createImageBitmap" in window) {
    try {
      return await createImageBitmap(file, { imageOrientation: "from-image" });
    } catch {
      // Safari and older Chromium builds can reject some camera formats here.
    }
  }
  return decodeWithImageElement(file);
}

function imageSize(image: DrawableImage) {
  if (image instanceof ImageBitmap) return { width: image.width, height: image.height };
  return { width: image.naturalWidth, height: image.naturalHeight };
}

function canvasBlob(canvas: HTMLCanvasElement) {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => blob ? resolve(blob) : reject(new Error("浏览器无法生成照片缩略图。")),
      "image/webp",
      THUMBNAIL_QUALITY,
    );
  });
}

export async function createOptimizedThumbnail(source: Blob, name = "photo") : Promise<OptimizedThumbnail> {
  const image = await decodeImage(source);
  try {
    const sourceSize = imageSize(image);
    if (!sourceSize.width || !sourceSize.height) throw new Error("无法读取照片尺寸。");
    const scale = Math.min(1, THUMBNAIL_MAX_EDGE / Math.max(sourceSize.width, sourceSize.height));
    const width = Math.max(1, Math.round(sourceSize.width * scale));
    const height = Math.max(1, Math.round(sourceSize.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) throw new Error("浏览器无法处理这张照片。");
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.drawImage(image, 0, 0, width, height);
    const blob = await canvasBlob(canvas);
    const baseName = name.replace(/\.[^.]+$/, "") || "photo";
    return {
      file: new File([blob], `${baseName}-thumbnail.webp`, { type: "image/webp" }),
      width,
      height,
    };
  } finally {
    if (image instanceof ImageBitmap) image.close();
  }
}
