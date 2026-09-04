/**
 * 知识库页。这里只负责摆版面：状态与异步全在 `useKnowledgeState`，四块界面各自成组件。
 * 原来这一个文件里塞了 12 个 useState、8 个 handler 和整棵树，三个真问题都是那么长出来的
 * （编辑变新建、选中态一份两用、轮询定时器没人取消），细节记在 `useKnowledgeState` 的头注释里。
 */
import { Icon } from "@iconify/react";
import { useConfirm } from "../components/ConfirmDialog";
import DocumentList from "../components/knowledge/DocumentList";
import DocumentUploader from "../components/knowledge/DocumentUploader";
import KbForm from "../components/knowledge/KbForm";
import KbList from "../components/knowledge/KbList";
import { useKnowledgeState } from "../components/knowledge/useKnowledgeState";
import { Alert, buttonClass } from "../components/ui";

const PANEL = "glass-card space-y-4 rounded-xl p-6";

interface KnowledgePageProps {
  readonly token: string;
  readonly onViewChange: (view: string) => void;
}

export default function Knowledge({ token, onViewChange }: KnowledgePageProps) {
  const { confirm, Dialog } = useConfirm();
  const kb = useKnowledgeState(token);

  // 首屏还在拉的时候别说「暂无」—— 那是两件事
  const emptyText = kb.loading ? "正在加载…" : "暂无知识库";

  return (
    <>
      <div className="mx-auto max-w-7xl space-y-6 p-6">
        <header className="flex items-center justify-between">
          <h1 className="text-2xl font-bold text-ink">知识库</h1>
          <button
            type="button"
            onClick={() => onViewChange("chat")}
            className={buttonClass({ variant: "outline", size: "lg", shape: "rounded" })}
          >
            返回对话
          </button>
        </header>

        {/* 首屏拉不回来时把原因摆出来；后续刷新失败只弹 toast，不占版面 */}
        {kb.loadError && <Alert tone="danger">{kb.loadError}</Alert>}

        <div className="grid grid-cols-12 gap-6">
          <div className="col-span-12 space-y-6 lg:col-span-5">
            <section className={PANEL}>
              <KbForm
                draft={kb.draft}
                editing={kb.editingId !== null}
                saving={kb.pending === "save"}
                onChange={kb.updateDraft}
                onSubmit={() => void kb.submitDraft()}
                onCancel={kb.cancelEdit}
              />
            </section>

            <KbList
              title="我的知识库"
              items={kb.myKbs}
              selectedId={kb.selectedKb?.id ?? null}
              emptyText={emptyText}
              maxHeight="max-h-96"
              busy={kb.pending === "list"}
              onSelect={kb.select}
              onRefresh={() => void kb.refresh()}
              onEdit={kb.startEdit}
              onDelete={(target) => {
                // 删库原来是点了就删，一步都不问
                void confirm({
                  title: `删除知识库「${target.name}」`,
                  message: "库里的文档和已建立的知识晶格会一起移除，且无法恢复。",
                  confirmText: "删除",
                  isDangerous: true,
                  onConfirm: () => kb.remove(target),
                });
              }}
            />

            <KbList
              title="官方知识库"
              items={kb.officialKbs}
              selectedId={kb.selectedKb?.id ?? null}
              emptyText={kb.loading ? "正在加载…" : "暂无官方库"}
              maxHeight="max-h-48"
              official
              onSelect={kb.select}
            />
          </div>

          <div className="col-span-12 lg:col-span-7">
            {kb.selectedKb === null ? (
              <div className="glass-card rounded-xl p-12 text-center">
                <Icon icon="mdi:folder-open-outline" className="mx-auto mb-4 text-5xl text-ink-tertiary" aria-hidden />
                <p className="text-lg font-semibold text-ink-secondary">选择一个知识库查看文档</p>
                <p className="mt-2 text-sm text-ink-secondary">点击左侧知识库开始</p>
              </div>
            ) : (
              <div className="space-y-6">
                <section className={PANEL}>
                  <h2 className="text-lg font-bold text-ink">{kb.selectedKb.name}</h2>
                  {kb.selectedKb.description && (
                    <p className="text-sm leading-relaxed text-ink-secondary">{kb.selectedKb.description}</p>
                  )}

                  {/* 官方库是只读的：后端对它的文档接口直接 403，所以连上传区都不给 */}
                  {kb.official ? (
                    <Alert tone="brand" bordered>
                      <p className="font-semibold">官方知识库</p>
                      <p className="mt-1 leading-6">已建立知识晶格数量：{kb.selectedKb.latticeCount ?? 0}</p>
                    </Alert>
                  ) : (
                    <DocumentUploader
                      files={kb.files}
                      uploaded={kb.uploaded}
                      failures={kb.failures}
                      uploading={kb.pending === "upload"}
                      pickerKey={kb.pickerKey}
                      onChoose={kb.chooseFiles}
                      onUpload={() => void kb.upload()}
                    />
                  )}
                </section>

                {!kb.official && (
                  <section className={PANEL}>
                    <h3 className="text-sm font-bold uppercase tracking-wider text-ink">文档列表</h3>
                    <DocumentList
                      documents={kb.documents}
                      deleting={kb.pending === "delete"}
                      onDelete={(doc) => {
                        void confirm({
                          title: `删除文档「${doc.name}」`,
                          message: "这篇文档已建立的知识晶格会一起移除，且无法恢复。",
                          confirmText: "删除",
                          isDangerous: true,
                          onConfirm: () => kb.removeDocument(doc.id),
                        });
                      }}
                    />
                  </section>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
      <Dialog />
    </>
  );
}
