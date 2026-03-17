# Project Feature

This feature manages the lifecycle of local projects, including file system access, persistence, and configuration.

## Architecture

The feature is built around the **File System Access API**, allowing the application to read and write directly to a user-selected folder on their disk. A `project.json` file is maintained in a `.vloproject` subdirectory to persist metadata and asset references.

### Key Components

- **`useProjectStore`**: The main Zustand store serving as the source of truth.
  - Manages the active `FileSystemDirectoryHandle`.
  - Tracks project metadata (`title`, `id`) and configuration (`fps`, `resolution`).
  - Handles `create`, `load`, and `save` operations.
- **`FileSystemService`**: A singleton service abstracting the browser's native File System API.
  - Handles permissions (read/write).
  - Provides helper methods for file I/O relative to the project root.
- **`ProjectManager`**: The UI entry point for users to Create or Open a project.

## Public API

The feature exposes its public members via `index.ts`. Consumers should NOT import internal files directly.

```typescript
import { useProjectStore, ProjectManager, fileSystemService } from "features/project";
```

### Usage Examples

#### Accessing Project State
```typescript
const project = useProjectStore(state => state.project);
const rootHandle = useProjectStore(state => state.rootHandle);

if (!project) {
  // Show ProjectManager to select a folder
}
```

#### Saving Configuration
```typescript
const updateConfig = useProjectStore(state => state.updateConfig);
updateConfig({ fps: 60, resolution: 1080 });
```

#### Interacting with Files
```typescript
// Read a file relative to the project root
const file = await fileSystemService.readFile("assets/video.mp4");
```

## Data Structure (`project.json`)

```json
{
  "id": "uuid",
  "title": "My Project",
  "schemaVersion": 1,
  "createdWithVloVersion": "0.1.0",
  "lastSavedWithVloVersion": "0.1.0",
  "assets": { ... },
  "created_at": 1234567890,
  "last_modified": 1234567890
}
```
