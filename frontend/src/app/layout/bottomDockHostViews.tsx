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
    // The first portable panel (plan §4.1). Scopes are equally at home under
    // the picture or beside it, and they hold a sampling loop and a canvas,
    // which is exactly the state a move must not disturb.
    allowedRegions: ["bottom-dock", "right-sidebar"],
    order: 10,
    // The dock is closed until the user opens it, so the view mounts on first
    // selection and then keeps its sampling loop alive across tab switches.
    keepMounted: true,
    component: renderScopes,
  });
}
