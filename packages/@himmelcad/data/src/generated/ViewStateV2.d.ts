import type { EntityId } from "./EntityId";
import type { ViewClipRefV2 } from "./ViewClipRefV2";
import type { ViewPresentationV2 } from "./ViewPresentationV2";
export type ViewStateV2 = {
    schema: string;
    version: number;
    camera: unknown;
    navigationMode: string;
    hiddenEntityIds: Array<EntityId>;
    sessionHiddenEntityIds: Array<EntityId>;
    selectedEntityIds: Array<EntityId>;
    clipRefs: Array<ViewClipRefV2>;
    presentation: ViewPresentationV2;
};
//# sourceMappingURL=ViewStateV2.d.ts.map