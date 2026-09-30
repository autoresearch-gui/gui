import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { CalendarClock, Gavel, Radio } from "lucide-react";
import { attentionApi } from "@/api/attention";
import { routinesApi } from "@/api/routines";
import { statusCardsApi } from "@/api/statusCards";
import { Card } from "@/components/ui/card";
import { Link } from "@/lib/router";
import { timeAgo } from "@/lib/timeAgo";
import { queryKeys } from "@/lib/queryKeys";

const MAX_ROWS = 4;

/**
 * The at-a-glance widget row for the V2 dashboard: Decisions, Status, and
 * Routines side by side in the same card grid the Skills and Connectors pages
 * use, so the operator reads the state of the company without scrolling to a
 * separate surface.
 *
 * Every widget is a read-only summary. Nothing here mutates, because a
 * dashboard glance should never be a place where a routine gets triggered or a
 * decision gets accepted by accident. Each widget also renders its own empty
 * state rather than vanishing: "0 waiting" is information, and a card that
 * disappears leaves the reader wondering whether it broke.
 */
export function DashboardAtAGlance({
  companyId,
  decisionsEnabled,
  statusCardsEnabled,
}: {
  companyId: string;
  decisionsEnabled: boolean;
  statusCardsEnabled: boolean;
}) {
  return (
    <div
      role="list"
      aria-label="At a glance"
      className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(19rem,1fr))]"
    >
      {decisionsEnabled ? <DecisionsWidget companyId={companyId} /> : null}
      {statusCardsEnabled ? <StatusWidget companyId={companyId} /> : null}
      <RoutinesWidget companyId={companyId} />
    </div>
  );
}

function WidgetHeader({
  icon,
  title,
  count,
  to,
}: {
  icon: ReactNode;
  title: string;
  count?: number;
  to: string;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-muted-foreground">{icon}</span>
      <h3 className="text-sm font-semibold text-foreground">{title}</h3>
      {count !== undefined ? (
        <span className="text-xs tabular-nums text-muted-foreground">{count}</span>
      ) : null}
      <Link
        to={to}
        className="ml-auto text-xs text-muted-foreground hover:text-foreground no-underline"
      >
        View all
      </Link>
    </div>
  );
}

function WidgetShell({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <Card role="listitem" aria-label={label} className="@container block gap-3 p-4">
      {children}
    </Card>
  );
}

function EmptyLine({ children }: { children: ReactNode }) {
  return <p className="text-xs text-muted-foreground">{children}</p>;
}

function DecisionsWidget({ companyId }: { companyId: string }) {
  const { data, isLoading } = useQuery({
    queryKey: queryKeys.attention(companyId),
    queryFn: () => attentionApi.list(companyId, { all: true, limit: MAX_ROWS }),
  });

  return (
    <WidgetShell label="Decisions">
      <WidgetHeader
        icon={<Gavel className="h-4 w-4" aria-hidden="true" />}
        title="Decisions"
        count={data?.totalCount}
        to="/decisions"
      />
      {isLoading ? (
        <EmptyLine>Loading…</EmptyLine>
      ) : data?.items.length ? (
        <ul className="flex flex-col divide-y divide-border">
          {data.items.slice(0, MAX_ROWS).map((item) => {
            const label = item.subject.title ?? item.subject.identifier ?? item.whyNow;
            return (
              <li key={item.id} className="py-1.5 first:pt-0 last:pb-0">
                <div className="flex items-baseline gap-2">
                  <span
                    className={`shrink-0 text-(length:--text-micro) uppercase tracking-wide ${
                      item.severity === "critical"
                        ? "text-destructive"
                        : "text-muted-foreground"
                    }`}
                  >
                    {item.severity}
                  </span>
                  {item.subject.href ? (
                    <Link
                      to={item.subject.href}
                      className="min-w-0 flex-1 truncate text-sm text-foreground no-underline hover:underline"
                      title={label}
                    >
                      {label}
                    </Link>
                  ) : (
                    <span className="min-w-0 flex-1 truncate text-sm" title={label}>
                      {label}
                    </span>
                  )}
                </div>
                <p className="truncate text-xs text-muted-foreground" title={item.whyNow}>
                  {item.whyNow}
                </p>
              </li>
            );
          })}
        </ul>
      ) : (
        <EmptyLine>Nothing is waiting on a decision.</EmptyLine>
      )}
    </WidgetShell>
  );
}

function StatusWidget({ companyId }: { companyId: string }) {
  const { data, isLoading } = useQuery({
    queryKey: queryKeys.statusCards.list(companyId, false),
    queryFn: () => statusCardsApi.list(companyId, false),
  });

  return (
    <WidgetShell label="Status">
      <WidgetHeader
        icon={<Radio className="h-4 w-4" aria-hidden="true" />}
        title="Status"
        count={data?.length}
        to="/status-cards"
      />
      {isLoading ? (
        <EmptyLine>Loading…</EmptyLine>
      ) : data?.length ? (
        <ul className="flex flex-col divide-y divide-border">
          {data.slice(0, MAX_ROWS).map((card) => (
            <li key={card.id} className="flex items-baseline gap-2 py-1.5 first:pt-0 last:pb-0">
              <span className="min-w-0 flex-1 truncate text-sm" title={card.title ?? card.interestPrompt}>
                {card.title ?? card.interestPrompt}
              </span>
              <span className="shrink-0 text-xs text-muted-foreground">
                {card.pendingChangeCount > 0 ? `${card.pendingChangeCount} new` : card.state}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <EmptyLine>No status cards yet.</EmptyLine>
      )}
    </WidgetShell>
  );
}

function RoutinesWidget({ companyId }: { companyId: string }) {
  const { data, isLoading } = useQuery({
    queryKey: queryKeys.routines.list(companyId),
    queryFn: () => routinesApi.list(companyId),
  });

  const routines = (data ?? [])
    .filter((routine) => routine.status === "active")
    .slice(0, MAX_ROWS);

  return (
    <WidgetShell label="Routines">
      <WidgetHeader
        icon={<CalendarClock className="h-4 w-4" aria-hidden="true" />}
        title="Routines"
        count={data?.length}
        to="/routines"
      />
      {isLoading ? (
        <EmptyLine>Loading…</EmptyLine>
      ) : routines.length ? (
        <ul className="flex flex-col divide-y divide-border">
          {routines.map((routine) => {
            const nextRunAt = routine.triggers.find((trigger) => trigger.nextRunAt)?.nextRunAt;
            return (
              <li key={routine.id} className="flex items-baseline gap-2 py-1.5 first:pt-0 last:pb-0">
                <Link
                  to={`/routines/${routine.id}`}
                  className="min-w-0 flex-1 truncate text-sm text-foreground no-underline hover:underline"
                  title={routine.title}
                >
                  {routine.title}
                </Link>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {nextRunAt ? `next ${timeAgo(nextRunAt)}` : "no schedule"}
                </span>
              </li>
            );
          })}
        </ul>
      ) : (
        <EmptyLine>No active routines.</EmptyLine>
      )}
    </WidgetShell>
  );
}
