import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ToastProvider } from "../../motion/Toast";
import { LocalBusinessPromoWorkflowStudio } from "./LocalBusinessPromoWorkflowStudio";
import {
  LOCAL_BUSINESS_PROMO_FALLBACK_OPTIONS,
  createDefaultLocalBusinessPromoSettings,
  createEmptyLocalBusinessPromoAudioState,
  createEmptyLocalBusinessPromoBrief,
  createEmptyLocalBusinessPromoMaterials,
} from "./localBusinessPromoWorkflowModel";

function renderStudio() {
  return renderToStaticMarkup(
    <ToastProvider>
      <LocalBusinessPromoWorkflowStudio
        token="token"
        initialOptions={LOCAL_BUSINESS_PROMO_FALLBACK_OPTIONS}
        initialProjects={[{
          id: "project-1",
          title: "禾木咖啡",
          status: "draft",
          latestRunId: null,
          materialCount: 1,
          createdAt: "2026-07-07T08:00:00.000Z",
          updatedAt: "2026-07-07T08:00:00.000Z",
        }]}
        initialProject={{
          id: "project-1",
          title: "禾木咖啡",
          brief: {
            ...createEmptyLocalBusinessPromoBrief(),
            storeName: "禾木咖啡",
            industry: "精品咖啡",
            cityArea: "上海静安",
            targetCustomers: "周边白领",
            mainOffer: "招牌拿铁",
            sellingPoints: "稳定出品",
          },
          materials: {
            ...createEmptyLocalBusinessPromoMaterials(),
            opening: [{ url: "https://example.test/opening.mp4", mime: "video/mp4", name: "门头", durationSec: 8 }],
          },
          settings: createDefaultLocalBusinessPromoSettings(),
          scriptDraft: "第一行\n第二行\n第三行",
          latestRunId: null,
          status: "draft",
          createdAt: "2026-07-07T08:00:00.000Z",
          updatedAt: "2026-07-07T08:00:00.000Z",
        }}
        initialLatestRun={null}
        initialRuns={[]}
        initialAudioState={createEmptyLocalBusinessPromoAudioState()}
        initialBootstrapping={false}
      />
    </ToastProvider>,
  );
}

function renderGeneratingStudioWithoutRun() {
  return renderToStaticMarkup(
    <ToastProvider>
      <LocalBusinessPromoWorkflowStudio
        token="token"
        initialOptions={LOCAL_BUSINESS_PROMO_FALLBACK_OPTIONS}
        initialProjects={[{
          id: "project-1",
          title: "禾木咖啡",
          status: "generating",
          latestRunId: null,
          materialCount: 1,
          createdAt: "2026-07-07T08:00:00.000Z",
          updatedAt: "2026-07-07T08:00:10.000Z",
        }]}
        initialProject={{
          id: "project-1",
          title: "禾木咖啡",
          brief: {
            ...createEmptyLocalBusinessPromoBrief(),
            storeName: "禾木咖啡",
            industry: "精品咖啡",
            cityArea: "上海静安",
            targetCustomers: "周边白领",
            mainOffer: "招牌拿铁",
            sellingPoints: "稳定出品",
          },
          materials: {
            ...createEmptyLocalBusinessPromoMaterials(),
            opening: [{ url: "https://example.test/opening.mp4", mime: "video/mp4", name: "门头", durationSec: 8 }],
          },
          settings: createDefaultLocalBusinessPromoSettings(),
          scriptDraft: "第一行\n第二行\n第三行",
          latestRunId: null,
          status: "generating",
          createdAt: "2026-07-07T08:00:00.000Z",
          updatedAt: "2026-07-07T08:00:10.000Z",
        }}
        initialLatestRun={null}
        initialRuns={[]}
        initialAudioState={createEmptyLocalBusinessPromoAudioState()}
        initialBootstrapping={false}
      />
    </ToastProvider>,
  );
}

function renderProjectList() {
  return renderToStaticMarkup(
    <ToastProvider>
      <LocalBusinessPromoWorkflowStudio
        token="token"
        initialOptions={LOCAL_BUSINESS_PROMO_FALLBACK_OPTIONS}
        initialProjects={[{
          id: "project-1",
          title: "禾木咖啡",
          status: "draft",
          latestRunId: null,
          materialCount: 1,
          createdAt: "2026-07-07T08:00:00.000Z",
          updatedAt: "2026-07-07T08:00:00.000Z",
        }]}
        initialBootstrapping={false}
      />
    </ToastProvider>,
  );
}

describe("LocalBusinessPromoWorkflowStudio", () => {
  it("renders the project list entry page before the studio", () => {
    const html = renderProjectList();

    expect(html).toContain("本地商家宣传项目");
    expect(html).toContain("进入工作台");
    expect(html).toContain("新建项目");
  });

  it("keeps narration mode options and adds the optimized bgm controls", () => {
    const html = renderStudio();

    expect(html).toContain("旁白语音");
    expect(html).toContain("BGM");
    expect(html).toContain("预制音色");
    expect(html).toContain("文本定制音色");
    expect(html).toContain("音频复刻音色");
    expect(html).toContain("项目列表");
    expect(html).toContain("口播历史版本");
    expect(html).toContain("预制库");
    expect(html).toContain("上传 BGM");
    expect(html).toContain("不使用");
    expect(html).toContain("设为当前 BGM");
    expect(html).toContain("生成正式口播");
    expect(html).toContain("overflow-x-auto");
    expect(html).toContain("min-w-[1244px]");
    expect(html).toContain("VV·女声·自然亲切");
    expect(html).toContain("MiMo 预置音色：冰糖");
  });

  it("shows a startup message when the project is generating but the run record is not ready yet", () => {
    const html = renderGeneratingStudioWithoutRun();

    expect(html).toContain("任务正在启动，等待运行记录同步。若长时间没有出现，请刷新后重试。");
  });
});
