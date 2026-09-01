-- 把 CodexPetImageCall 上那个退款索引改名到 Prisma 的默认命名，消掉 schema 与库之间
-- 唯一一处非噪音漂移。
--
-- 先说清楚漂移到底是什么，因为此前记错过一次：
--   * schema.prisma 写的是 @@index([refundStatus, createdAt])，无 map:，所以 Prisma
--     期望的索引名是 CodexPetImageCall_refundStatus_createdAt_idx。
--   * 20260730120000_codex_pet_failed_call_refund 手写的是
--     CREATE INDEX "CodexPetImageCall_refundStatus_idx" ON ... ("refundStatus", "createdAt")
--     —— **列和顺序完全正确，只有名字少了 createdAt 那一段**。
--   * 所以这是纯命名漂移，不是缺列。prisma migrate diff 报的也正是一句
--     RenameIndex（若真是单列索引，它会报 DROP + CREATE）。
--     2026-08-31 的知识库拆分计划里把它写成「实际只建了单列」，那句是错的，本次一并改正。
--
-- 执行前在本地库核对（2026-09-01）：
--   CodexPetImageCall_refundStatus_idx :: btree ("refundStatus", "createdAt")
-- 同表另外三个普通索引（projectId_createdAt / runId_status_createdAt / userId_createdAt）
-- 都已符合 Prisma 约定，就这一个是异类。
--
-- 为什么选改库名而不是给 schema 加 map:：全 schema 一个 map: 都没有，加一个就是引入
-- 一种此前不存在的写法，还得让后来人去解释它为什么在这儿；改名之后 schema 保持干净、
-- 同表命名一致。ALTER INDEX ... RENAME 只改系统目录，不重建索引、不动数据。
--
-- 顺带记一笔给下一个读到的人（本次不动）：这个索引当年是给「跨运行扫还欠着的退款」
-- 的 sweeper 建的（见原迁移注释），但现在 CodexPetImageCall 上所有读查询都带 runId
-- 前缀（call-ledger.ts:470 那个退款扫描也是 runId+projectId+userId 起头，走
-- runId_status_createdAt），没有一条以 refundStatus 领头。它今天大概率吃不到。
-- 要不要留是另一个决定，本次只修命名漂移，不替那个决定做主。

ALTER INDEX "CodexPetImageCall_refundStatus_idx"
  RENAME TO "CodexPetImageCall_refundStatus_createdAt_idx";
