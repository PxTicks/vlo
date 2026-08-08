import MonitorHeartIcon from "@mui/icons-material/MonitorHeart";
import { hostViewRegistry } from "../../core/shell/viewRegistry";
import { registerHostScopes, ScopesView } from "../../features/scopes";

let installed = false;

function renderScopes({ active }: { readonly active: boolean }) {
  return <ScopesView active={active} />;
}

export function declareBottomDockHostViews(): void {
  if (installed) return;
  installed = true;
  registerHostScopes();
  hostViewRegistry.registerHostView({
    id: "host.scopes",
    title: "Scopes",
    icon: () => <MonitorHeartIcon fontSize="small" />,
    defaultRegion: "bottom-dock",
    order: 10,
    // The dock is closed until the user opens it, so the view mounts on first
    // selection and then keeps its sampling loop alive across tab switches.
    keepMounted: true,
    component: renderScopes,
  });
}
