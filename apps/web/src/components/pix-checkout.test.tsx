import assert from "node:assert/strict";
import test from "node:test";
import "../test/setup-dom.js";
import React from "react";
import axe from "axe-core";
import { cleanup, render } from "@testing-library/react";
import { PixCheckout } from "./PixCheckout";

const styles = new Proxy<Record<string, string>>({}, {
  get: (_target, property) => String(property),
});

test.afterEach(() => cleanup());

test("has no automated WCAG A/AA accessibility violations in the Pix checkout", async () => {
  const { container } = render(
    <PixCheckout
      sessionId="session-test-id"
      styles={styles}
      fetcher={async () => new Response()}
    />,
  );

  const results = await axe.run(container, {
    runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] },
    rules: { "color-contrast": { enabled: false } },
  });

  assert.deepEqual(
    results.violations.map(({ id, impact }) => ({ id, impact })),
    [],
  );
});
