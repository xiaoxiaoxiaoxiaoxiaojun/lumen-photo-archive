import exifr from "exifr";

export type PhotoMetadata = {
  title: string;
  category: "摄影" | "动物" | "个人";
  location: string;
  capturedAt: string;
  camera: string;
  lens: string;
  technical: string;
  geocoded?: boolean;
  latitude?: number;
  longitude?: number;
};

type ExifData = Record<string, unknown>;

function textValue(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function numberValue(value: unknown) {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function cleanTitle(fileName: string) {
  const withoutExtension = fileName.replace(/\.[^.]+$/, "");
  const normalized = withoutExtension
    .replace(/^(?:img|dsc|pxl|mvimg|photo)[-_ ]*/i, "")
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return normalized || "未命名作品";
}

function formatDate(value: unknown) {
  let date: Date | null = null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) date = value;
  if (!date && typeof value === "string") {
    const normalized = value.trim().replace(/^(\d{4}):(\d{2}):(\d{2})/, "$1-$2-$3");
    const parsed = new Date(normalized.replace(" ", "T"));
    if (!Number.isNaN(parsed.getTime())) date = parsed;
  }
  if (!date) return "";
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function cameraName(data: ExifData) {
  const make = textValue(data.Make);
  const model = textValue(data.Model);
  if (!make) return model;
  if (!model) return make;
  return model.toLowerCase().startsWith(make.toLowerCase()) ? model : `${make} ${model}`;
}

function exposureLabel(value: unknown) {
  const exposure = numberValue(value);
  if (!exposure || exposure <= 0) return "";
  if (exposure < 1) return `1/${Math.max(1, Math.round(1 / exposure))}s`;
  return `${Number(exposure.toFixed(2))}s`;
}

function technicalSummary(data: ExifData) {
  const aperture = numberValue(data.FNumber ?? data.ApertureValue);
  const iso = numberValue(data.ISO ?? data.ISOSpeedRatings);
  const focalLength = numberValue(data.FocalLengthIn35mmFormat ?? data.FocalLength);
  return [
    aperture ? `ƒ/${Number(aperture.toFixed(1))}` : "",
    exposureLabel(data.ExposureTime),
    iso ? `ISO ${Math.round(iso)}` : "",
    focalLength ? `${Number(focalLength.toFixed(1))}mm` : "",
  ].filter(Boolean).join(" · ");
}

function automaticCategory(data: ExifData, fileName: string): PhotoMetadata["category"] {
  const searchable = [fileName, data.ImageDescription, data.Title, data.Subject, data.Keywords]
    .map(textValue)
    .join(" ")
    .toLowerCase();
  if (/animal|wildlife|pet|cat|dog|bird|horse|动物|宠物|猫|狗|鸟|马/.test(searchable)) return "动物";
  if (/portrait|selfie|person|people|family|friend|人像|人物|自拍|家人|朋友/.test(searchable)) return "个人";
  return "摄影";
}

export async function extractPhotoMetadata(file: File): Promise<PhotoMetadata> {
  let data: ExifData = {};
  try {
    data = (await exifr.parse(file, true) || {}) as ExifData;
  } catch {
    // Files without readable EXIF data still get safe automatic defaults.
  }

  const latitude = numberValue(data.latitude ?? data.GPSLatitude);
  const longitude = numberValue(data.longitude ?? data.GPSLongitude);
  const hasGps = latitude !== undefined && longitude !== undefined
    && latitude >= -90 && latitude <= 90 && longitude >= -180 && longitude <= 180;
  const embeddedTitle = textValue(data.ImageDescription ?? data.Title ?? data.ObjectName);

  return {
    title: embeddedTitle || cleanTitle(file.name),
    category: automaticCategory(data, file.name),
    location: "",
    capturedAt: formatDate(data.DateTimeOriginal ?? data.CreateDate ?? data.DateTimeDigitized ?? data.ModifyDate),
    camera: cameraName(data),
    lens: textValue(data.LensModel ?? data.Lens),
    technical: technicalSummary(data),
    ...(hasGps ? { latitude, longitude } : {}),
  };
}
