import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import type { ComponentProps } from "react";
import { Sidebar } from "./Sidebar";
import type { SessionMeta } from "../types";

vi.mock("../api", () => ({
  searchSessions: vi.fn(),
}));

import * as api from "../api";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const sessions: SessionMeta[] = [
  { id: "s1", title: "Fix parser", updatedAt: "21/07 18:32", updatedAtMs: Date.now(), messages: 3 },
];

function renderSidebar(overrides: Partial<ComponentProps<typeof Sidebar>> = {}) {
  const onSelect = vi.fn();
  const utils = render(
    <Sidebar
      mode="live"
      sessions={sessions}
      activeId="s1"
      onSelect={onSelect}
      onNew={vi.fn()}
      onRename={vi.fn()}
      onDelete={vi.fn()}
      onClearAll={vi.fn()}
      {...overrides}
    />,
  );
  return { ...utils, onSelect };
}

describe("Sidebar", () => {
  it("does not show a relative-time label for a session updated less than a minute ago", () => {
    const { queryByText } = renderSidebar();
    expect(queryByText("just now")).toBeNull();
  });
});

describe("Sidebar search", () => {
  it("shows the normal session list when there is no query", () => {
    const { getByText, queryByRole } = renderSidebar();
    expect(getByText("Fix parser")).toBeTruthy();
    expect(queryByRole("button", { name: "Clear search" })).toBeNull();
  });

  it("debounces typing and calls searchSessions, showing results instead of the normal list", async () => {
    vi.mocked(api.searchSessions).mockResolvedValue([
      { id: "s9", title: "Found one", updatedAt: "1/1 00:00", messages: 1, snippet: "…a match…" },
    ]);
    const { getByRole, getByText, queryByText } = renderSidebar();
    fireEvent.change(getByRole("textbox", { name: "Search conversations" }), {
      target: { value: "parser" },
    });

    await waitFor(() => expect(api.searchSessions).toHaveBeenCalledWith("parser"));
    await waitFor(() => expect(getByText("Found one")).toBeTruthy());
    expect(getByText("…a match…")).toBeTruthy();
    expect(queryByText("Fix parser")).toBeNull();
  });

  it("shows a subtle loading indicator while the search is pending", async () => {
    let resolvePromise: (v: SessionMeta[]) => void = () => {};
    vi.mocked(api.searchSessions).mockReturnValue(
      new Promise((resolve) => {
        resolvePromise = resolve;
      }),
    );
    const { getByRole, getByText } = renderSidebar();
    fireEvent.change(getByRole("textbox", { name: "Search conversations" }), {
      target: { value: "x" },
    });

    await waitFor(() => expect(getByText("Searching…")).toBeTruthy());
    resolvePromise([]);
    await waitFor(() => expect(getByText("no matches")).toBeTruthy());
  });

  it("shows a 'no matches' message for empty results", async () => {
    vi.mocked(api.searchSessions).mockResolvedValue([]);
    const { getByRole, getByText } = renderSidebar();
    fireEvent.change(getByRole("textbox", { name: "Search conversations" }), {
      target: { value: "zzz" },
    });
    await waitFor(() => expect(getByText("no matches")).toBeTruthy());
  });

  it("shows an inline error message when the search fails, without crashing", async () => {
    vi.mocked(api.searchSessions).mockRejectedValue(new Error("boom"));
    const { getByRole, getByText } = renderSidebar();
    fireEvent.change(getByRole("textbox", { name: "Search conversations" }), {
      target: { value: "err" },
    });
    await waitFor(() => expect(getByText("Search failed. Try again.")).toBeTruthy());
  });

  it("selecting a search result behaves like selecting a normal session", async () => {
    vi.mocked(api.searchSessions).mockResolvedValue([
      { id: "s9", title: "Found one", updatedAt: "1/1 00:00", messages: 1 },
    ]);
    const { getByRole, getByText, onSelect } = renderSidebar();
    fireEvent.change(getByRole("textbox", { name: "Search conversations" }), {
      target: { value: "found" },
    });
    await waitFor(() => expect(getByText("Found one")).toBeTruthy());
    fireEvent.click(getByText("Found one"));
    expect(onSelect).toHaveBeenCalledWith("s9");
  });

  it("clearing the input returns to the normal session list", async () => {
    vi.mocked(api.searchSessions).mockResolvedValue([
      { id: "s9", title: "Found one", updatedAt: "1/1 00:00", messages: 1 },
    ]);
    const { getByRole, getByText, queryByText } = renderSidebar();
    const input = getByRole("textbox", { name: "Search conversations" });
    fireEvent.change(input, { target: { value: "found" } });
    await waitFor(() => expect(getByText("Found one")).toBeTruthy());

    fireEvent.click(getByRole("button", { name: "Clear search" }));
    expect(queryByText("Found one")).toBeNull();
    expect(getByText("Fix parser")).toBeTruthy();
  });
});
