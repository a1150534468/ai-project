import { useEffect, useRef, useState } from "react";
import { Icon } from "@iconify/react";
import type { KnowledgeBase, KbDocument } from "../api";
import {
  listKb,
  createKb,
  renameKb,
  deleteKb,
  listKbDocuments,
  getKbDocument,
  addKbFile,
  deleteKbDocument,
} from "../api";
import { RippleButton, Stagger, StaggerItem, useToast } from "../motion";


interface KnowledgePageProps {
  token: string;
  onViewChange: (view: string) => void;
}

export default function Knowledge({ token, onViewChange }: KnowledgePageProps) {
  const toast = useToast();
  const [kbList, setKbList] = useState<KnowledgeBase[]>([]);
  const [selectedKbId, setSelectedKbId] = useState<string | undefined>();
  const [kbDocuments, setKbDocuments] = useState<KbDocument[]>([]);
  const [kbNewName, setKbNewName] = useState("");
  const [kbNewDescription, setKbNewDescription] = useState("");
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const folderInputRef = useRef<HTMLInputElement | null>(null);
  const [kbUploadFiles, setKbUploadFiles] = useState<readonly File[]>([]);
  const [kbUploadProgress, setKbUploadProgress] = useState(0);
  const [kbUploadFailures, setKbUploadFailures] = useState<readonly string[]>([]);
  const [uploadingKbFiles, setUploadingKbFiles] = useState(false);
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);

  const formatBytes = (bytes: number) => {
    if (bytes === 0) return "0 B";
    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + " " + sizes[i];
  };

  const getStatusPill = (status: string) => {
    const statusMap: Record<string, { bg: string; text: string; icon: string }> = {
      indexed: { bg: "bg-brand-soft", text: "text-brand-ink", icon: "mdi:check-circle" },
      indexing: { bg: "bg-warning/10", text: "text-warning-ink", icon: "mdi:loading" },
      failed: { bg: "bg-danger/10", text: "text-danger-ink", icon: "mdi:alert-circle" },
      pending: { bg: "bg-surface-subtle", text: "text-ink-secondary", icon: "mdi:clock-outline" },
    };
    const config = statusMap[status] || statusMap.pending;
    return config;
  };

  const handleLoadKbs = async () => {
    try {
      setMessage("");
      setLoading(true);
      const kbs = await listKb(token);
      setKbList(kbs);
    } catch (err) {
      setMessage(`加载知识库失败: ${err instanceof Error ? err.message : "未知错误"}`);
    } finally {
      setLoading(false);
    }
  };

  const handleCreateKb = async () => {
    try {
      setMessage("");
      if (!kbNewName.trim()) {
        toast.show("err", "知识库名称不能为空");
        return;
      }
      await createKb(token, kbNewName, kbNewDescription);
      setKbNewName("");
      setKbNewDescription("");
      setSelectedKbId(undefined);
      await handleLoadKbs();
      toast.show("ok", "创建成功");
    } catch (err) {
      toast.show("err", `创建失败: ${err instanceof Error ? err.message : "未知错误"}`);
    }
  };

  const handleRenameKb = async (id: string) => {
    try {
      setMessage("");
      if (!kbNewName.trim()) {
        toast.show("err", "知识库名称不能为空");
        return;
      }
      await renameKb(token, id, kbNewName, kbNewDescription);
      setKbNewName("");
      setKbNewDescription("");
      setSelectedKbId(undefined);
      await handleLoadKbs();
      toast.show("ok", "更新成功");
    } catch (err) {
      toast.show("err", `更新失败: ${err instanceof Error ? err.message : "未知错误"}`);
    }
  };

  const handleDeleteKb = async (id: string) => {
    try {
      setMessage("");
      await deleteKb(token, id);
      setSelectedKbId(undefined);
      await handleLoadKbs();
      toast.show("ok", "删除成功");
    } catch (err) {
      toast.show("err", `删除失败: ${err instanceof Error ? err.message : "未知错误"}`);
    }
  };

  const resetKbUploadState = () => {
    setKbUploadFiles([]);
    setKbUploadProgress(0);
    setKbUploadFailures([]);
    if (fileInputRef.current) fileInputRef.current.value = "";
    if (folderInputRef.current) folderInputRef.current.value = "";
  };

  const handleSelectKb = async (kb: KnowledgeBase) => {
    try {
      setMessage("");
      setSelectedKbId(kb.id);
      resetKbUploadState();
      if (kb.ownerType === "OFFICIAL") {
        setKbDocuments([]);
        return;
      }
      const docs = await listKbDocuments(token, kb.id);
      setKbDocuments(docs);
    } catch (err) {
      toast.show("err", `加载文档失败: ${err instanceof Error ? err.message : "未知错误"}`);
    }
  };

  const handlePollDocument = async (kbId: string, docId: string) => {
    const poll = async () => {
      try {
        const doc = await getKbDocument(token, kbId, docId);
        setKbDocuments((prev) =>
          prev.map((d) => (d.id === docId ? doc : d))
        );
        if (doc.status !== "indexed" && doc.status !== "failed") {
          setTimeout(poll, 3000);
        }
      } catch {
        // 忽略轮询错误
      }
    };
    poll();
  };

  const handleSelectUploadFiles = (files: FileList | null) => {
    setKbUploadFiles(Array.from(files ?? []));
    setKbUploadProgress(0);
    setKbUploadFailures([]);
  };

  const handleUploadFiles = async () => {
    if (!selectedKbId) {
      toast.show("err", "请先选择知识库");
      return;
    }
    if (kbUploadFiles.length === 0) {
      toast.show("err", "请选择文件或文件夹");
      return;
    }
    try {
      setMessage("");
      setUploadingKbFiles(true);
      setKbUploadProgress(0);
      setKbUploadFailures([]);
      const failures: string[] = [];
      const createdDocIds: string[] = [];

      for (const file of kbUploadFiles) {
        try {
          const doc = await addKbFile(token, selectedKbId, file);
          createdDocIds.push(doc.id);
        } catch (err) {
          failures.push(`${file.name}: ${err instanceof Error ? err.message : "未知错误"}`);
        } finally {
          setKbUploadProgress((value) => value + 1);
        }
      }

      const docs = await listKbDocuments(token, selectedKbId);
      setKbDocuments(docs);
      for (const docId of createdDocIds) {
        handlePollDocument(selectedKbId, docId);
      }
      setKbUploadFailures(failures);
      if (failures.length === 0) {
        resetKbUploadState();
        toast.show("ok", "文件已提交，正在向量化处理");
      } else {
        toast.show("err", `已提交 ${createdDocIds.length} 个，失败 ${failures.length} 个`);
      }
    } catch (err) {
      toast.show("err", `上传失败: ${err instanceof Error ? err.message : "未知错误"}`);
    } finally {
      setUploadingKbFiles(false);
    }
  };

  const handleDeleteDocument = async (kbId: string, docId: string) => {
    try {
      setMessage("");
      await deleteKbDocument(token, kbId, docId);
      setKbDocuments((prev) => prev.filter((d) => d.id !== docId));
      toast.show("ok", "删除成功");
    } catch (err) {
      toast.show("err", `删除失败: ${err instanceof Error ? err.message : "未知错误"}`);
    }
  };

  useEffect(() => {
    handleLoadKbs();
  }, []);

  useEffect(() => {
    folderInputRef.current?.setAttribute("webkitdirectory", "");
    folderInputRef.current?.setAttribute("directory", "");
  }, [selectedKbId]);

  const myKbs = kbList.filter((kb) => kb.ownerType !== "OFFICIAL");
  const officialKbs = kbList.filter((kb) => kb.ownerType === "OFFICIAL");
  const selectedKb = kbList.find((kb) => kb.id === selectedKbId);
  const isOfficialKb = selectedKb?.ownerType === "OFFICIAL";
  const fileAccept = [
    ".txt",
    ".md",
    ".markdown",
    ".json",
    ".xml",
    ".yaml",
    ".yml",
    ".csv",
    ".log",
    ".pdf",
    ".docx",
    ".xlsx",
    ".xls",
    ".pptx",
  ].join(",");

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-ink">知识库</h1>
        <button
          onClick={() => onViewChange("chat")}
          className="px-4 py-2 text-sm font-medium text-ink bg-surface border border-hairline-subtle rounded-lg "
        >
          返回对话
        </button>
      </div>

      <div className="grid grid-cols-12 gap-6">
        {/* Left panel: Create KB & List */}
        <div className="col-span-5 space-y-6">
          {/* Create KB form */}
          <div className="glass-card p-6 rounded-xl space-y-4">
            <h3 className="text-sm font-bold text-ink uppercase tracking-wider">新建知识库</h3>
            <div className="space-y-3">
              <input
                placeholder="知识库名称"
                value={kbNewName}
                onChange={(e) => setKbNewName(e.target.value)}
                className="w-full px-4 py-2.5 bg-surface border border-hairline-subtle rounded-lg focus:outline-none focus:ring-2 focus:ring-brand/20 text-sm placeholder:text-ink-tertiary"
              />
              <textarea
                placeholder="描述（可选）"
                value={kbNewDescription}
                onChange={(e) => setKbNewDescription(e.target.value)}
                className="w-full px-4 py-2.5 bg-surface border border-hairline-subtle rounded-lg focus:outline-none focus:ring-2 focus:ring-brand/20 text-sm placeholder:text-ink-tertiary resize-none"
                rows={3}
              />
              <RippleButton
                onClick={handleCreateKb}
                disabled={loading}
                className="w-full px-4 py-2.5 bg-brand text-white font-semibold rounded-lg disabled:bg-hairline disabled:text-ink-tertiary transition-colors flex items-center justify-center gap-2"
              >
                <Icon icon="mdi:plus" className="text-lg" aria-hidden />
                创建
              </RippleButton>
            </div>
          </div>

          {/* My KBs */}
          <div className="glass-card p-6 rounded-xl space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-bold text-ink uppercase tracking-wider">我的知识库</h3>
              <button
                onClick={handleLoadKbs}
                disabled={loading}
                className="p-1 text-ink-secondary disabled:text-ink-tertiary"
              >
                <Icon icon="mdi:refresh" className="text-lg" aria-hidden />
              </button>
            </div>
            <div className="space-y-2 max-h-96 overflow-y-auto">
              {myKbs.length === 0 ? (
                <p className="text-sm text-ink-secondary text-center py-4">暂无知识库</p>
              ) : (
                myKbs.map((kb) => (
                  <div
                    key={kb.id}
                    onClick={() => handleSelectKb(kb)}
                    className={`p-4 rounded-lg border cursor-pointer transition-all ${
                      selectedKbId === kb.id
                        ? "bg-brand-soft border-brand-soft"
                        : "bg-surface border-hairline-subtle "
                    }`}
                  >
                    <div className="flex items-start justify-between gap-2 mb-2">
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-semibold text-ink truncate">{kb.name}</p>
                        {kb.description && (
                          <p className="text-xs text-ink-secondary line-clamp-1 mt-1">{kb.description}</p>
                        )}
                        <p className="text-xs text-brand-ink mt-2">
                          已建立知识晶格数量：{kb.latticeCount ?? 0}
                        </p>
                      </div>
                    </div>
                    <div className="flex gap-2">
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          setKbNewName(kb.name);
                          setKbNewDescription(kb.description || "");
                          setSelectedKbId(kb.id);
                        }}
                        className="text-xs px-2 py-1.5 font-medium bg-surface-muted text-ink rounded transition-colors"
                      >
                        编辑
                      </button>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          handleDeleteKb(kb.id);
                        }}
                        className="text-xs px-2 py-1.5 font-medium bg-danger/10 text-danger-ink rounded transition-colors"
                      >
                        删除
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>

          {/* Official KBs */}
          <div className="glass-card p-6 rounded-xl space-y-4">
            <h3 className="text-sm font-bold text-ink uppercase tracking-wider">官方知识库</h3>
            <div className="space-y-2 max-h-48 overflow-y-auto">
              {officialKbs.length === 0 ? (
                <p className="text-sm text-ink-secondary text-center py-4">暂无官方库</p>
              ) : (
                officialKbs.map((kb) => (
                  <div
                    key={kb.id}
                    onClick={() => handleSelectKb(kb)}
                    className={`p-4 rounded-lg border cursor-pointer transition-all ${
                      selectedKbId === kb.id
                        ? "bg-brand-soft border-brand-soft"
                        : "bg-surface border-hairline-subtle "
                    }`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1">
                          <p className="text-sm font-semibold text-ink truncate">{kb.name}</p>
                          <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-info/15 text-info-ink">
                            官方
                          </span>
                        </div>
                        {kb.description && (
                          <p className="text-xs text-ink-secondary line-clamp-1 mt-1">{kb.description}</p>
                        )}
                        <p className="text-xs text-brand-ink mt-2">
                          已建立知识晶格数量：{kb.latticeCount ?? 0}
                        </p>
                      </div>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>

        {/* Right panel: KB Details & Documents */}
        <div className="col-span-7">
          {selectedKb ? (
            <div className="space-y-6">
              {/* KB Info */}
              <div className="glass-card p-6 rounded-xl space-y-4">
                <h2 className="text-lg font-bold text-ink">{selectedKb.name}</h2>
                {selectedKb.description && (
                  <p className="text-sm text-ink-secondary leading-relaxed">{selectedKb.description}</p>
                )}

                {!isOfficialKb && (
                  <div className="pt-4 space-y-4">
                    <div className="grid gap-3 sm:grid-cols-2">
                      <label className="block rounded-lg border border-hairline-subtle bg-surface p-4 text-sm">
                        <span className="mb-2 flex items-center gap-2 font-semibold text-ink">
                          <Icon icon="mdi:file-upload-outline" className="text-lg text-brand" aria-hidden />
                          批量选择文件
                        </span>
                        <input
                          ref={fileInputRef}
                          type="file"
                          multiple
                          accept={fileAccept}
                          onChange={(e) => handleSelectUploadFiles(e.currentTarget.files)}
                          className="w-full text-xs file:mr-3 file:rounded-lg file:border-0 file:bg-surface-muted file:px-3 file:py-2 file:text-xs file:font-medium file:text-ink "
                          disabled={uploadingKbFiles}
                        />
                      </label>
                      <label className="block rounded-lg border border-hairline-subtle bg-surface p-4 text-sm">
                        <span className="mb-2 flex items-center gap-2 font-semibold text-ink">
                          <Icon icon="mdi:folder-upload-outline" className="text-lg text-brand" aria-hidden />
                          一次选择文件夹
                        </span>
                        <input
                          ref={folderInputRef}
                          type="file"
                          multiple
                          onChange={(e) => handleSelectUploadFiles(e.currentTarget.files)}
                          className="w-full text-xs file:mr-3 file:rounded-lg file:border-0 file:bg-surface-muted file:px-3 file:py-2 file:text-xs file:font-medium file:text-ink "
                          disabled={uploadingKbFiles}
                        />
                      </label>
                    </div>
                    <p className="text-xs leading-5 text-ink-secondary">
                      支持 PDF、DOCX、XLS/XLSX、PPTX、CSV、TXT、MD、JSON、XML、YAML、LOG 等格式。文件会逐个提交并自动进入向量化处理。
                    </p>
                    {kbUploadFiles.length > 0 && (
                      <div className="rounded-lg border border-hairline-subtle bg-surface-subtle p-3">
                        <p className="text-sm font-semibold text-ink">已选择 {kbUploadFiles.length} 个文件</p>
                        <div className="mt-2 space-y-1">
                          {kbUploadFiles.slice(0, 5).map((file) => (
                            <p key={`${file.name}-${file.size}`} className="truncate text-xs text-ink-secondary">
                              {file.name}
                            </p>
                          ))}
                          {kbUploadFiles.length > 5 && (
                            <p className="text-xs text-ink-tertiary">还有 {kbUploadFiles.length - 5} 个文件</p>
                          )}
                        </div>
                      </div>
                    )}
                    {kbUploadFailures.length > 0 && (
                      <div className="rounded-lg border border-danger/20 bg-danger/10 p-3">
                        <p className="text-sm font-semibold text-danger-ink">失败 {kbUploadFailures.length} 个</p>
                        <div className="mt-2 space-y-1">
                          {kbUploadFailures.slice(0, 5).map((failure) => (
                            <p key={failure} className="truncate text-xs text-danger-ink">
                              {failure}
                            </p>
                          ))}
                        </div>
                      </div>
                    )}
                    <RippleButton
                      onClick={handleUploadFiles}
                      disabled={uploadingKbFiles || kbUploadFiles.length === 0}
                      className="w-full px-4 py-2.5 bg-brand text-white font-semibold rounded-lg disabled:bg-hairline disabled:text-ink-tertiary transition-colors flex items-center justify-center gap-2"
                    >
                      <Icon icon="mdi:upload" className="text-lg" aria-hidden />
                      {uploadingKbFiles ? `上传中 ${kbUploadProgress}/${kbUploadFiles.length}` : "上传并向量化"}
                    </RippleButton>
                  </div>
                )}
                {isOfficialKb && (
                  <div className="rounded-lg border border-brand/10 bg-brand-soft p-4">
                    <p className="text-sm font-semibold text-brand-ink">官方知识库</p>
                    <p className="mt-1 text-sm leading-6 text-ink-secondary">
                      已建立知识晶格数量：{selectedKb.latticeCount ?? 0}
                    </p>
                  </div>
                )}
              </div>

              {!isOfficialKb && (
                <div className="glass-card p-6 rounded-xl space-y-4">
                  <h3 className="text-sm font-bold text-ink uppercase tracking-wider">文档列表</h3>
                  {kbDocuments.length === 0 ? (
                    <p className="text-sm text-ink-secondary text-center py-8">暂无文档</p>
                  ) : (
                    <Stagger className="space-y-3 max-h-96 overflow-y-auto">
                      {kbDocuments.map((doc) => {
                        const statusConfig = getStatusPill(doc.status);
                        return (
                          <StaggerItem
                            key={doc.id}
                            className="p-4 bg-surface-subtle border border-hairline-subtle rounded-lg space-y-3"
                          >
                            <div className="flex items-start justify-between gap-2">
                              <div className="flex-1 min-w-0">
                                <p className="text-sm font-semibold text-ink truncate">{doc.name}</p>
                                <div className="flex items-center gap-2 mt-2">
                                  <span className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-semibold ${statusConfig.bg} ${statusConfig.text}`}>
                                    <Icon
                                      icon={statusConfig.icon}
                                      className={`text-sm ${doc.status === "indexing" ? "animate-spin" : ""}`}
                                      aria-hidden
                                    />
                                    {doc.status === "indexed" && "已建立知识晶格链接"}
                                    {doc.status === "indexing" && "索引中"}
                                    {doc.status === "failed" && "失败"}
                                    {doc.status === "pending" && "待处理"}
                                  </span>
                                </div>
                              </div>
                              <button
                                onClick={() => selectedKbId && handleDeleteDocument(selectedKbId, doc.id)}
                                className="inline-flex flex-none items-center gap-1 rounded-lg border border-danger/20 bg-surface px-2.5 py-1.5 text-xs font-medium text-danger-ink transition-colors"
                                title="删除文档"
                              >
                                <Icon icon="mdi:trash-outline" className="text-base" aria-hidden />
                                删除
                              </button>
                            </div>

                            <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-ink-secondary">
                              <span className="flex items-center gap-1">
                                <Icon icon="mdi:file-document" className="text-sm" aria-hidden />
                                {formatBytes(doc.sizeBytes)}
                              </span>
                              <span className="flex items-center gap-1">
                                <Icon icon="mdi:layers" className="text-sm" aria-hidden />
                                已链接晶格数量：{doc.chunkCount}
                              </span>
                              <span className="text-ink-tertiary">
                                {new Date(doc.createdAt).toLocaleDateString("zh-CN")}
                              </span>
                              {doc.sourceUri && (
                                <a
                                  href={doc.sourceUri}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="font-medium text-brand-ink "
                                >
                                  打开产物
                                </a>
                              )}
                            </div>

                            {doc.error && (
                              <p className="text-xs text-danger-ink bg-danger/10 px-2.5 py-1.5 rounded">
                                错误: {doc.error}
                              </p>
                            )}
                          </StaggerItem>
                        );
                      })}
                    </Stagger>
                  )}
                </div>
              )}
            </div>
          ) : (
            <div className="glass-card p-12 rounded-xl text-center">
              <Icon icon="mdi:folder-open-outline" className="text-5xl text-ink-tertiary mx-auto mb-4" aria-hidden />
              <p className="text-lg font-semibold text-ink-secondary">选择一个知识库查看文档</p>
              <p className="text-sm text-ink-secondary mt-2">点击左侧知识库开始</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
