package recon

import (
	"testing"
	"time"

	"ai-assistant-billing/internal/bucket"
	"ai-assistant-billing/internal/model"
	"ai-assistant-billing/internal/pgtest"
	"ai-assistant-billing/internal/store"
	"ai-assistant-billing/internal/vip"
	"ai-assistant-billing/internal/wallet"
)

func newTestStore(t *testing.T) *store.Store {
	dsn := pgtest.DSN()
	st, err := store.Open(dsn)
	if err != nil {
		t.Skipf("billing-postgres 不可用，跳过: %v", err)
	}
	pgtest.Serialize(t, st.DB)
	if err := st.DB.Exec("TRUNCATE vip_growth_ledgers, user_vip_states, vip_levels, point_buckets, usage_records, accounts CASCADE").Error; err != nil {
		t.Fatalf("truncate failed: %v", err)
	}
	if err := vip.New(st.DB).EnsureDefaultLevels(100); err != nil {
		t.Fatalf("EnsureDefaultLevels failed: %v", err)
	}
	return st
}

func seed(st *store.Store, userID string, balance int64) {
	_ = bucket.GrantPoints(st.DB, userID, balance, nil, "test")
}

func balanceOf(st *store.Store, id string) int64 {
	b, _ := bucket.Balance(st.DB, id)
	return b
}

func TestReconcileStaleRefunds(t *testing.T) {
	st := newTestStore(t)
	w := wallet.New(st)
	seed(st, "u1", 1000)
	// 预留 300，余额应为 700
	_, err := w.Reserve("stale", "u1", "chat", "m", 300)
	if err != nil {
		t.Fatal(err)
	}
	if balanceOf(st, "u1") != 700 {
		t.Fatalf("reserve 后应 700, got %d", balanceOf(st, "u1"))
	}
	// 手动把 created_at 改早（超过 10 分钟）
	st.DB.Model(&model.UsageRecord{}).Where("operation_id = ?", "stale").
		Update("created_at", time.Now().Add(-11*time.Minute))
	// 对账：扫描 10 分钟以上的超时预留，全额退回（actual=0）
	n := Reconcile(st, w, 10*time.Minute)
	if n != 1 {
		t.Fatalf("should reconcile 1 stale record, got %d", n)
	}
	// 余额应恢复到 1000（完全退回预扣）
	finalBal := balanceOf(st, "u1")
	if finalBal != 1000 {
		t.Fatalf("超时预留应全额退回, want 1000 got %d", finalBal)
	}
	// 记录状态应为 "refunded"
	var rec model.UsageRecord
	st.DB.First(&rec, "operation_id = ?", "stale")
	if rec.Status != "settled" { // Settle 将其改为 settled，actual=0 = refund
		t.Fatalf("status should be settled, got %s", rec.Status)
	}
	if rec.ActualPoints != 0 {
		t.Fatalf("actual should be 0 (refund), got %d", rec.ActualPoints)
	}
}

func TestReconcileDoesNotTouchRecentReserved(t *testing.T) {
	st := newTestStore(t)
	w := wallet.New(st)
	seed(st, "u1", 1000)
	// 创建一条新的预留
	_, err := w.Reserve("recent", "u1", "chat", "m", 200)
	if err != nil {
		t.Fatal(err)
	}
	if balanceOf(st, "u1") != 800 {
		t.Fatalf("reserve 后应 800, got %d", balanceOf(st, "u1"))
	}
	// 对账（10分钟超时）不应该动到这条刚创建的记录
	n := Reconcile(st, w, 10*time.Minute)
	if n != 0 {
		t.Fatalf("should not reconcile recent records, got %d", n)
	}
	// 余额应保持 800
	if balanceOf(st, "u1") != 800 {
		t.Fatalf("balance should remain 800, got %d", balanceOf(st, "u1"))
	}
	// 记录状态应仍为 "reserved"
	var rec model.UsageRecord
	st.DB.First(&rec, "operation_id = ?", "recent")
	if rec.Status != "reserved" {
		t.Fatalf("status should remain reserved, got %s", rec.Status)
	}
}

