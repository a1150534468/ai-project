// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { KbDocument, KnowledgeBase } from "../api";
import type { CodexPetProjectDetail } from "../codexPetApi";
import { ToastProvider } from "../motion";
import Knowledge from "./Knowledge";

const apiMocks = vi.hoisted(() => ({
  listKb: vi.fn(),
  createKb: vi.fn(),
  renameKb: vi.fn(),
  deleteKb: vi.fn(),
  listKbDocuments: vi.fn(),
  getKbDocument: vi.fn(),
  addKbFile: vi.fn(),
  deleteKbDocument: vi.fn(),
  getKbQuota: vi.fn(),
}));

const codexPetApiMocks = vi.hoisted(() => ({
  createCodexPetInstallLink: vi.fn(),
  downloadCodexPetPackage: vi.fn(),
  getCodexPetProject: vi.fn(),
}));

vi.mock("../api", () => apiMocks);
vi.mock("../codexPetApi", () => codexPetApiMocks);
vi.mock("@iconify/react", () => ({
  Icon: ({ icon }: { readonly icon: string }) => <span data-icon={icon} />,
}));

const personalKb: KnowledgeBase = {
  id: "kb-personal",
  name: "普通知识库",
  ownerType: "USER",
};

const artifactsKb: KnowledgeBase = {
  id: "kb-artifacts",
  name: "AI 产物",
  ownerType: "USER",
  systemKey: "AI_ARTIFACTS",
};

const petDocument: KbDocument = {
  id: "document-pet-1",
  name: "Codex 桌宠 · 码仔",
  status: "pending",
  sizeBytes: 4096,
  chunkCount: 0,
  sourceType: "ARTIFACT",
  sourceModule: "codex_pet",
  metadata: {
    projectId: "project-pet-1",
    runId: "run-pet-1",
    previewArtifactId: "preview-pet-1",
  },
  createdAt: "2026-07-17T08:00:00.000Z",
};

const regularDocument: KbDocument = {
  id: "document-regular-1",
  name: "普通文档",
  status: "indexed",
  sizeBytes: 1024,
  chunkCount: 2,
  createdAt: "2026-07-17T08:00:00.000Z",
};

const petDetail = {
  project: {
    id: "project-pet-1",
    name: "码仔",
    description: "陪伴写代码的机器人",
    prompt: "薄荷色圆润机器人",
    stylePreset: "pixel",
    styleNotes: "",
    referenceAssetIds: [],
    autoContinue: false,
    status: "ready",
    latestRunId: "run-pet-newer",
    createdAt: "2026-07-17T08:00:00.000Z",
    updatedAt: "2026-07-17T08:10:00.000Z",
  },
  latestRun: null,
  runs: [],
  jobs: [],
  artifacts: [{
    id: "preview-pet-1",
    projectId: "project-pet-1",
    runId: "run-pet-1",
    kind: "animation_preview",
    name: "preview.webp",
    status: "ready",
    mime: "image/webp",
    sizeBytes: 2048,
    width: 768,
    height: 1144,
    metadata: {},
    expiresAt: null,
    createdAt: "2026-07-17T08:10:00.000Z",
    previewUrl: "https://example.test/private-preview.webp",
  }],
} satisfies CodexPetProjectDetail;

async function flushEffects(iterations = 8): Promise<void> {
  for (let index = 0; index < iterations; index += 1) {
    await act(async () => { await Promise.resolve(); });
  }
}

async function waitForText(container: Element, text: string): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (container.textContent?.includes(text)) return;
    await flushEffects(1);
  }
  throw new Error(`Expected text not found: ${text}`);
}

function buttonByText(container: Element, text: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll("button")).find((candidate) => candidate.textContent?.includes(text));
  if (!(button instanceof HTMLButtonElement)) throw new Error(`Button not found: ${text}`);
  return button;
}

function kbCardByName(container: Element, name: string): HTMLElement {
  const label = Array.from(container.querySelectorAll("p")).find((candidate) => candidate.textContent === name);
  const card = label?.closest(".cursor-pointer");
  if (!(card instanceof HTMLElement)) throw new Error(`Knowledge base card not found: ${name}`);
  return card;
}

