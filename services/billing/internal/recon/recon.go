package recon

import (
	"time"

	"ai-assistant-billing/internal/model"
	"ai-assistant-billing/internal/store"
	"ai-assistant-billing/internal/wallet"
)

// Reconcile 扫描超时未结算的 reserved 记录，按实际=0 结算（全额退回预扣）
// 返回成功对账的记录数
//
// ttl 只是「没有声明有效期」的预留的默认口径。预留本身声明了
// reservation_expires_at 时以它为准：兜底只回收真正过期的预留，绝不去关一笔
// 调用方仍合法持有的预留——那会让调用方后续的真实用量全部免费结算（settle 遇到
// 非 reserved 记录静默返回 0），是一次无人报错的漏计费。
func Reconcile(st *store.Store, w *wallet.Wallet, ttl time.Duration) int {
	var stale []model.UsageRecord
	now := time.Now()
	st.DB.Where(
		"status = ? AND ((reservation_expires_at IS NULL AND created_at < ?) OR (reservation_expires_at IS NOT NULL AND reservation_expires_at < ?))",
		"reserved", now.Add(-ttl), now,
	).Find(&stale)
	n := 0
	for _, r := range stale {
		if err := w.Settle(r.OperationID, 0); err == nil {
			n++
		}
	}
	return n
}
