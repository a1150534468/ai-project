import type { WorkflowEcomSegmentIndex } from "../../workflowEcomApi";

type StitchSegmentSource = {
  readonly index: WorkflowEcomSegmentIndex;
  readonly originalUrl: string;
};

type LoadedImage = {
  readonly source: unknown;
  readonly width: number;
  readonly height: number;
};

type StitchCanvasContext = {
  fillStyle: string | CanvasGradient | CanvasPattern;
  fillRect: (x: number, y: number, width: number, height: number) => void;
  drawImage: (image: unknown, dx: number, dy: number, width: number, height: number) => void;
};

type StitchCanvas = {
  width: number;
  height: number;
  getContext: (contextId: "2d") => StitchCanvasContext | null;
  toDataURL: (type: string) => string;
};

export type StitchEcomSegmentsArgs = {
  readonly segments: readonly StitchSegmentSource[];
  readonly fetchBlob?: (url: string) => Promise<Blob>;
  readonly createObjectUrl?: (blob: Blob) => string;
  readonly revokeObjectUrl?: (url: string) => void;
  readonly loadImage?: (src: string) => Promise<LoadedImage>;
  readonly createCanvas?: () => StitchCanvas;
};

export type StitchedEcomImage = {
  readonly b64: string;
  readonly dataUrl: string;
  readonly width: number;
  readonly height: number;
};

const SEGMENT_ORDER = [0, 1, 2] as const satisfies readonly WorkflowEcomSegmentIndex[];

/**
 * 兜底下载器故意保留裸 fetch：segment.originalUrl 可能是对象存储/CDN 的外站地址，
 * 走注入鉴权头的统一客户端会把 bearer token 带给第三方主机。
 * 同源 API 的分段 blob 由调用方自己传 fetchBlob（见 EcomWorkflowStudio）。
 */
function defaultFetchBlob(url: string): Promise<Blob> {
  return fetch(url).then(async (response) => {
    if (!response.ok) throw new Error("分段图片下载失败");
    return response.blob();
  });
}

function defaultCreateObjectUrl(blob: Blob): string {
  return URL.createObjectURL(blob);
}

function defaultRevokeObjectUrl(url: string): void {
  URL.revokeObjectURL(url);
}

function defaultLoadImage(src: string): Promise<LoadedImage> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve({ source: image, width: image.width, height: image.height });
    image.onerror = () => reject(new Error("分段图片加载失败"));
    image.src = src;
  });
}

function defaultCreateCanvas(): StitchCanvas {
  const canvas = document.createElement("canvas");
  return {
    get width() {
      return canvas.width;
    },
    set width(value: number) {
      canvas.width = value;
    },
    get height() {
      return canvas.height;
    },
    set height(value: number) {
      canvas.height = value;
    },
    getContext(contextId: "2d") {
      const context = canvas.getContext(contextId);
      if (!context) return null;
      return {
        get fillStyle() {
          return context.fillStyle;
        },
        set fillStyle(value) {
          context.fillStyle = value;
        },
        fillRect: (x, y, width, height) => context.fillRect(x, y, width, height),
        drawImage: (image, dx, dy, width, height) => {
          if (image instanceof HTMLImageElement || image instanceof HTMLCanvasElement || image instanceof SVGImageElement) {
            context.drawImage(image, dx, dy, width, height);
            return;
          }
          if (typeof ImageBitmap !== "undefined" && image instanceof ImageBitmap) {
            context.drawImage(image, dx, dy, width, height);
            return;
          }
          if (typeof OffscreenCanvas !== "undefined" && image instanceof OffscreenCanvas) {
            context.drawImage(image, dx, dy, width, height);
            return;
          }
          if (typeof HTMLVideoElement !== "undefined" && image instanceof HTMLVideoElement) {
            context.drawImage(image, dx, dy, width, height);
            return;
          }
          throw new Error("浏览器暂不支持该分段图片源");
        },
      };
    },
    toDataURL: (type) => canvas.toDataURL(type),
  };
}

function resolveOrderedSegments(segments: readonly StitchSegmentSource[]): readonly StitchSegmentSource[] {
  return SEGMENT_ORDER.map((index) => {
    const segment = segments.find((item) => item.index === index && item.originalUrl.trim().length > 0);
    if (!segment) throw new Error("请先生成完整的三段长图");
    return segment;
  });
}

function isDataUrl(url: string): boolean {
  return url.startsWith("data:");
}

function validateLoadedImage(image: LoadedImage): LoadedImage {
  if (image.width <= 0 || image.height <= 0) throw new Error("分段图片尺寸无效");
  return image;
}

export async function stitchEcomSegments(args: StitchEcomSegmentsArgs): Promise<StitchedEcomImage> {
  const ordered = resolveOrderedSegments(args.segments);
  const fetchBlob = args.fetchBlob ?? defaultFetchBlob;
  const createObjectUrl = args.createObjectUrl ?? defaultCreateObjectUrl;
  const revokeObjectUrl = args.revokeObjectUrl ?? defaultRevokeObjectUrl;
  const loadImage = args.loadImage ?? defaultLoadImage;
  const createCanvas = args.createCanvas ?? defaultCreateCanvas;
  const temporaryUrls: string[] = [];

  try {
    const imageEntries = await Promise.all(ordered.map(async (segment) => {
      if (isDataUrl(segment.originalUrl)) {
        return {
          image: validateLoadedImage(await loadImage(segment.originalUrl)),
          source: segment.originalUrl,
        };
      }

      const blob = await fetchBlob(segment.originalUrl);
      const objectUrl = createObjectUrl(blob);
      temporaryUrls.push(objectUrl);
      return {
        image: validateLoadedImage(await loadImage(objectUrl)),
        source: objectUrl,
      };
    }));

    const width = Math.max(...imageEntries.map((entry) => entry.image.width));
    const scaledEntries = imageEntries.map((entry) => {
      const scale = width / entry.image.width;
      return { ...entry, drawWidth: width, drawHeight: Math.round(entry.image.height * scale) };
    });
    const height = scaledEntries.reduce((sum, entry) => sum + entry.drawHeight, 0);
    const canvas = createCanvas();
    canvas.width = width;
    canvas.height = height;

    const context = canvas.getContext("2d");
    if (!context) throw new Error("浏览器暂不支持长图拼接");
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, width, height);

    let offsetY = 0;
    for (const entry of scaledEntries) {
      context.drawImage(entry.image.source, 0, offsetY, entry.drawWidth, entry.drawHeight);
      offsetY += entry.drawHeight;
    }

    const dataUrl = canvas.toDataURL("image/png");
    if (!dataUrl.startsWith("data:image/png;base64,")) throw new Error("拼接结果导出失败");
    return {
      b64: dataUrl.replace(/^data:image\/png;base64,/, ""),
      dataUrl,
      width,
      height,
    };
  } finally {
    for (const url of temporaryUrls) revokeObjectUrl(url);
  }
}
