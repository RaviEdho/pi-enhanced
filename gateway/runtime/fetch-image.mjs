import { downloadPublicImage, ImageDeliveryError } from "./send-image.mjs";
import { detectDiscordImageMimeType } from "./messages.mjs";

const MAX_BYTES = 10 * 1024 * 1024;

// Download in the Pi child, not over the history IPC's small text frames. The
// same pinned-DNS/redirect/timeout boundaries apply as for image uploads.
export async function fetchImageForModel(url, signal) {
  if (typeof url !== "string" || !url.trim() || url.length > 2048) {
    throw new Error("Provide a public HTTPS image URL of at most 2048 characters.");
  }
  try {
    const image = await downloadPublicImage(url, MAX_BYTES, signal);
    signal?.throwIfAborted();
    const mimeType = detectDiscordImageMimeType(image.data);
    if (!mimeType) throw new ImageDeliveryError("Only PNG, JPEG, GIF, and WebP images are supported (validated by file signature).");
    return {
      content: { type: "image", data: image.data.toString("base64"), mimeType },
      byteLength: image.data.length,
    };
  } catch (error) {
    if (signal?.aborted) throw new Error("Image fetch cancelled.");
    if (error instanceof ImageDeliveryError) {
      throw new Error(error.message.replace("upload size limit", "10 MiB download size limit"));
    }
    // Never expose a signed URL, credentials, or raw filesystem/network errors.
    throw new Error("Could not fetch the image within the ten-second deadline. Check the public HTTPS URL and try again.");
  }
}
