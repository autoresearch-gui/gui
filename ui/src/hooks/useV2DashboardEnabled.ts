import { useContext } from "react";
import { QueryClient, QueryClientContext, useQuery } from "@tanstack/react-query";
import type { InstanceExperimentalSettings } from "@paperclipai/shared";
import { instanceSettingsApi } from "@/api/instanceSettings";
import { queryKeys } from "@/lib/queryKeys";

export function resolveV2DashboardEnabled(
  settings:
    | Pick<InstanceExperimentalSettings, "enableV2Dashboard">
    | null
    | undefined,
): boolean {
  return settings?.enableV2Dashboard !== false;
}

let detachedClient: QueryClient | null = null;
function getDetachedClient(): QueryClient {
  detachedClient ??= new QueryClient();
  return detachedClient;
}

/**
 * The V2 dashboard is the default. A missing flag, an instance that predates the
 * flag, and a failed read all count as enabled, so the dashboard never renders
 * in the classic layout just because the settings query had not resolved yet.
 *
 * `loaded` is still reported so a caller that cares about avoiding a layout
 * flash can hold off until the real value is known.
 */
export function useV2DashboardEnabled(): { enabled: boolean; loaded: boolean } {
  const contextClient = useContext(QueryClientContext);
  const query = useQuery(
    {
      queryKey: queryKeys.instance.experimentalSettings,
      queryFn: () => instanceSettingsApi.getExperimental(),
      enabled: contextClient != null,
    },
    contextClient ?? getDetachedClient(),
  );

  if (!contextClient) return { enabled: true, loaded: true };

  return {
    enabled: resolveV2DashboardEnabled(query.data),
    loaded: query.isFetched,
  };
}