describe("Knowledge Codex pet artifacts", () => {
  let container: HTMLDivElement;
  let root: Root;
  let scrollIntoView: ReturnType<typeof vi.fn>;
  let originalScrollIntoView: typeof HTMLElement.prototype.scrollIntoView | undefined;
  let anchorClick: ReturnType<typeof vi.spyOn>;
  let createObjectUrl: ReturnType<typeof vi.fn>;
  let revokeObjectUrl: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
    apiMocks.listKb.mockResolvedValue([personalKb, artifactsKb]);
    apiMocks.listKbDocuments.mockImplementation(async (_token: string, kbId: string) => (
      kbId === artifactsKb.id ? [petDocument] : [regularDocument]
    ));
    apiMocks.getKbQuota.mockResolvedValue({
      effective: 1024 * 1024,
      used: 4096,
      breakdown: { defaultBytes: 1024 * 1024, membershipBytes: 0, grantBytes: 0 },
    });
    codexPetApiMocks.getCodexPetProject.mockResolvedValue(petDetail);
    codexPetApiMocks.createCodexPetInstallLink.mockResolvedValue({
      installUrl: "codex://pets/install?name=%E7%A0%81%E4%BB%94",
    });
    codexPetApiMocks.downloadCodexPetPackage.mockResolvedValue({
      blob: new Blob(["zip"]),
      filename: "ma-zai.zip",
    });

    originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
    scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView,
    });
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      callback(0);
      return 1;
    });
    anchorClick = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    createObjectUrl = vi.fn(() => "blob:https://example.test/pet-package");
    revokeObjectUrl = vi.fn();
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: createObjectUrl });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: revokeObjectUrl });

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => { root.unmount(); });
    container.remove();
    if (originalScrollIntoView) {
      Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
        configurable: true,
        value: originalScrollIntoView,
      });
    } else {
      Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
    }
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it("opens the AI artifacts library at the requested document without trapping later library selection", async () => {
    const onOpenCodexPetProject = vi.fn();
    await act(async () => {
      root.render(
        <ToastProvider>
          <Knowledge
            token="bearer-token"
            initialDocumentId={petDocument.id}
            onViewChange={vi.fn()}
            onOpenCodexPetProject={onOpenCodexPetProject}
          />
        </ToastProvider>,
      );
    });
    await waitForText(container, petDocument.name);
    await flushEffects();

    expect(apiMocks.listKbDocuments).toHaveBeenCalledWith("bearer-token", artifactsKb.id);
    expect(codexPetApiMocks.getCodexPetProject).toHaveBeenCalledTimes(1);
    expect(codexPetApiMocks.getCodexPetProject).toHaveBeenCalledWith("bearer-token", "project-pet-1");
    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: "smooth", block: "center" });
    expect(container.textContent).toContain("AI 自动归档 · Codex 桌宠");
    expect(container.querySelector<HTMLImageElement>(`img[alt="${petDocument.name} 桌宠预览"]`)?.src)
      .toBe("https://example.test/private-preview.webp");

    await act(async () => { buttonByText(container, "打开桌宠项目").click(); });
    expect(onOpenCodexPetProject).toHaveBeenCalledWith("project-pet-1");

    await act(async () => { kbCardByName(container, personalKb.name).click(); });
    await waitForText(container, regularDocument.name);
    expect(apiMocks.listKbDocuments).toHaveBeenLastCalledWith("bearer-token", personalKb.id);
  });

  it("installs and downloads through authenticated pet APIs instead of persisted object URLs", async () => {
    await act(async () => {
      root.render(
        <ToastProvider>
          <Knowledge
            token="bearer-token"
            initialDocumentId={petDocument.id}
            onViewChange={vi.fn()}
          />
        </ToastProvider>,
      );
    });
    await waitForText(container, petDocument.name);

    await act(async () => { buttonByText(container, "安装到 Codex").click(); });
    await flushEffects();
    expect(codexPetApiMocks.createCodexPetInstallLink).toHaveBeenCalledWith("bearer-token", "project-pet-1", "run-pet-1");
    const installAnchor = anchorClick.mock.instances.at(-1) as HTMLAnchorElement;
    expect(installAnchor.href).toBe("codex://pets/install?name=%E7%A0%81%E4%BB%94");

    await act(async () => { buttonByText(container, "下载兼容包").click(); });
    await flushEffects();
    expect(codexPetApiMocks.downloadCodexPetPackage).toHaveBeenCalledWith("bearer-token", "project-pet-1", "run-pet-1");
    const downloadAnchor = anchorClick.mock.instances.at(-1) as HTMLAnchorElement;
    expect(downloadAnchor.href).toBe("blob:https://example.test/pet-package");
    expect(downloadAnchor.download).toBe("ma-zai.zip");
    expect(createObjectUrl).toHaveBeenCalledWith(expect.any(Blob));
    expect(revokeObjectUrl).toHaveBeenCalledWith("blob:https://example.test/pet-package");
  });

  it("does not spin on repeated project-detail requests when a private preview is temporarily unavailable", async () => {
    codexPetApiMocks.getCodexPetProject.mockRejectedValue(new Error("preview unavailable"));
    await act(async () => {
      root.render(
        <ToastProvider>
          <Knowledge
            token="bearer-token"
            initialDocumentId={petDocument.id}
            onViewChange={vi.fn()}
          />
        </ToastProvider>,
      );
    });
    await waitForText(container, petDocument.name);
    await flushEffects(16);

    expect(codexPetApiMocks.getCodexPetProject).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("安装到 Codex");
    expect(container.querySelector(`img[alt="${petDocument.name} 桌宠预览"]`)).toBeNull();
  });
});
