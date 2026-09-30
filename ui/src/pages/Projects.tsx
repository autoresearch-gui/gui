import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Project, ResourceMembershipState } from "@paperclipai/shared";
import { projectsApi } from "../api/projects";
import { useCompany } from "../context/CompanyContext";
import { useDialogActions } from "../context/DialogContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { ProjectTile } from "../components/ProjectTile";
import { StatusBadge } from "../components/StatusBadge";
import { MembershipAction } from "../components/MembershipAction";
import { StarToggle } from "../components/StarToggle";
import { EmptyState } from "../components/EmptyState";
import { formatDate, formatNumber, formatProjectBudget, projectUrl } from "../lib/utils";
import {
  isStarred,
  resourceMembershipState,
  useResourceMembershipMutation,
  useResourceMemberships,
} from "../hooks/useResourceMemberships";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Skeleton } from "@/components/ui/skeleton";
import { ArrowUpDown, Check, Hexagon, Plus } from "lucide-react";
import { Link } from "@/lib/router";

type ProjectSortField = "name" | "updated" | "created" | "targetDate";
type ProjectSortDir = "asc" | "desc";

const PROJECT_SORT_OPTIONS: Array<{ field: ProjectSortField; label: string }> = [
  { field: "name", label: "Name" },
  { field: "updated", label: "Updated" },
  { field: "created", label: "Created" },
  { field: "targetDate", label: "Target date" },
];

function compareProjectNames(left: Project, right: Project) {
  const nameDiff = left.name.localeCompare(right.name, undefined, { sensitivity: "base" });
  return nameDiff !== 0 ? nameDiff : left.id.localeCompare(right.id);
}

function projectTime(value: Date | string | null | undefined): number | null {
  if (!value) return null;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : null;
}

function compareOptionalTime(
  left: Date | string | null | undefined,
  right: Date | string | null | undefined,
  sortDir: ProjectSortDir,
) {
  const leftTime = projectTime(left);
  const rightTime = projectTime(right);
  if (leftTime === null && rightTime === null) return 0;
  if (leftTime === null) return 1;
  if (rightTime === null) return -1;
  return sortDir === "asc" ? leftTime - rightTime : rightTime - leftTime;
}

function sortProjects(projects: Project[], sortField: ProjectSortField, sortDir: ProjectSortDir) {
  return [...projects].sort((left, right) => {
    let comparison = 0;
    if (sortField === "name") {
      comparison = compareProjectNames(left, right);
      return sortDir === "asc" ? comparison : -comparison;
    }

    if (sortField === "updated") comparison = compareOptionalTime(left.updatedAt, right.updatedAt, sortDir);
    else if (sortField === "created") comparison = compareOptionalTime(left.createdAt, right.createdAt, sortDir);
    else comparison = compareOptionalTime(left.targetDate, right.targetDate, sortDir);

    if (comparison === 0) comparison = compareProjectNames(left, right);
    return comparison;
  });
}

/**
 * One project as a card. Mirrors the Connectors card (Browse.tsx `ConnectorCard`)
 * and the Skills card (CompanySkills.tsx `SkillCard`): a bordered card whose
 * footer pins to the bottom via `mt-auto`, so every card in a grid row lines up
 * regardless of how much description text it carries.
 *
 * The card body stays a real link rather than a `div role="button"`: right-click,
 * middle-click, and "open in new tab" are real affordances, and the reserved
 * description line is what keeps cards in a row aligned.
 */
function ProjectCard({
  project,
  membershipState,
  starred,
  pending,
  starPending,
  onToggleStar,
  onJoin,
  onLeave,
}: {
  project: Project;
  membershipState: ResourceMembershipState;
  starred: boolean;
  pending: boolean;
  starPending: boolean;
  onToggleStar: (next: boolean) => void;
  onJoin: () => void;
  onLeave: () => void;
}) {
  const taskCount = project.taskCount ?? 0;
  return (
    <div
      role="listitem"
      data-project-id={project.id}
      className={`group flex h-full flex-col overflow-hidden rounded-xl border border-border bg-card ${
        membershipState === "left" ? "text-foreground/55" : ""
      }`}
    >
      <div className="flex items-start gap-3 p-4">
        <Link
          to={projectUrl(project)}
          className="flex min-w-0 flex-1 items-start gap-3 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ProjectTile color={project.color ?? null} icon={project.icon ?? null} size="md" />
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-sm font-semibold text-foreground">{project.name}</h2>
            {/* Reserve the description line so cards align with and without one. */}
            <p aria-hidden={project.description ? undefined : true} className="mt-0.5 line-clamp-2 min-h-4 text-xs text-muted-foreground">
              {project.description ?? ""}
            </p>
          </div>
        </Link>
        <StarToggle
          size="row"
          starred={starred}
          pending={starPending}
          resourceName={project.name}
          onToggle={onToggleStar}
        />
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 text-xs text-muted-foreground tabular-nums">
        <span title={`${formatNumber(taskCount)} task${taskCount === 1 ? "" : "s"}`}>
          {formatNumber(taskCount)} task{taskCount === 1 ? "" : "s"}
        </span>
        {project.budget ? <span>{formatProjectBudget(project.budget)}</span> : null}
        {project.targetDate ? <span>{formatDate(project.targetDate)}</span> : null}
      </div>

      <div className="mt-auto flex items-center justify-between gap-2 border-t border-border px-4 py-2.5">
        <StatusBadge status={project.status} />
        <MembershipAction
          compact
          state={membershipState}
          pending={pending}
          resourceName={project.name}
          onJoin={onJoin}
          onLeave={onLeave}
        />
      </div>
    </div>
  );
}

