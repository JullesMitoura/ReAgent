import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { ErrorBoundary } from "./components/ErrorBoundary";

afterEach(cleanup);

function Boom(): never {
  throw new Error("kaboom");
}

describe("ErrorBoundary", () => {
  it("renders children when there is no error", () => {
    const { getByText, queryByText } = render(
      <ErrorBoundary>
        <span>filho ok</span>
      </ErrorBoundary>,
    );
    expect(getByText("filho ok")).toBeTruthy();
    expect(queryByText("Algo deu errado")).toBeNull();
  });

  it("shows the fallback and logs when a child throws", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { getByText } = render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    );
    expect(getByText("Algo deu errado")).toBeTruthy();
    expect(getByText("Reload")).toBeTruthy();
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("reloads the page when Reload is clicked", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const reload = vi.fn();
    const original = window.location;
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...original, reload },
    });

    const { getByText } = render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    );
    fireEvent.click(getByText("Reload"));
    expect(reload).toHaveBeenCalledTimes(1);

    Object.defineProperty(window, "location", { configurable: true, value: original });
    errorSpy.mockRestore();
  });
});
