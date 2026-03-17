export interface Project {
  id: string;
  title: string;
  /**
   * The reference to the root folder where assets will be stored.
   * Can be null initially until the first asset is uploaded.
   */
  rootAssetsFolder: string | null;
  createdAt: number;
  lastModified: number;
}
