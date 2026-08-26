import type { ReactNode } from "react";
import {
  CapabilityFailureNotice,
  useRuntimeCapability,
} from "../../runtimeCapabilities";

interface ExtensionCapabilityNoticeProps {
  /** Already resolved to a full capability id by the owning API binding. */
  capabilityId: string;
  fallbackMessage?: string | null;
  dense?: boolean;
  downloadSurface?: ReactNode;
}

/**
 * The host's remediation UI, addressed by capability id.
 *
 * `CapabilityFailureNotice` takes the failure as a prop because its host
 * callers already hold one — a dialog that gates on SAM2 has read the
 * capability to decide whether to gate at all. An extension rendering this in
 * its own panel has not, so this wrapper does the reading, which also means it
 * triggers the host's lazy first load exactly as a host surface does.
 *
 * It renders nothing when nothing is wrong, so it can sit unconditionally
 * above a feature's controls.
 */
export function ExtensionCapabilityNotice({
  capabilityId,
  fallbackMessage = null,
  dense = false,
  downloadSurface,
}: ExtensionCapabilityNoticeProps) {
  const { capability, failure, checking } = useRuntimeCapability(capabilityId);

  // Nothing is known yet: a cold read runs out-of-process probes and takes
  // seconds. Claiming a runtime is unavailable in that window would be the
  // same lie the capability contract exists to remove.
  if (checking) return null;

  return (
    <CapabilityFailureNotice
      capabilityLabel={capability?.label ?? capabilityId}
      failure={failure}
      lastFailure={capability?.lastFailure ?? null}
      fallbackMessage={fallbackMessage}
      dense={dense}
      {...(downloadSurface === undefined ? {} : { downloadSurface })}
    />
  );
}
