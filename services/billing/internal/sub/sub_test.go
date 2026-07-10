package sub

import (
	"testing"

	"gorm.io/gorm"
	"yc-billing/internal/bucket"
	"yc-billing/internal/model"
	"yc-billing/internal/pgtest"
	"yc-billing/internal/store"
)

func newStore(t *testing.T) *store.Store {
	st, err := store.Open(pgtest.DSN())
	if err != nil {
		t.Skipf("billing-postgres 不可用: %v", err)
	}
	pgtest.Serialize(t, st.DB)
	st.DB.Exec("TRUNCATE point_buckets, accounts, usage_records, top_ups, redemptions, subscriptions")
	return st
}

func TestApplyGrantsOnce(t *testing.T) {
	st := newStore(t)
	svc := New(st)

	// 第一次应用 pro，应该创建订阅并发放 10000 积分
	if err := svc.ApplyPlan("u1", "pro"); err != nil {
		t.Fatalf("第一次应用 pro 失败: %v", err)
	}

	var acc model.Account
	if err := st.DB.First(&acc, "user_id = ?", "u1").Error; err != nil {
		t.Fatalf("查询账户失败: %v", err)
	}

	b, _ := bucket.Balance(st.DB, "u1")
	if b != 10000 {
		t.Fatalf("余额应为 10000，实际 %d", b)
	}

	if acc.GroupRatio != 1.0 {
		t.Fatalf("GroupRatio 应为 1.0，实际 %f", acc.GroupRatio)
	}

	// 第二次同月应用 pro，不应重复发放
	if err := svc.ApplyPlan("u1", "pro"); err != nil {
		t.Fatalf("第二次应用 pro 失败: %v", err)
	}

	b2, _ := bucket.Balance(st.DB, "u1")
	if b2 != 10000 {
		t.Fatalf("同月重复应用后，余额应仍为 10000（不重复发放），实际 %d", b2)
	}
}

func TestApplyUnknownPlanErrors(t *testing.T) {
	st := newStore(t)
	svc := New(st)

	// 应用未知档位应返回错误
	if err := svc.ApplyPlan("u2", "bogus"); err == nil {
		t.Fatal("应用未知档位应返回错误")
	}

	// 不应创建任何记录
	var count int64
	st.DB.Model(&model.Subscription{}).Count(&count)
	if count != 0 {
		t.Fatalf("应用失败后不应创建任何订阅记录，实际 %d", count)
	}

	var acc model.Account
	err := st.DB.First(&acc, "user_id = ?", "u2").Error
	if err == nil {
		t.Fatal("应用失败后不应创建账户")
	}
}

func TestGrantInTxStacksDaysAndSetsRatio(t *testing.T) {
	st := newStore(t)
	if err := st.DB.Transaction(func(tx *gorm.DB) error {
		return GrantInTx(tx, "g1", "pro", 30)
	}); err != nil {
		t.Fatalf("grant1: %v", err)
	}
	var acc model.Account
	st.DB.First(&acc, "user_id = ?", "g1")
	if acc.GroupRatio != planConfigs["pro"].Ratio {
		t.Fatalf("ratio want %v got %v", planConfigs["pro"].Ratio, acc.GroupRatio)
	}
	b, _ := bucket.Balance(st.DB, "g1")
	if b != planConfigs["pro"].Grant {
		t.Fatalf("balance want %d got %d", planConfigs["pro"].Grant, b)
	}
	// 再发 30 天：ExpiresAt 应叠加（>=58 天后），余额再加一份 grant
	var before model.Subscription
	st.DB.Where("user_id = ?", "g1").Order("expires_at desc").First(&before)
	if err := st.DB.Transaction(func(tx *gorm.DB) error {
		return GrantInTx(tx, "g1", "pro", 30)
	}); err != nil {
		t.Fatalf("grant2: %v", err)
	}
	var after model.Subscription
	st.DB.Where("user_id = ?", "g1").Order("expires_at desc").First(&after)
	if !after.ExpiresAt.After(before.ExpiresAt) {
		t.Fatalf("expiresAt should stack: before=%v after=%v", before.ExpiresAt, after.ExpiresAt)
	}
}

func TestGrantInTxUnknownPlan(t *testing.T) {
	st := newStore(t)
	err := st.DB.Transaction(func(tx *gorm.DB) error { return GrantInTx(tx, "g2", "nope", 30) })
	if err == nil {
		t.Fatal("want error for unknown plan")
	}
}