func TestReconcileMultipleStaleRecords(t *testing.T) {
	st := newTestStore(t)
	w := wallet.New(st)
	seed(st, "u2", 5000)
	// 创建 3 条旧预留
	for i := 0; i < 3; i++ {
		opID := "stale" + string(rune('a'+i))
		_, err := w.Reserve(opID, "u2", "chat", "m", 400)
		if err != nil {
			t.Fatal(err)
		}
		// 标记为过期
		st.DB.Model(&model.UsageRecord{}).Where("operation_id = ?", opID).
			Update("created_at", time.Now().Add(-15*time.Minute))
	}
	// 余额应为 5000 - 3*400 = 3800
	if balanceOf(st, "u2") != 3800 {
		t.Fatalf("after 3 reserves, balance should be 3800, got %d", balanceOf(st, "u2"))
	}
	// 对账
	n := Reconcile(st, w, 10*time.Minute)
	if n != 3 {
		t.Fatalf("should reconcile 3 stale records, got %d", n)
	}
	// 余额应恢复到 5000
	if balanceOf(st, "u2") != 5000 {
		t.Fatalf("all stale reserves should be refunded, balance should be 5000, got %d", balanceOf(st, "u2"))
	}
}

// 声明了有效期且尚未到期的预留，即使早于全局 TTL 也不能被兜底关账：
// 关掉调用方仍合法持有的预留 = 之后的真实用量全部按 0 静默结算。
func TestReconcileKeepsUnexpiredDeclaredReservation(t *testing.T) {
	st := newTestStore(t)
	w := wallet.New(st)
	seed(st, "u3", 3000)
	deadline := time.Now().Add(2 * time.Hour)
	if _, err := w.ReservePricedUntil("longrun", "u3", "chat", "m", 800, &deadline); err != nil {
		t.Fatal(err)
	}
	// 创建时间远早于 10 分钟 TTL，但预留自己声明了 2 小时有效期
	st.DB.Model(&model.UsageRecord{}).Where("operation_id = ?", "longrun").
		Update("created_at", time.Now().Add(-3*time.Hour))

	n := Reconcile(st, w, 10*time.Minute)
	if n != 0 {
		t.Fatalf("未到期的声明式预留不应被回收, got %d", n)
	}
	if balanceOf(st, "u3") != 2200 {
		t.Fatalf("余额应保持 2200（预留仍持有）, got %d", balanceOf(st, "u3"))
	}
	var rec model.UsageRecord
	st.DB.First(&rec, "operation_id = ?", "longrun")
	if rec.Status != "reserved" {
		t.Fatalf("状态应仍为 reserved, got %s", rec.Status)
	}
	if rec.ReservationExpiresAt == nil {
		t.Fatal("reservation_expires_at 应被持久化")
	}
}

// 声明的有效期一过，兜底仍要收尸（否则预留会永久挂住余额）。
func TestReconcileReclaimsExpiredDeclaredReservation(t *testing.T) {
	st := newTestStore(t)
	w := wallet.New(st)
	seed(st, "u4", 3000)
	deadline := time.Now().Add(-time.Minute)
	if _, err := w.ReservePricedUntil("expired", "u4", "chat", "m", 800, &deadline); err != nil {
		t.Fatal(err)
	}
	if balanceOf(st, "u4") != 2200 {
		t.Fatalf("reserve 后应 2200, got %d", balanceOf(st, "u4"))
	}

	// created_at 是刚才（未过全局 TTL），只有声明的有效期过了
	n := Reconcile(st, w, 10*time.Minute)
	if n != 1 {
		t.Fatalf("已过期的声明式预留应被回收 1 条, got %d", n)
	}
	if balanceOf(st, "u4") != 3000 {
		t.Fatalf("过期预留应全额退回, want 3000 got %d", balanceOf(st, "u4"))
	}
	var rec model.UsageRecord
	st.DB.First(&rec, "operation_id = ?", "expired")
	if rec.Status != "settled" || rec.ActualPoints != 0 {
		t.Fatalf("应按 actual=0 关账, got status=%s actual=%d", rec.Status, rec.ActualPoints)
	}
}
