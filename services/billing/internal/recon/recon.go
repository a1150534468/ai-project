package recon

import (
	"time"

	"yc-billing/internal/model"
	"yc-billing/internal/store"
	"yc-billing/internal/wallet"
)

// Reconcile 扫描超时未结算的 reserved 记录，按实际=0 结算（全额退回预扣）
// 返回成功对账的记录数
func Reconcile(st *store.Store, w *wallet.Wallet, ttl time.Duration) int {
	var stale []model.UsageRecord
	st.DB.Where("status = ? AND created_at < ?", "reserved", time.Now().Add(-ttl)).Find(&stale)
	n := 0
	for _, r := range stale {
		if err := w.Settle(r.OperationID, 0); err == nil {
			n++
		}
	}
	return n
}
