package redeem

import (
	"sync"
	"testing"
	"time"

	"gorm.io/driver/postgres"
	"gorm.io/gorm"
	"yc-billing/internal/bucket"
	"yc-billing/internal/model"
	"yc-billing/internal/pgtest"
	"yc-billing/internal/store"
)

// newStore 打开测试数据库，清理表。如果数据库不可用，跳过测试。
func newStore(t *testing.T) *store.Store {
	dsn := pgtest.DSN()
	db, err := gorm.Open(postgres.Open(dsn), &gorm.Config{})
	if err != nil {
		t.Skipf("billing-postgres 不可用: %v", err)
	}

	// 清理表：保证测试隔离
	pgtest.Serialize(t, db)
	db.Exec("TRUNCATE point_buckets, accounts, usage_records, top_ups, redemptions, subscriptions CASCADE")

	return &store.Store{DB: db}
}

// balanceOf 查询桶余额
func balanceOf(st *store.Store, userID string) int64 {
	b, _ := bucket.Balance(st.DB, userID)
	return b
}

// TestRedeemOnce 验证兑换码并发兑换只成功一次
// 同一码并发兑换 10 次 → 只成功 1 次、余额只加一次、码置 used
func TestRedeemOnce(t *testing.T) {
	st := newStore(t)
	svc := New(st)

	// 初始化：创建兑换码
	st.DB.Create(&model.Redemption{Code: "CODE1", Points: 500, Status: "unused"})

	// 10 个 goroutine 并发兑换
	var wg sync.WaitGroup
	successCount := 0
	var mu sync.Mutex

	for i := 0; i < 10; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if err := svc.Redeem("CODE1", "u1"); err == nil {
				mu.Lock()
				successCount++
				mu.Unlock()
			}
		}()
	}
	wg.Wait()

	// 验证结果
	// 1. 只有一个成功
	if successCount != 1 {
		t.Fatalf("应仅成功 1 次, got %d", successCount)
	}

	// 2. 余额只加一次
	balance := balanceOf(st, "u1")
	if balance != 500 {
		t.Fatalf("应 +500, got %d", balance)
	}

	// 3. 码置 used
	var r model.Redemption
	st.DB.First(&r, "code = ?", "CODE1")
	if r.Status != "used" {
		t.Fatalf("码状态应为 used, got %s", r.Status)
	}
	if r.UsedBy != "u1" {
		t.Fatalf("码 UsedBy 应为 u1, got %s", r.UsedBy)
	}
	if r.UsedAt == nil {
		t.Fatal("码 UsedAt 应被设置")
	}
}

func TestRedeemBalancePayload(t *testing.T) {
	st := newStore(t)
	s := New(st)
	st.DB.Create(&model.Redemption{Code: "BAL1", GrantType: "BALANCE", GrantPayload: `{"points":500}`, Status: "unused"})
	if err := s.Redeem("BAL1", "u1"); err != nil {
		t.Fatalf("redeem: %v", err)
	}
	if got := balanceOf(st, "u1"); got != 500 {
		t.Fatalf("balance want 500 got %d", got)
	}
}

func TestRedeemLegacyBalanceCompat(t *testing.T) {
	st := newStore(t)
	s := New(st)
	// 旧码：grant_type 默认 BALANCE 但 payload 空，用 Points 兜底
	st.DB.Create(&model.Redemption{Code: "LEG1", Points: 300, Status: "unused"})
	if err := s.Redeem("LEG1", "u2"); err != nil {
		t.Fatalf("redeem: %v", err)
	}
	if got := balanceOf(st, "u2"); got != 300 {
		t.Fatalf("balance want 300 got %d", got)
	}
}

func TestRedeemMembership(t *testing.T) {
	st := newStore(t)
	s := New(st)
	st.DB.Create(&model.Redemption{Code: "MEM1", GrantType: "MEMBERSHIP", GrantPayload: `{"tier":"pro","days":30}`, Status: "unused"})
	if err := s.Redeem("MEM1", "u3"); err != nil {
		t.Fatalf("redeem: %v", err)
	}
	var acc model.Account
	st.DB.First(&acc, "user_id = ?", "u3")
	if acc.GroupRatio == 0 {
		t.Fatal("membership not applied")
	}
}

func TestRedeemUnsupportedRollsBack(t *testing.T) {
	st := newStore(t)
	s := New(st)
	st.DB.Create(&model.Redemption{Code: "FEA1", GrantType: "FEATURE", GrantPayload: `{"featureKey":"x"}`, Status: "unused"})
	if err := s.Redeem("FEA1", "u4"); err != ErrUnsupportedGrant {
		t.Fatalf("want ErrUnsupportedGrant got %v", err)
	}
	var r model.Redemption
	st.DB.First(&r, "code = ?", "FEA1")
	if r.Status != "unused" {
		t.Fatalf("code must stay unused on unsupported, got %s", r.Status)
	}
}

func TestRedeemExpired(t *testing.T) {
	st := newStore(t)
	s := New(st)
	past := time.Now().Add(-time.Hour)
	st.DB.Create(&model.Redemption{Code: "EXP1", GrantType: "BALANCE", GrantPayload: `{"points":100}`, Status: "unused", ExpiresAt: &past})
	if err := s.Redeem("EXP1", "u5"); err != ErrCodeExpired {
		t.Fatalf("want ErrCodeExpired got %v", err)
	}
	var r model.Redemption
	st.DB.First(&r, "code = ?", "EXP1")
	if r.Status != "unused" {
		t.Fatalf("expired code must stay unused, got %s", r.Status)
	}
}
