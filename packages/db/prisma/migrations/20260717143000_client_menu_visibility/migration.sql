CREATE TABLE "ClientMenuVisibility" (
    "key" TEXT NOT NULL,
    "visible" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClientMenuVisibility_pkey" PRIMARY KEY ("key")
);

-- 截图中暂时不对用户开放的工作流入口。
INSERT INTO "ClientMenuVisibility" ("key", "visible", "updatedAt") VALUES
    ('workflow.report', false, CURRENT_TIMESTAMP),
    ('workflow.fanout', false, CURRENT_TIMESTAMP),
    ('workflow.article-workflow', false, CURRENT_TIMESTAMP),
    ('workflow.local-business-promo', false, CURRENT_TIMESTAMP),
    ('workflow.ai-comic', false, CURRENT_TIMESTAMP),
    ('workflow.scheduled-task', false, CURRENT_TIMESTAMP),
    ('workflow.ppt', false, CURRENT_TIMESTAMP);
