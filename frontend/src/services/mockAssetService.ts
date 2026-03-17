import type { Asset, AssetType } from "../types/Asset";

// Helper to simulate network delay
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Helper to simulate xxhash
const mockHash = (str: string) =>
  `xxh-${str.length}-${Date.now().toString(36)}`;

export const mockUploadAsset = async (
  file: File,
  projectId: string
): Promise<{ asset: Asset; folderCreated?: string }> => {
  await delay(800); // Simulate upload time

  const fileType = file.type.split("/")[0];
  let type: AssetType = "image";
  if (fileType === "video") type = "video";
  if (fileType === "audio") type = "audio";

  // Simulate server generating a path
  // In reality, this URL comes from your FastAPI static mount
  const objectUrl = URL.createObjectURL(file);

  // Simulate Thumbnail Generation
  // For audio, we won't return a thumbnail URL here, the UI will handle the icon
  let thumbnailUrl: string | undefined = undefined;
  if (type === "image") {
    thumbnailUrl = objectUrl;
  } else if (type === "video") {
    // In a real app, the backend generates a .jpg in .thumbnails/
    // For this mock, we just use a grey placeholder or the video itself
    thumbnailUrl = objectUrl; // Simple hack for mock: video tags can show posters
  }

  // Simulate Folder Creation Logic
  // The backend would return the root folder path if it just created it
  const folderPath = `/projects/${projectId}/assets`;

  return {
    asset: {
      id: crypto.randomUUID(),
      hash: mockHash(file.name),
      name: file.name,
      type,
      src: objectUrl,
      thumbnail: thumbnailUrl,
      createdAt: Date.now(),
    },
    folderCreated: folderPath,
  };
};
