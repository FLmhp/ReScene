import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

import { legalDocuments } from "./index";

const readLicense = (path) => readFileSync(new URL(path, import.meta.url), "utf8").replace(/\r\n/g, "\n");

it("ships the complete repository and Inter licenses, including attribution", () => {
  const licenses = legalDocuments.find(({ id }) => id === "licenses");
  expect(licenses?.paragraphs.slice(1)).toEqual([
    readLicense("../../../LICENSE"),
    readLicense("../../design-tokens/assets/Inter-LICENSE.txt"),
  ]);
});

it("identifies the agreement and privacy text as drafts that are not in force", () => {
  expect(legalDocuments.filter(({ status }) => status === "审核稿 · 尚未生效").map(({ id }) => id)).toEqual([
    "terms", "privacy",
  ]);
});
