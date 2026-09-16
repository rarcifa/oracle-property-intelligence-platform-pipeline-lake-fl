import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { AppErrorBoundary } from "./AppErrorBoundary.js";

describe("AppErrorBoundary", () => {
  it("renders the application normally until a render failure", () => {
    const boundary = new AppErrorBoundary({ children: createElement("p", null, "Live data") });
    expect(renderToStaticMarkup(boundary.render())).toBe("<p>Live data</p>");
    expect(AppErrorBoundary.getDerivedStateFromError()).toEqual({ failed: true });
  });

  it("leaves a recoverable visible error instead of a blank window", () => {
    const boundary = new AppErrorBoundary({ children: "Hidden failed view" });
    boundary.state = { failed: true };
    const html = renderToStaticMarkup(boundary.render());
    expect(html).toContain('role="alert"');
    expect(html).toContain("Reload application");
    expect(html).toContain('href="/api/meta/run"');
    expect(html).not.toContain("Hidden failed view");
  });

  it("does not log source data or error stacks", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const boundary = new AppErrorBoundary({ children: null });
      boundary.componentDidCatch(new Error("private source value"), {
        componentStack: "private stack",
      });
      expect(log).toHaveBeenCalledWith("Oracle view failed to render.", { name: "Error" });
      expect(JSON.stringify(log.mock.calls)).not.toContain("private");
    } finally {
      log.mockRestore();
    }
  });
});