export function Projects() {
  const { selectedCompanyId } = useCompany();
  const { openNewProject } = useDialogActions();
  const { setBreadcrumbs } = useBreadcrumbs();
  const [sortField, setSortField] = useState<ProjectSortField>("name");
  const [sortDir, setSortDir] = useState<ProjectSortDir>("asc");

  useEffect(() => {
    setBreadcrumbs([{ label: "Projects" }]);
  }, [setBreadcrumbs]);

  const { data: allProjects, isLoading, error } = useQuery({
    queryKey: queryKeys.projects.list(selectedCompanyId!),
    queryFn: () => projectsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
  const membershipsQuery = useResourceMemberships(selectedCompanyId);
  const membershipMutation = useResourceMembershipMutation(selectedCompanyId);
  const projects = useMemo(
    () => allProjects ?? [],
    [allProjects],
  );
  const sortedProjects = useMemo(
    () => sortProjects(projects, sortField, sortDir),
    [projects, sortDir, sortField],
  );
  const groupedProjects = useMemo(() => {
    const groups = {
      mine: [] as typeof sortedProjects,
      other: [] as typeof sortedProjects,
    };

    for (const project of sortedProjects) {
      const state = resourceMembershipState(membershipsQuery.data, "project", project.id);
      if (state === "left") groups.other.push(project);
      else groups.mine.push(project);
    }

    return groups;
  }, [membershipsQuery.data, sortedProjects]);
  const sortLabel = PROJECT_SORT_OPTIONS.find((option) => option.field === sortField)?.label ?? "Name";

  if (!selectedCompanyId) {
    return <EmptyState icon={Hexagon} message="Select an organization to view projects." />;
  }

  if (isLoading) {
    return (
      <div className="space-y-3" aria-label="Loading projects">
        {Array.from({ length: 6 }).map((_, index) => (
          <Skeleton key={index} className="h-32 w-full rounded-xl" />
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <Popover>
          <PopoverTrigger asChild>
            <Button variant="ghost" size="sm" className="w-fit text-xs" title="Sort">
              <ArrowUpDown className="h-3.5 w-3.5 sm:h-3 sm:w-3 sm:mr-1" />
              <span>Sort: {sortLabel}</span>
            </Button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-44 p-0">
            <div className="p-2 space-y-0.5">
              {PROJECT_SORT_OPTIONS.map((option) => (
                <button
                  key={option.field}
                  type="button"
                  className={`flex w-full items-center justify-between rounded-sm px-2 py-1.5 text-sm ${
                    sortField === option.field
                      ? "bg-accent/50 text-foreground"
                      : "text-muted-foreground hover:bg-accent/50"
                  }`}
                  onClick={() => {
                    if (sortField === option.field) {
                      setSortDir((current) => (current === "asc" ? "desc" : "asc"));
                      return;
                    }
                    setSortField(option.field);
                    setSortDir(option.field === "name" || option.field === "targetDate" ? "asc" : "desc");
                  }}
                >
                  <span>{option.label}</span>
                  {sortField === option.field ? (
                    <span className="flex items-center gap-1 text-xs text-muted-foreground">
                      <Check className="h-3 w-3" />
                      {sortDir === "asc" ? "Asc" : "Desc"}
                    </span>
                  ) : null}
                </button>
              ))}
            </div>
          </PopoverContent>
        </Popover>
        <Button size="sm" variant="outline" onClick={openNewProject}>
          <Plus className="h-4 w-4 mr-1" />
          Add Project
        </Button>
      </div>

      {error && <p className="text-sm text-destructive">{error.message}</p>}

      {!isLoading && projects.length === 0 && (
        <EmptyState
          icon={Hexagon}
          message="No projects yet."
          action="Add Project"
          onAction={openNewProject}
        />
      )}

      {projects.length > 0 && (
        <div className="space-y-6">
          {([
            ["My Projects", groupedProjects.mine],
            ["Other Projects", groupedProjects.other],
          ] as const).map(([label, sectionProjects]) => {
            if (sectionProjects.length === 0) return null;

            return (
              <section key={label} className="space-y-2">
                <div className="flex items-center justify-between">
                  <h2 className="text-sm font-medium">{label}</h2>
                  <span className="text-xs text-muted-foreground">
                    {sectionProjects.length} project{sectionProjects.length === 1 ? "" : "s"}
                  </span>
                </div>
                <div
                  role="list"
                  aria-label={`${label} list`}
                  className="grid items-start gap-3 [grid-template-columns:repeat(auto-fill,minmax(19rem,1fr))]"
                >
                  {sectionProjects.map((project) => {
                    const state = resourceMembershipState(membershipsQuery.data, "project", project.id);
                    const pending = membershipMutation.isPending &&
                      membershipMutation.variables?.resourceType === "project" &&
                      membershipMutation.variables.resourceId === project.id;
                    const starPending = pending && membershipMutation.variables?.starred !== undefined;
                    const joinLeavePending = pending && membershipMutation.variables?.starred === undefined;
                    const starred = isStarred(membershipsQuery.data, "project", project.id);
                    return (
                      <ProjectCard
                        key={project.id}
                        project={project}
                        membershipState={state}
                        starred={starred}
                        pending={joinLeavePending}
                        starPending={starPending}
                        onToggleStar={(next) => membershipMutation.mutate({
                          resourceType: "project",
                          resourceId: project.id,
                          resourceName: project.name,
                          starred: next,
                        })}
                        onJoin={() => membershipMutation.mutate({
                          resourceType: "project",
                          resourceId: project.id,
                          resourceName: project.name,
                          state: "joined",
                        })}
                        onLeave={() => membershipMutation.mutate({
                          resourceType: "project",
                          resourceId: project.id,
                          resourceName: project.name,
                          state: "left",
                        })}
                      />
                    );
                  })}
                </div>
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
