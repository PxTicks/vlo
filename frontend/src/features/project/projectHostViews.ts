import { hostViewRegistry } from "../../core/shell/viewRegistry";
import { RecentProjectsView } from "./components/RecentProjectsView";

let installed = false;

export function declareProjectHostViews(): void {
  if (installed) return;
  installed = true;
  hostViewRegistry.registerHostView({
    id: "host.projects",
    title: "Recent projects",
    defaultRegion: "projects-page.main",
    order: 10,
    component: RecentProjectsView,
  });
}
