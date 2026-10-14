import assert from "node:assert/strict";
import test from "node:test";
import "../test/setup-dom.js";
import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { FinalResumeEditor } from "./FinalResumeEditor";
import type { AnalysisOutput } from "../lib/analysis-client";

const styles = new Proxy<Record<string, string>>({}, {
  get: (_target, property) => String(property),
});

const originalResume = "Desenvolvi APIs.";
const analysis: AnalysisOutput = {
  jobRequirements: [],
  suggestions: [{
    id: "suggestion-1",
    category: "job_alignment",
    section: "Experiência",
    originalText: originalResume,
    suggestedText: "Desenvolvi APIs REST.",
    relatedRequirementIds: [],
    rationale: "Explicita o tipo de API descrito.",
    sourceFacts: [originalResume],
    pointsToConfirm: [],
    sourceRange: { start: 0, end: originalResume.length },
  }],
  documentStructure: { sectionOrder: ["Experiência"], suggestionOrder: ["suggestion-1"] },
};

test.afterEach(() => cleanup());

test("applies only approved suggestions and leaves the final curriculum editable", () => {
  const drafts: Array<{ text: string; approvedIds: readonly string[] }> = [];
  render(
    <FinalResumeEditor
      originalResume={originalResume}
      analysis={analysis}
      decisions={{ "suggestion-1": "approved" }}
      styles={styles}
      onDraftChange={(text, approvedIds) => drafts.push({ text, approvedIds })}
    />,
  );

  const editor = screen.getByLabelText("Currículo final editável") as HTMLTextAreaElement;
  assert.equal(editor.value, originalResume);
  fireEvent.click(screen.getByRole("button", { name: "Aplicar sugestões aprovadas (1)" }));
  assert.equal(editor.value, "Desenvolvi APIs REST.");
  assert.ok(screen.getByRole("status").textContent?.includes("Sugestões aprovadas aplicadas"));

  fireEvent.change(editor, { target: { value: "Versão final revisada pela pessoa." } });
  assert.equal(editor.value, "Versão final revisada pela pessoa.");
  assert.deepEqual(drafts, [
    { text: "Desenvolvi APIs REST.", approvedIds: ["suggestion-1"] },
    { text: "Versão final revisada pela pessoa.", approvedIds: ["suggestion-1"] },
  ]);
});

test("downloads the edited final text locally as a text file", async () => {
  let downloadedBlob: Blob | undefined;
  let downloadName = "";
  const createDescriptor = Object.getOwnPropertyDescriptor(URL, "createObjectURL");
  const revokeDescriptor = Object.getOwnPropertyDescriptor(URL, "revokeObjectURL");
  const anchorClick = window.HTMLAnchorElement.prototype.click;

  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    value: (blob: Blob) => {
      downloadedBlob = blob;
      return "blob:curriculus-test";
    },
  });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: () => undefined });
  window.HTMLAnchorElement.prototype.click = function click() {
    downloadName = this.download;
    assert.equal(this.href, "blob:curriculus-test");
  };

  try {
    render(
      <FinalResumeEditor
        originalResume={originalResume}
        analysis={analysis}
        decisions={{}}
        styles={styles}
      />,
    );
    const editor = screen.getByLabelText("Currículo final editável") as HTMLTextAreaElement;
    fireEvent.change(editor, { target: { value: "Texto final local" } });
    fireEvent.click(screen.getByRole("button", { name: "Baixar currículo em texto (.txt)" }));

    assert.equal(downloadName, "curriculo-revisado.txt");
    assert.equal(await downloadedBlob?.text(), "Texto final local");
  } finally {
    if (createDescriptor) Object.defineProperty(URL, "createObjectURL", createDescriptor);
    else Reflect.deleteProperty(URL, "createObjectURL");
    if (revokeDescriptor) Object.defineProperty(URL, "revokeObjectURL", revokeDescriptor);
    else Reflect.deleteProperty(URL, "revokeObjectURL");
    window.HTMLAnchorElement.prototype.click = anchorClick;
  }
});
