/**
 * 素材库页面：数据编排 + 取件弹窗。展示全在 `components/assets/AssetLibraryView.tsx`。
 *
 * 两件容易写错的事在这里处理掉：
 *  - **换分区/换筛选要重置游标**。素材库的游标是键集 `(createdAt, id)`，换了筛选条件之后
 *    旧游标解出来的位置在新序列里没有意义，必须从第一页重来。
 *  - **过期响应不许落地**。切 Tab 比请求快时，先发的请求可能后到；这里用一个自增的
 *    `requestSeq` 认领响应，不是当前那次的直接丢。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { errorMessage } from "../apiError";
import { AssetLibraryView } from "../components/assets/AssetLibraryView";
import { DownloadLinkDialog, type DownloadDialogState } from "../components/ui/DownloadLinkDialog";
import { useToast } from "../motion";
import { listAssets, type AssetItem, type AssetOrigin, type AssetSourceModule } from "../assetApi";
import { appendAssetPage, ASSET_MODULE_LABELS, EMPTY_ASSET_LIST, type AssetListState } from "../assetLibrary";

interface AssetsPageProps {
  readonly token: string;
}

/** 一页 30 条是服务端缺省值；显式传，避免哪天服务端调缺省把前端网格的节奏也改了。 */
const PAGE_SIZE = 30;

export default function Assets({ token }: AssetsPageProps) {
  const toast = useToast();
  const [origin, setOrigin] = useState<AssetOrigin>("ai");
  const [moduleFilter, setModuleFilter] = useState<AssetSourceModule | null>(null);
  const [list, setList] = useState<AssetListState>(EMPTY_ASSET_LIST);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const [dialog, setDialog] = useState<DownloadDialogState | null>(null);
  const requestSeq = useRef(0);

  const loadFirstPage = useCallback(async () => {
    const seq = requestSeq.current + 1;
    requestSeq.current = seq;
    setLoading(true);
    setLoadingMore(false);
    setError("");
    try {
      const page = await listAssets(token, { limit: PAGE_SIZE, origin, sourceModule: moduleFilter });
      if (requestSeq.current !== seq) return;
      setList(appendAssetPage(EMPTY_ASSET_LIST, page));
    } catch (err) {
      if (requestSeq.current !== seq) return;
      setList(EMPTY_ASSET_LIST);
      setError(errorMessage(err, "获取素材库失败"));
    } finally {
      if (requestSeq.current === seq) setLoading(false);
    }
  }, [moduleFilter, origin, token]);

  useEffect(() => {
    void loadFirstPage();
  }, [loadFirstPage]);

  const handleLoadMore = async () => {
    if (!list.cursor || loadingMore) return;
    const seq = requestSeq.current;
    setLoadingMore(true);
    setError("");
    try {
      const page = await listAssets(token, { limit: PAGE_SIZE, origin, sourceModule: moduleFilter, cursor: list.cursor });
      // 期间换过筛选：这一页属于上一套条件，丢掉。
      if (requestSeq.current !== seq) return;
      setList((current) => appendAssetPage(current, page));
    } catch (err) {
      if (requestSeq.current !== seq) return;
      const message = errorMessage(err, "获取素材库失败");
      setError(message);
      toast.show("err", message);
    } finally {
      if (requestSeq.current === seq) setLoadingMore(false);
    }
  };

  const handleOpen = (item: AssetItem) => {
    if (!item.url) return;
    setDialog({
      title: item.title,
      links: [item.url],
      description: `${ASSET_MODULE_LABELS[item.sourceModule]}｜复制链接到浏览器地址栏打开后保存原文件。`,
      notice: "取件链接有有效期，过期后回到素材库重新获取即可。",
    });
  };

  return (
    <>
      <AssetLibraryView
        items={list.items}
        origin={origin}
        module={moduleFilter}
        loading={loading}
        loadingMore={loadingMore}
        hasMore={list.cursor !== null}
        error={error}
        onOriginChange={(next) => {
          if (next === origin) return;
          setOrigin(next);
          // 筛选项是按分区给的，换区之后旧的 module 可能在新区里根本不存在。
          setModuleFilter(null);
        }}
        onModuleChange={setModuleFilter}
        onLoadMore={() => void handleLoadMore()}
        onOpen={handleOpen}
        onRetry={() => void loadFirstPage()}
      />
      {dialog && <DownloadLinkDialog dialog={dialog} onClose={() => setDialog(null)} />}
    </>
  );
}
