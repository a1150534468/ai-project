package adjust

import (
	"testing"

	"yc-billing/internal/bucket"
	"yc-billing/internal/model"
	"yc-billing/internal/pgtest"
	"yc-billing/internal/store"
)

func newStore(t *testing.T) *store.Store {
	dsn := pgtest.DSN()
	st, err := store.Open(dsn)
	if err != nil {
		t.Skipf("billing-postgres 不可用: %v", err)
	}
	pgtest.Serialize(t, st.DB)
	st.DB.Exec("TRUNCATE point_buckets, balance_adjustments, video_point_accounts CASCADE")
	return st
}

func balance(st *store.Store, userID string) int64 {
	b, _ := bucket.Balance(st.DB, userID)
	return b
}

func TestAdjustIncrease(t *testing.T) {
	st := newStore(t)
	s := New(st)
	before, after, err := s.Adjust("adj1", "u1", 500, "充值补偿", "admin1")
	if err != nil {
		t.Fatalf("adjust: %v", err)
	}
	if before != 0 || after != 500 {
		t.Fatalf("want 0->500 got %d->%d", before, after)
	}
	// 验证桶存在且余额正确
	if bal := balance(st, "u1"); bal != 500 {
		t.Fatalf("bucket balance want 500 got %d", bal)
	}
}

func TestAdjustDecreaseInsufficient(t *testing.T) {
	st := newStore(t)
	s := New(st)
	bucket.GrantPoints(st.DB, "u2", 100, nil, "test")
	_, _, err := s.Adjust("adj2", "u2", -200, "扣减", "admin1")
	if err != ErrInsufficient {
		t.Fatalf("want ErrInsufficient got %v", err)
	}
	// 不足时不得写流水
	var n int64
	st.DB.Model(&model.BalanceAdjustment{}).Where("operation_id = ?", "adj2").Count(&n)
	if n != 0 {
		t.Fatalf("insufficient must not write ledger, got %d", n)
	}
	// 余额应不变
	if bal := balance(st, "u2"); bal != 100 {
		t.Fatalf("balance must not change on error, want 100 got %d", bal)
	}
}

func TestAdjustIdempotent(t *testing.T) {
	st := newStore(t)
	s := New(st)
	bucket.GrantPoints(st.DB, "u3", 100, nil, "test")
	_, after1, err := s.Adjust("adj3", "u3", 50, "x", "admin1")
	if err != nil {
		t.Fatalf("adjust1: %v", err)
	}
	_, after2, err := s.Adjust("adj3", "u3", 50, "x", "admin1") // 同 opID 重放
	if err != nil {
		t.Fatalf("adjust2: %v", err)
	}
	if after1 != 150 || after2 != 150 {
		t.Fatalf("idempotent want 150/150 got %d/%d", after1, after2)
	}
	// 验证桶余额不双计
	if bal := balance(st, "u3"); bal != 150 {
		t.Fatalf("balance must not double, want 150 got %d", bal)
	}
}

func TestAdjustLedgerMatchesBalance(t *testing.T) {
	st := newStore(t)
	s := New(st)
	bucket.GrantPoints(st.DB, "u4", 100, nil, "test")

	// 连续多笔调整：+50, -30, +80，验证每笔流水前后值与桶余额一致
	adjustments := []struct {
		opID   string
		delta  int64
		expect int64 // 调整后预期余额
	}{
		{"adj41", 50, 150},
		{"adj42", -30, 120},
		{"adj43", 80, 200},
	}

	var prevAfter int64 = 100 // 初始余额
	for _, adj := range adjustments {
		before, after, err := s.Adjust(adj.opID, "u4", adj.delta, "test", "admin1")
		if err != nil {
			t.Fatalf("adjust %s: %v", adj.opID, err)
		}
		// 本笔 before 应等于上一笔 after
		if before != prevAfter {
			t.Fatalf("ledger before mismatch: opID=%s want %d got %d", adj.opID, prevAfter, before)
		}
		// after 应等于预期
		if after != adj.expect {
			t.Fatalf("ledger after mismatch: opID=%s want %d got %d", adj.opID, adj.expect, after)
		}
		prevAfter = after

		// 断言桶当前余额与 after 一致
		if bal := balance(st, "u4"); bal != after {
			t.Fatalf("balance/ledger mismatch: opID=%s ledger.after=%d bucket.balance=%d", adj.opID, after, bal)
		}

		// 断言 BalanceAdjustment 记录值与余额一致
		var ledger model.BalanceAdjustment
		st.DB.First(&ledger, "operation_id = ?", adj.opID)
		if ledger.BalanceBefore != before || ledger.BalanceAfter != after {
			t.Fatalf("ledger record mismatch: opID=%s expected(%d,%d) got(%d,%d)",
				adj.opID, before, after, ledger.BalanceBefore, ledger.BalanceAfter)
		}
	}
}
