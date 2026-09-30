// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { DashboardAtAGlance } from "./DashboardAtAGlance";

const mockAttentionApi = vi.hoisted(() => ({ list: vi.fn() }));
const mockRoutinesApi = vi.hoisted(() => ({ list: vi.fn() }));
const mockStatusCardsApi = vi.hoisted(() => ({ list: vi.fn() }));

vi.mock("@/api/attention", () => ({ attentionApi: mockAttentionApi }));
vi.mock("@/api/routines", () => ({ routinesApi: mockRoutinesApi }));
vi.mock("@/api/statusCards", () => ({ statusCardsApi: mockStatusCardsApi }));
vi.mock("@/lib/router", () => ({
  Link: ({ children, to, ...props }: { children?: ReactNode; to: string }) => (
    <a href={to} {...props}>{children}</a>
  ),
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function act(callback: () => void | Promise<void>) {
  let result: void | Promise<void> = undefined;
  flushSync(() => {
    result = callback();
  });
  await result;
}

async function flushReact() {  for (let index = 0; index < 6; index += 1) {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  }
  flushSync(() => {});
}

describe("DashboardAtAGlance", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    mockAttentionApi.list.mockResolvedValue({
      companyId: "company-1",
      generatedAt: new Date().toISOString(),
      totalCount: 0,
      deskBadgeCount: 0,
      nextCursor: null,
      countsBySourceKind: {},
      items: [],
    });
    mockRoutinesApi.list.mockResolvedValue([]);
    mockStatusCardsApi.list.mockResolvedValue([]);
  });

  afterEach(() => {
    flushSync(() => root.unmount());
    host.remove();
    vi.clearAllMocks();
  });

  function render(props: {
    decisionsEnabled: boolean;
    statusCardsEnabled: boolean;
  }) {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <DashboardAtAGlance companyId="company-1" {...props} />
        </QueryClientProvider>,
      );
      await flushReact();
    });
  }

  it("renders the widget row as a multi-column grid", async () => {
    await render({ decisionsEnabled: true, statusCardsEnabled: true });

    const grid = host.querySelector('[aria-label="At a glance"]');
    expect(grid?.className).toContain("grid");
    expect(grid?.className).toContain(
      "[grid-template-columns:repeat(auto-fill,minmax(19rem,1fr))]",
    );
    expect(grid?.querySelectorAll('[role="listitem"]').length).toBe(3);
  });

  it("hides the Decisions widget when the Decisions surface is off", async () => {
    await render({ decisionsEnabled: false, statusCardsEnabled: true });

    const grid = host.querySelector('[aria-label="At a glance"]');
    expect(grid?.querySelector('[aria-label="Decisions"]')).toBeNull();
    expect(grid?.querySelector('[aria-label="Status"]')).not.toBeNull();
    expect(mockAttentionApi.list).not.toHaveBeenCalled();
  });

  it("hides the Status widget when status cards are off", async () => {
    await render({ decisionsEnabled: true, statusCardsEnabled: false });

    const grid = host.querySelector('[aria-label="At a glance"]');
    expect(grid?.querySelector('[aria-label="Status"]')).toBeNull();
    expect(mockStatusCardsApi.list).not.toHaveBeenCalled();
  });

  it("reports an empty state rather than hiding a widget with nothing in it", async () => {
    await render({ decisionsEnabled: true, statusCardsEnabled: true });

    expect(host.textContent).toContain("Nothing is waiting on a decision.");
    expect(host.textContent).toContain("No status cards yet.");
    expect(host.textContent).toContain("No active routines.");
  });

  it("lists a routine with its next run", async () => {
    mockRoutinesApi.list.mockResolvedValue([
      {
        id: "routine-1",
        title: "Nightly standup",
        status: "active",
        triggers: [{ id: "t1", nextRunAt: new Date(Date.now() + 3_600_000).toISOString() }],
      },
    ]);
    await render({ decisionsEnabled: true, statusCardsEnabled: true });

    const routines = host.querySelector('[aria-label="Routines"]');
    expect(routines?.textContent).toContain("Nightly standup");
    expect(routines?.textContent).toContain("next");
    const links = Array.from(routines?.querySelectorAll("a") ?? []);
    expect(links.some((link) => link.getAttribute("href")?.includes("routine-1"))).toBe(true);
  });
});
