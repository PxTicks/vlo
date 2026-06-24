type LiveSceneTransformListener = () => void;

const listeners = new Set<LiveSceneTransformListener>();

export function requestLiveSceneTransformSync(): void {
  listeners.forEach((listener) => listener());
}

export function subscribeLiveSceneTransformSync(
  listener: LiveSceneTransformListener,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
