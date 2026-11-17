import type { ImageContent } from "@earendil-works/pi-ai";

export function fetchImageForModel(url: string, signal?: AbortSignal): Promise<{
  content: ImageContent;
  byteLength: number;
}>;
